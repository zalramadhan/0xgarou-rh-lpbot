/**
 * The dust rule.
 */

/**
 * The smallest PnL that is worth showing, in USD.
 *
 * A close whose PnL is a fraction of a cent — a dry-run, a rounding dust —
 * says nothing, and it must not count as a loss either: the day would show
 * "1/6 wins" when two of the six ever happened.
 */
export const MIN_DUST_PNL_USD = 0.1;

/** True when a close is worth a row of its own. */
export function isDust(pnlUsd: number): boolean {
  if (!Number.isFinite(pnlUsd)) return false;
  return Math.abs(pnlUsd) < MIN_DUST_PNL_USD;
}
