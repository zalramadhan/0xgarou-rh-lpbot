import { describe, expect, it } from 'vitest';
import {
  backInRangeNotification,
  exitNotification,
  outOfRangeNotification,
} from '../src/monitor/notifyText.js';
import { alertKeyboard } from '../src/monitor/monitor.js';
import { positionKeyboard } from '../src/bot/ui.js';
import type { PositionSnapshot } from '../src/core/positions.js';
import type { PnlSummary, Valuation } from '../src/core/valuation.js';
import type { TrackedPosition } from '../src/store/store.js';

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
  principalUsd: 51.15,
  fees0Human: 0.0001,
  fees1Human: 0.1,
  feesUsd: 1.25,
  valueUsd: 52.4,
  lowerPrice: 0.001,
  upperPrice: 0.002,
  nearestDistancePct: 3.2,
  distanceToLowerPct: 3.2,
  distanceToUpperPct: -19.8,
};

const pnl: PnlSummary = {
  feesEarnedUsd: 1.25,
  pendingFeesUsd: 1.25,
  withdrawnFeesUsd: 0,
  compoundedFeesUsd: 0,
  totalPnlUsd: 21,
  totalPnlPct: 40,
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
  autoCompound: false,
  compoundIntervalMs: 21_600_000,
  compoundMinFeeUsd: 1,
  createdAt: Date.now() - 7_200_000,
};

const alert = { tracked, snapshot, valuation, marketCapUsd: 1_300_000 };

describe('out of range notification', () => {
  it('shows the side, the bar and the distance to the nearest bound', () => {
    // The price is below the lower bound of the range.
    const text = outOfRangeNotification(
      { ...alert, snapshot: { ...snapshot, inRange: false, tick: -3000, price: 0.0009 } },
    );

    expect(text).toContain('🔴 RAETO/USDG');
    expect(text).toContain('←[|□□□□□□□□□□] OOR LEFT');
    // The market cap at the bounds follows the price: it is below the range
    // now, so the token has to grow to reach the bounds again.
    expect(text).toContain('🏦 MC $1,44M → $2,89M · now $1,30M');
    expect(text).toContain('below the lower bound');
    expect(text).toContain('🔄 Rebalance is manual');
  });

  it('puts the PnL right under the range', () => {
    const text = outOfRangeNotification(
      { ...alert, pnl, idrRate: 16_000, snapshot: { ...snapshot, inRange: false, tick: -3000, price: 0.0009 } },
    );

    const lines = text.split('\n');
    const mcap = lines.findIndex((line) => line.includes('MC '));
    const pnlLine = lines.findIndex((line) => line.includes('📊'));
    expect(mcap).toBeGreaterThan(-1);
    // The range block is framed, and the PnL follows it right away.
    expect(lines[mcap + 1]).toBe('─────────────────────────────');
    expect(pnlLine).toBe(mcap + 2);
    expect(text).toContain('📊 +$21.00 (+40.00%)');
  });

  it('uses OOR RIGHT above the upper bound', () => {
    const text = outOfRangeNotification(
      { ...alert, snapshot: { ...snapshot, inRange: false, tick: 3000, price: 0.0021 } },
    );
    expect(text).toContain('OOR RIGHT');
    expect(text).toContain('above the upper bound');
    expect(text).toContain('🔄 Rebalance is manual');
  });

  it('reads the side from the traded token, not from the pool price', () => {
    // A pool that stores the traded token as token1 has the pool price
    // inverted: the token sits *below* its range while the pool price is
    // above it. The alert has to say LEFT all the same.
    const inverted = {
      ...snapshot,
      token0: snapshot.token1,
      token1: snapshot.token0,
      price: 0.0025,
      inRange: false,
    };
    const text = outOfRangeNotification({ ...alert, snapshot: inverted });
    expect(text).toContain('OOR LEFT');
    expect(text).not.toContain('OOR RIGHT');
  });

  it('omits the market cap line when there is none', () => {
    const text = outOfRangeNotification(
      { ...alert, marketCapUsd: Number.NaN, snapshot: { ...snapshot, inRange: false, tick: -3000, price: 0.0009 } },
    );
    expect(text).not.toContain('MC ');
    expect(text).not.toContain('NaN');
  });

  it('says that the rebalance is manual', () => {
    const text = outOfRangeNotification(
      {
        ...alert,
        snapshot: { ...snapshot, inRange: false, tick: -3000, price: 0.0009 },
      },
    );
    expect(text).toContain('Rebalance is manual');
  });
});

describe('back in range notification', () => {
  it('announces the distance to the nearest bound', () => {
    const text = backInRangeNotification(alert);

    expect(text).toContain('🟢 RAETO/USDG');
    expect(text).toContain('[■■■■■■■|□□□] 67% Left');
    expect(text).toContain('🏦 MC $778,44K → $1,56M · now $1,30M');
    expect(text).toContain('from the nearest bound');
  });
});

describe('exit notification', () => {
  const base = {
    kind: 'takeProfit' as const,
    tracked,
    snapshot,
    valuation,
    pnl,
    result: {},
    cycle: 1,
    limit: 3,
    dryRun: false,
    explorerUrl: 'https://explorer.example',
  };

  it('names the exit reason, the pair and the realized PnL', () => {
    const text = exitNotification(base);

    expect(text).toContain('<b>🎯 Take Profit · #1</b>');
    expect(text).toContain('RAETO/USDG · +40.00%');
    expect(text).toContain('💰 Closed $52.40 · Fees $1.25');
    expect(text).toContain('✅ Position closed');
    expect(text).not.toContain('Re-entered');
  });

  it('uses the right label for every exit reason', () => {
    const labels = [
      ['manual', '🔒 Manual Close'],
      ['takeProfit', '🎯 Take Profit'],
      ['stopLoss', '🛑 Stop Loss'],
      ['oorTakeProfit', '📈 OOR Take Profit'],
      ['autoTakeProfit', '⚡ Auto-TP'],
    ] as const;

    for (const [kind, label] of labels) {
      expect(exitNotification({ ...base, kind })).toContain(`<b>${label} · #1</b>`);
    }
  });

  it('reports the re-entry with the new position number', () => {
    const text = exitNotification({
      ...base,
      kind: 'autoTakeProfit',
      cycle: 2,
      result: { reentered: { ...tracked, id: 'p7' } },
    });

    expect(text).toContain('🔄 Re-entered as <b>#7</b> · Cycle 3/3');
    expect(text).toContain('Same range width and allocation');
  });

  it('reports a failed re-entry instead of hiding it', () => {
    const text = exitNotification({
      ...base,
      kind: 'autoTakeProfit',
      result: { error: 're-entry failed: mint reverted' },
    });

    expect(text).toContain('⚠️ Re-entry failed: mint reverted');
    expect(text).not.toContain('Re-entered as');
  });

  it('says when the last cycle does not re-enter', () => {
    const text = exitNotification({ ...base, kind: 'autoTakeProfit', cycle: 3, limit: 3 });
    expect(text).toContain('🏁 Cycle 3/3 was the last one — not re-entering.');
  });

  it('says that USDG came back for a USDG-only position', () => {
    const text = exitNotification({
      ...base,
      snapshot: { ...snapshot, amount0: 0n },
    });
    expect(text).toContain('✅ Position closed · USDG recovered');
  });

  it('marks a dry-run as simulated', () => {
    const text = exitNotification({ ...base, dryRun: true });
    expect(text).toContain('🧪 Simulated (dry-run)');
    expect(text).not.toContain('✅ Position closed');
  });
});

describe('keyboard callbacks', () => {
  it('keeps the alert actions', () => {
    const data = alertKeyboard('p1')
      .inline_keyboard.flat()
      .map((button) => (button as { callback_data?: string }).callback_data);
    expect(data).toEqual(['pos:show:p1', 'act:refresh:p1', 'act:rebalance:p1', 'act:close:p1']);
  });

  it('keeps the position actions', () => {
    const data = positionKeyboard('p1', tracked, true)
      .inline_keyboard.flat()
      .map((button) => (button as { callback_data?: string }).callback_data);
    for (const action of [
      'act:collect:p1',
      'act:refresh:p1',
      'act:tpsl:p1',
      'act:close:p1',
      'act:toggleCompound:p1',
      'act:toggleAutoTp:p1',
      'act:toggleOor:p1',
      'act:cycles:p1',
      'act:rebalance:p1',
      'act:toggleAlerts:p1',
      'act:untrack:p1',
    ]) {
      expect(data).toContain(action);
    }
  });
});
