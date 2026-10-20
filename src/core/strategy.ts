import type { Address } from 'viem';
import { collectFees, closePosition, increaseLiquidity, openPosition, type TxOutcome } from './actions.js';
import { alignTickDown, alignTickUp, MAX_TICK, reanchorRange } from './math/tickMath.js';
import { liquidityFromAmounts } from './math/positionMath.js';
import { refreshPool, type Pool } from './pools.js';
import type { PositionSnapshot } from './positions.js';
import { erc20BalanceOf } from './wallet.js';
import { createLogger } from '../logger.js';

const log = createLogger('strategy');

interface AutomationOptions {
  owner: Address;
  dryRun: boolean;
  slippagePct: number;
}

/**
 * Collects fees and immediately re-adds them to the same position.
 * Returns the USD value that was compounded.
 */
export async function compoundFees(
  snapshot: PositionSnapshot,
  feeUsd: number,
  options: AutomationOptions,
): Promise<{ outcome: TxOutcome; compoundedUsd: number }> {
  if (snapshot.fees0 === 0n && snapshot.fees1 === 0n) {
    return { outcome: { dryRun: options.dryRun }, compoundedUsd: 0 };
  }

  const collect = await collectFees(snapshot, options.owner, options.dryRun);
  if (collect.error) return { outcome: collect, compoundedUsd: 0 };
  if (collect.dryRun) return { outcome: collect, compoundedUsd: feeUsd };

  // The fees are now in the wallet; add exactly what was collected.
  const increase = await increaseLiquidity({
    snapshot,
    amount0: snapshot.fees0,
    amount1: snapshot.fees1,
    slippagePct: options.slippagePct,
    recipient: options.owner,
    dryRun: false,
  });
  log.info(`compounded fees for ${snapshot.version} #${snapshot.tokenId}: $${feeUsd.toFixed(2)}`);
  return { outcome: increase, compoundedUsd: feeUsd };
}

/**
 * The same tick width, centred on the current price.
 *
 * This is the range both the auto-rebalance and the auto-TP re-entry use.
 */
function recentredRange(
  tickLower: number,
  tickUpper: number,
  currentTick: number,
  spacing: number,
): { tickLower: number; tickUpper: number } {
  const width = tickUpper - tickLower;
  const half = Math.max(spacing, Math.floor(width / 2 / spacing) * spacing);
  let lower = alignTickDown(currentTick - half, spacing);
  let upper = alignTickUp(currentTick + half, spacing);
  if (upper > MAX_TICK) {
    upper = alignTickDown(MAX_TICK, spacing);
    lower = upper - 2 * half;
  }
  if (lower >= currentTick) lower = alignTickDown(currentTick - spacing, spacing);
  if (upper <= currentTick) upper = alignTickUp(currentTick + spacing, spacing);
  return { tickLower: lower, tickUpper: upper };
}

/**
 * Which side of the market the position sits on.
 *
 * A position that holds only token0 needs its range **above** the market to
 * stay one-sided (the price below the range means the position is all token0),
 * and a position that holds only token1 needs it **below**. A position that
 * holds both is re-centred.
 */
function sideOf(snapshot: PositionSnapshot): 'up' | 'down' | 'both' {
  const has0 = snapshot.amount0 > 0n;
  const has1 = snapshot.amount1 > 0n;
  if (has0 && !has1) return 'up';
  if (has1 && !has0) return 'down';
  return 'both';
}

/**
 * The range a re-entry uses: the same width and the same side, on the live
 * price.
 *
 * The side matters. A one-sided position that was re-centred would need both
 * tokens again, and the capital that came back from the close is one-sided —
 * so the mint had nothing to work with and failed. Keeping the side keeps the
 * mint possible.
 */
function reentryRange(
  snapshot: PositionSnapshot,
  currentTick: number,
  spacing: number,
): { tickLower: number; tickUpper: number } {
  const direction = sideOf(snapshot);
  if (direction === 'both') {
    return recentredRange(snapshot.tickLower, snapshot.tickUpper, currentTick, spacing);
  }
  // One-sided: the range keeps its side of the market and follows the price.
  return reanchorRange(
    { tickLower: snapshot.tickLower, tickUpper: snapshot.tickUpper },
    currentTick,
    direction,
    spacing,
  );
}

/**
 * Mints the withdrawn funds back into a range, never more than what was
 * withdrawn (plus a 1% buffer), so unrelated wallet balances stay untouched.
 */
async function mintWithdrawn(
  pool: Pool,
  owner: Address,
  withdrawn0: bigint,
  withdrawn1: bigint,
  range: { tickLower: number; tickUpper: number },
  slippagePct: number,
): Promise<{ amount0: bigint; amount1: bigint; opened: Awaited<ReturnType<typeof openPosition>> }> {
  const [wallet0, wallet1] = await Promise.all([
    erc20BalanceOf(pool.token0.address, owner),
    erc20BalanceOf(pool.token1.address, owner),
  ]);
  const cap0 = withdrawn0 + withdrawn0 / 100n;
  const cap1 = withdrawn1 + withdrawn1 / 100n;
  const amount0 = wallet0 < cap0 ? wallet0 : cap0;
  const amount1 = wallet1 < cap1 ? wallet1 : cap1;

  if (liquidityFromAmounts(pool.sqrtPriceX96, pool.tick, range.tickLower, range.tickUpper, amount0, amount1) <= 0n) {
    throw new Error('Not enough tokens withdrawn to re-mint the position');
  }

  const opened = await openPosition({
    pool,
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    amount0,
    amount1,
    slippagePct,
    recipient: owner,
    dryRun: false,
  });
  return { amount0: opened.amount0, amount1: opened.amount1, opened };
}

/**
 * Re-opens the same tick width centred on the current price, using only the
 * funds that the close returned (plus a 1% buffer). This is what auto-TP uses
 * for its re-entry: same pool, same width, same size.
 */
export async function reenterSameRange(
  snapshot: PositionSnapshot,
  options: AutomationOptions,
): Promise<RebalanceResult> {
  const pool = await poolForPosition(snapshot);
  if (!pool) throw new Error('Pool for this position is no longer available');

  const spacing = snapshot.tickSpacing || 60;
  const range = reentryRange(snapshot, pool.tick, spacing);

  if (options.dryRun) {
    return {
      outcome: { dryRun: true },
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      amount0: 0n,
      amount1: 0n,
    };
  }

  const { amount0, amount1, opened } = await mintWithdrawn(
    pool,
    options.owner,
    snapshot.amount0,
    snapshot.amount1,
    range,
    options.slippagePct,
  );
  log.info(`auto-TP re-entry ${snapshot.version} #${snapshot.tokenId} -> #${opened.tokenId ?? '?'}`);
  return {
    outcome: opened,
    newTokenId: opened.tokenId,
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    amount0,
    amount1,
  };
}

interface RebalanceResult {
  outcome: TxOutcome;
  newTokenId?: bigint;
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
  /**
   * The position was closed but the re-mint failed. The capital is in the
   * wallet and the position has to be untracked.
   */
  closedWithoutRemint?: boolean;
}

/** Builds a Pool object for an existing position's pool and refreshes it. */
async function poolForPosition(snapshot: PositionSnapshot): Promise<Pool | undefined> {
  if (snapshot.version === 'v3') {
    if (!snapshot.poolAddress) return undefined;
    const stub = {
      version: 'v3' as const,
      address: snapshot.poolAddress,
      token0: snapshot.token0,
      token1: snapshot.token1,
      fee: snapshot.fee,
      tickSpacing: snapshot.tickSpacing,
      sqrtPriceX96: snapshot.sqrtPriceX96,
      tick: snapshot.tick,
      liquidity: 0n,
      price: snapshot.price,
      label: `v3 ${snapshot.fee / 10_000}%`,
    };
    return refreshPool(stub);
  }
  if (!snapshot.poolId) return undefined;
  // The pool id is built from the key's static fee; a dynamic-fee pool reports
  // its current fee in `fee`, which would produce a different pool id.
  const keyFee = snapshot.keyFee ?? snapshot.fee;
  const stub: Pool = {
    version: 'v4',
    poolId: snapshot.poolId,
    key: {
      currency0: snapshot.token0.address,
      currency1: snapshot.token1.address,
      fee: keyFee,
      tickSpacing: snapshot.tickSpacing,
      hooks: snapshot.hooks!,
    },
    token0: snapshot.token0,
    token1: snapshot.token1,
    fee: keyFee,
    lpFee: snapshot.fee,
    tickSpacing: snapshot.tickSpacing,
    sqrtPriceX96: snapshot.sqrtPriceX96,
    tick: snapshot.tick,
    liquidity: 0n,
    price: snapshot.price,
    label: `v4`,
  };
  return refreshPool(stub);
}

/**
 * Closes an out-of-range position and re-mints it around the current price with
 * the same tick width. Only the withdrawn funds (plus a 1% buffer) are reused,
 * so unrelated wallet balances are never put at risk.
 *
 * Everything that can be checked is checked *before* the close. If the
 * re-mint fails after the close, the result says so, so the caller can record
 * the close and tell the user the capital is in the wallet.
 */
export async function rebalancePosition(
  snapshot: PositionSnapshot,
  options: AutomationOptions,
): Promise<RebalanceResult> {
  const spacing = snapshot.tickSpacing || 60;

  // The pool and the new range are resolved before anything is closed.
  const pool = await poolForPosition(snapshot);
  if (!pool) {
    return {
      outcome: { dryRun: options.dryRun, error: 'Pool for this position is no longer available' },
      tickLower: snapshot.tickLower,
      tickUpper: snapshot.tickUpper,
      amount0: 0n,
      amount1: 0n,
    };
  }
  const range = reentryRange(snapshot, pool.tick, spacing);

  // The close is confirmed before the re-mint is sent: the capital the
  // re-mint uses is what the close returns.
  const closed = await closePosition({
    snapshot,
    slippagePct: options.slippagePct,
    recipient: options.owner,
    dryRun: options.dryRun,
  });
  if (closed.error) {
    return { outcome: closed, tickLower: range.tickLower, tickUpper: range.tickUpper, amount0: 0n, amount1: 0n };
  }

  if (closed.dryRun) {
    return { outcome: closed, tickLower: range.tickLower, tickUpper: range.tickUpper, amount0: 0n, amount1: 0n };
  }

  try {
    const { amount0, amount1, opened } = await mintWithdrawn(
      pool,
      options.owner,
      snapshot.amount0,
      snapshot.amount1,
      range,
      options.slippagePct,
    );
    log.info(
      `rebalanced ${snapshot.version} #${snapshot.tokenId} -> #${opened.tokenId ?? '?'} [${range.tickLower}, ${range.tickUpper}]`,
    );
    return {
      outcome: opened,
      newTokenId: opened.tokenId,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      amount0,
      amount1,
    };
  } catch (err) {
    // The position is closed and the capital is in the wallet.
    return {
      outcome: {
        dryRun: false,
        error: `the position was closed but the re-mint failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      amount0: 0n,
      amount1: 0n,
      closedWithoutRemint: true,
    };
  }
}
