import type { Address } from 'viem';
import { TOKENS } from '../constants/chain.js';
import { findPools, priceFromPool } from './pools.js';
import { normalizeAddress } from './tokens.js';
import { createLogger } from '../logger.js';

const log = createLogger('prices');

/**
 * How long a price is kept. A token's price moves slowly compared to a
 * scan, and the price of a stable pair moves slower still, so a short cache
 * only causes needless lookups (each one probes the chain).
 */
const TTL_MS = 120_000;
const cache = new Map<string, { price: number; ts: number }>();
const inflight = new Map<string, Promise<number>>();

const USDG = normalizeAddress(TOKENS.USDG);
const WETH = normalizeAddress(TOKENS.WETH);

async function directPrice(token: Address, quote: Address): Promise<number | undefined> {
  const pools = await findPools(token, quote);
  if (pools.length === 0) return undefined;
  const pool = pools[0]!;
  try {
    return priceFromPool(pool, token, quote);
  } catch {
    return undefined;
  }
}

/**
 * USDG price of one whole token.
 *
 * USDG is the chain's anchor stablecoin, so it doubles as the USD unit. Direct
 * token/USDG pools are preferred; otherwise we route through WETH. Returns NaN
 * when no pool exists — callers must show "—" rather than a made-up number.
 */
export async function usdPrice(token: Address | string): Promise<number> {
  const addr = normalizeAddress(token);
  if (addr.toLowerCase() === USDG.toLowerCase()) return 1;

  const cached = cache.get(addr.toLowerCase());
  if (cached) {
    if (Date.now() - cached.ts < TTL_MS) return cached.price;
    // Drop the expired entry so the cache cannot grow without bound.
    cache.delete(addr.toLowerCase());
  }

  const key = addr.toLowerCase();
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    let price = await directPrice(addr, USDG);

    if (price === undefined && addr.toLowerCase() !== WETH.toLowerCase()) {
      const toWeth = await directPrice(addr, WETH);
      const wethUsd = await directPrice(WETH, USDG);
      if (toWeth !== undefined && wethUsd !== undefined) price = toWeth * wethUsd;
    }

    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      log.warn(`no USDG route for ${addr}`);
      return Number.NaN;
    }
    cache.set(key, { price, ts: Date.now() });
    return price;
  })().finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

/** USD value of a raw token amount. */