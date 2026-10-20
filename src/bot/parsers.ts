/**
 * Pure parsers for the numeric automation settings, kept out of the bot
 * handlers so the accepted formats are easy to test.
 */

/** `12` → 12 cycles; `default` clears the per-position override. */
interface CycleLimit {
  /** Undefined means "follow the Settings default". */
  limit?: number;
  useDefault?: boolean;
  error?: string;
}

export function parseCycleLimit(input: string): CycleLimit {
  const raw = input.trim().toLowerCase();
  if (!raw) return { error: 'Send a cycle count between 1 and 99, or "default".' };
  if (['default', 'off', 'auto', 'reset'].includes(raw)) return { useDefault: true };
  const value = Number(raw.replace(/[x×\s]/g, ''));
  if (!Number.isInteger(value)) return { error: 'Send a whole number of cycles between 1 and 99.' };
  if (value < 1 || value > 99) return { error: 'Send a whole number of cycles between 1 and 99.' };
  return { limit: value };
}

/** Auto-TP target as a profit % over the cost basis. */
interface TpTarget {
  pct?: number;
  error?: string;
}

export function parseTpTarget(input: string): TpTarget {
  const value = Number(input.replace(/[%+,\s]/g, ''));
  if (!Number.isFinite(value)) return { error: 'Send a profit % such as 1 or 2.5.' };
  if (value <= 0) return { error: 'The auto-TP target must be above 0%.' };
  if (value > 10_000) return { error: 'The auto-TP target must stay at or below 10000%.' };
  return { pct: value };
}
