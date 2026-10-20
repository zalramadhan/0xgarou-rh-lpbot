import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('gmgn');

const REQUEST_TIMEOUT_MS = 12_000;
/** GMGN's free plan allows a burst of 5 requests; stay well inside it. */
const MIN_REQUEST_GAP_MS = 250;

let lastRequestAt = 0;

export class GmgnError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'no_credentials'
      | 'unauthorized'
      | 'rate_limited'
      | 'not_found'
      | 'api_error'
      | 'network',
  ) {
    super(message);
    this.name = 'GmgnError';
  }
}

/** The windows GMGN can rank by. */
export type GmgnInterval = '1m' | '5m' | '1h' | '6h' | '24h';

export const GMGN_INTERVALS: readonly GmgnInterval[] = ['1m', '5m', '1h', '6h', '24h'];

/** The candle resolutions GMGN serves. */
export type GmgnResolution = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface GmgnTrendingToken {
  address: string;
  symbol: string;
  price: number;
  /** The price change over the requested window, in percent. */
  changePct: number;
  /** The traded volume over the window, in USD. */
  volumeUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  chain: string;
}

export interface GmgnCandle {
  /** The candle's open time, in milliseconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** The traded volume, in USD. */
  volume: number;
}

interface GmgnEnvelope {
  code: number;
  error?: string;
  message?: string;
  data?: { code?: number; message?: string; data?: unknown };
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A signed-out GMGN request.
 *
 * The market routes authenticate with the API key plus a `timestamp` and a
 * `client_id`; only the trading routes need the private key.
 */
async function gmgnGet<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const key = config.gmgnApiKey;
  if (!key) throw new GmgnError('No GMGN API key configured', 'no_credentials');

  const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const url = new URL(`${config.gmgnApiUrl.replace(/\/$/, '')}${path}`);
  url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
  url.searchParams.set('client_id', randomUUID());
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'X-APIKEY': key,
        accept: 'application/json',
        'User-Agent': '0xgarou-lp-bot',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GmgnError(`GMGN could not be reached: ${String(err).slice(0, 120)}`, 'network');
  }

  if (res.status === 401 || res.status === 403) {
    throw new GmgnError('GMGN rejected the API key', 'unauthorized');
  }
  if (res.status === 429) {
    throw new GmgnError('GMGN is rate limiting this IP', 'rate_limited');
  }
  if (!res.ok) {
    throw new GmgnError(`GMGN answered ${res.status}`, 'api_error');
  }

  const body = (await res.json()) as GmgnEnvelope;
  if (body.code !== 0) {
    // The API answers with its own error codes inside a 200.
    const reason =
      body.error === 'RATE_LIMIT_EXCEEDED' || body.error === 'RATE_LIMIT_BANNED'
        ? 'rate_limited'
        : 'api_error';
    throw new GmgnError(
      `GMGN refused the request: ${body.error || body.message || `code ${body.code}`}`,
      reason,
    );
  }
  const inner = body.data;
  if (!inner || inner.code !== 0 || inner.data === undefined) {
    throw new GmgnError(
      `GMGN returned no data: ${inner?.message || 'unknown error'}`,
      'api_error',
    );
  }
  return inner.data as T;
}

/** The trending tokens of a chain over a window, ranked by traded volume. */
export async function gmgnTrending(
  interval: GmgnInterval = '1h',
  options: { chain?: string; limit?: number } = {},
): Promise<GmgnTrendingToken[]> {
  const chain = options.chain ?? 'robinhood';
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));

  const data = await gmgnGet<{ rank?: GmgnRankRow[] }>('/v1/market/rank', {
    chain,
    interval,
    limit,
    // The list is ranked by the money that moved, not by the number of swaps.
    order_by: 'volume',
    direction: 'desc',
  });

  const rows = data.rank ?? [];
  const tokens = rows.map((row) => ({
    address: row.address ?? '',
    symbol: row.symbol || row.name || '???',
    price: number(row.price),
    changePct: changeFor(row, interval),
    volumeUsd: number(row.volume),
    liquidityUsd: number(row.liquidity),
    marketCapUsd: number(row.market_cap),
    chain: row.chain ?? chain,
  }));
  // The sort is done here as well: the screen says "ranked by volume", so the
  // order has to hold even when the API answers in its own order.
  return tokens.sort((a, b) => b.volumeUsd - a.volumeUsd);
}

interface GmgnRankRow {
  address?: string;
  symbol?: string;
  name?: string;
  chain?: string;
  price?: string;
  price_change_percent?: string;
  price_change_percent1m?: string;
  price_change_percent5m?: string;
  price_change_percent1h?: string;
  volume?: string;
  liquidity?: string;
  market_cap?: string;
}

/** The change over the requested window, falling back to the generic field. */
function changeFor(row: GmgnRankRow, interval: GmgnInterval): number {
  if (interval === '1m') return number(row.price_change_percent1m ?? row.price_change_percent);
  if (interval === '5m') return number(row.price_change_percent5m ?? row.price_change_percent);
  if (interval === '1h') return number(row.price_change_percent1h ?? row.price_change_percent);
  return number(row.price_change_percent);
}

/** The candles of a token over a time range. */
export async function gmgnKline(
  address: string,
  options: {
    chain?: string;
    resolution?: GmgnResolution;
    /** Unix milliseconds. */
    from?: number;
    to?: number;
  } = {},
): Promise<GmgnCandle[]> {
  const data = await gmgnGet<{ list?: GmgnCandleRow[] }>('/v1/market/token_kline', {
    chain: options.chain ?? 'robinhood',
    address,
    resolution: options.resolution ?? '1h',
    from: options.from,
    to: options.to,
  });

  return (data.list ?? []).map((row) => ({
    time: number(row.time),
    open: number(row.open),
    high: number(row.high),
    low: number(row.low),
    close: number(row.close),
    volume: number(row.volume),
  }));
}

interface GmgnCandleRow {
  time?: number;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  volume?: string;
}

/** True when a GMGN key is configured. */
export function hasGmgnKey(): boolean {
  return Boolean(config.gmgnApiKey);
}

/** A short description of what is configured, for the diagnostics. */
export function gmgnStatus(): string[] {
  return [
    `API key:     ${config.gmgnApiKey ? 'configured' : 'not set'}`,
    `Private key: ${config.gmgnPrivateKey ? 'configured' : 'not set'}`,
    `Base URL:    ${config.gmgnApiUrl}`,
  ];
}

/** Checks the key against the API and reports what works. */
export async function checkGmgnCredentials(): Promise<string[]> {
  const lines = gmgnStatus();
  if (!hasGmgnKey()) {
    lines.push('Nothing to test: add GMGN_API_KEY to .env (the key from gmgn.ai/ai).');
    return lines;
  }
  try {
    const tokens = await gmgnTrending('1h', { limit: 5 });
    lines.push(`Trending API: ok, ${tokens.length} token(s) for robinhood.`);
    for (const token of tokens.slice(0, 3)) {
      lines.push(`  ${token.symbol} ${token.changePct.toFixed(1)}% · vol $${Math.round(token.volumeUsd)}`);
    }
  } catch (err) {
    const reason = err instanceof GmgnError ? err.reason : 'error';
    lines.push(`Trending API: ${reason} — ${(err as Error).message}`);
  }
  return lines;
}

log.debug('GMGN client ready');
