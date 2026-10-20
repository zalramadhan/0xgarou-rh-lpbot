import { zeroAddress, type Address, type Hex } from 'viem';
import { v3FactoryAbi, v3PoolAbi } from '../constants/abis.js';
import { CONTRACTS, TOKENS } from '../constants/chain.js';
import { publicClient } from '../chain/client.js';
import { fetchIndexerPools } from './indexer.js';
import {
  computeV4PoolId,
  readV3PoolByAddress,
  readV4PoolByKey,
  sortCurrencies,
  type Pool,
  type PoolKeyShape,
} from './pools.js';
import { getToken } from './tokens.js';
import { createLogger } from '../logger.js';
import { retryRpc } from '../utils/async.js';

const log = createLogger('discovery');

/** The chain's quote assets: their pools are known without the indexer. */
const QUOTE_TOKENS = new Set<string>([
  TOKENS.USDG.toLowerCase(),
  TOKENS.WETH.toLowerCase(),
]);

/** Fee candidates tried when recovering a v4 pool key from its pool id. */
function feeCandidates(feePct: number | undefined): number[] {
  const fees = new Set<number>();
  if (feePct !== undefined && Number.isFinite(feePct)) {
    const derived = Math.round(feePct * 10_000);
    if (derived > 0) fees.add(derived);
  }
  // Dynamic-fee pools display their current fee, so always consider the flag.
  fees.add(0x800000);
  // Standard tiers plus the exotic static tiers launchpads initialise with
  // (4.4%, 5%, ...) which the listing does not always spell out.
  for (const fee of [100, 500, 3000, 10000, 20000, 25000, 30000, 40000, 44000, 50000, 80000, 90000, 100000]) {
    fees.add(fee);
  }
  return [...fees];
}

/**
 * The tick spacings Uniswap v4 pools actually use. Probing them first turns
 * the common case from tens of thousands of hashes into a hundred.
 */
const COMMON_TICK_SPACINGS = [1, 10, 60, 100, 200];

/** A pool id always recovers to the same key, so the result is remembered. */
const recoveredKeys = new Map<string, PoolKeyShape>();
const MAX_RECOVERED = 500;

function rememberKey(poolId: string, key: PoolKeyShape): void {
  if (recoveredKeys.size >= MAX_RECOVERED) {
    const oldest = recoveredKeys.keys().next().value;
    if (oldest) recoveredKeys.delete(oldest);
  }
  recoveredKeys.set(poolId, key);
}

/**
 * Uniswap v4 pool ids are keccak256(abi.encode(poolKey)). With the id known, the
 * remaining unknowns are the fee and the tick spacing; both are small enough to
 * brute force. A hook address cannot be brute forced, so hooked pools are
 * reported as unsupported instead of guessed.
 */
/**
 * Recovers the keys of several pool ids of the same pair in one sweep.
 *
 * A v4 pool id is `keccak256(abi.encode(poolKey))`, so the fee and the tick
 * spacing have to be guessed. The guess is the same for every pool of a pair,
 * so the sweep is paid **once for the whole list** instead of once per pool:
 * that is the difference between five seconds and a third of one.
 */
export function recoverV4Keys(
  currency0: Address,
  currency1: Address,
  wanted: { poolId: Hex; feePct?: number }[],
  maxTickSpacing = 2000,
): Map<string, PoolKeyShape> {
  const [c0, c1] = sortCurrencies(currency0, currency1);
  const found = new Map<string, PoolKeyShape>();

  const missing: { poolId: Hex; feePct?: number }[] = [];
  for (const entry of wanted) {
    const id = entry.poolId.toLowerCase();
    const cached = recoveredKeys.get(id);
    if (cached) {
      found.set(id, cached);
      continue;
    }
    missing.push(entry);
  }
  if (missing.length === 0) return found;

  const targets = new Set(missing.map((entry) => entry.poolId.toLowerCase()));
  const fees = new Set<number>();
  // The fees that are worth an exotic-spacing sweep: the one the listing
  // names (it spells the fee out) and the dynamic-fee flag. The standard
  // tiers almost always use a common spacing, which the pass below covers.
  const deepFees = new Set<number>();
  for (const entry of missing) {
    for (const fee of feeCandidates(entry.feePct)) {
      fees.add(fee);
      if (entry.feePct !== undefined && Number.isFinite(entry.feePct)) {
        const derived = Math.round(entry.feePct * 10_000);
        if (derived > 0) deepFees.add(derived);
      }
    }
  }
  deepFees.add(0x800000);

  const key = (fee: number, tickSpacing: number): PoolKeyShape => ({
    currency0: c0,
    currency1: c1,
    fee,
    tickSpacing,
    hooks: zeroAddress,
  });

  const matches = (fee: number, tickSpacing: number): void => {
    const id = computeV4PoolId(key(fee, tickSpacing)).toLowerCase();
    if (!targets.has(id)) return;
    const recovered = key(fee, tickSpacing);
    found.set(id, recovered);
    rememberKey(id, recovered);
  };

  // The common spacings first: this is what almost every pool uses.
  for (const fee of fees) {
    for (const tickSpacing of COMMON_TICK_SPACINGS) matches(fee, tickSpacing);
  }
  // Then the exotic ones, which cost a full sweep — for the fees that are
  // worth it.
  for (const fee of deepFees) {
    for (let tickSpacing = 1; tickSpacing <= maxTickSpacing; tickSpacing++) {
      if (COMMON_TICK_SPACINGS.includes(tickSpacing)) continue;
      matches(fee, tickSpacing);
    }
  }
  return found;
}

/**
 * Recovers one v4 pool key from its pool id.
 *
 * This is the complete search: every fee is tried against every tick
 * spacing, so a pool with an exotic fee *and* an exotic spacing is still
 * found. It costs a full sweep, so prefer {@link recoverV4Keys} when several
 * ids of the same pair have to be recovered.
 */
export function recoverV4Key(
  currency0: Address,
  currency1: Address,
  poolId: Hex,
  feePct?: number,
  maxTickSpacing = 2000,
): PoolKeyShape | undefined {
  const [c0, c1] = sortCurrencies(currency0, currency1);
  const target = poolId.toLowerCase();
  const cached = recoveredKeys.get(target);
  if (cached) return cached;
  const fees = feeCandidates(feePct);

  const key = (fee: number, tickSpacing: number): PoolKeyShape => ({
    currency0: c0,
    currency1: c1,
    fee,
    tickSpacing,
    hooks: zeroAddress,
  });

  const matches = (fee: number, tickSpacing: number): boolean =>
    computeV4PoolId(key(fee, tickSpacing)).toLowerCase() === target;

  // The common spacings first: this is what almost every pool uses.
  for (const fee of fees) {
    for (const tickSpacing of COMMON_TICK_SPACINGS) {
      if (matches(fee, tickSpacing)) {
        const found = key(fee, tickSpacing);
        rememberKey(target, found);
        return found;
      }
    }
  }

  // Exotic spacings still work, but they cost a full sweep.
  for (const fee of fees) {
    for (let tickSpacing = 1; tickSpacing <= maxTickSpacing; tickSpacing++) {
      if (COMMON_TICK_SPACINGS.includes(tickSpacing)) continue;
      if (matches(fee, tickSpacing)) {
        const found = key(fee, tickSpacing);
        rememberKey(target, found);
        return found;
      }
    }
  }
  return undefined;
}

function samePair(a: string, b: string, x: string, y: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return (left === x.toLowerCase() && right === y.toLowerCase()) || (left === y.toLowerCase() && right === x.toLowerCase());
}

interface DiscoveryOutcome {
  pools: Pool[];
  /** Uniswap pools the indexer knows about but whose key we could not rebuild. */
  unsupported: number;
}

/**
 * Indexer-assisted fallback for pools the local key probe cannot guess: exotic
 * fee tiers, custom tick spacings, or dynamnic fees.
 */
export async function discoverViaIndexer(tokenA: Address, tokenB: Address): Promise<DiscoveryOutcome> {
  // The quote pairs are well known and their listing is enormous: asking the
  // indexer for them costs three slow pages and finds nothing useful. The
  // local probes know these pools.
  const quote = [tokenA, tokenB].some((token) => QUOTE_TOKENS.has(token.toLowerCase()));
  if (quote) return { pools: [], unsupported: 0 };

  const listed = await fetchIndexerPools(tokenA);
  const candidates = listed
    .filter((pool) => pool.dex.includes('uniswap') && samePair(pool.baseToken, pool.quoteToken, tokenA, tokenB))
    .sort((a, b) => b.reserveUsd - a.reserveUsd);

  const pools: Pool[] = [];
  let unsupported = 0;

  const top = candidates.slice(0, 8);
  // The v4 pool ids of the pair are recovered in **one sweep**: the guess
  // (fee, tick spacing) is the same for every pool, so paying for it per pool
  // is what made a scan slow.
  const v4Candidates = top.filter((candidate) => candidate.address.length === 66);
  const v4Keys = recoverV4Keys(
    tokenA,
    tokenB,
    v4Candidates.map((candidate) => ({ poolId: candidate.address as Hex, feePct: candidate.feePct })),
  );

  for (const candidate of top) {
    try {
      if (candidate.address.length === 66) {
        const key =
          v4Keys.get(candidate.address.toLowerCase()) ??
          recoverV4Key(tokenA, tokenB, candidate.address as Hex, candidate.feePct);
        if (!key) {
          unsupported++;
          continue;
        }
        const [token0, token1] = await Promise.all([getToken(key.currency0), getToken(key.currency1)]);
        const pool = await readV4PoolByKey(key, token0, token1);
        if (pool) pools.push(pool);
      } else if (candidate.address.length === 42) {
        const address = candidate.address as Address;
        const [token0, token1, fee] = await retryRpc(() =>
          Promise.all([
            publicClient.readContract({ address, abi: v3PoolAbi, functionName: 'token0' }),
            publicClient.readContract({ address, abi: v3PoolAbi, functionName: 'token1' }),
            publicClient.readContract({ address, abi: v3PoolAbi, functionName: 'fee' }),
          ]),
        );
        const expected = await retryRpc(() =>
          publicClient.readContract({
            address: CONTRACTS.v3Factory,
            abi: v3FactoryAbi,
            functionName: 'getPool',
            args: [token0, token1, fee],
          }),
        );
        if (expected.toLowerCase() !== address.toLowerCase()) continue;
        const pool = await readV3PoolByAddress(address);
        if (pool) pools.push(pool);
      }
    } catch (err) {
      log.warn(`could not rebuild pool ${candidate.address}`, err);
    }
  }

  if (pools.length) log.info(`indexer discovery found ${pools.length} pool(s)`);
  return { pools, unsupported };
}
