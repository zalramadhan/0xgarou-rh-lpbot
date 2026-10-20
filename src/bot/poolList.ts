import { InlineKeyboard } from 'grammy';
import type { Pool } from '../core/pools.js';
import type { PoolHealth, ScannedPool, TokenScan } from '../core/scanner.js';
import type { TokenInfo } from '../core/tokens.js';
import { esc, fmtCompactUsd } from '../utils/format.js';

export const POOLS_PER_PAGE = 5;

export type SortMode = 'tvl' | 'apr' | 'vol';

export interface PoolViewOptions {
  sort?: SortMode;
  hideBroken?: boolean;
}

const SORT_LABEL: Record<SortMode, string> = { tvl: 'TVL', apr: 'APR', vol: '24h volume' };
const SORT_ORDER: SortMode[] = ['tvl', 'apr', 'vol'];

/** Next sort mode when the user taps the sort button. */
export function nextSort(current: SortMode | undefined): SortMode {
  const index = SORT_ORDER.indexOf(current ?? 'tvl');
  return SORT_ORDER[(index + 1) % SORT_ORDER.length]!;
}

const finite = (value: number) => (Number.isFinite(value) ? value : -1);

/** Pools in display order, after the active filter. */
export function visiblePools(scan: TokenScan, options: PoolViewOptions = {}): ScannedPool[] {
  const list = options.hideBroken ? scan.pools.filter((p) => p.health !== 'broken') : [...scan.pools];
  const sort = options.sort ?? 'tvl';
  return list.sort((a, b) =>
    sort === 'apr'
      ? finite(b.aprPct) - finite(a.aprPct)
      : sort === 'vol'
        ? b.volume24hUsd - a.volume24hUsd
        : b.tvlUsd - a.tvlUsd,
  );
}

const HEALTH_ICON: Record<PoolHealth, string> = {
  ok: '⚡',
  warn: '⚠️',
  blocked: '🛑',
  broken: '❌',
};

const HEALTH_NOTE: Record<PoolHealth, string | undefined> = {
  ok: undefined,
  warn: 'Thin liquidity · expect heavy slippage when you exit.',
  blocked: 'Liquidity too low · your deposit alone would move the price.',
  broken: 'Price broken vs the market · opening here trades your funds away. Avoid.',
};

/** 5.000% → "5.0%", 2.750% → "2.75%", 5.013% → "5.013%" */
export function feeLabel(pool: Pool): string {
  const raw = pool.version === 'v3' ? pool.fee : pool.lpFee;
  if (raw >= 0x100000) return 'dynamic';
  const pct = raw / 10_000;
  const text = pct.toFixed(3).replace(/0+$/, '');
  return `${text.endsWith('.') ? `${text}0` : text}%`;
}

export function fmtApr(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return `${Math.round(value).toLocaleString('en-US')}%`;
}

export function fmtPriceUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return value.toPrecision(4);
}

export function pageCount(scan: TokenScan, options: PoolViewOptions = {}): number {
  return Math.max(1, Math.ceil(visiblePools(scan, options).length / POOLS_PER_PAGE));
}

function pagePools(scan: TokenScan, page: number, options: PoolViewOptions = {}): ScannedPool[] {
  const start = clampPage(page, scan, options) * POOLS_PER_PAGE;
  return visiblePools(scan, options).slice(start, start + POOLS_PER_PAGE);
}

export function clampPage(page: number, scan: TokenScan, options: PoolViewOptions = {}): number {
  const last = pageCount(scan, options) - 1;
  return Math.min(Math.max(0, Number.isFinite(page) ? Math.trunc(page) : 0), last);
}

/** Pasted token first, like the market convention (RAETO/USDG). */
function pairLabel(pool: Pool, token: TokenInfo): string {
  const tokenFirst = pool.token0.address.toLowerCase() === token.address.toLowerCase()
    ? pool.token0.symbol
    : pool.token1.symbol;
  const other = tokenFirst === pool.token0.symbol ? pool.token1.symbol : pool.token0.symbol;
  return `${tokenFirst}/${other}`;
}

function healthDot(ratio: number): string {
  if (!Number.isFinite(ratio)) return '⚪';
  if (ratio < 0.1) return '🔴';
  if (ratio < 0.3) return '🟡';
  return '🟢';
}

function poolBlock(rank: number, entry: ScannedPool, token: TokenInfo): string[] {
  const { pool } = entry;
  const icon = HEALTH_ICON[entry.health];
  const lines = [
    `<b>${rank}.</b> ${esc(pairLabel(pool, token))} · ${icon} Uni ${pool.version} · ${feeLabel(pool)} fee`,
    `   💰 TVL ${fmtCompactUsd(entry.tvlUsd)}  ·  📈 APR ${fmtApr(entry.aprPct)}  ·  📊 24h ${fmtCompactUsd(entry.volume24hUsd)}`,
    `   💵 Price: $${fmtPriceUsd(entry.priceUsd)}`,
  ];
  const note = HEALTH_NOTE[entry.health];
  if (note) lines.push(`   ${icon} ${esc(note)}`);
  return lines;
}

export function scanText(scan: TokenScan, page: number, options: PoolViewOptions = {}): string {
  const current = clampPage(page, scan, options);
  const total = pageCount(scan, options);
  const shown = pagePools(scan, current, options);
  const found = Math.max(scan.listed, scan.pools.length);
  const sort = options.sort ?? 'tvl';

  const lines = [
    `<b>Pools · ${found} found (by ${SORT_LABEL[sort]}) · page ${current + 1}/${total}</b>`,
    `📊 Global TVL/MCAP: ${formatRatio(scan.tvlToMcap)} ${healthDot(scan.tvlToMcap)}`,
  ];
  if (scan.listed > scan.pools.length) {
    lines.push(`Showing the ${scan.pools.length} deepest pools that can be traded — the rest are dust.`);
  }
  if (options.hideBroken) lines.push(`Filter: broken-price pools hidden.`);

  const start = current * POOLS_PER_PAGE;
  shown.forEach((entry, index) => {
    lines.push('────────────', ...poolBlock(start + index + 1, entry, scan.token));
  });
  lines.push(
    '────────────',
    '⚡ = Normal  ·  ⚠️ = Warning  ·  🛑 = Low liquidity  ·  ❌ = Broken price',
    total > 1 ? 'Tap a pool to select it, or page through the list.' : 'Tap a pool below to select it.',
  );
  return lines.join('\n');
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 100) return Math.round(value).toString();
  return value.toFixed(2);
}

export function scanKeyboard(scan: TokenScan, page: number, options: PoolViewOptions = {}): InlineKeyboard {
  const current = clampPage(page, scan, options);
  const total = pageCount(scan, options);
  const shown = pagePools(scan, current, options);
  const kb = new InlineKeyboard();

  shown.forEach((entry, index) => {
    const rank = current * POOLS_PER_PAGE + index;
    const icon = HEALTH_ICON[entry.health];
    kb.text(`${icon} ${rank + 1}. ${entry.pool.version} ${feeLabel(entry.pool)}`, `new:pool:${rank}`);
    if (index % 2 === 1) kb.row();
  });
  if (shown.length % 2 === 1) kb.row();

  if (total > 1) {
    if (current > 0) kb.text('◀ Prev', `new:page:${current - 1}`);
    kb.text(`${current + 1}/${total}`, 'new:noop');
    if (current < total - 1) kb.text('Next ▶', `new:page:${current + 1}`);
    kb.row();
  }

  kb.text(`⇅ Sort: ${SORT_LABEL[options.sort ?? 'tvl']}`, 'new:sort:next').text(
    `Hide ❌: ${options.hideBroken ? 'on' : 'off'}`,
    'new:filter:toggle',
  );
  kb.row().text('🔄 Rescan', 'new:rescan').text('✖ Cancel', 'new:cancel');
  kb.row().text('🏠 Menu', 'menu:home');
  return kb;
}
