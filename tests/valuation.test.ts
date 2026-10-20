import { describe, expect, it } from 'vitest';
import { summarizePnl, type Valuation } from '../src/core/valuation.js';
import { decideExit } from '../src/monitor/exits.js';

const valuation = (principal: number, fees: number): Valuation => ({
  amount0Human: 0,
  amount1Human: 0,
  price0Usd: 0,
  price1Usd: 0,
  principalUsd: principal,
  fees0Human: 0,
  fees1Human: 0,
  feesUsd: fees,
  valueUsd: principal + fees,
  lowerPrice: 0,
  upperPrice: 0,
  nearestDistancePct: 0,
  distanceToLowerPct: 0,
  distanceToUpperPct: 0,
});

describe('cost-basis PnL', () => {
  it('counts principal, pending and withdrawn fees against the basis', () => {
    const pnl = summarizePnl(valuation(102, 1), {
      basisUsd: 100,
      feesWithdrawnUsd: 0.5,
      compoundedFeesUsd: 0,
      openedAt: Date.now() - 10 * 86_400_000,
    });
    expect(pnl.totalPnlUsd).toBeCloseTo(3.5, 6);
    expect(pnl.totalPnlPct).toBeCloseTo(3.5, 6);
    expect(pnl.feesEarnedUsd).toBeCloseTo(1.5, 6);
  });

  it('does not double count compounded fees', () => {
    // 100 deposited, 5 of fees compounded -> basis 105, principal 105, no pending.
    const pnl = summarizePnl(valuation(105, 0), {
      basisUsd: 105,
      feesWithdrawnUsd: 0,
      compoundedFeesUsd: 5,
      openedAt: Date.now() - 86_400_000,
    });
    expect(pnl.totalPnlUsd).toBeCloseTo(0, 6);
    expect(pnl.feesEarnedUsd).toBeCloseTo(5, 6);
    expect(pnl.aprPct).toBeGreaterThan(0);
  });

  it('handles losses', () => {
    const pnl = summarizePnl(valuation(80, 0.2), {
      basisUsd: 100,
      feesWithdrawnUsd: 1,
      compoundedFeesUsd: 0,
      openedAt: Date.now() - 86_400_000,
    });
    expect(pnl.totalPnlUsd).toBeCloseTo(-18.8, 6);
    expect(pnl.totalPnlPct).toBeCloseTo(-18.8, 6);
  });

  it('never divides by a zero basis', () => {
    const pnl = summarizePnl(valuation(10, 0), {
      basisUsd: 0,
      feesWithdrawnUsd: 0,
      compoundedFeesUsd: 0,
      openedAt: Date.now(),
    });
    expect(pnl.totalPnlPct).toBe(0);
    expect(pnl.aprPct).toBe(0);
  });

  it('keeps an unknown price unknown instead of showing a total loss', () => {
    // A price feed that fails must not look like a 100% loss, or the stop loss
    // would close the position for real.
    const unknown = { ...valuation(50, 50), principalUsd: Number.NaN, valueUsd: Number.NaN };
    const pnl = summarizePnl(unknown, {
      basisUsd: 50,
      feesWithdrawnUsd: 0,
      compoundedFeesUsd: 0,
      openedAt: Date.now(),
    });
    expect(Number.isNaN(pnl.totalPnlUsd)).toBe(true);
    expect(Number.isNaN(pnl.totalPnlPct)).toBe(true);
    expect(
      decideExit({ pnlPct: pnl.totalPnlPct, aboveRange: false, stopLossPct: -20, autoTpTargetPct: 1 }),
    ).toBeUndefined();
  });
});
