import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import { decideExit } from '../src/monitor/exits.js';
import { parseExitRules } from '../src/bot/positionsFlow.js';
import { exitRulesLine } from '../src/bot/ui.js';
import { nextSort, scanKeyboard, scanText, visiblePools } from '../src/bot/poolList.js';
import { safetyIcon, safetyText, type SafetyReport } from '../src/core/safety.js';
import type { V4Pool } from '../src/core/pools.js';
import type { PoolHealth, ScannedPool, TokenScan } from '../src/core/scanner.js';
import type { TokenInfo } from '../src/core/tokens.js';
import type { TrackedPosition } from '../src/store/store.js';

const RAETO: TokenInfo = {
  address: '0x72be1277e198d0c476869253cb4e62807e14533c',
  symbol: 'RAETO',
  name: 'RAETO',
  decimals: 18,
};
const USDG: TokenInfo = {
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  symbol: 'USDG',
  name: 'Global Dollar',
  decimals: 6,
};

function pool(id: string, fee = 3000): V4Pool {
  return {
    version: 'v4',
    poolId: `0x${id.padEnd(64, '0')}` as `0x${string}`,
    key: { currency0: USDG.address, currency1: RAETO.address, fee, tickSpacing: 100, hooks: zeroAddress },
    token0: USDG,
    token1: RAETO,
    fee,
    lpFee: fee,
    tickSpacing: 100,
    sqrtPriceX96: 1n << 96n,
    tick: 0,
    liquidity: 10n ** 18n,
    price: 663,
    label: 'v4 0.3%',
  };
}

function entry(id: string, health: PoolHealth, tvlUsd: number, aprPct: number): ScannedPool {
  return {
    pool: pool(id),
    tvlUsd,
    volume24hUsd: tvlUsd / 2,
    aprPct,
    priceUsd: 0.0015,
    deviationPct: health === 'broken' ? -40 : 0,
    health,
  };
}

const scan: TokenScan = {
  token: RAETO,
  pools: [
    entry('a1', 'ok', 1_000, 50),
    entry('a2', 'broken', 3_000, 10),
    entry('a3', 'warn', 2_000, 900),
  ],
  listed: 3,
  totalTvlUsd: 6_000,
  marketCapUsd: 100_000,
  tvlToMcap: 0.06,
  referencePriceUsd: 0.0015,
};

describe('TP/SL rules', () => {
  it('accepts a pair, single leg and clear', () => {
    expect(parseExitRules('30 -20')).toEqual({ takeProfitPct: 30, stopLossPct: -20 });
    expect(parseExitRules('tp 30')).toEqual({ takeProfitPct: 30 });
    expect(parseExitRules('sl -20')).toEqual({ stopLossPct: -20 });
    expect(parseExitRules('sl 20')).toEqual({ stopLossPct: -20 });
    expect(parseExitRules('clear')).toEqual({ clear: true });
  });

  it('rejects nonsense instead of guessing', () => {
    expect(parseExitRules('hello').error).toBeDefined();
    expect(parseExitRules('0').error).toBeDefined();
    expect(parseExitRules('sl 100').error).toBeDefined();
    expect(parseExitRules('tp -5').error).toBeDefined();
  });

  it('fires only on the armed rule', () => {
    const base = { aboveRange: false, autoTpTargetPct: 1 };
    expect(decideExit({ ...base, pnlPct: 31, takeProfitPct: 30, stopLossPct: -20 })).toBe('takeProfit');
    expect(decideExit({ ...base, pnlPct: 30, takeProfitPct: 30, stopLossPct: -20 })).toBe('takeProfit');
    expect(decideExit({ ...base, pnlPct: -20, takeProfitPct: 30, stopLossPct: -20 })).toBe('stopLoss');
    expect(decideExit({ ...base, pnlPct: -19.9, takeProfitPct: 30, stopLossPct: -20 })).toBeUndefined();
    expect(decideExit({ ...base, pnlPct: 5 })).toBeUndefined();
    expect(decideExit({ ...base, pnlPct: Number.NaN, takeProfitPct: 30, stopLossPct: -20 })).toBeUndefined();
  });

  it('prefers the OOR take profit above the range and auto-TP last', () => {
    const base = { pnlPct: 5, autoTpTargetPct: 1, aboveRange: true };
    expect(decideExit({ ...base, oorTakeProfit: true })).toBe('oorTakeProfit');
    expect(decideExit({ ...base, aboveRange: false, autoTakeProfit: true })).toBe('autoTakeProfit');
    expect(decideExit({ ...base, aboveRange: false, takeProfitPct: 30 })).toBeUndefined();
  });

  it('renders the armed rules on the card', () => {
    const base = { takeProfitPct: 30, stopLossPct: -20 } as TrackedPosition;
    expect(exitRulesLine(base)).toBe('🎯 TP +30% · SL -20%');
    expect(exitRulesLine({ takeProfitPct: 30 } as TrackedPosition)).toBe('🎯 TP +30%');
    expect(exitRulesLine({} as TrackedPosition)).toBeUndefined();
  });
});

describe('pool sorting and filters', () => {
  it('cycles the sort mode', () => {
    expect(nextSort('tvl')).toBe('apr');
    expect(nextSort('apr')).toBe('vol');
    expect(nextSort('vol')).toBe('tvl');
    expect(nextSort(undefined)).toBe('apr');
  });

  it('orders by the selected metric and hides broken pools', () => {
    expect(visiblePools(scan, { sort: 'tvl' }).map((p) => p.tvlUsd)).toEqual([3_000, 2_000, 1_000]);
    expect(visiblePools(scan, { sort: 'apr' }).map((p) => Math.round(p.aprPct))).toEqual([900, 50, 10]);
    expect(visiblePools(scan, { sort: 'vol' }).map((p) => p.volume24hUsd)).toEqual([1_500, 1_000, 500]);
    expect(visiblePools(scan, { sort: 'tvl', hideBroken: true })).toHaveLength(2);
  });

  it('reflects the sort and filter in the message and keyboard', () => {
    const text = scanText(scan, 0, { sort: 'apr', hideBroken: true });
    expect(text).toContain('found (by APR)');
    expect(text).toContain('Filter: broken-price pools hidden.');
    expect(text).not.toContain('4.4%');

    const buttons = scanKeyboard(scan, 0, { sort: 'apr', hideBroken: true })
      .inline_keyboard.flat()
      .map((b) => b.text);
    expect(buttons).toContain('⇅ Sort: APR');
    expect(buttons).toContain('Hide ❌: on');
  });
});

describe('safety report rendering', () => {
  const report: SafetyReport = {
    ok: false,
    danger: true,
    sellTaxPct: 42,
    checks: [
      { label: 'Buy/sell simulation', status: 'fail', detail: 'the sell leg of the simulation reverted' },
      { label: 'Supply', status: 'pass', detail: 'no mint entry point found' },
    ],
  };

  it('renders each check with its icon and blocks on failure', () => {
    const text = safetyText(report, pool('s1'), RAETO);
    expect(text).toContain('❌ <b>Buy/sell simulation</b>');
    expect(text).toContain('✅ <b>Supply</b>');
    expect(text).toContain('Blocked');
    expect(safetyIcon(report)).toBe('❌');
  });

  it('treats warnings as non-blocking', () => {
    const warned: SafetyReport = {
      ok: true,
      danger: false,
      sellTaxPct: 5,
      checks: [{ label: 'Buy/sell simulation', status: 'warn', detail: 'round trip loses 5.0% beyond fees' }],
    };
    expect(safetyText(warned, pool('s2'), RAETO)).toContain('Warnings only');
    expect(safetyIcon(warned)).toBe('⚠️');
  });
});
