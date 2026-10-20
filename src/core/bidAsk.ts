import type { Address } from 'viem';
import {
  BID_ASK_MAX_ENTRIES,
  BID_ASK_MIN_ENTRIES,
  isValidBidAskEntries,
} from '../constants/bidAsk.js';
import { alignTickDown, alignTickUp, tickToPrice } from './math/tickMath.js';
import { planByUsd, type DepositPlan } from './planner.js';
import { erc20BalanceOf } from './wallet.js';
import type { Pool } from './pools.js';
import type { TokenInfo } from './tokens.js';

/** Allocations are rounded in micro-USD so their sum is exact to the cent's edge. */
const MICRO_USD = 1_000_000;
/** Planned value may differ from the request by this fraction because liquidity is floored. */
const OVERSIZE_TOLERANCE = 0.005;

interface BidAskBin {
  /** 1-based, nearest the current market price first. */
  index: number;
  tickLower: number;
  tickUpper: number;
}

interface BidAskAllocation {
  /** 1-based, nearest the current market price first. */
  index: number;
  weight: number;
  usd: number;
  pct: number;
}

export interface BidAskEntryPlan {
  /** 1-based, nearest the current market price first. */
  index: number;
  weight: number;
  allocationUsd: number;
  allocationPct: number;
  tickLower: number;
  tickUpper: number;
  plan: DepositPlan;
}

export interface BidAskPlan {
  entryCount: number;
  side: 'quote' | 'token';
  /** True when the funded token is pool token0. */
  fundedIsToken0: boolean;
  totalUsd: number;
  plannedUsd: number;
  /** Requested minus planned, usually a few cents of integer-liquidity dust. */
  dustUsd: number;
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
  balance0?: bigint;
  balance1?: bigint;
  shortfall0: bigint;
  shortfall1: bigint;
  entries: BidAskEntryPlan[];
}

function assertEntryCount(entryCount: number): void {
  if (!isValidBidAskEntries(entryCount)) {
    throw new Error(`Bid Ask entries must be between ${BID_ASK_MIN_ENTRIES} and ${BID_ASK_MAX_ENTRIES}`);
  }
}

/** Progressive weights 1, 2, … N. */
export function bidAskWeights(entryCount: number): number[] {
  assertEntryCount(entryCount);
  return Array.from({ length: entryCount }, (_, i) => i + 1);
}

/**
 * Splits a total into progressive 1:2:…:N allocations.
 *
 * The arithmetic is done in integer micro-USD and the remainder is handed out
 * by largest fractional part, so the returned values sum to the requested total
 * instead of drifting by a cent per entry.
 */
export function bidAskAllocations(totalUsd: number, entryCount: number): BidAskAllocation[] {
  assertEntryCount(entryCount);
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
    throw new Error('Bid Ask total must be greater than zero');
  }

  const units = Math.round(totalUsd * MICRO_USD);
  if (units <= 0) throw new Error('Bid Ask total is too small');

  const weights = bidAskWeights(entryCount);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const raw = weights.map((weight) => (units * weight) / totalWeight);
  const shares = raw.map((value) => Math.floor(value));
  const remainder = units - shares.reduce((sum, value) => sum + value, 0);

  const order = raw
    .map((value, i) => ({ i, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || b.i - a.i);
  for (let i = 0; i < remainder; i++) {
    const target = order[i];
    if (target) shares[target.i]! += 1;
  }

  return shares.map((value, i) => ({
    index: i + 1,
    weight: weights[i]!,
    usd: value / MICRO_USD,
    pct: (weights[i]! / totalWeight) * 100,
  }));
}

/**
 * Which way the ladder walks away from the market.
 *
 * `up` means the range sits above the live price, `down` means it sits below.
 * Uniswap hands a position `token0` when the price is at or below the lower
 * bound and `token1` when it is at or above the upper bound, so the funded
 * token decides the direction: funding `token0` walks up, funding `token1`
 * walks down.
 */
type BidAskDirection = 'up' | 'down';

/**
 * Splits the selected one-sided range into N contiguous, tick-spaced bins.
 *
 * The bin nearest the market comes first, so allocation weight 1 (the smallest)
 * always lands on the closest entry and weight N on the farthest. The near
 * edge follows the live price, which keeps every mint one-sided even when the
 * market moved after the range was picked; the far edge stays where the user
 * put it.
 */
export function buildBidAskBins(
  pool: Pick<Pool, 'tick' | 'tickSpacing'>,
  tickLower: number,
  tickUpper: number,
  entryCount: number,
  direction: BidAskDirection,
): BidAskBin[] {
  assertEntryCount(entryCount);
  if (!Number.isFinite(tickLower) || !Number.isFinite(tickUpper) || tickLower >= tickUpper) {
    throw new Error('Bid Ask needs a valid non-empty range');
  }
  const spacing = pool.tickSpacing;
  if (!Number.isInteger(spacing) || spacing <= 0) throw new Error('Pool tick spacing is invalid');

  const userNear = direction === 'up' ? tickLower : tickUpper;
  const userFar = direction === 'up' ? tickUpper : tickLower;
  // The near edge always starts at the live price so the ladder stays on the
  // funded side of the market, whatever the price did since the range was set.
  const marketEdge =
    direction === 'up' ? alignTickUp(pool.tick, spacing) : alignTickDown(pool.tick, spacing);
  const alignedNear = direction === 'up' ? alignTickUp(userNear, spacing) : alignTickDown(userNear, spacing);
  const near = direction === 'up' ? Math.max(alignedNear, marketEdge) : Math.min(alignedNear, marketEdge);
  const far = direction === 'up' ? alignTickDown(userFar, spacing) : alignTickUp(userFar, spacing);

  const span = direction === 'up' ? far - near : near - far;
  if (span <= 0) {
    throw new Error(
      direction === 'up'
        ? 'This range is not above the current price, but this side funds entries above the market. Pick a range above the price.'
        : 'This range is not below the current price, but this side funds entries below the market. Pick a range below the price.',
    );
  }

  const spacings = Math.floor(span / spacing);
  if (spacings < entryCount) {
    throw new Error(
      `This range is too narrow for ${entryCount} Bid Ask entries at ${spacing}-tick spacing. ` +
        'Pick a wider range or reduce the entry count in Settings.',
    );
  }

  const base = Math.floor(spacings / entryCount);
  const extra = spacings % entryCount;
  const bins: BidAskBin[] = [];
  let cursor = near;

  for (let i = 0; i < entryCount; i++) {
    // Extra tick-spacings go to the farthest bins, not the nearest ones.
    const width = (base + (i >= entryCount - extra ? 1 : 0)) * spacing;
    if (direction === 'up') {
      bins.push({ index: i + 1, tickLower: cursor, tickUpper: cursor + width });
      cursor += width;
    } else {
      bins.push({ index: i + 1, tickLower: cursor - width, tickUpper: cursor });
      cursor -= width;
    }
  }
  return bins;
}

/** Human price of the pasted token at a tick, in quote-token units. */
export function displayPriceAtTick(
  pool: Pick<Pool, 'token0' | 'token1'>,
  token: Pick<TokenInfo, 'address'>,
  tick: number,
): number {
  const raw = tickToPrice(tick, pool.token0.decimals, pool.token1.decimals);
  return pool.token0.address.toLowerCase() === token.address.toLowerCase() ? raw : 1 / raw;
}

interface BuildBidAskPlanParams {
  pool: Pool;
  token: TokenInfo;
  side: 'quote' | 'token';
  tickLower: number;
  tickUpper: number;
  totalUsd: number;
  entryCount: number;
  owner?: Address;
  /** Injectable for tests; production uses the live USD planner. */
  planUsd?: typeof planByUsd;
}

/**
 * Builds the full ladder preview: bins, progressive allocations, per-entry
 * sizing and aggregate balances. Throws before anything is signed if an entry
 * is too small, the range is not fully one-sided, or the plan would overspend.
 */
export async function buildBidAskPlan(params: BuildBidAskPlanParams): Promise<BidAskPlan> {
  const { pool, token, side, tickLower, tickUpper, totalUsd, entryCount, owner } = params;
  const planUsd = params.planUsd ?? planByUsd;
  const allocations = bidAskAllocations(totalUsd, entryCount);

  const tokenIsToken0 = pool.token0.address.toLowerCase() === token.address.toLowerCase();
  const fundedIsToken0 = side === 'quote' ? !tokenIsToken0 : tokenIsToken0;
  // Funding token0 means the range has to sit above the market, funding
  // token1 means it has to sit below it.
  const direction: BidAskDirection = fundedIsToken0 ? 'up' : 'down';
  const bins = buildBidAskBins(pool, tickLower, tickUpper, entryCount, direction);

  const entries: BidAskEntryPlan[] = [];
  let amount0 = 0n;
  let amount1 = 0n;

  for (let i = 0; i < bins.length; i++) {
    const bin = bins[i]!;
    const allocation = allocations[i]!;
    // Balances are read once for the whole ladder, not once per entry.
    let plan: DepositPlan;
    try {
      plan = await planUsd(pool, bin.tickLower, bin.tickUpper, allocation.usd, undefined);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        detail === 'Deposit too small for this range'
          ? `Entry #${bin.index} is too small for this range — increase the total or reduce the entry count.`
          : `Entry #${bin.index}: ${detail}`,
      );
    }

    const fundedAmount = fundedIsToken0 ? plan.amount0 : plan.amount1;
    const otherAmount = fundedIsToken0 ? plan.amount1 : plan.amount0;
    if (fundedAmount <= 0n) {
      throw new Error(
        `Entry #${bin.index} is too small for this range — increase the total or reduce the entry count.`,
      );
    }
    if (otherAmount !== 0n) {
      throw new Error(
        `Entry #${bin.index} would require both tokens. Bid Ask ranges must sit entirely on the funded side.`,
      );
    }

    entries.push({
      index: bin.index,
      weight: allocation.weight,
      allocationUsd: allocation.usd,
      allocationPct: allocation.pct,
      tickLower: bin.tickLower,
      tickUpper: bin.tickUpper,
      plan,
    });
    amount0 += plan.amount0;
    amount1 += plan.amount1;
  }

  const plannedUsd = entries.reduce((sum, entry) => sum + entry.plan.valueUsd, 0);
  const overspend = plannedUsd - totalUsd;
  if (overspend > Math.max(0.01, totalUsd * OVERSIZE_TOLERANCE)) {
    throw new Error(
      `The ladder would deposit about $${plannedUsd.toFixed(2)}, more than the $${totalUsd.toFixed(2)} requested. ` +
        'Reduce the total slightly.',
    );
  }

  const balance0 = owner ? await erc20BalanceOf(pool.token0.address, owner) : undefined;
  const balance1 = owner ? await erc20BalanceOf(pool.token1.address, owner) : undefined;
  const shortfall0 = balance0 !== undefined && amount0 > balance0 ? amount0 - balance0 : 0n;
  const shortfall1 = balance1 !== undefined && amount1 > balance1 ? amount1 - balance1 : 0n;

  // The ladder can start closer to the market than the range the user picked,
  // so report the bounds the entries actually use.
  const ladderLower = entries.reduce((min, entry) => Math.min(min, entry.tickLower), Infinity);
  const ladderUpper = entries.reduce((max, entry) => Math.max(max, entry.tickUpper), -Infinity);

  return {
    entryCount,
    side,
    fundedIsToken0,
    totalUsd,
    plannedUsd,
    dustUsd: Math.max(0, totalUsd - plannedUsd),
    tickLower: ladderLower,
    tickUpper: ladderUpper,
    amount0,
    amount1,
    balance0,
    balance1,
    shortfall0,
    shortfall1,
    entries,
  };
}
