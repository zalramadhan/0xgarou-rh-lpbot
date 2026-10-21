import { describe, expect, it } from 'vitest';
import { formatDeviationPct, pickReferencePrice } from '../src/core/scanner.js';

describe('the market price a pool is compared against', () => {
  it('comes from the deepest USDG pool', () => {
    // The quote the prices are compared in.
    const reference = pickReferencePrice([
      { priceUsd: 0.005, tvlUsd: 150_000, quote: 'usdg' },
      { priceUsd: 0.0049, tvlUsd: 60_000, quote: 'usdg' },
    ]);
    expect(reference).toBe(0.005);
  });

  it('never comes from a pool with a broken price', () => {
    // The AI/microduck case: the deepest pool, quoted in a token that has no
    // market at all, so its price is a fraction of nothing.
    const reference = pickReferencePrice([
      { priceUsd: 2.66e-40, tvlUsd: 344_577, quote: 'other' },
      { priceUsd: 0.005, tvlUsd: 149_261, quote: 'usdg' },
    ]);
    expect(reference).toBe(0.005);
  });

  it('falls back to a WETH pool when there is no USDG pool', () => {
    const reference = pickReferencePrice([
      { priceUsd: 0.005, tvlUsd: 4_500, quote: 'weth' },
      { priceUsd: 0.02, tvlUsd: 300_000, quote: 'other' },
    ]);
    expect(reference).toBe(0.005);
  });

  it('has no reference when no pool can price the token', () => {
    // Nothing to compare against: the pools are judged by their TVL and
    // their volume alone.
    const reference = pickReferencePrice([
      { priceUsd: 2.66e-40, tvlUsd: 344_577, quote: 'other' },
      { priceUsd: Number.NaN, tvlUsd: 8_000, quote: 'usdg' },
    ]);
    expect(Number.isFinite(reference)).toBe(false);
  });

  it('ignores a pool whose price is zero', () => {
    const reference = pickReferencePrice([
      { priceUsd: 0, tvlUsd: 500_000, quote: 'usdg' },
      { priceUsd: 0.005, tvlUsd: 1_000, quote: 'usdg' },
    ]);
    expect(reference).toBe(0.005);
  });
});

describe('a deviation that is too big to print', () => {
  it('is capped', () => {
    expect(formatDeviationPct(2.1e39)).toBe('more than 999%');
    expect(formatDeviationPct(1500)).toBe('more than 999%');
    expect(formatDeviationPct(27.94)).toBe('27.9%');
    expect(formatDeviationPct(-5.25)).toBe('5.3%');
    expect(formatDeviationPct(Number.NaN)).toBe('—');
  });
});
