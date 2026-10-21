/**
 * How far below the market a swap route may be priced.
 *
 * The price impact is what the route costs against the market: a route that is
 * 2% under the market hands over 2% of the position. On a $55 position that is
 * $1.10 — more than the gas of swapping it by hand, so above the limit the
 * tokens stay in the wallet and the user decides.
 *
 * The default is 2%. A token with a v3 pool can also be swapped through it,
 * where the impact is only the pool's own fee.
 */
export const DEFAULT_MAX_ROUTE_DISCOUNT_PCT = 2;

/** The values offered in the settings. */
export const ROUTE_DISCOUNT_CHOICES: readonly number[] = [1, 2, 3, 5];

/** The largest limit that is accepted. */
export const MAX_ROUTE_DISCOUNT_PCT = 25;

/** Keeps the limit a sane percentage. */
export function normalizeRouteDiscount(value: unknown): number {
  const pct = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(pct) || pct <= 0) return DEFAULT_MAX_ROUTE_DISCOUNT_PCT;
  return Math.min(MAX_ROUTE_DISCOUNT_PCT, Math.round(pct * 100) / 100);
}
