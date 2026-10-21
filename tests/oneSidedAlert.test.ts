import { describe, expect, it } from 'vitest';
import { isOneSidedEntry } from '../src/monitor/monitor.js';
import type { TrackedPosition } from '../src/store/store.js';

function tracked(amount0: string, amount1: string): TrackedPosition {
  return {
    id: 'p1',
    chatId: 1,
    version: 'v4',
    tokenId: '42',
    entry: { amount0, amount1, valueUsd: 53, price: 0.001, openedAt: Date.now() },
    basisUsd: 53,
    feesWithdrawnUsd: 0,
    compoundedFeesUsd: 0,
    alerts: true,
    autoCompound: false,
    compoundIntervalMs: 3_600_000,
    compoundMinFeeUsd: 1,
    createdAt: Date.now(),
  } as unknown as TrackedPosition;
}

describe('a position that was opened with one token', () => {
  it('is recognised by its entry', () => {
    // One side of the deposit is zero: the position waits for the price to
    // come into its range, so it is out of range from the start.
    expect(isOneSidedEntry(tracked('0', '52998728'))).toBe(true);
    expect(isOneSidedEntry(tracked('52998728', '0'))).toBe(true);
  });

  it('is not what a two-sided entry looks like', () => {
    expect(isOneSidedEntry(tracked('13235538', '25000000000000000'))).toBe(false);
  });
});
