/**
 * The calendar's rules.
 */

/**
 * The smallest PnL that is worth a row of its own, in USD.
 *
 * A close whose PnL is a fraction of a cent — a dry-run, a rounding dust —
 * says nothing, and it must not count as a loss either: the day would show
 * "1/6 wins" when two of the six ever happened.
 */
export const MIN_CALENDAR_ROW_PNL_USD = 0.1;
