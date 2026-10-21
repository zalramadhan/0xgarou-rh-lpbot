import { describe, expect, it } from 'vitest';
import { otherRouteAfterRefusal, routeDiscountPct } from '../src/core/swap.js';
import {
  DEFAULT_MAX_ROUTE_DISCOUNT_PCT,
  normalizeRouteDiscount,
  ROUTE_DISCOUNT_CHOICES,
} from '../src/constants/routeImpact.js';
import { store } from '../src/store/store.js';
import { settingsKeyboard, settingsText } from '../src/bot/ui.js';

const CHAT_ID = 777_040;

describe('the route impact limit', () => {
  it('is 2% by default', () => {
    expect(DEFAULT_MAX_ROUTE_DISCOUNT_PCT).toBe(2);
    const settings = store.settingsFor(CHAT_ID);
    expect(settings.maxRouteDiscountPct).toBe(2);
  });

  it('keeps a sane percentage', () => {
    expect(normalizeRouteDiscount(3)).toBe(3);
    expect(normalizeRouteDiscount('2.5')).toBe(2.5);
    // Nonsense falls back to the default.
    expect(normalizeRouteDiscount(0)).toBe(2);
    expect(normalizeRouteDiscount(-5)).toBe(2);
    expect(normalizeRouteDiscount(Number.NaN)).toBe(2);
    expect(normalizeRouteDiscount(undefined)).toBe(2);
    expect(normalizeRouteDiscount(1000)).toBe(25);
  });

  it('offers the usual limits in the settings', () => {
    expect(ROUTE_DISCOUNT_CHOICES).toContain(2);
    const settings = store.settingsFor(CHAT_ID);
    const text = settingsText(settings, undefined);
    expect(text).toContain('Route impact');
    expect(text).toContain('2%');
    const buttons = settingsKeyboard(settings).inline_keyboard.flat();
    const button = buttons.find((b) => ('callback_data' in b ? b.callback_data : '') === 'set:swapImpact');
    expect(button).toBeDefined();
  });

  it('measures how far below the market a route is priced', () => {
    expect(routeDiscountPct(0.98, 1)).toBeCloseTo(2, 6);
    expect(routeDiscountPct(0.99, 1)).toBeCloseTo(1, 6);
    expect(routeDiscountPct(1.02, 1)).toBeCloseTo(-2, 6);
  });
});

describe('the other route after a refusal', () => {
  it('offers the V3 pool when the 0x route was refused', () => {
    expect(otherRouteAfterRefusal('0x', true, true)).toBe('uniswap-v3');
  });

  it('offers the 0x API when the V3 route was refused', () => {
    expect(otherRouteAfterRefusal('uniswap-v3', true, true)).toBe('0x');
  });

  it('does not offer the V3 route for a token that has no v3 pool', () => {
    // IGNITION only trades in v4 pools: there is no V3 route to offer.
    expect(otherRouteAfterRefusal('0x', true, false)).toBeUndefined();
  });

  it('offers nothing when the swap worked or failed for another reason', () => {
    expect(otherRouteAfterRefusal('0x', false, true)).toBeUndefined();
  });
});
