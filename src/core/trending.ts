import { config } from '../config.js';
import { gmgnTrending, type GmgnTrendingToken } from './gmgn.js';
import { createLogger } from '../logger.js';

const log = createLogger('trending');

/** The time windows the trending list can be shown for. */
export type TrendingWindow = '5m' | '1h' | '6h' | '24h';

export const TRENDING_WINDOWS: readonly TrendingWindow[] = ['5m', '1h', '6h', '24h'];

export const DEFAULT_TRENDING_WINDOW: TrendingWindow = '1h';

/** How many tokens the trending list holds. The screen shows the top ten. */
export const TRENDING_LIMIT = 10;

/** The chain the trending list is about. */
export const TRENDING_CHAIN = 'robinhood';

export interface TrendingToken {
  /** The traded token's contract address. */
  address: string;
  symbol: string;
  /** The pool it trades in, "SYMBOL / QUOTE". */
  poolName: string;
  priceUsd: number;
  /** The price change over the window, in percent. */
  changePct: number;
  /** The traded volume over the window, in USD. */
  volumeUsd: number;
  /** The pool's liquidity, in USD. */
  liquidityUsd: number;
  marketCapUsd: number;
  poolAddress: string;
}

interface GeckoAttributes {
  name?: string;
  address?: string;
  base_token_price_usd?: string;
  price_change_percentage?: Record<string, string>;
  volume_usd?: Record<string, string>;
  reserve_in_usd?: string;
  market_cap_usd?: string;
}

interface GeckoPool {
  id?: string;
  attributes?: GeckoAttributes;
  relationships?: { base_token?: { data?: { id?: string } } };
}

/** The upstream API is rate limited, so a list is kept for a minute. */
const CACHE_TTL_MS = 60_000;
const cache = new Map<TrendingWindow, { ts: number; tokens: TrendingToken[] }>();

const number = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/** "robinhood_0xabc…" → "0xabc…" */
function tokenAddressOf(id: string | undefined): string {
  if (!id) return '';
  const index = id.indexOf('_');
  return index >= 0 ? id.slice(index + 1) : id;
}

/**
 * The window the API is asked for and the key the same window comes back
 * under: the query parameter says `1h`, the response says `h1`.
 */
const WINDOW_KEY: Record<TrendingWindow, string> = {
  '5m': 'm5',
  '1h': 'h1',
  '6h': 'h6',
  '24h': 'h24',
};

/** The volume a token traded; a missing number counts as zero. */
function volumeOf(token: TrendingToken): number {
  return Number.isFinite(token.volumeUsd) ? token.volumeUsd : 0;
}

/**
 * The list the screen shows: the most traded volume first, ten tokens at
 * most. The order is set here as well as in the request, so the list reads
 * the same whichever source answered.
 */
export function sortByVolume(tokens: TrendingToken[]): TrendingToken[] {
  return tokens.sort((a, b) => volumeOf(b) - volumeOf(a)).slice(0, TRENDING_LIMIT);
}

/**
 * The trending tokens of the chain over a window.
 *
 * GMGN is the primary source: it ranks the whole chain by traded volume and
 * knows each token's price, change, volume, liquidity and market cap. The
 * GeckoTerminal list is the fallback for when no GMGN key is configured or
 * the API cannot be reached.
 */
export async function trendingTokens(
  window: TrendingWindow = DEFAULT_TRENDING_WINDOW,
): Promise<TrendingToken[]> {
  const gmgn = await gmgnTrending(window, { chain: TRENDING_CHAIN, limit: TRENDING_LIMIT }).catch((err) => {
    log.warn(`GMGN trending unavailable: ${String(err).slice(0, 120)}`);
    return [] as GmgnTrendingToken[];
  });
  if (gmgn.length > 0) {
    return sortByVolume(
      gmgn.map((token) => ({
        address: token.address,
        symbol: token.symbol,
        poolName: token.symbol,
        priceUsd: token.price,
        changePct: token.changePct,
        volumeUsd: token.volumeUsd,
        liquidityUsd: token.liquidityUsd,
        marketCapUsd: token.marketCapUsd,
        poolAddress: '',
      })),
    );
  }

  const base = (config.indexerUrl ?? 'https://api.geckoterminal.com/api/v2').replace(/\/$/, '');
  const url = `${base}/networks/${TRENDING_CHAIN}/trending_pools?page=1&duration=${window}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (res.status === 429) {
    throw new Error('The trending API is rate limited — try again in a minute.');
  }
  if (!res.ok) throw new Error(`trending request failed (${res.status})`);
  const body = (await res.json()) as { data?: GeckoPool[] };

  const tokens = (body.data ?? [])
    .map((pool): TrendingToken | undefined => {
      const attributes = pool.attributes;
      const address = tokenAddressOf(pool.relationships?.base_token?.data?.id);
      if (!attributes || !address) return undefined;
      const name = attributes.name ?? '';
      const symbol = name.split('/')[0]?.trim() ?? '';
      const key = WINDOW_KEY[window];
      const change = number(attributes.price_change_percentage?.[key]);
      return {
        address,
        symbol: symbol || '???',
        poolName: name,
        priceUsd: number(attributes.base_token_price_usd),
        changePct: change,
        volumeUsd: number(attributes.volume_usd?.[key]),
        liquidityUsd: number(attributes.reserve_in_usd),
        marketCapUsd: number(attributes.market_cap_usd),
        poolAddress: attributes.address ?? '',
      };
    })
    .filter((token): token is TrendingToken => Boolean(token));
  return sortByVolume(tokens);
}

/**
 * The trending list, or an empty list when the source is unavailable.
 *
 * The upstream API is rate limited, so a list is kept for a minute and a
 * failed request keeps the previous list on screen.
 */
export async function safeTrendingTokens(
  window: TrendingWindow = DEFAULT_TRENDING_WINDOW,
): Promise<TrendingToken[]> {
  const cached = cache.get(window);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.tokens;
  try {
    const tokens = await trendingTokens(window);
    cache.set(window, { ts: Date.now(), tokens });
    return tokens;
  } catch (err) {
    log.warn(`trending list unavailable: ${String(err)}`);
    // A stale list beats an empty screen.
    if (cached) return cached.tokens;
    return [];
  }
}
