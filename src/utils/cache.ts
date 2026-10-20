/**
 * A tiny time-to-live cache.
 *
 * Entries expire on their own after `ttlMs`, so a stale value is never served
 * for long, and they can be dropped by hand when a fresh read is wanted.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { at: number; value: T }>();

  constructor(private readonly ttlMs: number) {}

  /** The cached value, or undefined when it is missing or expired. */
  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Stores a value, stamped with the time it was written. */
  set(key: string, value: T, now = Date.now()): void {
    this.entries.set(key, { at: now, value });
  }

  /** Drops one entry. */
  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Drops every entry. */
  clear(): void {
    this.entries.clear();
  }

  /** How many entries are held, expired ones included. */
  get size(): number {
    return this.entries.size;
  }
}
