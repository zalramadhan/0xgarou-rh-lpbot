import { describe, expect, it } from 'vitest';
import {
  marketCapLine,
  positionCard,
  positionNumber,
  positionPair,
  positionRow,
  poolLine,
  rangeVisual,
  rangeWidthPct,
} from '../src/bot/ui.js';
import type { PositionSnapshot } from '../src/core/positions.js';
import type { Valuation, PnlSummary } from '../src/core/valuation.js';
import type { TrackedPosition } from '../src/store/store.js';
import type { V3Pool } from '../src/core/pools.js';

const USDG_ADDRESS = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const TOKEN_ADDRESS = '0x72be1277e198d0c476869253cb4e62807e14533c';

const snapshot: PositionSnapshot = {
  version: 'v3',
  tokenId: 42n,
  owner: '0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52',
  token0: { address: TOKEN_ADDRESS, symbol: 'RAETO', name: 'RAETO', decimals: 18 },
  token1: { address: USDG_ADDRESS, symbol: 'USDG', name: 'Global Dollar', decimals: 6 },
  hasNative: false,
  fee: 500,
  tickSpacing: 10,
  tickLower: -2000,
  tickUpper: 2000,
  liquidity: 10n ** 18n,
  sqrtPriceX96: 2n ** 96n,
  tick: 0,
  price: 0.00167,
  amount0: 25n * 10n ** 15n,
  amount1: 60n * 10n ** 6n,
  fees0: 10n ** 14n,
  fees1: 10n ** 5n,
  inRange: true,
  poolAddress: '0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a',
};

const valuation: Valuation = {
  amount0Human: 0.025,
  amount1Human: 60,
  price0Usd: 0.0015,
  price1Usd: 1,
  principalUsd: 48.2,
  fees0Human: 0.0001,
  fees1Human: 0.1,
  feesUsd: 1.25,
  valueUsd: 48.2,
  lowerPrice: 0.001,
  upperPrice: 0.002,
  nearestDistancePct: 40,
  distanceToLowerPct: 40.1,
  distanceToUpperPct: -19.8,
};

const pnl: PnlSummary = {
  feesEarnedUsd: 1.25,
  pendingFeesUsd: 1.25,
  withdrawnFeesUsd: 0,
  compoundedFeesUsd: 0,
  totalPnlUsd: 2.4,
  totalPnlPct: 5.1,
  aprPct: 12.4,
};

const tracked: TrackedPosition = {
  id: 'p1',
  chatId: 1,
  version: 'v3',
  tokenId: '42',
  entry: { amount0: '25000000000000000', amount1: '60000000', valueUsd: 48, price: 0.0015, openedAt: Date.now() - 7_200_000 },
  basisUsd: 48,
  feesWithdrawnUsd: 0,
  compoundedFeesUsd: 0,
  alerts: true,
  autoCompound: true,
  compoundIntervalMs: 21_600_000,
  compoundMinFeeUsd: 1,
  takeProfitPct: 30,
  stopLossPct: -20,
  autoTakeProfit: true,
  tpCycles: 3,
  rangeLabel: '-37% to -7%',
  cycle: 2,
  oorTakeProfit: true,
  lastRebalanceAt: Date.now() - 3_600_000,
  createdAt: Date.now() - 7_200_000,
};

describe('position rendering', () => {
  it('renders the compact card with the position number and the pair label', () => {
    const text = positionCard(tracked, snapshot, valuation, pnl, { autoTpTargetPct: 1.5 });

    expect(text).toContain('🟢 <b>#1 · RAETO/USDG</b> · Robinhood');
    expect(text).toContain('IN RANGE');
    expect(text).toContain('[■■■■■■■|□□□]');
    expect(text).toContain('67% Left');
    expect(text).toContain('💰 $48.20 · Fees $1.25');
    expect(text).toContain('📊 +$2.40 (+5.10%)');
    expect(text).toContain('🎯 TP +30% · SL -20%');
    expect(text).toContain('⚡ Auto-TP +1.5% · Cycle 2/3');
    // The second line: the state, the age, the strategy and the width of the
    // range. The old trailing lines are gone.
    expect(text).toContain('IN RANGE ⏱ Age 2h · Last rebalance 1h · Spot 30%');
    expect(text).not.toContain('Rebalance is manual');
    expect(text).not.toContain('Compound');
    expect(text).not.toContain('APR');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
  });

  it('never prints prices, amounts or the cost basis', () => {
    const text = positionCard(tracked, snapshot, valuation, pnl);
    expect(text).not.toContain('per RAETO');
    expect(text).not.toContain('basis');
    expect(text).not.toContain('Amounts');
    expect(text).not.toContain('0.0015');
  });

  it('omits the market cap line when there is no market cap', () => {
    const text = positionCard(tracked, snapshot, valuation, pnl);
    expect(text).not.toContain('MC ');
    expect(
      positionCard(tracked, snapshot, valuation, pnl, {
        marketCap: { fdvUsd: 1_300_000, priceUsd: 0.00167 },
      }),
    ).toContain('now $1,30M');
  });

  it('reads the width of the range from its label', () => {
    // "-37% to -7%" is a range that is 30% wide — that is what the card
    // shows next to the strategy.
    expect(rangeWidthPct(tracked)).toBe(30);
    expect(rangeWidthPct({ ...tracked, rangeLabel: '-33% to -1%' })).toBe(32);
    expect(rangeWidthPct({ ...tracked, rangeLabel: '-15% to +16%' })).toBe(31);
    // A position without a range label has no width to show.
    expect(rangeWidthPct({ ...tracked, rangeLabel: undefined })).toBeUndefined();
    expect(rangeWidthPct({ ...tracked, rangeLabel: 'nonsense' })).toBeUndefined();
  });

  it('scales the market cap with the range bounds', () => {
    // The traded token is token0 here, so the market cap follows the price.
    const line = marketCapLine(snapshot, valuation, { fdvUsd: 1_300_000, priceUsd: 0.00167 });
    expect(line).toBe('MC $778,44K → $1,56M · now $1,30M');
  });

  it('flags out of range positions', () => {
    // The price is below the lower bound, so the position is OOR LEFT.
    const text = positionCard(
      tracked,
      { ...snapshot, inRange: false, tick: -3000, price: 0.0009 },
      { ...valuation, nearestDistancePct: -3.2 },
      pnl,
    );
    // Out of range is orange: the position needs attention, whatever the PnL.
    expect(text).toContain('🟠 <b>#1 · RAETO/USDG</b> · Robinhood');
    expect(text).toContain('OUT OF RANGE · LEFT');
    expect(text).toContain('OOR LEFT');
  });

  it('colours a position by its profit', () => {
    expect(
      positionRow(tracked, snapshot, valuation, { ...pnl, totalPnlPct: 5.1 }),
    ).toContain('🟢 <b>#1 · RAETO/USDG</b>');
    expect(
      positionRow(tracked, snapshot, valuation, { ...pnl, totalPnlPct: -5.1 }),
    ).toContain('🔴 <b>#1 · RAETO/USDG</b>');
  });

  it('reports OOR RIGHT when the price is above the upper bound', () => {
    const text = positionCard(
      tracked,
      { ...snapshot, inRange: false, tick: 3000, price: 0.0021 },
      { ...valuation, nearestDistancePct: -3.2 },
      pnl,
    );
    expect(text).toContain('OUT OF RANGE · RIGHT');
    expect(text).toContain('OOR RIGHT');
  });

  it('reads the side from the traded token, not from the pool price', () => {
    // A pool that stores the traded token as token1 has the pool price
    // inverted: the token is *below* its range while the pool price is above
    // it. The card has to say LEFT all the same.
    const inverted = {
      ...snapshot,
      token0: snapshot.token1,
      token1: snapshot.token0,
      price: 0.0025,
      inRange: false,
    };
    const text = positionCard(tracked, inverted, valuation, pnl);
    expect(text).toContain('OUT OF RANGE · LEFT');
    expect(text).toContain('OOR LEFT');
  });

  it('renders a compact list row', () => {
    const row = positionRow(tracked, snapshot, valuation, pnl);
    expect(row).toContain('🟢 <b>#1 · RAETO/USDG</b> · Robinhood');
    expect(row).toContain('[■■■■■■■|□□□] 67% Left');
    expect(row).toContain('$48.20 · PnL +5.10% · Fees $1.25');
  });

  it('numbers positions and labels the pair', () => {
    expect(positionNumber('p1')).toBe('#1');
    expect(positionNumber('p42')).toBe('#42');
    expect(positionNumber('weird')).toBe('weird');
    expect(positionPair(snapshot)).toBe('RAETO/USDG');
    expect(positionPair({ ...snapshot, token0: snapshot.token1, token1: snapshot.token0 })).toBe(
      'RAETO/USDG',
    );
  });

  it('escapes token symbols', () => {
    const nasty = {
      ...snapshot,
      token0: { ...snapshot.token0, symbol: '<b>x</b>' },
    };
    const text = positionCard(tracked, nasty, valuation, pnl);
    expect(text).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(text).not.toContain('<b>x</b>');
  });

  it('draws the price inside the range', () => {
    const visual = rangeVisual(valuation, snapshot);
    expect(visual.bar).toBe('[■■■■■■■|□□□]');
    expect(visual.label).toBe('67% Left');
    expect(visual.oor).toBeNull();
  });

  it('marks a price that left the range', () => {
    // The side comes from the price against the bounds, not from the tick:
    // a pool that stores the traded token as token1 has the pool price
    // inverted.
    // Below the range: the marker sits left of it and the arrow points left.
    const below = rangeVisual(valuation, { ...snapshot, inRange: false, tick: -3000, price: 0.0009 });
    expect(below.oor).toBe('left');
    expect(below.label).toBe('OOR LEFT');
    expect(below.bar).toBe('←[|□□□□□□□□□□]');

    // Above the range: the marker sits right of it and the arrow points right.
    const above = rangeVisual(valuation, { ...snapshot, inRange: false, tick: 3000, price: 0.0021 });
    expect(above.oor).toBe('right');
    expect(above.label).toBe('OOR RIGHT');
    expect(above.bar).toBe('[■■■■■■■■■■|]→');
  });

  it('escapes token symbols in pool lines', () => {
    const pool: V3Pool = {
      version: 'v3',
      address: '0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a',
      token0: snapshot.token0,
      token1: snapshot.token1,
      fee: 500,
      tickSpacing: 10,
      sqrtPriceX96: 2n ** 96n,
      tick: 0,
      liquidity: 10n ** 18n,
      price: 2400,
      label: 'v3 0.05%',
    };
    expect(poolLine(pool, 12345)).toContain('v3 0.05%');
    expect(poolLine(pool, Number.NaN)).not.toContain('depth');
  });
});
