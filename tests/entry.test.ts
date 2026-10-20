import { describe, expect, it } from 'vitest';
import { amountsForLiquidity } from '../src/core/math/positionMath.js';
import {
  fullRangeTicks,
  oneSidedTicks,
  priceToTick,
  sqrtRatioX96AtTick,
  tickRangeFromPercent,
} from '../src/core/math/tickMath.js';
import { rangeKeyboard, sideKeyboard } from '../src/bot/ui.js';
import type { TokenInfo } from '../src/core/tokens.js';
import type { InlineKeyboard } from 'grammy';

const USDG: TokenInfo = { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', name: 'Global Dollar', decimals: 6 };
const RAETO: TokenInfo = { address: '0x72be1277e198d0c476869253cb4e62807e14533c', symbol: 'RAETO', name: 'RAETO', decimals: 18 };

const DEC0 = USDG.decimals;
const DEC1 = RAETO.decimals;
const SPACING = 100;

// RAETO per USDG — token1 per token0, the convention the tick helpers expect.
const PRICE = 663;
const TICK = priceToTick(PRICE, DEC0, DEC1);

/** Token amounts a range would consume at the live price, in human units. */
function splitAt(tickLower: number, tickUpper: number): { usdg: number; raeto: number } {
  const sqrt = sqrtRatioX96AtTick(TICK);
  const { amount0, amount1 } = amountsForLiquidity(sqrt, tickLower, tickUpper, 10n ** 18n);
  return { usdg: Number(amount0) / 10 ** DEC0, raeto: Number(amount1) / 10 ** DEC1 };
}

/** A range sitting above the live price: funded entirely in token0 (USDG). */
const above = (pct: number) => oneSidedTicks(PRICE, pct, true, DEC0, DEC1, SPACING);
/** A range sitting below the live price: funded entirely in token1 (RAETO). */
const below = (pct: number) => oneSidedTicks(PRICE, pct, false, DEC0, DEC1, SPACING);

const codes = (kb: InlineKeyboard) => kb.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : undefined));

describe('one-sided ranges', () => {
  it('a range above the live price is funded entirely in the quote (token0)', () => {
    const { tickLower, tickUpper } = above(15);
    expect(tickLower).toBeGreaterThan(TICK);
    const { usdg, raeto } = splitAt(tickLower, tickUpper);
    expect(usdg).toBeGreaterThan(0);
    expect(raeto).toBe(0);
  });

  it('a range below the live price is funded entirely in the token (token1)', () => {
    const { tickLower, tickUpper } = below(15);
    expect(tickUpper).toBeLessThan(TICK);
    const { usdg, raeto } = splitAt(tickLower, tickUpper);
    expect(usdg).toBe(0);
    expect(raeto).toBeGreaterThan(0);
  });

  it('a straddling range holds both sides', () => {
    const { tickLower, tickUpper } = tickRangeFromPercent(PRICE, 15, 15, DEC0, DEC1, SPACING);
    expect(tickLower).toBeLessThan(TICK);
    expect(tickUpper).toBeGreaterThan(TICK);
    const { usdg, raeto } = splitAt(tickLower, tickUpper);
    expect(usdg).toBeGreaterThan(0);
    expect(raeto).toBeGreaterThan(0);
  });

  it('the bound touching the live price is aligned away from it', () => {
    // Above: the lower bound must clear the live tick, never sit under it.
    expect(above(85).tickLower).toBeGreaterThanOrEqual(TICK);
    // Below: the upper bound must stay under the live tick.
    expect(below(85).tickUpper).toBeLessThanOrEqual(TICK);
  });

  it('every preset width produces a non-empty range on the spacing grid', () => {
    for (const pct of [15, 35, 55, 85]) {
      for (const range of [above(pct), below(pct)]) {
        expect(range.tickUpper).toBeGreaterThan(range.tickLower);
        expect(range.tickLower % SPACING).toBe(0);
        expect(range.tickUpper % SPACING).toBe(0);
      }
    }
  });

  it('a wider preset spans more ticks than a narrower one', () => {
    expect(above(85).tickUpper - above(85).tickLower).toBeGreaterThan(above(15).tickUpper - above(15).tickLower);
  });

  it('rejects widths that cannot form a range', () => {
    expect(() => above(0)).toThrow();
    expect(() => above(100)).toThrow();
    expect(() => above(150)).toThrow();
  });

  it('full range brackets the live tick', () => {
    const full = fullRangeTicks(SPACING);
    expect(full.tickLower).toBeLessThan(TICK);
    expect(full.tickUpper).toBeGreaterThan(TICK);
  });
});

describe('entry flow keyboards', () => {
  it('offers quote-only, token-only and both-sides', () => {
    const list = codes(sideKeyboard(RAETO.symbol, USDG.symbol));
    expect(list).toContain('new:side:quote');
    expect(list).toContain('new:side:token');
    expect(list).toContain('new:side:both');
    expect(list).toContain('new:cancel');
    expect(list).toContain('menu:home');
  });

  it('names both tokens on the side buttons', () => {
    const labels = sideKeyboard(RAETO.symbol, USDG.symbol).inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(expect.arrayContaining(['💵 USDG only', '🪙 RAETO only', '⚖️ Both sides']));
  });

  it('uses directional presets per side and 15–85% widths', () => {
    const WIDTHS = ['15', '20', '25', '30', '35', '45', '50', '55', '60', '65', '70', '75', '80', '85'];
    const presets = (side: 'both' | 'quote' | 'token') =>
      codes(rangeKeyboard(side)).filter((d) => /^new:range:(q|t)?\d+$/.test(d ?? ''));

    expect(presets('quote')).toEqual(WIDTHS.map((w) => `new:range:q${w}`));
    expect(presets('token')).toEqual(WIDTHS.map((w) => `new:range:t${w}`));
    expect(presets('both')).toEqual(WIDTHS.map((w) => `new:range:${w}`));
  });

  it('keeps full-range, custom, cancel and the home button on every side', () => {
    for (const side of ['both', 'quote', 'token'] as const) {
      const list = codes(rangeKeyboard(side));
      expect(list).toContain('new:range:full');
      expect(list).toContain('new:range:custom');
      expect(list).toContain('new:cancel');
      expect(list).toContain('menu:home');
    }
  });

  it('draws the direction on the one-sided presets', () => {
    const quoteTexts = rangeKeyboard('quote').inline_keyboard.flat().map((b) => b.text);
    const tokenTexts = rangeKeyboard('token').inline_keyboard.flat().map((b) => b.text);
    const bothTexts = rangeKeyboard('both').inline_keyboard.flat().map((b) => b.text);
    expect(quoteTexts.filter((t) => t.startsWith('▼'))).toHaveLength(14);
    expect(tokenTexts.filter((t) => t.startsWith('▲'))).toHaveLength(14);
    expect(bothTexts.filter((t) => t.startsWith('±'))).toHaveLength(14);
  });

  it('lays the presets out in rows of three', () => {
    const rows = rangeKeyboard('quote').inline_keyboard;
    // The window, custom, cancel and home rows are not presets.
    const presetRows = rows.filter((row) => row.some((b) => b.text.startsWith('▼')));
    expect(presetRows.every((row) => row.length <= 3)).toBe(true);
  });
});
