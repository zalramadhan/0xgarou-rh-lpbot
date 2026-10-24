import { describe, expect, it } from 'vitest';
import { liquidityFromAmounts } from '../src/core/math/positionMath.js';
import { oneSidedTicks, reanchorRange, sqrtRatioX96AtTick, tickToPrice } from '../src/core/math/tickMath.js';

/**
 * Uniswap counts a position as in range when `tickLower <= tick < tickUpper`.
 * A range whose lower bound equals the live tick is therefore *in* range, and
 * a token0-only deposit cannot mint it. The live tick lands on a multiple of
 * the spacing once every `spacing` ticks, so the near bound of a range above
 * the market has to be the first aligned tick strictly above the live tick.
 */
const SPACING = 300;
const TICK = 331_800; // a multiple of the spacing
// Any price inside the tick: at or above its own sqrt ratio, below the next one.
const SQRT_PRICE = sqrtRatioX96AtTick(TICK) + 1n;
const AMOUNT0 = 13_235_538n; // token0 only, as a close of a quote-only position returns

describe('a range above the market when the live tick sits on the spacing', () => {
  it('re-anchors strictly above the live tick, so token0 alone can mint it', () => {
    // The price moved up into the range; the live tick is on the spacing.
    const anchored = reanchorRange({ tickLower: 330_000, tickUpper: 334_500 }, TICK, 'up', SPACING);

    expect(anchored.changed).toBe(true);
    expect(anchored.tickLower).toBeGreaterThan(TICK);
    expect(anchored.tickUpper - anchored.tickLower).toBe(4_500);

    // The result has to satisfy the rule reanchorRange itself checks.
    expect(reanchorRange(anchored, TICK, 'up', SPACING).changed).toBe(false);

    const liquidity = liquidityFromAmounts(SQRT_PRICE, TICK, anchored.tickLower, anchored.tickUpper, AMOUNT0, 0n);
    expect(liquidity).toBeGreaterThan(0n);
  });

  it('builds a one-sided range above the market that token0 alone can mint', () => {
    // A price that rounds to the aligned tick.
    const price = tickToPrice(TICK, 6, 18);
    const range = oneSidedTicks(price, 50, true, 6, 18, SPACING);

    expect(range.tickLower).toBeGreaterThan(TICK);
    const liquidity = liquidityFromAmounts(SQRT_PRICE, TICK, range.tickLower, range.tickUpper, AMOUNT0, 0n);
    expect(liquidity).toBeGreaterThan(0n);
  });
});
