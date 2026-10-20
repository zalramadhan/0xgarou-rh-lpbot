import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import {
  clampPage,
  feeLabel,
  fmtApr,
  fmtPriceUsd,
  pageCount,
  scanKeyboard,
  scanText,
  POOLS_PER_PAGE,
} from '../src/bot/poolList.js';
import { fmtCompactUsd } from '../src/utils/format.js';
import type { Pool, V4Pool } from '../src/core/pools.js';
import type { ScannedPool, TokenScan } from '../src/core/scanner.js';
import type { TokenInfo } from '../src/core/tokens.js';

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

function v4Pool(fee: number, lpFee: number, id: string): V4Pool {
  return {
    version: 'v4',
    poolId: `0x${id.padEnd(64, '0')}` as `0x${string}`,
    key: { currency0: USDG.address, currency1: RAETO.address, fee, tickSpacing: 100, hooks: zeroAddress },
    token0: USDG,
    token1: RAETO,
    fee,
    lpFee,
    tickSpacing: 100,
    sqrtPriceX96: 1n,
    tick: 0,
    liquidity: 0n,
    price: 663.3,
    label: `v4 ${fee / 10_000}%`,
  };
}

function scanned(pool: Pool, overrides: Partial<ScannedPool>): ScannedPool {
  return {
    pool,
    tvlUsd: 0,
    volume24hUsd: 0,
    aprPct: Number.NaN,
    priceUsd: Number.NaN,
    deviationPct: Number.NaN,
    health: 'ok',
    ...overrides,
  };
}

const big = scanned(v4Pool(50000, 50000, 'a1'), {
  tvlUsd: 59_643,
  volume24hUsd: 189_800,
  aprPct: 5_816,
  priceUsd: 0.001492,
  deviationPct: 0,
  health: 'ok',
});
const thin = scanned(v4Pool(10000, 10000, 'b2'), {
  tvlUsd: 179.24,
  volume24hUsd: 369.65,
  aprPct: 753,
  priceUsd: 0.001431,
  deviationPct: -4,
  health: 'warn',
});
const broken = scanned(v4Pool(44000, 44000, 'c3'), {
  tvlUsd: 331.81,
  volume24hUsd: 6_600,
  aprPct: 32_053,
  priceUsd: 0.001001,
  deviationPct: -33,
  health: 'broken',
});

const scan: TokenScan = {
  token: RAETO,
  pools: [big, thin, broken],
  listed: 3,
  totalTvlUsd: 60_154,
  marketCapUsd: 1_519_764,
  tvlToMcap: 0.0396,
  referencePriceUsd: 0.001492,
};

describe('pool scan formatting', () => {
  it('renders the header, market ratio and per-pool block', () => {
    const text = scanText(scan, 0);
    expect(text).toContain('Pools · 3 found (by TVL) · page 1/1');
    expect(text).toContain('Global TVL/MCAP: 0.04 🔴');
    expect(text).toContain('<b>1.</b> RAETO/USDG · ⚡ Uni v4 · 5.0% fee');
    expect(text).toContain('💰 TVL $59.6K');
    expect(text).toContain('📈 APR 5,816%');
    expect(text).toContain('📊 24h $189.8K');
    expect(text).toContain('💵 Price: $0.001492');
  });

  it('flags thin and broken pools', () => {
    const text = scanText(scan, 0);
    expect(text).toContain('RAETO/USDG · ⚠️ Uni v4 · 1.0% fee');
    expect(text).toContain('⚠️ Thin liquidity');
    expect(text).toContain('RAETO/USDG · ❌ Uni v4 · 4.4% fee');
    expect(text).toContain('❌ Price broken vs the market');
    expect(text).toContain('🛑 = Low liquidity');
  });

  it('keeps the pasted token first even when it is token1', () => {
    expect(scanText(scan, 0)).toContain('RAETO/USDG');
    expect(scanText(scan, 0)).not.toContain('USDG/RAETO');
  });
});

describe('pool scan paging', () => {
  const many: TokenScan = {
    ...scan,
    pools: Array.from({ length: 12 }, (_, i) => scanned(v4Pool(3000, 3000, `p${i}`), { tvlUsd: 100 + i })),
    listed: 30,
  };

  it('splits pools into pages', () => {
    expect(pageCount(many)).toBe(Math.ceil(12 / POOLS_PER_PAGE));
    expect(scanText(many, 0)).toContain(`page 1/${pageCount(many)}`);
    expect(scanText(many, 1)).toContain(`page 2/${pageCount(many)}`);
    expect(scanText(many, 1)).toContain(`<b>${POOLS_PER_PAGE + 1}.</b>`);
  });

  it('clamps out-of-range pages and reports truncation', () => {
    expect(clampPage(-3, many)).toBe(0);
    expect(clampPage(99, many)).toBe(pageCount(many) - 1);
    expect(scanText(many, 99)).toContain(`page ${pageCount(many)}/${pageCount(many)}`);
    expect(scanText(many, 0)).toContain('Showing the 12 deepest pools');
  });

  it('builds selection and paging buttons', () => {
    const rows = scanKeyboard(many, 0).inline_keyboard.map((row) => row.map((button) => button.text));
    expect(rows[0]![0]).toContain('1. v4 0.3%');
    expect(rows.flat()).toContain(`Next ▶`);
    expect(rows.flat()).toContain('🔄 Rescan');
  });
});

describe('number formatting', () => {
  it('formats fees with up to three decimals', () => {
    expect(feeLabel(v4Pool(50000, 50000, 'a'))).toBe('5.0%');
    expect(feeLabel(v4Pool(27500, 27500, 'b'))).toBe('2.75%');
    expect(feeLabel(v4Pool(50130, 50130, 'c'))).toBe('5.013%');
    expect(feeLabel(v4Pool(500, 500, 'd'))).toBe('0.05%');
  });

  it('compacts USD values like the scan view', () => {
    expect(fmtCompactUsd(59_643)).toBe('$59.6K');
    expect(fmtCompactUsd(376.92)).toBe('$376.92');
    expect(fmtCompactUsd(1_500_000)).toBe('$1.5M');
    expect(fmtCompactUsd(Number.NaN)).toBe('—');
  });

  it('formats APR and token prices', () => {
    expect(fmtApr(5_816)).toBe('5,816%');
    expect(fmtApr(350_771)).toBe('350,771%');
    expect(fmtApr(Number.NaN)).toBe('—');
    expect(fmtPriceUsd(0.001492)).toBe('0.001492');
    expect(fmtPriceUsd(1.23456)).toBe('1.23');
  });
});
