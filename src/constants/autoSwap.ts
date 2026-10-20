/**
 * The smallest amount worth swapping into USDG after a close.
 *
 * A swap costs gas, so swapping a few cents of leftovers is a net loss. The
 * default is $0.30; the user can raise or lower it in the settings.
 */
export const DEFAULT_AUTO_SWAP_MIN_USD = 0.3;

/** The values offered in the settings. */
export const AUTO_SWAP_MIN_CHOICES: readonly number[] = [0.3, 1, 5, 10, 25, 100];

/** The largest threshold that is accepted. */
export const MAX_AUTO_SWAP_MIN_USD = 10_000;

/** Keeps the threshold a sane, non-negative USD amount. */
export function normalizeAutoSwapMin(value: unknown): number {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0) return DEFAULT_AUTO_SWAP_MIN_USD;
  return Math.min(MAX_AUTO_SWAP_MIN_USD, Math.round(amount * 100) / 100);
}
