import { InlineKeyboard, type Context } from 'grammy';
import { answer } from './answers.js';
import { esc } from '../utils/format.js';
import { fmtCompactUsd } from '../utils/format.js';
import {
  DEFAULT_TRENDING_WINDOW,
  TRENDING_LIMIT,
  TRENDING_WINDOWS,
  safeTrendingTokens,
  type TrendingToken,
  type TrendingWindow,
} from '../core/trending.js';
import { gmgnTokenLink } from './links.js';
import { scanPastedAddress } from './newFlow.js';
import { showLoading } from './screens.js';

function isWindow(value: string | undefined): value is TrendingWindow {
  return TRENDING_WINDOWS.includes(value as TrendingWindow);
}

/** The rank emoji for a position in the list. */
const RANK_EMOJI = [
  '1️⃣',
  '2️⃣',
  '3️⃣',
  '4️⃣',
  '5️⃣',
  '6️⃣',
  '7️⃣',
  '8️⃣',
  '9️⃣',
  '🔟',
];

/**
 * The trending list.
 *
 * Each token gets two lines: the symbol with its change, then the numbers
 * that matter (market cap, liquidity, volume). The price is left out — it is
 * noise here, the market cap is the size that counts.
 */
export function trendingText(tokens: TrendingToken[], window: TrendingWindow): string {
  const lines = [
    `🔥 <b>Top Trending</b> · Robinhood Chain`,
    `⏱ Window <b>${window}</b> · ranked by volume`,
    '────────────────',
  ];
  if (tokens.length === 0) {
    lines.push('🚫 The trending list is not available right now.');
    return lines.join('\n');
  }
  tokens.slice(0, TRENDING_LIMIT).forEach((token, index) => {
    const change = Number.isFinite(token.changePct)
      ? `${token.changePct > 0 ? '▲' : token.changePct < 0 ? '▼' : '▬'} ${token.changePct > 0 ? '+' : ''}${token.changePct.toFixed(1)}%`
      : '—';
    const mcap = Number.isFinite(token.marketCapUsd) ? `🏦 MC ${fmtCompactUsd(token.marketCapUsd)}` : '';
    const liquidity = Number.isFinite(token.liquidityUsd) ? `🧲 Liq ${fmtCompactUsd(token.liquidityUsd)}` : '';
    const volume = Number.isFinite(token.volumeUsd) ? `💵 Vol ${fmtCompactUsd(token.volumeUsd)}` : '';
    const stats = [mcap, liquidity, volume].filter(Boolean).join(' · ');
    lines.push(
      `${RANK_EMOJI[index] ?? `${index + 1}.`} <b>${esc(token.symbol)}</b>  ${change}`,
      stats ? `   ${esc(stats)}` : '',
    );
  });
  lines.push(
    '────────────────',
    '👆 Tap a token to scan its pools · 🧭 opens GMGN',
  );
  return lines.filter((line) => line !== '').join('\n');
}

/** The window toggle, one row per token and a GMGN link next to each. */
export function trendingKeyboard(tokens: TrendingToken[], window: TrendingWindow): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const candidate of TRENDING_WINDOWS) {
    kb.text(
      candidate === window ? `• ${candidate}` : candidate,
      `trend:w:${candidate}`,
    );
  }
  kb.row();
  for (const token of tokens.slice(0, TRENDING_LIMIT)) {
    kb.text(`🔍 ${token.symbol}`, `trend:s:${token.address}`);
    kb.url('🧭', gmgnTokenLink(token.address));
    kb.row();
  }
  return kb;
}

/** Shows the trending list. */
export async function showTrending(ctx: Context, window: TrendingWindow = DEFAULT_TRENDING_WINDOW): Promise<void> {
  // GMGN is rate limited and can take a moment: say that the list is on its
  // way, so the button is not tapped again.
  if (ctx.callbackQuery) await showLoading(ctx, '⏳ <b>Loading the trending list…</b>');
  const tokens = await safeTrendingTokens(window);
  const text = trendingText(tokens, window);
  const keyboard = trendingKeyboard(tokens, window);
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => undefined);
    return;
  }
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

/** Handles the `trend:*` callbacks. */
export async function handleTrendingCallback(ctx: Context, data: string): Promise<boolean> {
  const [, action, value] = data.split(':');
  await answer(ctx);

  if (action === 'w' && isWindow(value)) {
    await showTrending(ctx, value);
    return true;
  }
  if (action === 's' && value) {
    // The same path as a pasted contract address: scan the pools right away.
    await scanPastedAddress(ctx, value);
    return true;
  }
  return true;
}
