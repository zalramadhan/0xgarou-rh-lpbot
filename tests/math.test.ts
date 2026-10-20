import { describe, expect, it } from 'vitest';
import {
  Q96,
  alignTickDown,
  alignTickUp,
  fullRangeTicks,
  priceToTick,
  sqrtRatioX96AtTick,
  sqrtRatioX96ToPrice,
  tickRangeFromPercent,
  tickToPrice,
} from '../src/core/math/tickMath.js';
import {
  accruedFees,
  feeGrowthInside,
  getAmountsForLiquidity,
  maxLiquidityForAmounts,
} from '../src/core/math/liquidityMath.js';
import { amountsForLiquidity, isInRange, positionAmounts } from '../src/core/math/positionMath.js';
import { Q128 } from '../src/constants/chain.js';

const near = (actual: number, expected: number, relTol = 1e-6) => {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(relTol);
};

describe('tick math', () => {
  it('maps tick 0 to a price of 1 and sqrtPrice 2^96', () => {
    expect(tickToPrice(0, 18, 18)).toBe(1);
    expect(sqrtRatioX96ToPrice(Q96, 18, 18)).toBe(1);
    expect(sqrtRatioX96AtTick(0)).toBe(Q96);
  });

  it('converts 1.0001^tick exactly enough', () => {
    near(tickToPrice(23027, 18, 18), 10, 1e-3);
    near(tickToPrice(-23027, 18, 18), 0.1, 1e-3);
  });

  it('accounts for token decimals', () => {
    // price 2000 USDG (6dp) per WETH (18dp): raw price = 2000 * 10^-12
    // Integer ticks quantize price at 1bp, so allow a tick-sized error.
    const price = tickToPrice(priceToTick(2000, 18, 6), 18, 6);
    near(price, 2000, 1e-4);
  });

  it('round-trips price -> tick -> price', () => {
    for (const p of [0.00042, 0.98, 1.5, 2000, 123456]) {
      const tick = priceToTick(p, 18, 18);
      near(tickToPrice(tick, 18, 18), p, 1e-4);
    }
  });

  it('aligns ticks to spacing', () => {
    expect(alignTickDown(1005, 60)).toBe(960);
    expect(alignTickUp(1005, 60)).toBe(1020);
    expect(alignTickDown(-1, 10)).toBe(-10);
    expect(alignTickUp(-1, 10)).toBe(0);
  });

  it('builds a ±10% range that brackets the target prices', () => {
    const { tickLower, tickUpper } = tickRangeFromPercent(2000, 10, 10, 18, 6, 60);
    expect(Math.abs(tickLower % 60)).toBe(0);
    expect(Math.abs(tickUpper % 60)).toBe(0);
    expect(tickToPrice(tickLower, 18, 6)).toBeLessThanOrEqual(1800);
    expect(tickToPrice(tickUpper, 18, 6)).toBeGreaterThanOrEqual(2200);
    expect(tickUpper).toBeGreaterThan(tickLower);
  });

  it('produces sane full-range ticks', () => {
    const { tickLower, tickUpper } = fullRangeTicks(60);
    expect(Math.abs(tickUpper % 60)).toBe(0);
    expect(Math.abs(tickLower % 60)).toBe(0);
    expect(tickLower).toBeLessThan(0);
    expect(tickUpper).toBeGreaterThan(0);
  });
});

describe('liquidity math', () => {
  const L = 10n ** 18n;

  it('splits amounts at the current price', () => {
    const sqrtLower = sqrtRatioX96AtTick(-600);
    const sqrtUpper = sqrtRatioX96AtTick(600);
    const { amount0, amount1 } = getAmountsForLiquidity(Q96, sqrtLower, sqrtUpper, L);
    expect(amount0).toBeGreaterThan(0n);
    expect(amount1).toBeGreaterThan(0n);
    // Symmetric range around price 1 -> roughly equal value on both sides.
    near(Number(amount0), Number(amount1), 1e-3);
  });

  it('returns only token0 below the range and only token1 above', () => {
    const sqrtLower = sqrtRatioX96AtTick(1000);
    const sqrtUpper = sqrtRatioX96AtTick(2000);
    const below = getAmountsForLiquidity(sqrtRatioX96AtTick(500), sqrtLower, sqrtUpper, L);
    expect(below.amount1).toBe(0n);
    expect(below.amount0).toBeGreaterThan(0n);

    const above = getAmountsForLiquidity(sqrtRatioX96AtTick(3000), sqrtLower, sqrtUpper, L);
    expect(above.amount0).toBe(0n);
    expect(above.amount1).toBeGreaterThan(0n);
  });

  it('inverts amounts -> liquidity', () => {
    const sqrtLower = sqrtRatioX96AtTick(-1200);
    const sqrtUpper = sqrtRatioX96AtTick(1200);
    const { amount0, amount1 } = getAmountsForLiquidity(Q96, sqrtLower, sqrtUpper, L);
    const liquidity = maxLiquidityForAmounts(Q96, sqrtLower, sqrtUpper, amount0, amount1);
    // Rounding can only lower the result slightly.
    expect(liquidity).toBeLessThanOrEqual(L);
    expect(Number(liquidity) / Number(L)).toBeGreaterThan(0.9999);
  });

  it('values a full-range position at ~L on both sides at price 1', () => {
    const { tickLower, tickUpper } = fullRangeTicks(60);
    const amounts = amountsForLiquidity(Q96, tickLower, tickUpper, L);
    near(Number(amounts.amount0), Number(L), 1e-3);
    near(Number(amounts.amount1), Number(L), 1e-3);
  });

  it('computes fee growth inside for all three regions', () => {
    const global0 = 100n;
    const global1 = 100n;
    const lower0 = 10n;
    const lower1 = 10n;
    const upper0 = 20n;
    const upper1 = 20n;

    const below = feeGrowthInside(0, 100, 200, global0, global1, lower0, lower1, upper0, upper1);
    expect(below.inside0X128).toBe(10n - 20n + (1n << 256n));

    const inside = feeGrowthInside(150, 100, 200, global0, global1, lower0, lower1, upper0, upper1);
    expect(inside.inside0X128).toBe(70n);

    const above = feeGrowthInside(250, 100, 200, global0, global1, lower0, lower1, upper0, upper1);
    expect(above.inside0X128).toBe(10n);
  });

  it('accrues fees proportional to liquidity', () => {
    expect(accruedFees(L, Q128, 0n, 0n)).toBe(L);
    expect(accruedFees(L, Q128 / 2n, Q128 / 4n, 5n)).toBe(L / 4n + 5n);
    expect(accruedFees(0n, Q128, 0n, 7n)).toBe(7n);
  });

  it('reports range membership', () => {
    expect(isInRange(50, 0, 100)).toBe(true);
    expect(isInRange(100, 0, 100)).toBe(false);
    expect(isInRange(-1, 0, 100)).toBe(false);
  });
});

describe('position amounts', () => {
  it('matches amountsForLiquidity', () => {
    const state = {
      sqrtPriceX96: sqrtRatioX96AtTick(1234),
      tick: 1234,
      tickLower: 0,
      tickUpper: 3000,
      liquidity: 5n * 10n ** 17n,
    };
    const a = positionAmounts(state);
    const b = amountsForLiquidity(state.sqrtPriceX96, state.tickLower, state.tickUpper, state.liquidity);
    expect(a).toEqual(b);
  });
});
