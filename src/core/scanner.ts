import { zeroAddress, type Address, type Hex } from 'viem';
import { isDynamicFee } from '../constants/chain.js';
import { createLogger } from '../logger.js';
import { fetchIndexerPools, type IndexerPool } from './indexer.js';
import { recoverV4Key, recoverV4Keys } from './discovery.js';
import {
  activeLiquidityUsd,
  findPools,
  readV3PoolByAddress,
  readV4PoolByKey,
  type Pool,
  type PoolKeyShape,
} from './pools.js';
import { usdPrice } from './prices.js';
import { getToken, type TokenInfo } from './tokens.js';
import { errorMessage } from '../utils/errors.js';
import { mapLimit } from '../utils/async.js';

const log = createLogger('scanner');

/** Health thresholds for a pool, in USD and in % away from the market price. */
const BLOCKED_TVL_USD = 150;
const WARN_TVL_USD = 1_000;
const BROKEN_DEVIATION_PCT = 20;
const WARN_DEVIATION_PCT = 5;
/** Deepest pools are read first; the rest are dust and would only slow the scan. */
const MAX_SCAN_POOLS = 15;

/** A scan costs dozens of RPC calls; the result is reused for a minute. */
const SCAN_TTL_MS = 60_000;
const MAX_SCANS = 20;
const scanCache = new Map<string, { ts: number; scan: TokenScan }>();

export type PoolHealth = 'ok' | 'warn' | 'blocked' | 'broken';

export interface ScannedPool {
  pool: Pool;
  tvlUsd: number;
  volume24hUsd: number;
  /** Fee APR estimated from 24h volume, NaN when the inputs are unknown. */
  aprPct: number;
  /** USD price of the pasted token according to this pool. */
  priceUsd: number;
  /** Percent difference of `priceUsd` from the reference price. */
  deviationPct: number;
  health: PoolHealth;
}

export interface TokenScan {
  token: TokenInfo;
  pools: ScannedPool[];
  /** Number of pools the indexer listed, before the ones we can address. */
  listed: number;
  totalTvlUsd: number;
  /** Token market cap (FDV) from the indexer, NaN when unknown. */
  marketCapUsd: number;
  /** totalTvlUsd / marketCapUsd — how much of the token is in Uniswap. */
  tvlToMcap: number;
  referencePriceUsd: number;
}

function isSame(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function poolKeyOf(pool: Pool): string {
  return pool.version === 'v3' ? pool.address.toLowerCase() : pool.poolId.toLowerCase();
}

/** Rebuilds one indexer listing entry into a real, chain-verified pool. */
async function readCandidate(
  entry: IndexerPool,
  token: TokenInfo,
  v4Keys?: Map<string, PoolKeyShape>,
): Promise<Pool | undefined> {
  if (entry.address.length === 66) {
    const other = isSame(entry.baseToken, token.address) ? entry.quoteToken : entry.baseToken;
    if (isSame(other, token.address)) return undefined;
    // The keys of the whole list are recovered in one sweep. The single
    // recovery is the complete (and slow) fallback, so it only runs for a
    // pool whose pair was not swept at all.
    const key =
      v4Keys?.get(entry.address.toLowerCase()) ??
      (v4Keys?.size === 0
        ? recoverV4Key(token.address, other as Address, entry.address as Hex, entry.feePct)
        : undefined);
    if (!key) return undefined;    // Native-ETH v4 pools are read-only for this bot (it only wraps WETH).
    if (key.currency0 === zeroAddress || key.currency1 === zeroAddress) return undefined;
    const [token0, token1] = await Promise.all([getToken(key.currency0), getToken(key.currency1)]);
    return readV4PoolByKey(key, token0, token1);
  }
  if (entry.address.length === 42) {
    const pool = await readV3PoolByAddress(entry.address as Address);
    if (!pool) return undefined;
    const involvesToken =
      isSame(pool.token0.address, token.address) || isSame(pool.token1.address, token.address);
    return involvesToken ? pool : undefined;
  }
  return undefined;
}

/** Token price in USD according to a pool, NaN when the other side has no price. */
async function priceFromPool(pool: Pool, token: TokenInfo): Promise<number> {
  const isToken0 = isSame(pool.token0.address, token.address);
  const quote = isToken0 ? pool.token1 : pool.token0;
  const quoted = isToken0 ? pool.price : 1 / pool.price;
  const quoteUsd = await usdPrice(quote.address);
  return Number.isFinite(quoteUsd) && quoteUsd > 0 ? quoted * quoteUsd : Number.NaN;
}

function feeFraction(pool: Pool): number {
  const raw = pool.version === 'v3' ? pool.fee : pool.lpFee;
  // A dynamic fee is unknown up front.
  if (isDynamicFee(raw)) return Number.NaN;
  return raw / 1_000_000;
}

function healthOf(tvlUsd: number, deviationPct: number): PoolHealth {
  if (Number.isFinite(deviationPct) && Math.abs(deviationPct) > BROKEN_DEVIATION_PCT) return 'broken';
  if (tvlUsd < BLOCKED_TVL_USD) return 'blocked';
  if (tvlUsd < WARN_TVL_USD) return 'warn';
  if (Number.isFinite(deviationPct) && Math.abs(deviationPct) > WARN_DEVIATION_PCT) return 'warn';
  return 'ok';
}

/**
 * Full scan for a token: every Uniswap v3/v4 pool it trades in, priced,
 * measured and graded. Pool keys that the local probe cannot guess are
 * recovered from the indexer listing, then every pool is re-read on chain.
 */
export async function scanToken(token: TokenInfo): Promise<TokenScan> {
  const cached = scanCache.get(token.address.toLowerCase());
  if (cached && Date.now() - cached.ts < SCAN_TTL_MS) return cached.scan;

  const scan = await runScan(token);
  scanCache.set(token.address.toLowerCase(), { ts: Date.now(), scan });
  if (scanCache.size > MAX_SCANS) {
    const oldest = scanCache.keys().next().value;
    if (oldest) scanCache.delete(oldest);
  }
  return scan;
}

async function runScan(token: TokenInfo): Promise<TokenScan> {
  const listed = await fetchIndexerPools(token.address);
  const uniswapPools = listed.filter((entry) => entry.dex.includes('uniswap'));
  const uniswap = uniswapPools.slice(0, MAX_SCAN_POOLS);

  const pools: Pool[] = [];
  if (uniswap.length > 0) {
    // The v4 pool ids of a token are recovered in **one sweep per pair**:
    // the guess (fee, tick spacing) is the same for every pool of a pair, so
    // paying for it per pool is what made a scan slow.
    const v4Entries = uniswap.filter((entry) => entry.address.length === 66);
    const groups = new Map<string, { poolId: Hex; feePct?: number }[]>();
    for (const entry of v4Entries) {
      const other =
        entry.baseToken.toLowerCase() === token.address.toLowerCase() ? entry.quoteToken : entry.baseToken;
      const list = groups.get(other.toLowerCase()) ?? [];
      list.push({ poolId: entry.address as Hex, feePct: entry.feePct });
      groups.set(other.toLowerCase(), list);
    }
    const v4Keys = new Map<string, PoolKeyShape>();
    for (const [other, list] of groups) {
      for (const [id, key] of recoverV4Keys(token.address, other as Address, list)) {
        v4Keys.set(id, key);
      }
    }

    // The candidate pools are independent, so they are read in parallel; the
    // RPC gate in `chain/client.ts` keeps the burst within the provider's
    // limits.
    const found = await Promise.all(
      uniswap.map(async (entry) => {
        try {
          return await readCandidate(entry, token, v4Keys);
        } catch (err) {
          log.warn(`could not read pool ${entry.address}: ${errorMessage(err)}`);
          return undefined;
        }
      }),
    );
    for (const pool of found) if (pool) pools.push(pool);
  } else {
    // Indexer disabled or unreachable: fall back to direct probing of the
    // quote pairs the bot can price. The quotes are independent, so they are
    // probed in parallel.
    const quotes = await quoteAddresses(token);
    const probed = await Promise.all(quotes.map((quote) => findPools(token.address, quote)));
    for (const found of probed) pools.push(...found);
  }

  const stats = new Map<string, IndexerPool>();
  for (const entry of listed) stats.set(entry.address.toLowerCase(), entry);

  // The pool prices are independent of each other, so they are read in
  // parallel: one slow price feed must not delay the whole scan.
  const priceList = await mapLimit(pools, 6, (pool) => priceFromPool(pool, token));
  const prices = new Map<string, number>();
  pools.forEach((pool, index) => prices.set(poolKeyOf(pool), priceList[index] ?? Number.NaN));
  // The deepest pool is the best available reference for "the market price".
  let referencePriceUsd = Number.NaN;
  let deepestTvl = -1;
  for (const pool of pools) {
    const entry = stats.get(poolKeyOf(pool));
    const tvl = entry?.reserveUsd ?? 0;
    const price = prices.get(poolKeyOf(pool)) ?? Number.NaN;
    if (Number.isFinite(price) && tvl > deepestTvl) {
      deepestTvl = tvl;
      referencePriceUsd = price;
    }
  }

  // A pool the indexer has no TVL for is measured from its own liquidity.
  const depths = await mapLimit(pools, 6, async (pool) => {
    const entry = stats.get(poolKeyOf(pool));
    const tvl = entry?.reserveUsd ?? 0;
    if (tvl > 0) return tvl;
    // The traded token's price is already known from the pool, so only the
    // quote has to be looked up — and USDG is one dollar, which keeps this
    // from probing the chain a second time.
    const isToken0 = isSame(pool.token0.address, token.address);
    const tradedUsd = prices.get(poolKeyOf(pool)) ?? Number.NaN;
    const quoteUsd = await usdPrice((isToken0 ? pool.token1 : pool.token0).address);
    const p0 = isToken0 ? tradedUsd : quoteUsd;
    const p1 = isToken0 ? quoteUsd : tradedUsd;
    const depth = Number.isFinite(p0) && Number.isFinite(p1) ? activeLiquidityUsd(pool, p0, p1) : 0;
    return Number.isFinite(depth) ? depth : 0;
  });

  const scanned: ScannedPool[] = [];
  let totalTvlUsd = 0;
  pools.forEach((pool, index) => {
    const entry = stats.get(poolKeyOf(pool));
    const priceUsd = prices.get(poolKeyOf(pool)) ?? Number.NaN;
    const tvlUsd = depths[index] ?? 0;
    const volume24hUsd = entry?.volume24hUsd ?? 0;
    const fee = feeFraction(pool);
    const aprPct =
      Number.isFinite(fee) && tvlUsd > 0 && volume24hUsd > 0
        ? ((volume24hUsd * fee) / tvlUsd) * 365 * 100
        : Number.NaN;
    const deviationPct =
      Number.isFinite(referencePriceUsd) && referencePriceUsd > 0 && Number.isFinite(priceUsd)
        ? (priceUsd / referencePriceUsd - 1) * 100
        : Number.NaN;

    totalTvlUsd += tvlUsd;
    scanned.push({
      pool,
      tvlUsd,
      volume24hUsd,
      aprPct,
      priceUsd,
      deviationPct,
      health: healthOf(tvlUsd, deviationPct),
    });
  });

  scanned.sort((a, b) => b.tvlUsd - a.tvlUsd);

  const marketCapUsd = marketCapOf(listed, token);
  return {
    token,
    pools: scanned,
    listed: uniswapPools.length,
    totalTvlUsd,
    marketCapUsd,
    tvlToMcap: marketCapUsd > 0 ? totalTvlUsd / marketCapUsd : Number.NaN,
    referencePriceUsd,
  };
}

async function quoteAddresses(token: TokenInfo): Promise<Address[]> {
  const { TOKENS } = await import('../constants/chain.js');
  return [TOKENS.USDG, TOKENS.WETH]
    .map((q) => q as Address)
    .filter((q) => !isSame(q, token.address));
}

/**
 * FDV for the scanned token. The listing reports it per pool as the FDV of the
 * base token, so take the deepest pool where our token is the base side.
 */
function marketCapOf(listed: IndexerPool[], token: TokenInfo): number {
  const sorted = [...listed]
    .filter((entry) => isSame(entry.baseToken, token.address))
    .sort((a, b) => b.reserveUsd - a.reserveUsd);
  for (const entry of sorted) {
    if (Number.isFinite(entry.baseFdvUsd) && entry.baseFdvUsd > 0) return entry.baseFdvUsd;
  }
  return Number.NaN;
}

/** The market cap of a token, cached for a minute. */
const marketCapCache = new Map<string, { ts: number; value: number }>();
const MARKET_CAP_TTL_MS = 60_000;

/**
 * FDV of a single token, using the same listing and the same calculation as
 * the pool scan. NaN when the indexer has no FDV for it.
 *
 * The FDV is a property of the token, not of the pool, so the first page that
 * has one is enough: the deep pool of a launchpad token can sit on page three
 * and paging for it would cost seconds on every screen. The value is cached
 * and refreshed in the background, so a screen is never held up by it.
 */
export async function marketCapUsd(token: TokenInfo): Promise<number> {
  const key = token.address.toLowerCase();
  const hit = marketCapCache.get(key);
  if (hit) {
    // Serve the cached number and refresh in the background.
    if (Date.now() - hit.ts > MARKET_CAP_TTL_MS) void refreshMarketCap(key, token).catch(() => undefined);
    return hit.value;
  }
  return refreshMarketCap(key, token);
}

/** Fetches the FDV and keeps it for a minute. */
async function refreshMarketCap(key: string, token: TokenInfo): Promise<number> {
  const listed = await fetchIndexerPools(token.address, { maxPages: 1 });
  const value = marketCapOf(listed, token);
  marketCapCache.set(key, { ts: Date.now(), value });
  return value;
}
