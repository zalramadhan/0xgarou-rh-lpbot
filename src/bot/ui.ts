import { InlineKeyboard } from 'grammy';
import { BID_ASK_ENTRY_CHOICES } from '../constants/bidAsk.js';
import { AUTO_SWAP_MIN_CHOICES } from '../constants/autoSwap.js';
import { ROUTE_DISCOUNT_CHOICES } from '../constants/routeImpact.js';
import { DISPLAY_CURRENCIES } from '../constants/currency.js';
import { TIME_ZONES } from '../constants/timezone.js';
import { TOKENS } from '../constants/chain.js';
import { bidAskAllocations, bidAskWeights } from '../core/bidAsk.js';
import type { Pool } from '../core/pools.js';
import type { PositionSnapshot } from '../core/positions.js';
import type { Valuation, PnlSummary } from '../core/valuation.js';
import type { TokenInfo } from '../core/tokens.js';
import type { ChatSettings, TrackedPosition } from '../store/store.js';
import {
  esc,
  fmtCompactDuration,
  fmtCompactUsd,
  fmtMcapUsd,
  fmtPct,
  fmtPrice,
  fmtSignedUsd,
  fmtUsd,
  shortAddr,
} from '../utils/format.js';
import { fmtIdr } from '../core/fx.js';
import { config } from '../config.js';
import { chartTokenAddress, gmgnTokenLink, lpAgentPortfolioLink } from './links.js';
import { quoteToken, rangeForToken, tokenPrice, tradedRange } from '../core/pairs.js';
import { tokenSupply, UNKNOWN_MARKET_CAP, type MarketCap } from '../core/scanner.js';
import { tickToPrice } from '../core/math/tickMath.js';

export function txLink(hash: string): string {
  return `${config.explorerUrl}/tx/${hash}`;
}

function addressLink(address: string): string {
  return `${config.explorerUrl}/address/${address}`;
}

const USDG_ADDRESS = TOKENS.USDG.toLowerCase();


/** Cells in the range bar, the marker aside. */
const RANGE_BAR_CELLS = 10;

/** "#1" for the tracked id "p1"; anything else is shown as-is. */
export function positionNumber(id: string): string {
  const match = /^p(\d+)$/.exec(id);
  return match ? `#${match[1]}` : id;
}

/** The traded side of the pair: the token that is not USDG. */
export function tradedToken(pair: { token0: TokenInfo; token1: TokenInfo }): TokenInfo {
  const token0 = pair.token0.address.toLowerCase();
  const token1 = pair.token1.address.toLowerCase();
  if (token0 === USDG_ADDRESS) return pair.token1;
  if (token1 === USDG_ADDRESS) return pair.token0;
  return pair.token0;
}

/** "TOKEN/USDG" — the traded token first, the USDG quote last. */
export function positionPair(pair: { token0: TokenInfo; token1: TokenInfo }): string {
  const token0 = pair.token0.address.toLowerCase();
  const token1 = pair.token1.address.toLowerCase();
  if (token0 === USDG_ADDRESS) return `${pair.token1.symbol}/USDG`;
  if (token1 === USDG_ADDRESS) return `${pair.token0.symbol}/USDG`;
  return `${pair.token0.symbol}/${pair.token1.symbol}`;
}

/** True when the position only holds USDG, so its proceeds are already USDG. */
export function holdsOnlyUsdg(snapshot: PositionSnapshot): boolean {
  const token0 = snapshot.token0.address.toLowerCase();
  const token1 = snapshot.token1.address.toLowerCase();
  if (token0 === USDG_ADDRESS && token1 !== USDG_ADDRESS) return snapshot.amount1 === 0n;
  if (token1 === USDG_ADDRESS && token0 !== USDG_ADDRESS) return snapshot.amount0 === 0n;
  return false;
}

/** The rule that frames the range block on the position screen and the alerts. */
export const RANGE_FRAME = '─────────────────────────────';

interface RangeVisual {
  /** "[■■■■■■■|□□□]" */
  bar: string;
  /** "67% Left" while in range, "OOR LEFT" / "OOR RIGHT" once outside. */
  label: string;
  /** Share of the range below the current price, 0–100 while in range. */
  leftPct: number;
  /** Which side the price left the range on; null while in range. */
  oor: 'left' | 'right' | null;
  /** Distance to the nearest bound, always positive. */
  distancePct: number;
}

/**
 * The range bar.
 *
 * While the price is inside the range the marker sits in it: the filled cells
 * are the part of the range the price already traversed, the empty cells are
 * what is left.
 *
 * Once the price is outside, the marker moves past the end it left through and
 * an arrow shows the way:
 *
 *   OOR RIGHT   [■■■■■■■■■■|]→
 *   OOR LEFT    ←[|□□□□□□□□□□]
 */
function rangeBar(
  ratio: number,
  oor: 'left' | 'right' | null,
): string {
  if (oor === 'right') return `[${'■'.repeat(RANGE_BAR_CELLS)}|]→`;
  if (oor === 'left') return `←[|${'□'.repeat(RANGE_BAR_CELLS)}]`;
  const filled = Math.min(RANGE_BAR_CELLS - 1, Math.max(0, Math.round(ratio * RANGE_BAR_CELLS)));
  return `[${'■'.repeat(filled)}|${'□'.repeat(RANGE_BAR_CELLS - filled)}]`;
}

/**
 * Visual position of the price inside the range.
 *
 * The filled cells are the part of the range the price already traversed, the
 * marker is the price itself and the empty cells are what is left. The
 * percentage is the real distance to the lower bound, not a count of empty
 * blocks.
 *
 * Everything is measured in the traded token's own terms (see
 * `tradedRange`): the price below the lower bound is **OOR LEFT**, above the
 * upper bound **OOR RIGHT**.
 */
export function rangeVisual(valuation: Valuation, snapshot: PositionSnapshot): RangeVisual {
  const traded = tradedRange(snapshot, snapshot.price, valuation.lowerPrice, valuation.upperPrice);
  const lower = traded.lower;
  const upper = traded.upper;
  const current = traded.current;
  const width = upper - lower;
  const ratio = Number.isFinite(width) && width > 0 ? (current - lower) / width : 0;
  const inRange = current >= lower && current <= upper;
  const oor = inRange ? null : current < lower ? 'left' : 'right';

  const bar = rangeBar(ratio, oor);
  const leftPct = Math.max(0, Math.min(100, ratio * 100));
  const label = oor ? `OOR ${oor.toUpperCase()}` : `${leftPct.toFixed(0)}% Left`;

  return { bar, label, leftPct, oor, distancePct: Math.abs(valuation.nearestDistancePct) };
}

/**
 * The same bar for a position that is not open yet (the review screen).
 *
 * The pool and the chosen ticks are enough: the bar is drawn from the price
 * the pool has right now and the range that was picked, in the traded token's
 * terms, exactly like an open position.
 */
export function plannedRangeVisual(
  pool: { price: number; token0: TokenInfo; token1: TokenInfo },
  token: TokenInfo,
  tickLower: number,
  tickUpper: number,
): RangeVisual {
  const dec0 = pool.token0.decimals;
  const dec1 = pool.token1.decimals;
  const a = tickToPrice(tickLower, dec0, dec1);
  const b = tickToPrice(tickUpper, dec0, dec1);
  const lowerPrice = Math.min(a, b);
  const upperPrice = Math.max(a, b);
  const traded = rangeForToken(pool, token, pool.price, lowerPrice, upperPrice);
  const width = traded.upper - traded.lower;
  const ratio = Number.isFinite(width) && width > 0 ? (traded.current - traded.lower) / width : 0;
  const inRange = traded.current >= traded.lower && traded.current <= traded.upper;
  const oor = inRange ? null : traded.current < traded.lower ? 'left' : 'right';

  const bar = rangeBar(ratio, oor);
  const leftPct = Math.max(0, Math.min(100, ratio * 100));
  const label = oor ? `OOR ${oor.toUpperCase()}` : `${leftPct.toFixed(0)}% Left`;
  const distancePct =
    oor === 'left'
      ? Math.abs(((traded.current - traded.lower) / traded.lower) * 100)
      : oor === 'right'
        ? Math.abs(((traded.current - traded.upper) / traded.upper) * 100)
        : Math.min(
            Math.abs(((traded.current - traded.lower) / traded.lower) * 100),
            Math.abs(((traded.current - traded.upper) / traded.upper) * 100),
          );
  return { bar, label, leftPct, oor, distancePct };
}

/**
 * "MC $1.12M → $1.40M · now $1.30M" — the market cap at the range bounds and
 * right now. Omitted entirely when no market cap is available.
 *
 * The market cap of a price is the supply times that price, so a bound keeps
 * the same market cap for as long as the supply does not change. The
 * indexer's FDV is a snapshot taken at *its* price, so dividing it by that
 * price gives the supply — and the supply is what makes the numbers steady.
 * Scaling a stale FDV by the live price instead would make the bounds drift
 * every time the price moved.
 */
export function marketCapLine(
  snapshot: PositionSnapshot,
  valuation: Valuation,
  marketCap: MarketCap,
): string | undefined {
  const supply = tokenSupply(marketCap);
  if (!Number.isFinite(supply) || supply <= 0) return undefined;
  const quoteUsd = quoteUsdPrice(snapshot, valuation);
  if (!Number.isFinite(quoteUsd) || quoteUsd <= 0) return undefined;
  const traded = tradedRange(snapshot, snapshot.price, valuation.lowerPrice, valuation.upperPrice);
  if (!Number.isFinite(traded.current) || traded.current <= 0) return undefined;

  const atLower = supply * Math.min(traded.lower, traded.upper) * quoteUsd;
  const atUpper = supply * Math.max(traded.lower, traded.upper) * quoteUsd;
  const now = supply * traded.current * quoteUsd;
  if (!Number.isFinite(atLower) || !Number.isFinite(atUpper) || !Number.isFinite(now)) {
    return undefined;
  }
  return `MC ${fmtMcapUsd(atLower)} → ${fmtMcapUsd(atUpper)} · now ${fmtMcapUsd(now)}`;
}

/**
 * The quote's price in USDG — the unit every number of the bot is in.
 *
 * USDG is the chain's dollar, so its price is 1. A pool against WETH is
 * priced through the WETH/USDG pool.
 */
function quoteUsdPrice(snapshot: PositionSnapshot, valuation: Valuation): number {
  const quote = quoteToken(snapshot);
  return quote.address.toLowerCase() === snapshot.token0.address.toLowerCase()
    ? valuation.price0Usd
    : valuation.price1Usd;
}

/**
 * The same market cap line for a range that is not open yet.
 *
 * The bounds are the prices of the pasted token (quote per token), so the
 * ratio is the one the position card uses.
 */
export function plannedMarketCapLine(
  marketCap: MarketCap,
  pool: { price: number; token0: TokenInfo; token1: TokenInfo },
  token: TokenInfo,
  lower: number,
  upper: number,
  quoteUsd: number,
): string | undefined {
  const supply = tokenSupply(marketCap);
  if (!Number.isFinite(supply) || supply <= 0) return undefined;
  if (!Number.isFinite(quoteUsd) || quoteUsd <= 0) return undefined;
  const now = tokenPrice(pool, token, pool.price);
  if (!Number.isFinite(now) || now <= 0) return undefined;
  const atLower = supply * Math.min(lower, upper) * quoteUsd;
  const atUpper = supply * Math.max(lower, upper) * quoteUsd;
  const nowMcap = supply * now * quoteUsd;
  if (!Number.isFinite(atLower) || !Number.isFinite(atUpper) || !Number.isFinite(nowMcap)) {
    return undefined;
  }
  return `MC ${fmtMcapUsd(atLower)} → ${fmtMcapUsd(atUpper)} · now ${fmtMcapUsd(nowMcap)}`;
}

/** "🎯 TP +30% · SL -20%", or undefined when no exit rule is armed. */
export function exitRulesLine(tracked: TrackedPosition): string | undefined {
  const parts: string[] = [];
  if (tracked.takeProfitPct !== undefined) parts.push(`🎯 TP +${tracked.takeProfitPct}%`);
  if (tracked.stopLossPct !== undefined) parts.push(`SL ${tracked.stopLossPct}%`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** "⚡ Auto-TP +1.5% · Cycle 2/3", or undefined when auto-TP is off. */
function autoTpLine(
  tracked: TrackedPosition,
  defaultTargetPct: number,
  defaultCycles = 3,
): string | undefined {
  if (!tracked.autoTakeProfit) return undefined;
  const limit = tracked.tpCycles ?? defaultCycles;
  return `⚡ Auto-TP +${defaultTargetPct}% · Cycle ${tracked.cycle ?? 1}/${limit}`;
}

export function poolLine(pool: Pool, depthUsd?: number): string {
  const price = `${fmtPrice(pool.price)} ${pool.token1.symbol}/${pool.token0.symbol}`;
  const depth = depthUsd !== undefined && Number.isFinite(depthUsd) ? ` · depth ~${fmtUsd(depthUsd)}` : '';
  const kind = pool.version === 'v3' ? 'v3' : 'v4';
  const fee = pool.version === 'v3' ? `${pool.fee / 10_000}%` : `${pool.lpFee / 10_000}%`;
  return `${kind} ${fee} · ${price}${depth}`;
}

/**
 * Compact position card.
 *
 *   🟢 #1 · TOKEN/USDG · Robinhood
 *   IN RANGE
 *
 *   [■■■■■■■|□□□] 67% Left
 *   MC $1.12M → $1.40M · now $1.30M
 *
 *   💰 $48.20 · Fees $1.25
 *   📊 +$2.40 (+5.10%) · Rp 38.400
 */
export function positionCard(
  tracked: TrackedPosition,
  snapshot: PositionSnapshot,
  valuation: Valuation,
  pnl: PnlSummary,
  options: { idrRate?: number; autoTpTargetPct?: number; marketCap?: MarketCap; cycleLimit?: number } = {},
): string {
  const visual = rangeVisual(valuation, snapshot);
  const pair = positionPair(snapshot);
  // The status follows the visual, so the label and the bar can never
  // contradict each other.
  const status = visual.oor ? `OUT OF RANGE · ${visual.oor === 'right' ? 'RIGHT' : 'LEFT'}` : 'IN RANGE';

  const lines = [
    `${statusEmoji(snapshot, pnl)} <b>${positionNumber(tracked.id)} · ${esc(pair)}</b> · Robinhood`,
    status,
    RANGE_FRAME,
    `${visual.bar} <b>${visual.label}</b>`,
  ];

  const marketCap = marketCapLine(snapshot, valuation, options.marketCap ?? UNKNOWN_MARKET_CAP);
  if (marketCap) lines.push(marketCap);
  lines.push(RANGE_FRAME);

  const pnlLine = `📊 ${fmtSignedUsd(pnl.totalPnlUsd)} (${fmtPct(pnl.totalPnlPct)})`;
  const idr = options.idrRate !== undefined && Number.isFinite(options.idrRate)
    ? fmtIdr(pnl.totalPnlUsd, options.idrRate)
    : undefined;
  lines.push(
    `💰 ${fmtUsd(valuation.valueUsd)} · Fees ${fmtUsd(valuation.feesUsd)}`,
    idr ? `${pnlLine} · ${idr}` : pnlLine,
  );

  const rules = exitRulesLine(tracked);
  if (rules) lines.push(rules);
  const autoTp = autoTpLine(tracked, options.autoTpTargetPct ?? 1, options.cycleLimit ?? 3);
  if (autoTp) lines.push(autoTp);
  lines.push(`🔄 Rebalance is manual · OOR TP ${tracked.oorTakeProfit ? 'ON' : 'OFF'}`);
  lines.push(
    `🧩 Compound ${tracked.autoCompound ? fmtCompactDuration(tracked.compoundIntervalMs) : 'OFF'} · APR ${
      Number.isFinite(pnl.aprPct) ? `${pnl.aprPct.toFixed(1)}%` : '—'
    }`,
  );
  const age = fmtCompactDuration(Date.now() - tracked.entry.openedAt);
  const rebalanced = tracked.lastRebalanceAt
    ? ` · Last rebalance ${fmtCompactDuration(Date.now() - tracked.lastRebalanceAt)}`
    : '';
  lines.push(`⏱ Age ${age}${rebalanced}`);

  return lines.join('\n');
}

/**
 * The colour of a position: green for a profit, red for a loss and orange
 * when it left its range — that one needs attention, whatever the PnL says.
 */
export function statusEmoji(snapshot: PositionSnapshot, pnl: PnlSummary): '🟢' | '🔴' | '🟠' {
  if (!snapshot.inRange) return '🟠';
  return pnl.totalPnlPct >= 0 ? '🟢' : '🔴';
}

/**
 * Compact row for the position list.
 *
 *   🟢 #1 · TOKEN/USDG · Robinhood
 *   [■■■■■■■|□□□] 67% Left
 *   $48.20 · PnL +5.10% · Fees $1.25
 */
export function positionRow(
  tracked: TrackedPosition,
  snapshot: PositionSnapshot,
  valuation: Valuation,
  pnl: PnlSummary,
): string {
  const visual = rangeVisual(valuation, snapshot);
  const pair = positionPair(snapshot);
  return [
    `${statusEmoji(snapshot, pnl)} <b>${positionNumber(tracked.id)} · ${esc(pair)}</b> · Robinhood`,
    `${visual.bar} ${visual.label}`,
    `${fmtUsd(valuation.valueUsd)} · PnL ${fmtPct(pnl.totalPnlPct)} · Fees ${fmtUsd(valuation.feesUsd)}`,
  ].join('\n');
}

/**
 * The position block on the home screen.
 *
 * The same rows as the position list, with the market cap in between:
 *
 *   🟢 #6 · IGNITION/USDG · Robinhood
 *   [■■■■■■■■■|□] 91% Left
 *   MC $712,81K → $1,06M · now $1,03M
 *   $53.27 · PnL +0.51% · Fees $0.3383
 */
export function menuPositionRow(
  tracked: TrackedPosition,
  view: { snapshot: PositionSnapshot; valuation: Valuation; pnl: PnlSummary },
  marketCap: MarketCap,
): string {
  const lines = positionRow(tracked, view.snapshot, view.valuation, view.pnl).split('\n');
  const mcap = marketCapLine(view.snapshot, view.valuation, marketCap);
  if (mcap) lines.splice(2, 0, mcap);
  return lines.join('\n');
}

export function positionKeyboard(
  id: string,
  tracked: TrackedPosition,
  canTrade: boolean,
  links?: { snapshot: PositionSnapshot; wallet: string },
  cycleLimit = 3,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (canTrade) {
    kb.text('💧 Collect fees', `act:collect:${id}`).text('🔄 Refresh', `act:refresh:${id}`).row();
    kb.text('🎯 TP/SL', `act:tpsl:${id}`).text('🔒 Close', `act:close:${id}`).row();
    kb.text(`♻️ Compound ${tracked.autoCompound ? '✅' : '❌'}`, `act:toggleCompound:${id}`)
      .row();
    kb.text(`⚡ Auto-TP ${tracked.autoTakeProfit ? '✅' : '❌'}`, `act:toggleAutoTp:${id}`)
      .text(`📈 OOR TP ${tracked.oorTakeProfit ? '✅' : '❌'}`, `act:toggleOor:${id}`)
      .row();
    kb.text(`🎯 Cycle ${tracked.cycle ?? 1}/${tracked.tpCycles ?? cycleLimit}`, `act:cycles:${id}`)
      .text('🔁 Rebalance now', `act:rebalance:${id}`)
      .row();
  } else {
    kb.text('🔄 Refresh', `act:refresh:${id}`).row();
  }
  kb.text(`🔔 Alerts ${tracked.alerts ? '✅' : '❌'}`, `act:toggleAlerts:${id}`)
    .text(`🗑 Untrack`, `act:untrack:${id}`)
    .row();
  if (links) {
    kb.url('🤖 Check LP Agent', lpAgentPortfolioLink(links.wallet))
      .url('📈 View Chart on GMGN', gmgnTokenLink(chartTokenAddress(links.snapshot)))
      .row();
  }
  return withHome(kb);
}

/** Appends the global “home” button so every screen can return to the menu. */
export function withHome(kb: InlineKeyboard): InlineKeyboard {
  return kb.row().text('🏠 Menu', 'menu:home');
}

interface KeystoreInfo {
  label: string;
  address: string;
}

export function settingsText(
  settings: ChatSettings,
  owner: string | undefined,
  keystore?: KeystoreInfo,
): string {
  return [
    '⚙️ <b>Settings</b>',
    '────────────',
    `👛 Wallet: ${owner ? `<a href="${addressLink(owner)}">${esc(shortAddr(owner))}</a>` : '⚠️ not configured (read-only)'}`,
    `🔐 Keystore: ${keystore ? `🏷 ${esc(keystore.label)} · <code>${esc(shortAddr(keystore.address))}</code>` : '📭 none imported'}`,
    `⚡ Execution: ${settings.dryRun ? '🧪 dry-run — transactions simulated, not sent' : '⚡ live — real transactions'}`,
    `🎚 Slippage: ${settings.slippagePct}%`,
    `🔔 Range alerts: ${settings.alertsEnabled ? 'on' : 'off'} (out of range, back in range)`,
    `💱 Auto-swap to USDG: ${settings.autoSwapToUsdg ? 'on — proceeds are swapped after a live close' : 'off'}`,
    `   smallest swap: $${settings.autoSwapMinUsd.toFixed(2)}`,
    `🛡 Route impact: at most <b>${settings.maxRouteDiscountPct}%</b> below the market`,
    `⚡ Auto-TP target: +${settings.autoTpTargetPct}%`,
    `🔄 Default cycles: ${settings.tpCycleLimit}`,
    `📊 Bid Ask entries: ${settings.bidAskEntries} (one-sided ladders)`,
    `💱 Display currency: ${settings.currency}`,
    `🕒 Calendar timezone: ${settings.timezone}`,
    '⛓ Chain: Robinhood Chain (4663) · Uniswap v3 + v4',
    '────────────',
    '👇 Tap to change:',
  ].join('\n');
}

export function settingsKeyboard(settings: ChatSettings): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(settings.dryRun ? '⚡ Switch to LIVE' : '🧪 Switch to dry-run', 'set:dryRun')
    .row()
    .text('🎚 0.5%', 'set:slip:0.5')
    .text('1%', 'set:slip:1')
    .text('2%', 'set:slip:2')
    .row()
    .text(settings.alertsEnabled ? '🔔 Range alerts off' : '🔕 Range alerts on', 'set:alerts')
    .row()
    .text(`💱 Auto-swap ${settings.autoSwapToUsdg ? '✅' : '❌'}`, 'set:autoSwap')
    .text(`💴 Swap ≥ $${settings.autoSwapMinUsd.toFixed(2)}`, 'set:swapMin')
    .row()
    .text(`🛡 Impact ≤ ${settings.maxRouteDiscountPct}%`, 'set:swapImpact')
    .row()
    .text(`⚡ TP target +${settings.autoTpTargetPct}%`, 'set:autoTp')
    .text(`🔄 Cycles ${settings.tpCycleLimit}`, 'set:cycles')
    .row()
    .text(`📊 Bid Ask entries: ${settings.bidAskEntries}`, 'set:bidask')
    .text(`💱 ${settings.currency}`, 'set:currency')
    .row()
    .text(`🕒 ${settings.timezone}`, 'set:timezone')
    .row()
    .text('🔑 Import wallet', 'wallet:import')
    .text('🏷 Rename', 'wallet:rename')
    .row()
    .text('🔓 Unlock', 'wallet:unlock')
    .text('📒 Address book', 'book:list');
  return withHome(kb);
}

/** Settings → Bid Ask → Number of entries. */
export function bidAskEntriesText(current: number): string {
  return [
    '📊 <b>Bid Ask — Number of entries</b>',
    '────────────',
    `Current value: <b>${current} entries</b>`,
    `Weights: ${bidAskWeights(current).join(' : ')}`,
    `Split: ${bidAskAllocations(100, current).map((entry) => `${entry.pct.toFixed(1)}%`).join(' / ')}`,
    '',
    'The total investment is split progressively: the entry nearest the market gets the smallest share, the farthest gets the largest.',
    'Available choices: 4, 5, 6, 7, 8, 9, 10 entries.',
    'Only new Bid Ask setups use this value — active positions are never changed.',
    '────────────',
    '👇 Pick the entry count:',
  ].join('\n');
}

export function bidAskEntriesKeyboard(current: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const n of BID_ASK_ENTRY_CHOICES) {
    if (n === 8) kb.row();
    kb.text(n === current ? `${n} ✅` : `${n}`, `set:bidaskSelect:${n}`);
  }
  kb.row().text('◀ Back to settings', 'set:back');
  return withHome(kb);
}

export function bidAskConfirmText(current: number, next: number): string {
  return [
    '📊 <b>Apply Bid Ask entry count?</b>',
    '────────────',
    `Change: <b>${current} → ${next} entries</b>`,
    `Weights: ${bidAskWeights(next).join(' : ')}`,
    `Split: ${bidAskAllocations(100, next).map((entry) => `${entry.pct.toFixed(1)}%`).join(' / ')}`,
    '',
    'This only affects the next Bid Ask setup. Existing positions are untouched.',
  ].join('\n');
}

export function bidAskConfirmKeyboard(next: number): InlineKeyboard {
  return withHome(
    new InlineKeyboard()
      .text('✅ Apply', `set:bidAskApply:${next}`)
      .text('✖ Cancel', 'set:bidask'),
  );
}

/** One-sided entry strategy: a single spot range or a Bid Ask ladder. */
export function strategyKeyboard(entries: number): InlineKeyboard {
  return withHome(
    new InlineKeyboard()
      .text('🎯 Spot', 'new:strategy:spot')
      .row()
      .text(`📊 Bid Ask · ${entries} entries`, 'new:strategy:bidAsk')
      .row()
      .text('✖ Cancel', 'new:cancel'),
  );
}

/** Settings → Display currency. */
export function currencyText(current: string): string {
  return [
    '💱 <b>Display currency</b>',
    '────────────',
    `Current: <b>${current}</b>`,
    '',
    'The PnL card shows the main amounts in this currency. Next to the ROI it always shows the other one, so the same number is never printed twice.',
    '────────────',
    '👇 Pick a currency:',
  ].join('\n');
}

export function currencyKeyboard(current: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const currency of DISPLAY_CURRENCIES) {
    kb.text(currency === current ? `${currency} ✅` : currency, `set:currency:${currency}`);
  }
  kb.row().text('◀ Back to settings', 'set:back');
  return withHome(kb);
}

/** Settings -> the smallest amount worth swapping into USDG. */
export function autoSwapMinText(current: number): string {
  return [
    '💴 <b>Auto-swap minimum</b>',
    '────────────',
    `Current: <b>$${current.toFixed(2)}</b>`,
    '',
    'After a live close, the token proceeds are swapped into USDG only when they are worth at least this much. A smaller leftover stays in your wallet — the gas of the swap would cost more than the swap is worth.',
    '────────────',
    '👇 Pick a minimum:',
  ].join('\n');
}

export function autoSwapMinKeyboard(current: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const amount of AUTO_SWAP_MIN_CHOICES) {
    const label = `$${amount.toFixed(2)}`;
    kb.text(amount === current ? `${label} ✅` : label, `set:swapMin:${amount}`);
  }
  kb.row().text('◀ Back to settings', 'set:back');
  return withHome(kb);
}

/** Settings -> how far below the market a swap route may be priced. */
export function routeImpactText(current: number): string {
  return [
    '🛡 <b>Route impact</b>',
    '────────────',
    `Current: at most <b>${current}%</b> below the market`,
    '',
    'A swap route is priced against the market. When it is more than this far below, the tokens stay in your wallet instead: the route would cost more than swapping them by hand.',
    `On a $55 position, ${current}% is $${(55 * current / 100).toFixed(2)} — a swap by hand costs about $0.02 of gas.`,
    '────────────',
    '👇 Pick a limit:',
  ].join('\n');
}

export function routeImpactKeyboard(current: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const pct of ROUTE_DISCOUNT_CHOICES) {
    const label = `${pct}%`;
    kb.text(pct === current ? `${label} ✅` : label, `set:swapImpact:${pct}`);
  }
  kb.row().text('◀ Back to settings', 'set:back');
  return withHome(kb);
}

/** Settings -> the timezone the calendar buckets days in. */
export function timeZoneText(current: string): string {
  const zone = TIME_ZONES.find((option) => option.id === current) ?? TIME_ZONES[0]!;
  return [
    '🕒 <b>Calendar timezone</b>',
    '────────────',
    `Current: <b>${esc(zone.label)}</b>`,
    '',
    'Closed positions are bucketed into days with this timezone. The profit calendar and every daily total use it.',
    '────────────',
    '👇 Pick a timezone:',
  ].join('\n');
}

export function timeZoneKeyboard(current: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const zone of TIME_ZONES) {
    kb.text(zone.id === current ? `${zone.label} ✅` : zone.label, `set:timezone:${zone.id}`);
  }
  kb.row().text('◀ Back to settings', 'set:back');
  return withHome(kb);
}

/** Wallet actions: import, rename, unlock and the address book. */
export function walletKeyboard(): InlineKeyboard {
  return withHome(
    new InlineKeyboard()
      .text('🔑 Import wallet', 'wallet:import')
      .text('🏷 Rename', 'wallet:rename')
      .row()
      .text('🔓 Unlock', 'wallet:unlock')
      .text('📒 Address book', 'book:list'),
  );
}

export function confirmKeyboard(count = 1): InlineKeyboard {
  return withHome(
    new InlineKeyboard()
      .text(count > 1 ? `✅ Open ${count} positions` : '✅ Open position', 'new:confirm')
      .text('✖ Cancel', 'new:cancel'),
  );
}

/** Which side the deposit spends, and the symbols for the buttons. */
export function sideKeyboard(tokenSymbol: string, quoteSymbol: string): InlineKeyboard {
  return withHome(
    new InlineKeyboard()
      .text(`💵 ${quoteSymbol} only`, 'new:side:quote')
      .row()
      .text(`🪙 ${tokenSymbol} only`, 'new:side:token')
      .row()
      .text(`⚖️ Both sides`, 'new:side:both')
      .text('✖ Cancel', 'new:cancel'),
  );
}

/**
 * Range presets depend on the chosen side. A one-sided deposit puts the live
 * price on one bound: for a quote-only deposit the upper bound is the live
 * price and the lower bound steps down; for a token-only deposit the lower
 * bound is the live price and the upper bound steps up. A two-sided deposit
 * brackets the price symmetrically.
 */
/**
 * The quick-pick range widths, in percent.
 *
 * The negative side (the quote-only entry) can step down this far below the
 * live price; the symmetric and the token-only range use the same widths.
 */
export const RANGE_PRESETS = [15, 20, 25, 30, 35, 45, 50, 55, 60, 65, 70, 75, 80, 85];

/**
 * The range picker.
 *
 * Three buttons per row keeps the ladder readable on a phone. Every button
 * carries the percentage in its data, so a value that was typed by hand and a
 * value that was tapped go through exactly the same calculation.
 */
export function rangeKeyboard(side: 'both' | 'quote' | 'token' = 'both'): InlineKeyboard {
  const kb = new InlineKeyboard();
  const label = (pct: number): string =>
    side === 'both' ? `±${pct}%` : side === 'quote' ? `▼ -${pct}%` : `▲ +${pct}%`;
  const data = (pct: number): string =>
    side === 'both'
      ? `new:range:${pct}`
      : side === 'quote'
        ? `new:range:q${pct}`
        : `new:range:t${pct}`;

  for (let i = 0; i < RANGE_PRESETS.length; i += 3) {
    for (const pct of RANGE_PRESETS.slice(i, i + 3)) {
      kb.text(label(pct), data(pct));
    }
    kb.row();
  }
  kb.text('🌈 Full range', 'new:range:full')
    .text('✏️ Custom prices', 'new:range:custom')
    .row()
    .text('✖ Cancel', 'new:cancel');
  return withHome(kb);
}

export function amountKeyboard(): InlineKeyboard {
  return withHome(
    new InlineKeyboard()
      .text('25%', 'new:amt:25')
      .text('50%', 'new:amt:50')
      .row()
      .text('75%', 'new:amt:75')
      .text('100%', 'new:amt:100')
      .row()
      .text('✏️ Custom USD', 'new:amt:custom')
      .text('✖ Cancel', 'new:cancel'),
  );
}
