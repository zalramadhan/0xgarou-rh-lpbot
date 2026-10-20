/** Bid Ask ladder limits shared by the store, the UI and the planner. */
export const BID_ASK_MIN_ENTRIES = 4;
export const BID_ASK_MAX_ENTRIES = 10;
export const BID_ASK_DEFAULT_ENTRIES = 5;

/** The values offered in Settings → Bid Ask → Number of entries. */
export const BID_ASK_ENTRY_CHOICES = [4, 5, 6, 7, 8, 9, 10] as const;

export function normalizeBidAskEntries(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) return BID_ASK_DEFAULT_ENTRIES;
  return Math.max(BID_ASK_MIN_ENTRIES, Math.min(BID_ASK_MAX_ENTRIES, n));
}

export function isValidBidAskEntries(value: number): boolean {
  return Number.isInteger(value) && value >= BID_ASK_MIN_ENTRIES && value <= BID_ASK_MAX_ENTRIES;
}
