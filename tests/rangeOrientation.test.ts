import { describe, expect, it } from 'vitest';
import { rangeForToken, tradedPrice, tradedRange } from '../src/core/pairs.js';
import { plannedMarketCapLine, plannedRangeVisual } from '../src/bot/ui.js';
import type { TokenInfo } from '../src/core/tokens.js';

const USDG: TokenInfo = {
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  symbol: 'USDG',
  name: 'Global Dollar',
  decimals: 6,
};
const TOKEN: TokenInfo = {
  address: '0xC60bA256B44334A0Cd2C7242E98B88f031abB006',
  symbol: 'V4',
  name: 'Programmable',
  decimals: 18,
};

/** A pool that stores the traded token as token1 — the inverted case. */
const invertedPool = { price: 260.32, token0: USDG, token1: TOKEN };
/** A pool that stores the traded token as token0 — the direct case. */
const directPool = { price: 0.00384, token0: TOKEN, token1: USDG };

describe('the range in the traded token’s terms', () => {
  it('keeps the pool price when the traded token is token0', () => {
    const range = tradedRange(directPool, directPool.price, 0.003, 0.004);
    expect(range.direct).toBe(true);
    expect(range.lower).toBe(0.003);
    expect(range.upper).toBe(0.004);
    expect(range.current).toBe(0.00384);
  });

  it('inverts the pool price when the traded token is token1', () => {
    const range = tradedRange(invertedPool, invertedPool.price, 264, 414);
    expect(range.direct).toBe(false);
    expect(range.lower).toBeCloseTo(1 / 414, 10);
    expect(range.upper).toBeCloseTo(1 / 264, 10);
    expect(range.current).toBeCloseTo(1 / 260.32, 10);
  });

  it('reads the traded price in the same unit as the entry price', () => {
    expect(tradedPrice(directPool, 0.00384)).toBe(0.00384);
    expect(tradedPrice(invertedPool, 260.32)).toBeCloseTo(1 / 260.32, 10);
  });

  it('follows the token the user asked about, not the pool’s traded side', () => {
    // The pasted token is token1 of this pool, so its price is the inverse.
    const range = rangeForToken(invertedPool, TOKEN, invertedPool.price, 264, 414);
    expect(range.direct).toBe(false);
    expect(range.current).toBeCloseTo(1 / 260.32, 10);
  });
});

describe('the range of a position that is not open yet', () => {
  // The same pool as the live V4 position: USDG is token0, V4 is token1.
  const tickLower = 332100;
  const tickUpper = 336600;

  it('draws the bar from the same numbers the position card uses', () => {
    const visual = plannedRangeVisual(invertedPool, TOKEN, tickLower, tickUpper);
    // The token's price is above the upper bound, so the bar is filled.
    expect(visual.oor).toBe('right');
    expect(visual.label).toBe('OOR RIGHT');
    expect(visual.bar).toBe('[■■■■■■■■■■|]→');
  });

  it('shows the market cap at the bounds, not the price', () => {
    // The display prices of the bounds: the token's own price in USDG.
    const line = plannedMarketCapLine(3_560_302, invertedPool, TOKEN, 1 / 414.59, 1 / 264.36);
    expect(line).toBeDefined();
    expect(line).toContain('now $3,56M');
    expect(line).not.toContain('per V4');
  });
});
