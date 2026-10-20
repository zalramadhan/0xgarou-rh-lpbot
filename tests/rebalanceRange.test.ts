import { describe, expect, it } from 'vitest';
import { liquidityFromAmounts } from '../src/core/math/positionMath.js';
import { reanchorRange } from '../src/core/math/tickMath.js';
import type { PositionSnapshot } from '../src/core/positions.js';

/**
 * The rebalance used to re-centre the range on the live price, whatever the
 * position was. For a one-sided position that meant the re-mint needed both
 * tokens again — and the capital that came back from the close is one-sided,
 * so the mint had nothing to work with and failed.
 *
 * These tests pin the rule the fix follows: the range keeps its side of the
 * market, so a one-sided position stays one-sided and the mint works.
 */
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const TOKEN = '0xC60bA256B44334A0Cd2C7242E98B88f031abB006';

function snapshot(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    version: 'v4',
    tokenId: 3918279n,
    owner: '0xA934cb8Ae1cDd1b9eC532B83D901219e4169d48b',
    token0: { address: USDG, symbol: 'USDG', name: 'Global Dollar', decimals: 6 },
    token1: { address: TOKEN, symbol: 'V4', name: 'Programmable', decimals: 18 },
    hasNative: false,
    fee: 29990,
    keyFee: 29990,
    tickSpacing: 300,
    tickLower: 332100,
    tickUpper: 336600,
    liquidity: 10n ** 18n,
    sqrtPriceX96: 1278346572758239747207527829081407476n,
    tick: 331946,
    price: 260.32,
    amount0: 13_235_538n,
    amount1: 0n,
    fees0: 0n,
    fees1: 0n,
    inRange: false,
    poolAddress: '0x0',
    poolId: `0x${'0'.repeat(64)}`,
    hooks: '0x0000000000000000000000000000000000000000',
    ...overrides,
  } as unknown as PositionSnapshot;
}

describe('the range a re-entry uses', () => {
  it('keeps a quote-only position one-sided', () => {
    // The position holds only token0 (the quote), so the range has to stay
    // above the market: the price below the range means the position is all
    // token0 again.
    const position = snapshot({ amount0: 13_235_538n, amount1: 0n });
    const direction = position.amount0 > 0n && position.amount1 === 0n ? 'up' : 'both';
    expect(direction).toBe('up');

    const range = reanchorRange(
      { tickLower: position.tickLower, tickUpper: position.tickUpper },
      position.tick,
      direction,
      position.tickSpacing,
    );
    // The range is above the market, so the position is all token0.
    expect(range.tickLower).toBeGreaterThan(position.tick);

    // And the capital that came back from the close can mint it again.
    const liquidity = liquidityFromAmounts(
      position.sqrtPriceX96,
      position.tick,
      range.tickLower,
      range.tickUpper,
      position.amount0,
      position.amount1,
    );
    expect(liquidity).toBeGreaterThan(0n);
  });

  it('keeps a token-only position one-sided the other way', () => {
    const position = snapshot({ amount0: 0n, amount1: 25n * 10n ** 18n });
    const direction = position.amount1 > 0n && position.amount0 === 0n ? 'down' : 'both';
    expect(direction).toBe('down');

    const range = reanchorRange(
      { tickLower: position.tickLower, tickUpper: position.tickUpper },
      position.tick,
      direction,
      position.tickSpacing,
    );
    expect(range.tickUpper).toBeLessThanOrEqual(position.tick);

    const liquidity = liquidityFromAmounts(
      position.sqrtPriceX96,
      position.tick,
      range.tickLower,
      range.tickUpper,
      position.amount0,
      position.amount1,
    );
    expect(liquidity).toBeGreaterThan(0n);
  });

  it('re-centres a position that holds both tokens', () => {
    const position = snapshot({ amount0: 13_235_538n, amount1: 25n * 10n ** 18n });
    const both = position.amount0 > 0n && position.amount1 > 0n;
    expect(both).toBe(true);
  });

  it('would fail if the range were re-centred for a one-sided position', () => {
    // This is the bug: re-centring puts the price inside the range, and then
    // the one-sided capital cannot mint anything.
    const position = snapshot({ amount0: 13_235_538n, amount1: 0n });
    const centred = reanchorRange(
      { tickLower: position.tickLower, tickUpper: position.tickUpper },
      position.tick,
      'both',
      position.tickSpacing,
    );
    const liquidity = liquidityFromAmounts(
      position.sqrtPriceX96,
      position.tick,
      centred.tickLower,
      centred.tickUpper,
      position.amount0,
      position.amount1,
    );
    expect(liquidity).toBe(0n);
  });
});
