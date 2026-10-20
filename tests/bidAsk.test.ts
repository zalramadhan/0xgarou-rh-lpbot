import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import {
  bidAskAllocations,
  bidAskWeights,
  buildBidAskBins,
  buildBidAskPlan,
  displayPriceAtTick,
} from '../src/core/bidAsk.js';
import {
  bidAskConfirmKeyboard,
  bidAskEntriesKeyboard,
  bidAskEntriesText,
  confirmKeyboard,
  strategyKeyboard,
} from '../src/bot/ui.js';
import type { V4Pool } from '../src/core/pools.js';
import type { TokenInfo } from '../src/core/tokens.js';
import type { DepositPlan } from '../src/core/planner.js';

const USDG: TokenInfo = {
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  symbol: 'USDG',
  name: 'Global Dollar',
  decimals: 6,
};
const RAETO: TokenInfo = {
  address: '0x72be1277e198d0c476869253cb4e62807e14533c',
  symbol: 'RAETO',
  name: 'RAETO',
  decimals: 18,
};

function pool(tick: number, tickSpacing = 10): V4Pool {
  return {
    version: 'v4',
    poolId: `0x${'ab'.repeat(32)}` as `0x${string}`,
    key: { currency0: USDG.address, currency1: RAETO.address, fee: 3000, tickSpacing, hooks: zeroAddress },
    token0: USDG,
    token1: RAETO,
    fee: 3000,
    lpFee: 3000,
    tickSpacing,
    sqrtPriceX96: 1n << 96n,
    tick,
    liquidity: 10n ** 18n,
    price: 663,
    label: 'v4 0.3%',
  };
}

function fakePlan(fundedIsToken0: boolean): typeof import('../src/core/planner.js').planByUsd {
  return async (_pool, _tickLower, _tickUpper, targetUsd) => {
    const raw = BigInt(Math.round(targetUsd * 1e6));
    return {
      liquidity: 1n,
      amount0: fundedIsToken0 ? raw : 0n,
      amount1: fundedIsToken0 ? 0n : raw,
      valueUsd: targetUsd,
      price0Usd: 1,
      price1Usd: 1,
      balance0: 10n ** 18n,
      balance1: 10n ** 18n,
      shortfall0: 0n,
      shortfall1: 0n,
    } satisfies DepositPlan;
  };
}

function fakeBothPlan(): typeof import('../src/core/planner.js').planByUsd {
  return async (_pool, _tickLower, _tickUpper, targetUsd) => {
    const raw = BigInt(Math.round(targetUsd * 1e6));
    return {
      liquidity: 1n,
      amount0: raw,
      amount1: raw,
      valueUsd: targetUsd,
      price0Usd: 1,
      price1Usd: 1,
      balance0: 10n ** 18n,
      balance1: 10n ** 18n,
      shortfall0: 0n,
      shortfall1: 0n,
    } satisfies DepositPlan;
  };
}

describe('Bid Ask progressive weights', () => {
  it('uses 1, 2, 3 … N', () => {
    expect(bidAskWeights(5)).toEqual([1, 2, 3, 4, 5]);
    expect(bidAskWeights(10)).toHaveLength(10);
  });

  it('rejects entry counts outside 4–10', () => {
    expect(() => bidAskWeights(3)).toThrow('4 and 10');
    expect(() => bidAskWeights(11)).toThrow('4 and 10');
  });
});

describe('Bid Ask capital allocation', () => {
  it('allocates 1:2:3:4:5 and sums to the requested total', () => {
    const allocations = bidAskAllocations(100, 5);
    expect(allocations.map((entry) => entry.weight)).toEqual([1, 2, 3, 4, 5]);
    expect(allocations[0]!.usd).toBeCloseTo(6.666667, 6);
    expect(allocations[4]!.usd).toBeCloseTo(33.333333, 6);
    expect(allocations[0]!.usd).toBeLessThan(allocations[4]!.usd);
    expect(allocations.reduce((sum, entry) => sum + entry.usd, 0)).toBeCloseTo(100, 9);
    expect(allocations.reduce((sum, entry) => sum + entry.pct, 0)).toBeCloseTo(100, 9);
  });

  it('is exact for a clean split and keeps the remainder out of the first entry', () => {
    const allocations = bidAskAllocations(10, 4);
    expect(allocations.map((entry) => entry.usd)).toEqual([1, 2, 3, 4]);
  });

  it('keeps the sum exact after micro-USD rounding', () => {
    for (const total of [0.01, 1, 7.77, 100, 1234.56]) {
      for (let n = 4; n <= 10; n++) {
        const sum = bidAskAllocations(total, n).reduce((acc, entry) => acc + entry.usd, 0);
        expect(sum).toBeCloseTo(total, 9);
      }
    }
  });
});

describe('Bid Ask bin placement', () => {
  it('places the nearest bin first below the market', () => {
    const bins = buildBidAskBins({ tick: 1000, tickSpacing: 10 }, 800, 1000, 5, 'down');
    expect(bins.map((bin) => [bin.tickLower, bin.tickUpper])).toEqual([
      [960, 1000],
      [920, 960],
      [880, 920],
      [840, 880],
      [800, 840],
    ]);
  });

  it('mirrors the ladder above the market', () => {
    const bins = buildBidAskBins({ tick: 800, tickSpacing: 10 }, 800, 1000, 5, 'up');
    expect(bins.map((bin) => [bin.tickLower, bin.tickUpper])).toEqual([
      [800, 840],
      [840, 880],
      [880, 920],
      [920, 960],
      [960, 1000],
    ]);
  });

  it('gives leftover tick-spacings to the farthest bins', () => {
    const bins = buildBidAskBins({ tick: 1000, tickSpacing: 10 }, 800, 1000, 6, 'down');
    expect(bins.map((bin) => (bin.tickUpper - bin.tickLower) / 10)).toEqual([3, 3, 3, 3, 4, 4]);
    expect(bins[5]!.tickLower).toBe(800);
    expect(bins[5]!.tickUpper).toBe(840);
  });

  it('refuses a range that is too narrow for the entry count', () => {
    expect(() => buildBidAskBins({ tick: 60, tickSpacing: 10 }, 0, 50, 6, 'down')).toThrow('too narrow');
  });

  it('refuses a range on the wrong side of the market', () => {
    expect(() => buildBidAskBins({ tick: 1000, tickSpacing: 10 }, 800, 1000, 5, 'up')).toThrow(
      'above the market',
    );
    expect(() => buildBidAskBins({ tick: 800, tickSpacing: 10 }, 800, 1000, 5, 'down')).toThrow(
      'below the market',
    );
  });

  it('follows the market when the price moved into the range', () => {
    // The range was picked below a 1000 market; the price dropped to 900.
    const bins = buildBidAskBins({ tick: 900, tickSpacing: 10 }, 800, 1000, 5, 'down');
    expect(bins[0]!.tickUpper).toBe(900);
    expect(bins[0]!.tickLower).toBe(880);
    expect(bins[4]!.tickLower).toBe(800);
  });

  it('converts a tick to both sides of the pair consistently', () => {
    const p = pool(0);
    const a = displayPriceAtTick(p, USDG, 100);
    const b = displayPriceAtTick(p, RAETO, 100);
    expect(a * b).toBeCloseTo(1, 12);
  });

  it('keeps every bin on a spacing boundary at the tick clamp', () => {
    const bins = buildBidAskBins({ tick: -887_272, tickSpacing: 60 }, 800_000, 887_272, 4, 'up');
    expect(bins).toHaveLength(4);
    for (const bin of bins) {
      expect(bin.tickLower % 60).toBe(0);
      expect(bin.tickUpper % 60).toBe(0);
      expect(bin.tickUpper).toBeLessThanOrEqual(887_272);
    }
    expect(bins[0]!.tickLower).toBeLessThan(bins[3]!.tickUpper);
  });
});

describe('Bid Ask plan validation', () => {
  it('builds a quote-only ladder with one-sided plans', async () => {
    // RAETO is token1, so quoting funds token0 — the range sits above the market.
    const plan = await buildBidAskPlan({
      pool: pool(800),
      token: RAETO,
      side: 'quote',
      tickLower: 800,
      tickUpper: 1000,
      totalUsd: 100,
      entryCount: 5,
      planUsd: fakePlan(true),
    });

    expect(plan.entryCount).toBe(5);
    expect(plan.fundedIsToken0).toBe(true);
    expect(plan.entries).toHaveLength(5);
    expect(plan.entries[0]!.allocationUsd).toBeLessThan(plan.entries[4]!.allocationUsd);
    expect(plan.amount0).toBeGreaterThan(0n);
    expect(plan.amount1).toBe(0n);
    expect(plan.plannedUsd).toBeCloseTo(100, 9);
    expect(plan.shortfall0).toBe(0n);
    expect(plan.entries[0]!.tickLower).toBe(800);
    expect(plan.tickLower).toBe(800);
    expect(plan.tickUpper).toBe(1000);
  });

  it('builds a token-only ladder with one-sided plans', async () => {
    // Funding RAETO (token1) puts the range below the market.
    const plan = await buildBidAskPlan({
      pool: pool(1000),
      token: RAETO,
      side: 'token',
      tickLower: 800,
      tickUpper: 1000,
      totalUsd: 50,
      entryCount: 4,
      planUsd: fakePlan(false),
    });

    expect(plan.fundedIsToken0).toBe(false);
    expect(plan.amount0).toBe(0n);
    expect(plan.amount1).toBeGreaterThan(0n);
    expect(plan.entries[0]!.tickUpper).toBe(1000);
  });

  it('rejects an entry that would need the other token', async () => {
    await expect(
      buildBidAskPlan({
        pool: pool(1000),
        token: RAETO,
        side: 'token',
        tickLower: 800,
        tickUpper: 1000,
        totalUsd: 50,
        entryCount: 4,
        planUsd: fakeBothPlan(),
      }),
    ).rejects.toThrow('both tokens');
  });

  it('rejects an entry whose allocation is too small', async () => {
    const empty: typeof import('../src/core/planner.js').planByUsd = async () => ({
      liquidity: 0n,
      amount0: 0n,
      amount1: 0n,
      valueUsd: 0,
      price0Usd: 1,
      price1Usd: 1,
      shortfall0: 0n,
      shortfall1: 0n,
    });

    await expect(
      buildBidAskPlan({
        pool: pool(1000),
        token: RAETO,
        side: 'token',
        tickLower: 800,
        tickUpper: 1000,
        totalUsd: 100,
        entryCount: 5,
        planUsd: empty,
      }),
    ).rejects.toThrow('too small');
  });

  it('rejects an entry count outside the allowed range', async () => {
    await expect(
      buildBidAskPlan({
        pool: pool(1000),
        token: RAETO,
        side: 'token',
        tickLower: 800,
        tickUpper: 1000,
        totalUsd: 100,
        entryCount: 3,
        planUsd: fakePlan(false),
      }),
    ).rejects.toThrow('4 and 10');
  });
});

describe('Bid Ask settings UI', () => {
  it('shows the current value and every allowed choice', () => {
    const text = bidAskEntriesText(5);
    expect(text).toContain('Current value: <b>5 entries</b>');
    expect(text).toContain('4, 5, 6, 7, 8, 9, 10');
    expect(text).toContain('1 : 2 : 3 : 4 : 5');
  });

  it('offers 4–10 with the current value marked and a back button', () => {
    const data = bidAskEntriesKeyboard(5)
      .inline_keyboard.flat()
      .map((button) => (button as { callback_data?: string }).callback_data);
    for (let n = 4; n <= 10; n++) expect(data).toContain(`set:bidaskSelect:${n}`);
    expect(data).toContain('set:back');
    expect(
      bidAskEntriesKeyboard(5)
        .inline_keyboard.flat()
        .some((button) => button.text === '5 ✅'),
    ).toBe(true);
  });

  it('requires an explicit apply before writing the setting', () => {
    const data = bidAskConfirmKeyboard(6)
      .inline_keyboard.flat()
      .map((button) => (button as { callback_data?: string }).callback_data);
    expect(data).toContain('set:bidAskApply:6');
    expect(data).toContain('set:bidask');
  });

  it('labels the ladder action and the multi-mint confirm button', () => {
    const strategy = strategyKeyboard(5)
      .inline_keyboard.flat()
      .map((button) => button.text);
    expect(strategy).toContain('🎯 Spot');
    expect(strategy).toContain('📊 Bid Ask · 5 entries');
    expect(
      confirmKeyboard(5)
        .inline_keyboard.flat()
        .some((button) => button.text === '✅ Open 5 positions'),
    ).toBe(true);
  });
});
