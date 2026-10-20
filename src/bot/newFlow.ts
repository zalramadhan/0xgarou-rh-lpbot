import { InlineKeyboard, type Context } from 'grammy';
import { answer } from './answers.js';
import { TOKENS } from '../constants/chain.js';
import { usdPrice } from '../core/prices.js';
import { botAddress } from '../chain/client.js';
import { refreshPool, type Pool } from '../core/pools.js';
import { getToken, normalizeAddress, type TokenInfo } from '../core/tokens.js';
import { scanToken, type TokenScan } from '../core/scanner.js';
import type { SortMode } from './poolList.js';
import {
  clampPage,
  fmtPriceUsd,
  nextSort,
  scanKeyboard,
  scanText,
  visiblePools,
  type PoolViewOptions,
} from './poolList.js';
import { fullRangeTicks, oneSidedTicks, reanchorRange, tickRangeFromPrices } from '../core/math/tickMath.js';
import { oneSidedDirection } from '../core/pairs.js';
import { planBySideShare, planByUsd, planByWalletShare, type DepositPlan } from '../core/planner.js';
import {
  buildBidAskPlan,
  displayPriceAtTick,
  type BidAskEntryPlan,
  type BidAskPlan,
} from '../core/bidAsk.js';
import { formatRangeLabel } from '../card/data.js';
import { marketCapUsd as fetchMarketCap } from '../core/scanner.js';
import { openPosition, type OpenPositionResult } from '../core/actions.js';
import { safetyIcon, safetyText, screenToken, type SafetyReport } from '../core/safety.js';
import { store } from '../store/store.js';
import { clearSession, getSession, setSession, type Draft, type EntryStrategy } from './session.js';
import {
  amountKeyboard,
  confirmKeyboard,
  plannedMarketCapLine as plannedMarketCapLineOf,
  plannedRangeVisual,
  rangeKeyboard,
  sideKeyboard,
  strategyKeyboard,
  tradedToken,
  txLink,
  withHome,
} from './ui.js';
import { esc, fmtAmount, fmtCompactUsd, fmtPrice, fmtUsd } from '../utils/format.js';
import { errorMessage } from '../utils/errors.js';
import { txLock } from './locks.js';
import { showLoading } from './screens.js';
import { positionScreen } from './positionsFlow.js';

/* ------------------------------- helpers --------------------------------- */

function pastedIsToken0(pool: Pool, token: TokenInfo): boolean {
  return pool.token0.address.toLowerCase() === token.address.toLowerCase();
}

/** Human price of the pasted token, quoted in the other token. */
function displayPrice(pool: Pool, token: TokenInfo): number {
  return pastedIsToken0(pool, token) ? pool.price : 1 / pool.price;
}

/** Converts a range expressed in quoted-token units into aligned ticks. */
function ticksFromQuotedRange(pool: Pool, token: TokenInfo, low: number, high: number) {
  const dec0 = pool.token0.decimals;
  const dec1 = pool.token1.decimals;
  const spacing = pool.tickSpacing;
  if (pastedIsToken0(pool, token)) {
    return tickRangeFromPrices(low, high, dec0, dec1, spacing);
  }
  // Pasted token is token1: invert so ticks are in token1-per-token0 terms.
  return tickRangeFromPrices(1 / high, 1 / low, dec0, dec1, spacing);
}

function quoteOf(pool: Pool, token: TokenInfo): TokenInfo {
  return pastedIsToken0(pool, token) ? pool.token1 : pool.token0;
}

/**
 * A one-sided deposit must hold exactly one token, so the range has to sit
 * entirely on one side of the live price. Uniswap hands you `token0` when the
 * price is at or above the upper bound and `token1` when it is at or below the
 * lower bound, so the side that touches the live price is aligned away from it.
 */
function oneSidedTicksFor(
  pool: Pool,
  token: TokenInfo,
  want: 'quote' | 'token',
  pct: number,
) {
  // The funded token decides which side of the market the range has to sit on.
  const direction = oneSidedDirection(pool, want);
  // `pool.price` is token1 per token0 in human units, which is what the tick
  // helpers expect.
  return oneSidedTicks(
    pool.price,
    pct,
    direction === 'up',
    pool.token0.decimals,
    pool.token1.decimals,
    pool.tickSpacing,
  );
}

/** Scans every pool the token trades in and shows the paged list. */
export async function showPoolScan(ctx: Context, token: TokenInfo, editing = false): Promise<void> {
  const chatId = ctx.chat!.id;
  // The scan reads the indexer and then every pool on the chain: that takes
  // a moment. Say so at once, so nobody taps the button again.
  if (editing) await showLoading(ctx, `⏳ <b>Scanning the pools of ${esc(token.symbol)}…</b>`);
  const scan = await scanToken(token);

  if (scan.pools.length === 0) {
    clearSession(chatId);
    const detail = scan.listed > 0
      ? `The indexer lists ${scan.listed} pool(s) for it, but none could be rebuilt as a Uniswap v3/v4 pool (hooked or unsupported).`
      : 'It has no pool on Uniswap v3 or v4 for this chain.';
    const text = `No tradable Uniswap pool found for ${esc(token.symbol)}.\n\n${esc(detail)}\n\nIf it trades on another DEX I cannot manage it.`;
    if (editing) await ctx.editMessageText(text, { parse_mode: 'HTML' }).catch(() => undefined);
    else await ctx.reply(text, { parse_mode: 'HTML' });
    return;
  }

  setSession(chatId, {
    step: 'range',
    token,
    scan,
    page: 0,
    selected: 0,
    sort: 'tvl',
    hideBroken: false,
    side: 'both',
    strategy: 'spot',
  });
  const options: PoolViewOptions = { sort: 'tvl', hideBroken: false };
  const text = scanText(scan, 0, options);
  const keyboard = scanKeyboard(scan, 0, options);
  if (editing) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => undefined);
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function sidePrompt(
  ctx: Context,
  base: { token: TokenInfo; scan: TokenScan; page: number; selected: number; sort: SortMode; hideBroken: boolean },
): Promise<void> {
  const { token } = base;
  const pool = base.scan.pools[base.selected]?.pool ?? base.scan.pools[0]!.pool;
  setSession(ctx.chat!.id, { step: 'side', ...base });
  const quote = quoteOf(pool, token);
  const price = displayPrice(pool, token);
  const fee = pool.version === 'v3' ? `${pool.fee / 10_000}%` : `${pool.lpFee / 10_000}%`;
  await ctx.reply(
    [
      `🎛 <b>Which side do you fund? · ${esc(token.symbol)}/${esc(quote.symbol)}</b>`,
      `🏷 Pool: ${pool.version} ${fee}`,
      `💵 Current price: <code>${fmtPrice(price)}</code> ${esc(quote.symbol)} per ${esc(token.symbol)}`,
      '────────────',
      `💵 <b>${esc(quote.symbol)} only</b> — range sits below the live price. You fund one side, no swap needed.`,
      `🪙 <b>${esc(token.symbol)} only</b> — range sits above the live price. You fund one side, no swap needed.`,
      `⚖️ <b>Both sides</b> — the classic two-token deposit around the live price.`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: sideKeyboard(token.symbol, quote.symbol) },
  );
}

async function strategyPrompt(
  ctx: Context,
  base: {
    token: TokenInfo;
    scan: TokenScan;
    page: number;
    selected: number;
    sort: SortMode;
    hideBroken: boolean;
    side: 'quote' | 'token';
  },
): Promise<void> {
  const { token, side } = base;
  const pool = base.scan.pools[base.selected]?.pool ?? base.scan.pools[0]!.pool;
  setSession(ctx.chat!.id, { step: 'strategy', ...base });
  const quote = quoteOf(pool, token);
  const price = displayPrice(pool, token);
  const fee = pool.version === 'v3' ? `${pool.fee / 10_000}%` : `${pool.lpFee / 10_000}%`;
  const entries = store.settingsFor(ctx.chat!.id).bidAskEntries;
  await ctx.reply(
    [
      `🎛 <b>Entry strategy · ${esc(token.symbol)}/${esc(quote.symbol)}</b>`,
      `🏷 Pool: ${pool.version} ${fee}`,
      `💵 Current price: <code>${fmtPrice(price)}</code> ${esc(quote.symbol)} per ${esc(token.symbol)}`,
      `🎛 Side: ${side === 'quote' ? `💵 ${esc(quote.symbol)} only` : `🪙 ${esc(token.symbol)} only`}`,
      '────────────',
      `🎯 <b>Spot</b> — one position across the whole selected range.`,
      `📊 <b>Bid Ask</b> — ${entries} entries; the total is split 1 : 2 : … : ${entries}.`,
      `   Entry 1 is nearest the market, entry ${entries} is the farthest.`,
      '',
      `Change the entry count in ⚙️ Settings (current: ${entries}).`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: strategyKeyboard(entries) },
  );
}

async function rangePrompt(
  ctx: Context,
  pool: Pool,
  token: TokenInfo,
  side: 'both' | 'quote' | 'token' = 'both',
  strategy: EntryStrategy = 'spot',
): Promise<void> {
  const quote = quoteOf(pool, token);
  const price = displayPrice(pool, token);
  const fee = pool.version === 'v3' ? `${pool.fee / 10_000}%` : `${pool.lpFee / 10_000}%`;
  const entries = store.settingsFor(ctx.chat!.id).bidAskEntries;
  const headline =
    strategy === 'bidAsk'
      ? side === 'quote'
        ? `📐 Pick the outer range; it is split into ${entries} bids below the live price:`
        : `📐 Pick the outer range; it is split into ${entries} asks above the live price:`
      : side === 'quote'
        ? `📐 Upper bound is the live price; pick how far the lower bound steps down:`
        : side === 'token'
          ? `📐 Lower bound is the live price; pick how far the upper bound steps up:`
          : '📐 How wide should the range be around the current price?';
  await ctx.reply(
    [
      `📏 <b>Pick a range · ${esc(token.symbol)}/${esc(quote.symbol)}</b>`,
      `🏷 Pool: ${pool.version} ${fee}`,
      `💵 Current price: <code>${fmtPrice(price)}</code> ${esc(quote.symbol)} per ${esc(token.symbol)}`,
      `🎛 Side: ${side === 'quote' ? `💵 ${esc(quote.symbol)} only` : side === 'token' ? `🪙 ${esc(token.symbol)} only` : '⚖️ Both sides'}`,
      strategy === 'bidAsk'
        ? `📊 Strategy: Bid Ask · ${entries} entries (range split into ${entries} bins)`
        : '🎯 Strategy: Spot · one position',
      '────────────',
      headline,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: rangeKeyboard(side) },
  );
}

function displayBounds(pool: Pool, token: TokenInfo, tickLower: number, tickUpper: number) {
  const a = displayPriceAtTick(pool, token, tickLower);
  const b = displayPriceAtTick(pool, token, tickUpper);
  return { lower: Math.min(a, b), upper: Math.max(a, b) };
}

function pairLabel(pool: Pool, token: TokenInfo): string {
  return pastedIsToken0(pool, token)
    ? `${pool.token0.symbol}/${pool.token1.symbol}`
    : `${pool.token1.symbol}/${pool.token0.symbol}`;
}

/**
 * The market cap of the pasted token, or NaN when the indexer has none.
 */
async function plannedMarketCap(pool: Pool, token: TokenInfo): Promise<number> {
  return fetchMarketCap(token).catch(() => Number.NaN);
}

/**
 * The market cap the token would have at a given display price.
 *
 * The market cap follows the token's price, so a bound is the market cap
 * scaled by the price the token would have there.
 */
function marketCapAt(
  marketCapNow: number,
  pool: Pool,
  token: TokenInfo,
  bound: number,
): number {
  if (!Number.isFinite(marketCapNow) || marketCapNow <= 0) return Number.NaN;
  const now = displayPrice(pool, token);
  if (!Number.isFinite(now) || now <= 0) return Number.NaN;
  return marketCapNow * (bound / now);
}

/**
 * "MC $1.12M → $1.40M · now $1.30M" for a range that is not open yet.
 */
async function plannedMarketCapLine(
  pool: Pool,
  token: TokenInfo,
  lower: number,
  upper: number,
): Promise<string | undefined> {
  const marketCap = await plannedMarketCap(pool, token);
  return plannedMarketCapLineOf(marketCap, pool, token, lower, upper);
}

function safetyLines(safety: SafetyReport | undefined): string[] {
  if (!safety) return [];
  const flagged = safety.checks.filter((c) => c.status === 'warn' || c.status === 'fail');
  return [
    '',
    `🛡 Safety ${safetyIcon(safety)}${flagged.length === 0 ? ' — no flags' : ''}`,
    ...flagged.map((c) => `${c.status === 'fail' ? '❌' : '⚠️'} ${esc(c.label)} — ${esc(c.detail)}`),
  ];
}

async function sendPreview(
  ctx: Context,
  draft: Draft,
  plan: DepositPlan,
  safety?: SafetyReport,
): Promise<void> {
  const { pool, token, quote, tickLower, tickUpper } = draft;
  const settings = store.settingsFor(ctx.chat!.id);
  const pair = pairLabel(pool, token);
  const fee = pool.version === 'v3' ? `${pool.fee / 10_000}%` : `${pool.lpFee / 10_000}%`;
  const { lower, upper } = displayBounds(pool, token, tickLower, tickUpper);

  // The range is shown in market cap, not in price: the market cap is what
  // the position is measured against, and the bar is drawn from the very same
  // numbers, so the review and the position agree.
  const visual = plannedRangeVisual(pool, token, tickLower, tickUpper);
  const marketCap = await plannedMarketCapLine(pool, token, lower, upper);

  const lines = [
    `📝 <b>Review · ${esc(pair)}</b>`,
    `🏷 ${pool.version} ${fee} · 🎯 Spot`,
    '────────────',
    `${visual.bar} ${visual.label}`,
    marketCap
      ? `📐 Range ${esc(marketCap)}`
      : `📐 Range <code>${fmtPrice(lower)}</code> – <code>${fmtPrice(upper)}</code> ${esc(quote.symbol)} per ${esc(token.symbol)}`,
    `Deposit <b>${fmtAmount(plan.amount0, pool.token0.decimals)} ${esc(pool.token0.symbol)}</b> + <b>${fmtAmount(plan.amount1, pool.token1.decimals)} ${esc(pool.token1.symbol)}</b>`,
    `Total ≈ <b>${fmtUsd(plan.valueUsd)}</b> · slippage ${settings.slippagePct}%`,
  ];

  // The price range as well, so it can be compared with the Uniswap screen.
  if (marketCap) {
    lines.splice(
      6,
      0,
      `💲 <code>${fmtPrice(lower)}</code> → <code>${fmtPrice(upper)}</code> ${esc(quote.symbol)} per ${esc(token.symbol)}`,
    );
  }

  if (plan.balance0 !== undefined && plan.balance1 !== undefined) {
    lines.push(
      `Wallet ${fmtAmount(plan.balance0, pool.token0.decimals)} ${esc(pool.token0.symbol)} + ${fmtAmount(plan.balance1, pool.token1.decimals)} ${esc(pool.token1.symbol)}`,
    );
    if (plan.shortfall0 > 0n || plan.shortfall1 > 0n) {
      lines.push(
        `⚠️ Short by ${fmtAmount(plan.shortfall0, pool.token0.decimals)} ${esc(pool.token0.symbol)} / ${fmtAmount(plan.shortfall1, pool.token1.decimals)} ${esc(pool.token1.symbol)}`,
      );
    }
  }

  lines.push(...safetyLines(safety));
  lines.push(
    '────────────',
    settings.dryRun ? '🧪 <b>Dry-run</b>: the transaction will be simulated, not sent.' : '⚡ <b>Live</b>: this will send a transaction.',
  );
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: confirmKeyboard() });
}

async function sendBidAskPreview(
  ctx: Context,
  draft: Draft,
  plan: BidAskPlan,
  safety?: SafetyReport,
): Promise<void> {
  const { pool, token, quote } = draft;
  const settings = store.settingsFor(ctx.chat!.id);
  const pair = pairLabel(pool, token);
  const fee = pool.version === 'v3' ? `${pool.fee / 10_000}%` : `${pool.lpFee / 10_000}%`;
  const outer = displayBounds(pool, token, plan.tickLower, plan.tickUpper);
  const plannedPct = plan.totalUsd > 0 ? (plan.plannedUsd / plan.totalUsd) * 100 : 0;
  // The outer range is shown in market cap, like the spot review.
  const outerMcap = await plannedMarketCapLine(pool, token, outer.lower, outer.upper);
  const mcapNow = await plannedMarketCap(pool, token);
  const visual = plannedRangeVisual(pool, token, plan.tickLower, plan.tickUpper);

  const lines = [
    `📊 <b>Bid Ask review · ${esc(pair)}</b>`,
    `🏷 ${pool.version} ${fee} · ${plan.side === 'quote' ? `💵 ${esc(quote.symbol)} only` : `🪙 ${esc(token.symbol)} only`}`,
    '────────────',
    `${visual.bar} ${visual.label}`,
    outerMcap
      ? `📐 Range ${esc(outerMcap)}`
      : `📐 Range <code>${fmtPrice(outer.lower)}</code> – <code>${fmtPrice(outer.upper)}</code> ${esc(quote.symbol)} per ${esc(token.symbol)}`,
    `📊 <b>${plan.entryCount} entries</b> · weights ${plan.entries.map((entry) => entry.weight).join(' : ')} · ${
      plan.side === 'quote' ? 'bids below the market' : 'asks above the market'
    }`,
    '────────────',
    ...plan.entries.map((entry) => {
      const bin = displayBounds(pool, token, entry.tickLower, entry.tickUpper);
      const binLow = marketCapAt(mcapNow, pool, token, bin.lower);
      const binHigh = marketCapAt(mcapNow, pool, token, bin.upper);
      // The bins are shown in market cap as well, so the whole review is read
      // in one unit.
      const range =
        Number.isFinite(binLow) && Number.isFinite(binHigh)
          ? `<b>MC ${fmtCompactUsd(Math.min(binLow, binHigh))}–${fmtCompactUsd(Math.max(binLow, binHigh))}</b>`
          : `bin <code>${fmtPrice(bin.lower)}</code>–<code>${fmtPrice(bin.upper)}</code>`;
      return (
        `#${entry.index} · <b>${fmtUsd(entry.allocationUsd)}</b> (${entry.allocationPct.toFixed(1)}%) ` +
        `· ${range}`
      );
    }),
    '────────────',
    `Total requested <b>${fmtUsd(plan.totalUsd)}</b> · planned ${fmtUsd(plan.plannedUsd)} (${plannedPct.toFixed(1)}%)`,
  ];

  if (plan.dustUsd > 0.005) {
    lines.push(`Rounding dust ${fmtUsd(plan.dustUsd)} stays in the wallet.`);
  }
  if (plan.balance0 !== undefined && plan.balance1 !== undefined) {
    lines.push(
      `Wallet ${fmtAmount(plan.balance0, pool.token0.decimals)} ${esc(pool.token0.symbol)} + ${fmtAmount(plan.balance1, pool.token1.decimals)} ${esc(pool.token1.symbol)}`,
      `Needs ${fmtAmount(plan.amount0, pool.token0.decimals)} ${esc(pool.token0.symbol)} + ${fmtAmount(plan.amount1, pool.token1.decimals)} ${esc(pool.token1.symbol)}`,
    );
    if (plan.shortfall0 > 0n || plan.shortfall1 > 0n) {
      lines.push(
        `⚠️ Short by ${fmtAmount(plan.shortfall0, pool.token0.decimals)} ${esc(pool.token0.symbol)} / ${fmtAmount(plan.shortfall1, pool.token1.decimals)} ${esc(pool.token1.symbol)}`,
      );
    }
  }

  lines.push(...safetyLines(safety));
  lines.push(
    '────────────',
    `📌 ${plan.entryCount} entries = ${plan.entryCount} separate positions (${plan.entryCount} mints).`,
    settings.dryRun
      ? '🧪 <b>Dry-run</b>: every mint will be simulated, not sent.'
      : '⚡ <b>Live</b>: this will send one transaction per entry.',
  );
  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: confirmKeyboard(plan.entryCount),
  });
}

/* -------------------------------- entry ---------------------------------- */

export async function startNew(ctx: Context): Promise<void> {
  if (!botAddress) {
    await ctx.reply('⚠️ No wallet configured. Set PRIVATE_KEY in .env to open positions.');
    return;
  }
  setSession(ctx.chat!.id, { step: 'token' });
  await ctx.reply(
    [
      '🚀 <b>Open a position</b>',
      '────────────',
      '📌 Send the <b>contract address</b> of the token you want to LP.',
      '🔎 I scan every Uniswap v3 + v4 pool for it, price each one and grade its health.',
      '',
      '✖ /cancel to stop.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: withHome(new InlineKeyboard()) },
  );
}

/** True when the text looks like an ERC-20 contract address. */
export function looksLikeAddress(text: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(text.trim());
}

/**
 * Scans the pools of a pasted contract address and shows the pool list.
 *
 * This is the first step of `/new`, and it is also what happens when the user
 * just pastes an address into the chat.
 */
export async function scanPastedAddress(ctx: Context, address: string): Promise<void> {
  const chatId = ctx.chat!.id;
  let token: TokenInfo;
  try {
    token = await getToken(normalizeAddress(address));
  } catch (err) {
    await ctx.reply(`❌ Could not read that token: ${esc(errorMessage(err))}\n\n📌 Send a valid ERC-20 contract address.`, {
      parse_mode: 'HTML',
    });
    return;
  }
  // Every pasted CA is remembered so the address book can find it again.
  await store.rememberToken(chatId, token);
  await ctx.reply(`🛰 Scanning every Uniswap pool for <b>${esc(token.symbol)}</b>…`, { parse_mode: 'HTML' });
  await showPoolScan(ctx, token);
}

/**
 * Handles a message that arrived outside a flow.
 *
 * A pasted contract address is all it takes: the pools are scanned and listed
 * right away, so the user never has to type `/new` first.
 */
export async function handleLooseText(ctx: Context, text: string): Promise<boolean> {
  if (!looksLikeAddress(text)) return false;
  await scanPastedAddress(ctx, text);
  return true;
}

/** Text input while a /new flow is active. Returns false when not handled. */
export async function handleNewText(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const session = getSession(chatId);
  if (!session) return false;

  if (session.step === 'token') {
    await scanPastedAddress(ctx, text);
    return true;
  }

  if (session.step === 'customRange') {
    const pool = session.scan.pools[session.selected]!.pool;
    const numbers = text
      .split(/[-–,;]|\s+to\s+/i)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    if (numbers.length !== 2 || numbers.some((n) => !Number.isFinite(n) || n <= 0)) {
      await ctx.reply('Send the range as two positive prices, e.g. <code>1800 - 2200</code>', { parse_mode: 'HTML' });
      return true;
    }
    const [a, b] = numbers as [number, number];
    const { tickLower, tickUpper } = ticksFromQuotedRange(pool, session.token, Math.min(a, b), Math.max(a, b));
    await askAmount(ctx, {
      token: session.token,
      quote: quoteOf(pool, session.token),
      pool,
      tickLower,
      tickUpper,
      side: session.side,
      strategy: session.strategy ?? 'spot',
    });
    return true;
  }

  if (session.step === 'amount') {
    const usd = Number(text.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(usd) || usd <= 0) {
      await ctx.reply('Send a deposit size in USD, e.g. <code>50</code>', { parse_mode: 'HTML' });
      return true;
    }
    await preview(ctx, session.draft, usd);
    return true;
  }

  return false;
}

async function askAmount(ctx: Context, draft: Draft): Promise<void> {
  const entries = store.settingsFor(ctx.chat!.id).bidAskEntries;
  const bidAsk = draft.strategy === 'bidAsk';
  setSession(ctx.chat!.id, { step: 'amount', draft });
  await ctx.reply(
    [
      `💰 <b>Size the ${bidAsk ? 'Bid Ask ladder' : 'position'} · ${esc(draft.token.symbol)}/${esc(draft.quote.symbol)}</b>`,
      ...(bidAsk
        ? [
            `📊 Effective entries: <b>${entries}</b> (change in ⚙️ Settings)`,
            `🧮 Total split ${Array.from({ length: entries }, (_, i) => i + 1).join(' : ')} — nearest gets the smallest share, farthest the largest.`,
            '────────────',
          ]
        : ['────────────']),
      draft.side === 'both'
        ? '✏️ Reply with a USD amount (e.g. <code>50</code>), or pick a share of your wallet below:'
        : '✏️ Pick a share of your wallet balance below (the size is taken from the funded side only):',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: amountKeyboard() },
  );
}

async function preview(ctx: Context, draft: Draft, usd: number): Promise<void> {
  if (draft.strategy === 'bidAsk') {
    await previewBidAsk(ctx, draft, usd);
    return;
  }

  try {
    const pool = (await refreshPool(draft.pool)) ?? draft.pool;

    // Screen the token before anything is signed: a failed check stops here.
    const safety = await screenToken(pool, draft.token, draft.quote);
    if (safety.danger) {
      clearSession(ctx.chat!.id);
      await ctx.reply(
        `${safetyText(safety, pool, draft.token)}\n\nSending you back to the pool list — pick another pool or token.`,
        { parse_mode: 'HTML' },
      );
      await showPoolScan(ctx, draft.token);
      return;
    }

    const plan = await planByUsd(pool, draft.tickLower, draft.tickUpper, usd, botAddress);
    setSession(ctx.chat!.id, {
      step: 'confirm',
      draft: { ...draft, pool },
      liquidity: plan.liquidity,
      amount0: plan.amount0,
      amount1: plan.amount1,
      valueUsd: plan.valueUsd,
      price: displayPrice(pool, draft.token),
    });
    await sendPreview(ctx, { ...draft, pool }, plan, safety);
  } catch (err) {
    await ctx.reply(`❌ Could not build that position: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
  }
}

async function previewBidAsk(ctx: Context, draft: Draft, totalUsd: number): Promise<void> {
  try {
    if (draft.side === 'both') throw new Error('Bid Ask requires a one-sided entry');
    const pool = (await refreshPool(draft.pool)) ?? draft.pool;

    // Screen the token once, before any of the N mints are built.
    const safety = await screenToken(pool, draft.token, draft.quote);
    if (safety.danger) {
      clearSession(ctx.chat!.id);
      await ctx.reply(
        `${safetyText(safety, pool, draft.token)}\n\nSending you back to the pool list — pick another pool or token.`,
        { parse_mode: 'HTML' },
      );
      await showPoolScan(ctx, draft.token);
      return;
    }

    const entryCount = store.settingsFor(ctx.chat!.id).bidAskEntries;
    const plan = await buildBidAskPlan({
      pool,
      token: draft.token,
      side: draft.side,
      tickLower: draft.tickLower,
      tickUpper: draft.tickUpper,
      totalUsd,
      entryCount,
      owner: botAddress,
    });
    setSession(ctx.chat!.id, {
      step: 'confirm',
      draft: { ...draft, pool },
      liquidity: 0n,
      amount0: plan.amount0,
      amount1: plan.amount1,
      valueUsd: plan.plannedUsd,
      price: displayPrice(pool, draft.token),
      bidAsk: plan,
    });
    await sendBidAskPreview(ctx, { ...draft, pool }, plan, safety);
  } catch (err) {
    await ctx.reply(`❌ Could not build that Bid Ask ladder: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
  }
}

/* ------------------------------ callbacks -------------------------------- */

export async function handleNewCallback(ctx: Context, data: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const session = getSession(chatId);
  const [, action, arg] = data.split(':');

  if (action === 'cancel') {
    clearSession(chatId);
    await answer(ctx, { text: 'Cancelled' });
    await ctx.editMessageText('✖ Cancelled. Use /menu to start again.').catch(() => undefined);
    return true;
  }

  if (!session) {
    await answer(ctx, { text: 'This flow expired. Send /new again.', show_alert: true });
    return true;
  }

  if (action === 'noop') {
    await answer(ctx);
    return true;
  }

  if (action === 'page' && session.step === 'range') {
    const options: PoolViewOptions = { sort: session.sort, hideBroken: session.hideBroken };
    const page = clampPage(Number(arg), session.scan, options);
    setSession(chatId, { ...session, page });
    await answer(ctx);
    await ctx
      .editMessageText(scanText(session.scan, page, options), {
        parse_mode: 'HTML',
        reply_markup: scanKeyboard(session.scan, page, options),
      })
      .catch(() => undefined);
    return true;
  }

  if ((action === 'sort' || action === 'filter') && session.step === 'range') {
    const sort = action === 'sort' ? nextSort(session.sort) : session.sort;
    const hideBroken = action === 'filter' ? !session.hideBroken : session.hideBroken;
    const options: PoolViewOptions = { sort, hideBroken };
    setSession(chatId, { ...session, sort, hideBroken, page: 0 });
    await answer(ctx, {
      text: action === 'sort' ? `Sorted by ${sort.toUpperCase()}` : `Broken pools ${hideBroken ? 'hidden' : 'shown'}`,
    });
    await ctx
      .editMessageText(scanText(session.scan, 0, options), {
        parse_mode: 'HTML',
        reply_markup: scanKeyboard(session.scan, 0, options),
      })
      .catch(() => undefined);
    return true;
  }

  if (action === 'rescan' && session.step === 'range') {
    await answer(ctx, { text: 'Rescanning…' });
    await showPoolScan(ctx, session.token, true);
    return true;
  }

  if (action === 'pool' && session.step === 'range') {
    const rank = Number(arg);
    // Buttons are numbered in the current sort/filter order, so resolve the
    // tapped row back to its stable index in the scan.
    const visible = visiblePools(session.scan, { sort: session.sort, hideBroken: session.hideBroken });
    const picked = visible[rank];
    const index = picked ? session.scan.pools.indexOf(picked) : -1;
    const entry = index >= 0 ? session.scan.pools[index] : undefined;
    if (!entry) {
      await answer(ctx, { text: 'Unknown pool' });
      return true;
    }
    setSession(chatId, { ...session, selected: index });
    await answer(ctx);
    if (entry.health === 'broken') {
      await ctx.reply(
        `❌ <b>${esc(entry.pool.token0.symbol)}/${esc(entry.pool.token1.symbol)}</b> trades at $${esc(fmtPriceUsd(entry.priceUsd))}, ${Math.abs(entry.deviationPct).toFixed(1)}% away from the market price.\n\nOpening here would hand your deposit to arbitrageurs. Pick another pool.`,
        { parse_mode: 'HTML' },
      );
      return true;
    }
    await sidePrompt(ctx, {
      token: session.token,
      scan: session.scan,
      page: session.page,
      selected: index,
      sort: session.sort,
      hideBroken: session.hideBroken,
    });
    return true;
  }

  if (action === 'side' && session.step === 'side') {
    const side = arg === 'quote' || arg === 'token' ? arg : 'both';
    const pool = session.scan.pools[session.selected]?.pool ?? session.scan.pools[0]!.pool;
    if (side === 'both') {
      setSession(chatId, { ...session, step: 'range', side, strategy: 'spot' });
      await answer(ctx);
      await rangePrompt(ctx, pool, session.token, side, 'spot');
      return true;
    }
    setSession(chatId, { ...session, step: 'strategy', side });
    await answer(ctx);
    await strategyPrompt(ctx, {
      token: session.token,
      scan: session.scan,
      page: session.page,
      selected: session.selected,
      sort: session.sort,
      hideBroken: session.hideBroken,
      side,
    });
    return true;
  }

  if (action === 'strategy' && session.step === 'strategy') {
    const strategy: EntryStrategy = arg === 'bidAsk' ? 'bidAsk' : 'spot';
    const pool = session.scan.pools[session.selected]?.pool ?? session.scan.pools[0]!.pool;
    setSession(chatId, { ...session, step: 'range', strategy });
    await answer(ctx, {
      text: strategy === 'bidAsk' ? 'Bid Ask ladder' : 'Spot range',
    });
    await rangePrompt(ctx, pool, session.token, session.side, strategy);
    return true;
  }

  if (action === 'range' && (session.step === 'range' || session.step === 'side')) {
    const pool = session.scan.pools[session.selected]?.pool ?? session.scan.pools[0]?.pool;
    if (!pool) {
      // The scan has no pool any more (the token can have been delisted
      // between the scan and the tap). Say so instead of crashing.
      await answer(ctx, { text: 'No pool left for this token — rescan it.', show_alert: true });
      return true;
    }
    const token = session.token;
    // The chosen side is carried by the range step, or inferred from the button
    // prefix (q* = quote-only, t* = token-only) while still on the side step.
    const side: 'both' | 'quote' | 'token' =
      session.step === 'range'
        ? session.side
        : (arg ?? '').startsWith('q')
          ? 'quote'
          : (arg ?? '').startsWith('t')
            ? 'token'
            : 'both';
    const strategy: EntryStrategy = session.step === 'range' ? (session.strategy ?? 'spot') : 'spot';
    let ticks;
    if (arg === 'full') {
      if (side !== 'both') {
        await answer(ctx, {
          text: 'Full range needs both tokens — pick a one-sided range for this side.',
          show_alert: true,
        });
        return true;
      }
      ticks = fullRangeTicks(pool.tickSpacing);
    } else if ((arg ?? '') === 'custom') {
      setSession(chatId, {
        step: 'customRange',
        token,
        scan: session.scan,
        page: session.page,
        selected: session.selected,
        sort: session.sort,
        hideBroken: session.hideBroken,
        side,
        strategy,
      });
      await answer(ctx);
      await ctx.reply(
        `Send the range as two prices in ${esc(quoteOf(pool, token).symbol)} per ${esc(token.symbol)}, e.g. <code>${fmtPrice(displayPrice(pool, token) * 0.9)} - ${fmtPrice(displayPrice(pool, token) * 1.1)}</code>`,
        { parse_mode: 'HTML' },
      );
      return true;
    } else {
      const pct = Number((arg ?? '').replace(/^[qt]/, ''));
      if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
        await answer(ctx, { text: 'Invalid range' });
        return true;
      }
      const price = displayPrice(pool, token);
      ticks =
        side === 'both'
          ? ticksFromQuotedRange(pool, token, price * (1 - pct / 100), price * (1 + pct / 100))
          : oneSidedTicksFor(pool, token, side, pct);
    }
    await answer(ctx);
    await askAmount(ctx, {
      token,
      quote: quoteOf(pool, token),
      pool,
      tickLower: ticks.tickLower,
      tickUpper: ticks.tickUpper,
      side,
      strategy,
    });
    return true;
  }

  if (action === 'amt' && session.step === 'amount') {
    const pct = Number(arg);
    if (!botAddress) {
      await answer(ctx, { text: 'No wallet configured', show_alert: true });
      return true;
    }
    // The pool is refreshed and the deposit is planned before the answer:
    // acknowledge the tap first, so the button never feels dead.
    await answer(ctx);
    try {
      const pool = (await refreshPool(session.draft.pool)) ?? session.draft.pool;
      if (session.draft.strategy === 'bidAsk') {
        if (session.draft.side === 'both') throw new Error('Bid Ask requires a one-sided entry');
        const total = await planBySideShare(
          pool,
          session.draft.tickLower,
          session.draft.tickUpper,
          session.draft.side,
          pct,
          botAddress,
          session.draft.token,
        );
        await previewBidAsk(ctx, { ...session.draft, pool }, total.valueUsd);
        return true;
      }
      const plan =
        session.draft.side === 'both'
          ? await planByWalletShare(pool, session.draft.tickLower, session.draft.tickUpper, pct, botAddress)
          : await planBySideShare(
              pool,
              session.draft.tickLower,
              session.draft.tickUpper,
              session.draft.side,
              pct,
              botAddress,
              session.draft.token,
            );
      setSession(chatId, {
        step: 'confirm',
        draft: { ...session.draft, pool },
        liquidity: plan.liquidity,
        amount0: plan.amount0,
        amount1: plan.amount1,
        valueUsd: plan.valueUsd,
        price: displayPrice(pool, session.draft.token),
      });
      await sendPreview(ctx, { ...session.draft, pool }, plan);
    } catch (err) {
      await answer(ctx, { text: errorMessage(err), show_alert: true });
    }
    return true;
  }

  if (action === 'confirm' && session.step === 'confirm') {
    if (session.bidAsk) await executeBidAskOpen(ctx, session);
    else await executeOpen(ctx, session);
    return true;
  }

  return false;
}

/**
 * The bits the PnL card needs that only exist while the position is open:
 * the market cap at entry, the configured range and the strategy.
 */
async function cardContext(
  pool: Pool,
  token: TokenInfo,
  tickLower: number,
  tickUpper: number,
  entryPrice: number,
  strategy: EntryStrategy,
  knownMcap?: number,
): Promise<{
  entryMcapUsd?: number;
  rangeLabel: string;
  strategy: 'spot' | 'bidAsk';
  contract: string;
}> {
  const traded = tradedToken(pool);
  const mcap = knownMcap ?? (await fetchMarketCap(traded).catch(() => Number.NaN));
  return {
    entryMcapUsd: Number.isFinite(mcap) ? mcap : undefined,
    rangeLabel: formatRangeLabel(
      displayPriceAtTick(pool, token, tickLower),
      displayPriceAtTick(pool, token, tickUpper),
      entryPrice,
    ),
    strategy: strategy === 'bidAsk' ? 'bidAsk' : 'spot',
    contract: traded.address,
  };
}

async function executeOpen(ctx: Context, session: Extract<NonNullable<ReturnType<typeof getSession>>, { step: 'confirm' }>): Promise<void> {
  const chatId = ctx.chat!.id;
  const owner = botAddress;
  if (!owner) {
    await answer(ctx, { text: 'No wallet configured', show_alert: true });
    return;
  }
  const settings = store.settingsFor(chatId);
  const { draft } = session;

  await answer(ctx, { text: 'Submitting…' });
  const status = await ctx.reply(settings.dryRun ? '🧪 Simulating…' : '⚡ Sending transaction…');

  try {
    await txLock.run(`chat:${chatId}`, async () => {
      // A second tap on Confirm Open queues behind the first one on the chat
      // lock. The first tap ends the flow, so this one has to stop: the
      // position must not be minted twice.
      const live = getSession(chatId);
      if (!live || live.step !== 'confirm') {
        await ctx.api
          .editMessageText(chatId, status.message_id, '✅ <b>This position was already opened.</b>', {
            parse_mode: 'HTML',
          })
          .catch(() => undefined);
        return;
      }

      const fresh = (await refreshPool(draft.pool)) ?? draft.pool;

      // The price may have moved while the user was deciding. A one-sided
      // range has to sit on one side of the market, so it is moved with the
      // price instead of failing; a two-sided range is re-centred on it.
      const direction = draft.side === 'both' ? 'both' : oneSidedDirection(fresh, draft.side);
      const reanchored = reanchorRange(
        { tickLower: draft.tickLower, tickUpper: draft.tickUpper },
        fresh.tick,
        direction,
        fresh.tickSpacing,
      );
      const tickLower = reanchored.tickLower;
      const tickUpper = reanchored.tickUpper;

      // The amounts belong to the old range, so they are planned again.
      const replanned = reanchored.changed
        ? await planByUsd(fresh, tickLower, tickUpper, session.valueUsd, owner)
        : undefined;
      const amount0 = replanned ? replanned.amount0 : session.amount0;
      const amount1 = replanned ? replanned.amount1 : session.amount1;

      const result = await openPosition({
        pool: fresh,
        tickLower,
        tickUpper,
        amount0,
        amount1,
        slippagePct: settings.slippagePct,
        recipient: owner,
        dryRun: settings.dryRun,
      });

      if (result.error) throw new Error(`Simulation reverted: ${result.error}`);

      if (result.dryRun) {
        clearSession(chatId);
        const lines = [
          result.note ? '🧪 <b>Dry-run</b> — call built, simulation skipped.' : '🧪 <b>Dry-run OK</b> — the mint call simulated successfully and was not sent.',
          result.note ? esc(result.note) : '',
          reanchored.changed ? '📐 The price moved, so the range was moved with it (same width).' : '',
          `Would deposit ${fmtAmount(result.amount0, fresh.token0.decimals)} ${esc(fresh.token0.symbol)} + ${fmtAmount(result.amount1, fresh.token1.decimals)} ${esc(fresh.token1.symbol)} (~${fmtUsd(session.valueUsd)}).`,
          'Switch off dry-run in /settings to trade for real.',
        ].filter(Boolean);
        await ctx.api.editMessageText(chatId, status.message_id, lines.join('\n'), { parse_mode: 'HTML' });
        return;
      }

      const card = await cardContext(
        fresh,
        draft.token,
        tickLower,
        tickUpper,
        session.price,
        draft.strategy ?? 'spot',
      );

      const tracked = result.tokenId
        ? await store.add({
            chatId,
            version: fresh.version,
            tokenId: result.tokenId.toString(),
            entry: {
              amount0: result.amount0.toString(),
              amount1: result.amount1.toString(),
              valueUsd: session.valueUsd,
              price: session.price,
              openedAt: Date.now(),
              txHash: result.hash,
              ethPriceUsd: await usdPrice(TOKENS.WETH).catch(() => undefined),
            },
            basisUsd: session.valueUsd,
            feesWithdrawnUsd: 0,
            compoundedFeesUsd: 0,
            alerts: store.settingsFor(chatId).alertsEnabled,
            autoCompound: false,
            compoundIntervalMs: 6 * 3_600_000,
            compoundMinFeeUsd: 1,
            autoTakeProfit: false,
            oorTakeProfit: false,
            tpCycles: store.settingsFor(chatId).tpCycleLimit,
            cycle: 1,
            range: { tickLower, tickUpper },
            ...card,
          })
        : undefined;

      clearSession(chatId);

      // A freshly opened position is shown like any other position: the
      // status, the range, the PnL and the actions. A plain "opened"
      // message would leave the user without a way to act on it.
      const screen = tracked ? await positionScreen(tracked).catch(() => undefined) : undefined;
      if (screen) {
        const note = reanchored.changed
          ? '📐 The price moved, so the range was moved with it (same width).'
          : '';
        const deposit = `💵 Deposited ${fmtAmount(result.amount0, fresh.token0.decimals)} ${esc(fresh.token0.symbol)} + ${fmtAmount(result.amount1, fresh.token1.decimals)} ${esc(fresh.token1.symbol)}`;
        const tx = result.hash ? `<a href="${txLink(result.hash)}">View transaction</a>` : '';
        const text = [screen.text, '', note, deposit, tx].filter(Boolean).join('\n');
        await ctx.api.editMessageText(chatId, status.message_id, text, {
          parse_mode: 'HTML',
          reply_markup: screen.keyboard,
          link_preview_options: { is_disabled: true },
        });
        return;
      }

      const lines = [
        `✅ <b>Position opened</b>${tracked ? ` as ${tracked.id}` : ''}`,
        `${esc(fresh.token0.symbol)}/${esc(fresh.token1.symbol)} · ${fresh.version} · ticks ${tickLower} → ${tickUpper}`,
        reanchored.changed ? '📐 The price moved, so the range was moved with it (same width).' : '',
        `Deposited ${fmtAmount(result.amount0, fresh.token0.decimals)} ${esc(fresh.token0.symbol)} + ${fmtAmount(result.amount1, fresh.token1.decimals)} ${esc(fresh.token1.symbol)}`,
      ].filter(Boolean);
      if (result.hash) lines.push(`<a href="${txLink(result.hash)}">View transaction</a>`);
      if (!tracked) lines.push('Could not read the minted tokenId from the receipt — use /import to track it.');
      await ctx.api.editMessageText(chatId, status.message_id, lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    });
  } catch (err) {
    await ctx.api
      .editMessageText(chatId, status.message_id, `❌ ${esc(errorMessage(err))}`, { parse_mode: 'HTML' })
      .catch(() => undefined);
  }
}

interface BidAskOpened {
  entry: BidAskEntryPlan;
  result: OpenPositionResult;
  pool: Pool;
  plan: DepositPlan;
  trackedId?: string;
  trackingError?: string;
}

async function executeBidAskOpen(
  ctx: Context,
  session: Extract<NonNullable<ReturnType<typeof getSession>>, { step: 'confirm' }>,
): Promise<void> {
  const chatId = ctx.chat!.id;
  const owner = botAddress;
  if (!owner) {
    await answer(ctx, { text: 'No wallet configured', show_alert: true });
    return;
  }
  const settings = store.settingsFor(chatId);
  const { draft, bidAsk } = session;
  if (!bidAsk) {
    await executeOpen(ctx, session);
    return;
  }

  // The preview froze the entry count. Never silently apply a different setting.
  if (settings.bidAskEntries !== bidAsk.entryCount) {
    clearSession(chatId);
    await answer(ctx, {
      text: 'Bid Ask entry count changed — build the preview again.',
      show_alert: true,
    });
    await ctx.reply(
      `📊 Bid Ask entries is now <b>${settings.bidAskEntries}</b>, but this preview was built for <b>${bidAsk.entryCount}</b>.\n\nSend /new to build a fresh ladder.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  if (!settings.dryRun && (bidAsk.shortfall0 > 0n || bidAsk.shortfall1 > 0n)) {
    await answer(ctx, {
      text: 'Insufficient balance — reduce the total or top up the wallet.',
      show_alert: true,
    });
    return;
  }

  await answer(ctx, { text: 'Submitting…' });
  const status = await ctx.reply(
    settings.dryRun
      ? `🧪 Simulating ${bidAsk.entryCount} Bid Ask mints…`
      : `⚡ Sending ${bidAsk.entryCount} Bid Ask transactions…`,
  );

  const opened: BidAskOpened[] = [];
  let failure: string | undefined;
  // The market cap is the same for every entry, so it is fetched once.
  const bidAskMcap = await fetchMarketCap(tradedToken(draft.pool)).catch(() => Number.NaN);

  try {
    await txLock.run(`chat:${chatId}`, async () => {
      for (const entry of bidAsk.entries) {
        try {
          await ctx.api
            .editMessageText(
              chatId,
              status.message_id,
              `${settings.dryRun ? '🧪' : '⚡'} Entry ${entry.index}/${bidAsk.entryCount} · ${fmtUsd(entry.allocationUsd)}…`,
              { parse_mode: 'HTML' },
            )
            .catch(() => undefined);

          const fresh = (await refreshPool(draft.pool)) ?? draft.pool;
          const plan = await planByUsd(fresh, entry.tickLower, entry.tickUpper, entry.allocationUsd, owner);
          const fundedAmount = bidAsk.fundedIsToken0 ? plan.amount0 : plan.amount1;
          const otherAmount = bidAsk.fundedIsToken0 ? plan.amount1 : plan.amount0;
          if (fundedAmount <= 0n) throw new Error('the allocation is too small at the current price');
          if (otherAmount !== 0n) {
            throw new Error('the price moved into this entry — rebuild the ladder with /new');
          }
          if (!settings.dryRun && (plan.shortfall0 > 0n || plan.shortfall1 > 0n)) {
            throw new Error('insufficient wallet balance');
          }

          const result = await openPosition({
            pool: fresh,
            tickLower: entry.tickLower,
            tickUpper: entry.tickUpper,
            amount0: plan.amount0,
            amount1: plan.amount1,
            slippagePct: settings.slippagePct,
            recipient: owner,
            dryRun: settings.dryRun,
          });
          if (result.error) throw new Error(`simulation reverted: ${result.error}`);

          let trackedId: string | undefined;
          let trackingError: string | undefined;
          if (!result.dryRun && result.tokenId) {
            try {
              const entryCard = await cardContext(
                fresh,
                draft.token,
                entry.tickLower,
                entry.tickUpper,
                displayPrice(fresh, draft.token),
                'bidAsk',
                bidAskMcap,
              );
              const tracked = await store.add({
                chatId,
                version: fresh.version,
                tokenId: result.tokenId.toString(),
                label: `BidAsk ${draft.token.symbol} ${entry.index}/${bidAsk.entryCount}`,
                entry: {
                  amount0: result.amount0.toString(),
                  amount1: result.amount1.toString(),
                  valueUsd: plan.valueUsd,
                  price: displayPrice(fresh, draft.token),
                  openedAt: Date.now(),
                  txHash: result.hash,
                  ethPriceUsd: await usdPrice(TOKENS.WETH).catch(() => undefined),
                },
                basisUsd: plan.valueUsd,
                feesWithdrawnUsd: 0,
                compoundedFeesUsd: 0,
                alerts: settings.alertsEnabled,
                autoCompound: false,
                compoundIntervalMs: 6 * 3_600_000,
                compoundMinFeeUsd: 1,
                autoTakeProfit: false,
                oorTakeProfit: false,
                tpCycles: settings.tpCycleLimit,
                cycle: 1,
                range: { tickLower: entry.tickLower, tickUpper: entry.tickUpper },
                entryMcapUsd: entryCard.entryMcapUsd,
                rangeLabel: entryCard.rangeLabel,
                strategy: 'bidAsk',
                contract: entryCard.contract,
              });
              trackedId = tracked.id;
            } catch (err) {
              trackingError = errorMessage(err);
            }
          }

          opened.push({ entry, result, pool: fresh, plan, trackedId, trackingError });
        } catch (err) {
          failure = `Entry #${entry.index}: ${errorMessage(err)}`;
          break;
        }
      }
    });
  } catch (err) {
    failure = errorMessage(err);
  }

  clearSession(chatId);

  const liveOpened = opened.filter((item) => !item.result.dryRun).length;
  const lines: string[] = [];
  if (failure) {
    lines.push(
      `⚠️ <b>Bid Ask stopped</b> — ${settings.dryRun ? opened.length : liveOpened}/${bidAsk.entryCount} ${settings.dryRun ? 'simulated' : 'opened'}.`,
    );
  } else if (settings.dryRun) {
    lines.push(`🧪 <b>Bid Ask dry-run OK</b> — ${opened.length}/${bidAsk.entryCount} mints simulated.`);
  } else {
    lines.push(`✅ <b>Bid Ask opened</b> — ${liveOpened}/${bidAsk.entryCount} positions.`);
  }
  lines.push(
    `${esc(pairLabel(draft.pool, draft.token))} · ${draft.pool.version} · ${
      bidAsk.side === 'quote' ? `💵 ${esc(draft.quote.symbol)} only` : `🪙 ${esc(draft.token.symbol)} only`
    }`,
    '────────────',
  );

  for (const item of opened) {
    const amounts =
      `${fmtAmount(item.result.amount0, item.pool.token0.decimals)} ${esc(item.pool.token0.symbol)} + ` +
      `${fmtAmount(item.result.amount1, item.pool.token1.decimals)} ${esc(item.pool.token1.symbol)}`;
    if (item.result.dryRun) {
      lines.push(`#${item.entry.index} · ${fmtUsd(item.plan.valueUsd)} · ${amounts}`);
      if (item.result.note) lines.push(`   ${esc(item.result.note)}`);
      continue;
    }
    const tokenId = item.result.tokenId ? ` · NFT #${item.result.tokenId}` : '';
    const tracked = item.trackedId ? ` · ${item.trackedId}` : '';
    lines.push(`#${item.entry.index} · ${fmtUsd(item.plan.valueUsd)} · ${amounts}${tokenId}${tracked}`);
    lines.push(`   Tick ${item.entry.tickLower} → ${item.entry.tickUpper}`);
    if (item.result.hash) lines.push(`   <a href="${txLink(item.result.hash)}">View transaction</a>`);
    if (item.trackingError) lines.push(`   ⚠️ Minted but could not track: ${esc(item.trackingError)}`);
    if (!item.result.tokenId) {
      lines.push('   ⚠️ The NFT id could not be read — track it with /detect if you want alerts.');
    }
  }

  if (failure) {
    lines.push(
      '────────────',
      `❌ ${esc(failure)}`,
      settings.dryRun
        ? 'The remaining entries were not simulated.'
        : 'Opened entries remain tracked; the remaining entries were not sent.',
    );
  } else if (settings.dryRun) {
    lines.push('────────────', 'Switch off dry-run in /settings to trade for real.');
  }

  // The first opened position is shown like any other position, so the user
  // can act on it right away. The rest of the ladder stays in the list above.
  const firstTracked = opened.find((item) => item.trackedId && !item.result.dryRun);
  const first = firstTracked?.trackedId ? store.find(chatId, firstTracked.trackedId) : undefined;
  const screen = first ? await positionScreen(first).catch(() => undefined) : undefined;

  await ctx.api
    .editMessageText(
      chatId,
      status.message_id,
      screen ? [screen.text, '', ...lines].join('\n') : lines.join('\n'),
      {
        parse_mode: 'HTML',
        ...(screen ? { reply_markup: screen.keyboard } : {}),
        link_preview_options: { is_disabled: true },
      },
    )
    .catch(() => undefined);
}
