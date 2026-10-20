import { InlineKeyboard, type Context } from 'grammy';
import { answer } from './answers.js';
import { botAddress } from '../chain/client.js';
import { store, type ChatSettings, type TrackedPosition } from '../store/store.js';
import { esc, shortAddr } from '../utils/format.js';
import { listPositions, portfolioSummary, positionButton } from './positionsFlow.js';
import { showCalendar } from './calendarFlow.js';
import { showTrending } from './trendingFlow.js';
import { startNew } from './newFlow.js';
import { showHelp, showSettings, showWallet, showStatus, present } from './screens.js';
import { showHistory } from './historyFlow.js';
import { showBook } from './addressBookFlow.js';
import { runDetect } from './detectFlow.js';
import { clearSession } from './session.js';
import { ensureViews, type PositionView } from '../core/positionViews.js';
import { menuPositionRow, positionNumber } from './ui.js';

const MENU_TITLE = '🏠 ROBINHOOD LP BOT';

/**
 * Welcome screen: mode, wallet and the open positions.
 *
 * The positions are drawn from the cached views, so the home screen never
 * waits for the chain. The cache is refreshed in the background; the first
 * time — when there is nothing to draw yet — the menu waits for the read.
 */
export function menuText(chatId: number, views?: Map<string, PositionView>): string {
  const settings = store.settingsFor(chatId);
  const positions = store.positionsFor(chatId);
  const armed = positions.filter(
    (p) => p.takeProfitPct !== undefined || p.stopLossPct !== undefined,
  ).length;
  const closed = store.historyFor(chatId);
  const netPnl = closed.reduce((sum, record) => sum + record.pnlUsd, 0);

  const lines = [
    `<b>${MENU_TITLE}</b>`,
    'Uniswap v3 + v4 · Robinhood Chain (4663)',
    '────────────',
    settings.dryRun ? '🧪 Mode: <b>DRY-RUN</b> — nothing is sent' : '⚡ Mode: <b>LIVE</b> — real transactions',
    `🔔 Range alerts: <b>${settings.alertsEnabled ? 'on' : 'off'}</b> — out of range and back in range`,
    `👛 Wallet: ${botAddress ? `<code>${esc(shortAddr(botAddress))}</code>` : '⚠️ not configured'}`,
    `📊 Open positions: <b>${positions.length}</b>`,
    `🎯 Armed exit rules: <b>${armed}</b>`,
    `📜 Closed: <b>${closed.length}</b>${closed.length > 0 ? ` · net PnL ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}` : ''}`,
  ];

  // The open positions, with their range, market cap, PnL and fees.
  if (positions.length > 0) {
    lines.push('────────────');
    for (const tracked of positions) {
      const view = views?.get(tracked.id);
      lines.push(
        view
          ? menuPositionRow(tracked, view, view.marketCapUsd)
          : `⚪ <b>${positionNumber(tracked.id)}</b> — the position is being read…`,
      );
    }
  }

  lines.push('────────────', '👇 Pick an action:');
  return lines.join('\n');
}

/** The button of every open position, so it can be tapped from the menu. */
function positionButtons(
  positions: TrackedPosition[],
  views?: Map<string, PositionView>,
): { text: string; data: string }[] {
  const buttons: { text: string; data: string }[] = [];
  for (const tracked of positions) {
    const view = views?.get(tracked.id);
    if (!view) continue;
    buttons.push({ text: positionButton(tracked, view), data: `pos:show:${tracked.id}` });
  }
  return buttons;
}

export function menuKeyboard(
  settings?: ChatSettings,
  positions: TrackedPosition[] = [],
  views?: Map<string, PositionView>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  // The open positions come first: they are what the home screen is for.
  for (const button of positionButtons(positions, views)) {
    kb.text(button.text, button.data).row();
  }
  kb.text('🚀 Open position', 'menu:open')
    .row()
    .text('📅 Profit Calendar', 'menu:calendar')
    .text('📊 Positions', 'menu:positions')
    .row()
    .text('🔥 Top Trending', 'menu:trending')
    .row()
    .text('💼 Portfolio', 'menu:portfolio')
    .text('🔍 Detect', 'menu:detect')
    .row()
    .text('📜 History', 'menu:history')
    .text('👛 Wallet', 'menu:wallet')
    .row()
    .text('⚙️ Settings', 'menu:settings')
    .text('📒 Address book', 'menu:book')
    .row()
    .text('📡 Status', 'menu:status')
    .text('ℹ️ Help', 'menu:help');
  if (settings) {
    // The range alerts (out of range and back in range) can be switched off
    // straight from the menu.
    kb.row()
      .text(settings.alertsEnabled ? '🔕 Range alerts off' : '🔔 Range alerts on', 'menu:alerts');
  }
  return kb;
}

export async function showMenu(ctx: Context, edit = false): Promise<void> {
  const chatId = ctx.chat!.id;
  const positions = store.positionsFor(chatId);
  // The views are cached: the menu is instant most of the time. Only a cold
  // cache is waited for, because there would be nothing to show otherwise.
  const views = await ensureViews(positions);
  await present(
    ctx,
    menuText(chatId, views),
    menuKeyboard(store.settingsFor(chatId), positions, views),
    edit,
  );
}

/** Handles `menu:*` callbacks; every sub-screen keeps the same message. */
export async function handleMenuCallback(ctx: Context, data: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const [, action] = data.split(':');

  switch (action) {
    case 'home':
      clearSession(chatId);
      await answer(ctx, { text: 'Menu' });
      await showMenu(ctx, true);
      return true;

    case 'open':
      clearSession(chatId);
      await answer(ctx);
      await startNew(ctx);
      return true;

    case 'positions':
      await answer(ctx);
      await listPositions(ctx, true);
      return true;

    case 'trending':
      await answer(ctx);
      await showTrending(ctx);
      return true;

    case 'calendar':
      await answer(ctx);
      await showCalendar(ctx);
      return true;

    case 'portfolio':
      await answer(ctx);
      await portfolioSummary(ctx, true);
      return true;

    case 'detect':
      await answer(ctx, { text: 'Scanning…' });
      // The scan can take minutes, so it gets its own message and the menu
      // stays usable while it runs.
      await runDetect(ctx);
      return true;

    case 'history':
      await answer(ctx);
      await showHistory(ctx, 0, true);
      return true;

    case 'book':
      await answer(ctx);
      await showBook(ctx, true);
      return true;

    case 'wallet':
      await answer(ctx);
      await showWallet(ctx, true);
      return true;

    case 'settings':
      await answer(ctx);
      await showSettings(ctx, true);
      return true;

    case 'alerts': {
      const current = store.settingsFor(chatId);
      const next = !current.alertsEnabled;
      await store.updateSettings(chatId, { alertsEnabled: next });
      await answer(ctx, { text: next ? 'Range alerts on' : 'Range alerts off' });
      await showMenu(ctx, true);
      return true;
    }

    case 'status':
      await answer(ctx);
      await showStatus(ctx, true);
      return true;

    case 'help':
      await answer(ctx);
      await showHelp(ctx, true);
      return true;

    default:
      await answer(ctx);
      return true;
  }
}
