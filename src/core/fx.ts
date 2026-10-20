import { createLogger } from '../logger.js';

const log = createLogger('fx');

const TTL_MS = 60 * 60_000;
const ENDPOINT = 'https://open.er-api.com/v6/latest/USD';

interface FxRates {
  /** IDR per USD. */
  idr: number;
  /** USD per SOL. */
  sol: number;
}

let cached: { rates: FxRates; ts: number } | undefined;
let inflight: Promise<FxRates> | undefined;

/**
 * USD → IDR and USD → SOL rates, cached for an hour. Returns NaN for a rate
 * that was never fetched — callers must show "—" rather than guess.
 * The rates are frozen into every closed record, so history never moves.
 */
async function fetchRates(): Promise<FxRates> {
  try {
    const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) throw new Error(`fx responded ${res.status}`);
    const body = (await res.json()) as { rates?: Record<string, unknown> };
    const idr = Number(body.rates?.IDR);
    if (!Number.isFinite(idr) || idr <= 0) throw new Error('fx returned no IDR rate');
    // The API quotes one USD in the other currency, so SOL per USD is the
    // inverse of the USD price of one SOL.
    const solPerUsd = Number(body.rates?.SOL);
    const sol = Number.isFinite(solPerUsd) && solPerUsd > 0 ? 1 / solPerUsd : Number.NaN;
    cached = { rates: { idr, sol }, ts: Date.now() };
    return cached.rates;
  } catch (err) {
    log.warn(`FX rates unavailable: ${String(err)}`);
    return cached?.rates ?? { idr: Number.NaN, sol: Number.NaN };
  }
}

async function rates(): Promise<FxRates> {
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.rates;
  if (inflight) return inflight;

  const promise = fetchRates();
  inflight = promise;
  try {
    return await promise;
  } finally {
    if (inflight === promise) inflight = undefined;
  }
}

/** USD → IDR rate, cached for an hour. */
export async function usdIdrRate(): Promise<number> {
  return (await rates()).idr;
}

/** USD price of one SOL, cached for an hour. */
export async function usdSolRate(): Promise<number> {
  return (await rates()).sol;
}

export function idrValue(usd: number, rate: number): number {
  if (!Number.isFinite(usd) || !Number.isFinite(rate)) return Number.NaN;
  return usd * rate;
}

/** "Rp 1.234.567" — Indonesian grouping, rounded to whole rupiah. */
export function fmtIdr(usd: number, rate: number): string {
  const value = idrValue(usd, rate);
  if (!Number.isFinite(value)) return 'Rp —';
  return formatIdrValue(value);
}

/**
 * "Rp 1.234.567" — an amount that is already in rupiah.
 *
 * The card and the bot use the same grouping, so a number never looks
 * different in two places.
 */
export function formatIdrValue(value: number): string {
  if (!Number.isFinite(value)) return 'Rp —';
  const sign = value < 0 ? '-' : '';
  return `${sign}Rp ${Math.round(Math.abs(value)).toLocaleString('id-ID')}`;
}
