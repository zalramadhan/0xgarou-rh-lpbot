import { describe, expect, it } from 'vitest';
import {
  applySlippageDown,
  fmtAmount,
  fmtDuration,
  fmtUsd,
  parseDecimalToBigInt,
  shortAddr,
  toDecimalString,
} from '../src/utils/format.js';

describe('toDecimalString', () => {
  it('formats raw units', () => {
    expect(toDecimalString(1_500_000n, 6, 2)).toBe('1.5');
    expect(toDecimalString(10n ** 18n, 18, 4)).toBe('1');
    expect(toDecimalString(123n, 2, 4)).toBe('1.23');
    expect(toDecimalString(0n, 18)).toBe('0');
    expect(toDecimalString(-2_500_000n, 6, 2)).toBe('-2.5');
  });
});

describe('fmtAmount', () => {
  it('keeps significant digits for small amounts', () => {
    expect(fmtAmount(1_234_567_890_000_000n, 18)).toBe('0.00123457');
    expect(fmtAmount(2_500_000n, 6)).toBe('2.5');
    expect(fmtAmount(1234n * 10n ** 18n, 18)).toBe('1234');
  });
});

describe('parseDecimalToBigInt', () => {
  it('parses decimal strings', () => {
    expect(parseDecimalToBigInt('1.5', 6)).toBe(1_500_000n);
    expect(parseDecimalToBigInt('0.000001', 6)).toBe(1n);
    expect(parseDecimalToBigInt('12', 18)).toBe(12n * 10n ** 18n);
    expect(parseDecimalToBigInt('.5', 1)).toBe(5n);
  });

  it('rejects invalid input', () => {
    expect(() => parseDecimalToBigInt('abc', 18)).toThrow();
    expect(() => parseDecimalToBigInt('1.2345678', 6)).toThrow(/decimals/);
    expect(() => parseDecimalToBigInt('', 18)).toThrow();
  });
});

describe('misc formatting', () => {
  it('applies slippage', () => {
    expect(applySlippageDown(1_000_000n, 1)).toBe(990_000n);
    expect(applySlippageDown(1_000_000n, 0)).toBe(1_000_000n);
    expect(applySlippageDown(0n, 5)).toBe(0n);
  });

  it('shortens addresses', () => {
    expect(shortAddr('0x0bd7d308f8e1639fab988df18a8011f41eacad73')).toBe('0x0bd7…ad73');
  });

  it('formats usd and durations', () => {
    expect(fmtUsd(1234.5)).toBe('$1,234.50');
    expect(fmtUsd(0.12345)).toBe('$0.1235');
    expect(fmtDuration(90_000)).toBe('1m');
    expect(fmtDuration(3 * 3600_000 + 60_000)).toBe('3h 1m');
  });
});
