import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { sleep } from '../utils/async.js';

const log = createLogger('indexer');

export interface IndexerPool {
  /** v4 pool id (32 bytes) or v3 pool address. */
  address: string;
  dex: string;
  baseToken: string;
  quoteToken: string;
  feePct?: number;
  reserveUsd: number;
  volume24hUsd: number;
  /** USD price of `baseToken` as reported by the indexer. */
  basePriceUsd: number;
  /** Fully diluted valuation of `baseToken`, NaN when the indexer has none. */
  baseFdvUsd: number;
  name: string;
}

const cache = new Map<string, { ts: number; pools: IndexerPool[] }>();
/**
 * The listing changes slowly — a token's pools come and go with its launch —
 * and the public API has a small rate limit, so a short cache would only
 * cause 429s.
 */
const TTL_MS = 120_000;
/** The listing is not liquidity-ordered, so page past the dust pools. */
const INDEXER_MAX_PAGES = 3;
/** Do not hammer a failing/rate-limited listing; retry sooner than a real result. */
const FAILURE_TTL_MS = 60_000;

interface GeckoPool {
  id?: string;
  attributes?: {
    address?: string;
    name?: string;
    pool_fee_percentage?: string | null;
    reserve_in_usd?: string | null;
    volume_usd?: { h24?: string | null } | null;
    base_token_price_usd?: string | null;
    fdv_usd?: string | null;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } | null };
  };
}

function tokenAddress(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const parts = id.split('_');
  return parts[1]?.toLowerCase();
}

/**
 * The token-pools listing omits `pool_fee_percentage` but always renders the
 * fee in the display name ("RAETO / USDG 5%"). Without it a v4 pool key with
 * an exotic fee tier cannot be rebuilt, so read both sources.
 */
export function parseFeePct(raw: string | null | undefined, name: string | undefined): number | undefined {
  const direct = raw === undefined || raw === null ? Number.NaN : Number(raw);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const match = /(\d+(?:\.\d+)?)\s*%\s*$/.exec(name ?? '');
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * One page of the token-pools listing.
 *
 * A page that fails is simply missing: the other pages still have their
 * pools, and a failed page must not hold up the whole listing.
 */
async function fetchIndexPage(base: string, key: string, page: number): Promise<GeckoPool[] | undefined> {
  try {
    let res = await fetchPage(base, key, page);
    if (res.status === 429) {
      // The public API is rate limited; one short retry usually clears it.
      await sleep(700);
      res = await fetchPage(base, key, page);
    }
    if (!res.ok) {
      log.warn(`indexer responded ${res.status} on page ${page}`);
      return undefined;
    }
    const body = (await res.json()) as { data?: GeckoPool[] };
    return body.data ?? [];
  } catch (err) {
    log.warn(`indexer unavailable on page ${page}`, err);
    return undefined;
  }
}

/**
 * Lists a token's pools from GeckoTerminal, which indexes the chain's
 * launchpad pools. It is only used for discovery: the returned pool ids are
 * turned into real Uniswap pool keys locally, and every pool is re-read from
 * the chain before use.
 */
export async function fetchIndexerPools(
  token: string,
  options: { maxPages?: number } = {},
): Promise<IndexerPool[]> {
  if (!config.enableIndexer) return [];
  const key = token.toLowerCase();
  const maxPages = Math.max(1, Math.min(INDEXER_MAX_PAGES, options.maxPages ?? INDEXER_MAX_PAGES));
  const hit = cache.get(key);
  if (hit) {
    if (Date.now() - hit.ts < TTL_MS) return hit.pools;
    // Drop the expired entry so the cache cannot grow without bound.
    cache.delete(key);
  }

  const base = config.indexerUrl.replace(/\/$/, '');
  const pools: IndexerPool[] = [];

  // The indexer does not order pools by liquidity, so the deepest pool for a
  // token can sit on a later page. A few pages cover tokens with many dust
  // pools (launchpads create one per fee/bundle) without hammering the API.
  //
  // The first page is fetched on its own — it holds the deepest pools — and
  // the rest follow in parallel: three sequential pages cost three round
  // trips, and the public API is slow enough for that to be the difference
  // between a snappy scan and a slow one.
  const first = await fetchIndexPage(base, key, 1);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, maxPages - 1) }, (_, index) => fetchIndexPage(base, key, index + 2)),
  );
  const pages = [first, ...rest].filter((page): page is GeckoPool[] => page !== undefined);

  if (pages.length === 0) {
    // Every page failed: remember it for a moment, so the next scan does not
    // hammer an API that is already rate limiting us.
    cache.set(key, { ts: Date.now() - TTL_MS + FAILURE_TTL_MS, pools: [] });
    return pools;
  }

  for (const page of pages) {
    if (!page) continue;
    for (const entry of page) {
      const address = entry.attributes?.address;
      const baseToken = tokenAddress(entry.relationships?.base_token?.data?.id);
      const quoteToken = tokenAddress(entry.relationships?.quote_token?.data?.id);
      const dex = entry.relationships?.dex?.data?.id ?? '';
      if (!address || !baseToken || !quoteToken) continue;
      if (pools.some((p) => p.address === address.toLowerCase())) continue;
      const feePct = parseFeePct(entry.attributes?.pool_fee_percentage, entry.attributes?.name);
      pools.push({
        address: address.toLowerCase(),
        dex,
        baseToken,
        quoteToken,
        feePct: Number.isFinite(feePct) ? feePct : undefined,
        reserveUsd: Number(entry.attributes?.reserve_in_usd ?? 0),
        volume24hUsd: Number(entry.attributes?.volume_usd?.h24 ?? 0),
        basePriceUsd: Number(entry.attributes?.base_token_price_usd ?? Number.NaN),
        baseFdvUsd: Number(entry.attributes?.fdv_usd ?? Number.NaN),
        name: entry.attributes?.name ?? '',
      });
    }
  }

  if (pools.length === 0) return pools;
  pools.sort((a, b) => b.reserveUsd - a.reserveUsd);
  cache.set(key, { ts: Date.now(), pools });
  return pools;
}

function fetchPage(base: string, token: string, page: number): Promise<Response> {
  return fetch(`${base}/networks/robinhood/tokens/${token}/pools?page=${page}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(6_000),
  });
}
