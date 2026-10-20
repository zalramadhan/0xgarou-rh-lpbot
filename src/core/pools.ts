import { keccak256, zeroAddress, type Address, type Hex } from 'viem';
import { v3FactoryAbi, v3PoolAbi, v4StateViewAbi } from '../constants/abis.js';
import { CONTRACTS, V3_FEE_TIERS, V4_POOL_CANDIDATES } from '../constants/chain.js';
import { publicClient } from '../chain/client.js';
import { getToken, type TokenInfo } from './tokens.js';
import { sqrtRatioX96ToPrice } from './math/tickMath.js';
import { positionAmounts } from './math/positionMath.js';
import { createLogger } from '../logger.js';
import { retryRpc } from '../utils/async.js';
import { discoverViaIndexer } from './discovery.js';
import { isRevertError } from '../utils/errors.js';

const log = createLogger('pools');

export interface PoolKeyShape {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

interface PoolBase {
  version: 'v3' | 'v4';
  token0: TokenInfo;
  token1: TokenInfo;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  /** token1 per token0, human units */
  price: number;
  label: string;
}

export interface V3Pool extends PoolBase {
  version: 'v3';
  address: Address;
}

export interface V4Pool extends PoolBase {
  version: 'v4';
  poolId: Hex;
  key: PoolKeyShape;
  lpFee: number;
}

export type Pool = V3Pool | V4Pool;

/** lexicographic ordering of currencies, as Uniswap v4 requires. */
export function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/** keccak256(abi.encode(poolKey)) — the Uniswap v4 PoolId. */
/**
 * The pool id is keccak256(abi.encode(PoolKey)). The encoding is a fixed
 * 5 x 32 byte head, so it is written by hand here: the generic ABI encoder
 * costs ~17 us per call, and the key recovery in `discovery.ts` probes tens of
 * thousands of keys.
 */
function writeAddress(target: Uint8Array, offset: number, address: Address): void {
  const hex = address.slice(2).toLowerCase();
  for (let i = 0; i < 20; i++) {
    target[offset + 12 + i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
}

/** A uint24 (or a positive int24) as a right-aligned 32 byte word. */
function writeUint24(target: Uint8Array, offset: number, value: number): void {
  target[offset + 29] = (value >>> 16) & 0xff;
  target[offset + 30] = (value >>> 8) & 0xff;
  target[offset + 31] = value & 0xff;
}

export function computeV4PoolId(key: PoolKeyShape): Hex {
  const encoded = new Uint8Array(160);
  writeAddress(encoded, 0, key.currency0);
  writeAddress(encoded, 32, key.currency1);
  writeUint24(encoded, 64, key.fee);
  writeUint24(encoded, 96, key.tickSpacing);
  writeAddress(encoded, 128, key.hooks);
  return keccak256(encoded);
}

function v4PoolLabel(fee: number): string {
  if (fee >= 0x800000) return 'dynamic fee';
  return `${fee / 10_000}%`;
}

export async function readV3PoolByAddress(address: Address): Promise<V3Pool | undefined> {
  try {
    const [token0Addr, token1Addr, fee, tickSpacing, slot0, liquidity] = await retryRpc(() =>
      Promise.all([
        publicClient.readContract({ address, abi: v3PoolAbi, functionName: 'token0' }),
        publicClient.readContract({ address, abi: v3PoolAbi, functionName: 'token1' }),
        publicClient.readContract({ address, abi: v3PoolAbi, functionName: 'fee' }),
        publicClient.readContract({ address, abi: v3PoolAbi, functionName: 'tickSpacing' }),
        publicClient.readContract({ address, abi: v3PoolAbi, functionName: 'slot0' }),
        publicClient.readContract({ address, abi: v3PoolAbi, functionName: 'liquidity' }),
      ]),
    );
    const [sqrt, tick] = slot0;
    const [token0, token1] = await Promise.all([getToken(token0Addr), getToken(token1Addr)]);
    return {
      version: 'v3',
      address,
      token0,
      token1,
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
      sqrtPriceX96: sqrt,
      tick: Number(tick),
      liquidity,
      price: sqrtRatioX96ToPrice(sqrt, token0.decimals, token1.decimals),
      label: `v3 ${fee / 10_000}%`,
    };
  } catch (err) {
    if (isRevertError(err)) {
      log.debug(`v3 pool read reverted ${address}`, err);
      return undefined;
    }
    throw err;
  }
}

export async function readV4PoolByKey(key: PoolKeyShape, token0: TokenInfo, token1: TokenInfo): Promise<V4Pool | undefined> {
  const poolId = computeV4PoolId(key);
  try {
    const [slot0, liquidity] = await retryRpc(() =>
      Promise.all([
        publicClient.readContract({
          address: CONTRACTS.v4StateView,
          abi: v4StateViewAbi,
          functionName: 'getSlot0',
          args: [poolId],
        }),
        publicClient.readContract({
          address: CONTRACTS.v4StateView,
          abi: v4StateViewAbi,
          functionName: 'getLiquidity',
          args: [poolId],
        }),
      ]),
    );
    const [sqrt, tick, , lpFee] = slot0;
    if (sqrt === 0n) return undefined;
    return {
      version: 'v4',
      poolId,
      key,
      token0,
      token1,
      fee: key.fee,
      lpFee: Number(lpFee),
      tickSpacing: key.tickSpacing,
      sqrtPriceX96: sqrt,
      tick: Number(tick),
      liquidity,
      price: sqrtRatioX96ToPrice(sqrt, token0.decimals, token1.decimals),
      label: `v4 ${v4PoolLabel(key.fee)}${key.hooks !== zeroAddress ? ' hooked' : ''}`,
    };
  } catch (err) {
    if (isRevertError(err)) {
      log.debug(`v4 pool read reverted ${poolId}`, err);
      return undefined;
    }
    throw err;
  }
}

/** Every initialized v3 pool for the pair, across standard fee tiers. */
async function findV3Pools(tokenA: Address, tokenB: Address): Promise<V3Pool[]> {
  let failures = 0;
  const results = await Promise.all(
    V3_FEE_TIERS.map(async (fee) => {
      try {
        const pool = await retryRpc(() =>
          publicClient.readContract({
            address: CONTRACTS.v3Factory,
            abi: v3FactoryAbi,
            functionName: 'getPool',
            args: [tokenA, tokenB, fee],
          }),
        );
        if (pool === zeroAddress) return undefined;
        return await readV3PoolByAddress(pool);
      } catch (err) {
        failures++;
        log.warn(`v3 probe failed for fee ${fee}`, err);
        return undefined;
      }
    }),
  );
  const pools = results.filter((p): p is V3Pool => Boolean(p));
  if (pools.length === 0 && failures > 0) {
    throw new Error('RPC failed while probing v3 pools (rate limited?)');
  }
  return pools;
}

/** Every initialized v4 pool for the pair among the candidate keys. */
async function findV4Pools(tokenA: Address, tokenB: Address): Promise<V4Pool[]> {
  const [currency0, currency1] = sortCurrencies(tokenA, tokenB);
  const [token0, token1] = await Promise.all([getToken(currency0), getToken(currency1)]);
  let failures = 0;
  const results = await Promise.all(
    V4_POOL_CANDIDATES.map(async (candidate) => {
      try {
        return await readV4PoolByKey(
          { currency0, currency1, fee: candidate.fee, tickSpacing: candidate.tickSpacing, hooks: zeroAddress },
          token0,
          token1,
        );
      } catch (err) {
        failures++;
        log.warn(`v4 probe failed for ${candidate.fee}/${candidate.tickSpacing}`, err);
        return undefined;
      }
    }),
  );
  const pools = results.filter((p): p is V4Pool => Boolean(p));
  if (pools.length === 0 && failures > 0) {
    throw new Error('RPC failed while probing v4 pools (rate limited?)');
  }
  return pools;
}

const poolCache = new Map<string, { ts: number; pools: Pool[]; deep: boolean }>();
const POOL_CACHE_TTL_MS = 30_000;

/**
 * All tradable v3 + v4 pools, deepest liquidity first.
 *
 * Pool-key scanning is RPC heavy, so results are cached briefly. Callers that
 * need current price/liquidity (before a mint) re-read with `refreshPool`.
 */
export async function findPools(
  tokenA: Address,
  tokenB: Address,
  options: { deep?: boolean } = {},
): Promise<Pool[]> {
  if (tokenA.toLowerCase() === tokenB.toLowerCase()) return [];
  const deep = options.deep ?? false;
  const cacheKey = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort().join(':');
  const cached = poolCache.get(cacheKey);
  if (cached) {
    if (Date.now() - cached.ts < POOL_CACHE_TTL_MS && (cached.deep || !deep)) return cached.pools;
    // Drop the expired entry so the cache cannot grow without bound.
    poolCache.delete(cacheKey);
  }

  const [v3, v4] = await Promise.all([findV3Pools(tokenA, tokenB), findV4Pools(tokenA, tokenB)]);

  // Standard key probing cannot guess launchpad fee tiers (5%, 4.4%) or custom
  // tick spacings, so always let the indexer list the pair. It is one cached
  // HTTP call and only the deepest unseen pools are read from the chain; a
  // probe alone would otherwise miss the deepest pool whenever a dust v3 pool
  // happens to exist for the same token.
  const discovered = await discoverViaIndexer(tokenA, tokenB);

  const seen = new Set<string>();
  const pools = [...v3, ...v4, ...discovered.pools].filter((pool) => {
    const key = pool.version === 'v3' ? pool.address.toLowerCase() : pool.poolId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  pools.sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0));
  poolCache.set(cacheKey, { ts: Date.now(), pools, deep });
  return pools;
}

/** Re-reads a pool to get its current price and liquidity. */
export async function refreshPool(pool: Pool): Promise<Pool | undefined> {
  return pool.version === 'v3'
    ? readV3PoolByAddress(pool.address)
    : readV4PoolByKey(pool.key, pool.token0, pool.token1);
}

/** Price of tokenIn denominated in tokenOut (human units). */
export function priceFromPool(pool: Pool, tokenIn: Address, tokenOut: Address): number {
  const inIsToken0 = pool.token0.address.toLowerCase() === tokenIn.toLowerCase();
  const outIsToken1 = pool.token1.address.toLowerCase() === tokenOut.toLowerCase();
  if (inIsToken0 && outIsToken1) return pool.price;
  if (!inIsToken0 && !outIsToken1) return 1 / pool.price;
  throw new Error('Pool does not match the requested pair');
}

/**
 * Rough USD value of the liquidity sitting in the active tick. That is the
 * capital actually earning fees right now, so it doubles as a depth measure.
 */
export function activeLiquidityUsd(pool: Pool, price0Usd: number, price1Usd: number): number {
  const amounts = positionAmounts({
    sqrtPriceX96: pool.sqrtPriceX96,
    tick: pool.tick,
    tickLower: -887272,
    tickUpper: 887272,
    liquidity: pool.liquidity,
  });
  const a0 = Number(amounts.amount0) / 10 ** pool.token0.decimals;
  const a1 = Number(amounts.amount1) / 10 ** pool.token1.decimals;
  const safe = (n: number) => (Number.isFinite(n) ? n : 0);
  return safe(a0 * price0Usd) + safe(a1 * price1Usd);
}
