import { InlineKeyboard, type Context } from 'grammy';
import { answer } from './answers.js';
import { store, type ClosedRecord } from '../store/store.js';
import { fmtIdr } from '../core/fx.js';
import { esc, fmtDuration, fmtPct, fmtPrice, fmtUsd } from '../utils/format.js';
import { txLink } from './ui.js';
import { sendPnlCard } from './cardFlow.js';
import { present } from './screens.js';

const PAGE_SIZE = 5;

const REASON: Record<ClosedRecord['reason'], string> = {
  manual: '🔒 Manual',
  takeProfit: '🎯 Take profit',
  stopLoss: '🛑 Stop loss',
  oorTakeProfit: '📈 OOR take profit',
  autoTakeProfit: '⚡ Auto TP',
};

function reasonIcon(reason: ClosedRecord['reason']): string {
  return REASON[reason] ?? '🏁';
}

/** One-line history row: id, pair, reason, PnL in USD and IDR. */
export function historyRow(record: ClosedRecord): string {
  const badge = record.pnlUsd >= 0 ? '🟢' : '🔴';
  const pieces = [
    `${badge} <b>${esc(record.id)}</b> ${esc(record.pair)} ${record.version} · ${reasonIcon(record.reason)}`,
    `   ${fmtUsd(record.pnlUsd)} (${fmtPct(record.pnlPct)}) · 💵 ${fmtIdr(record.pnlUsd, record.idrRate)} · ⏳ ${fmtDuration(record.closedAt - record.openedAt)}`,
  ];
  if (record.cycle !== undefined && record.reason === 'autoTakeProfit') {
    pieces[1] += ` · 🔄 cycle ${record.cycle}`;
  }
  return pieces.join('\n');
}

function shortDate(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

export function historyText(chatId: number, page = 0): string {
  const all = store.historyFor(chatId);
  if (all.length === 0) {
    return [
      '📜 <b>History</b>',
      '────────────',
      '🫙 No closed positions yet.',
      '',
      '🚀 Open a position, or 📥 import an existing one, and every exit lands here.',
    ].join('\n');
  }

  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);
  const rows = all.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  const pnlUsd = all.reduce((sum, r) => sum + r.pnlUsd, 0);
  const feesUsd = all.reduce((sum, r) => sum + r.feesUsd, 0);
  const wins = all.filter((r) => r.pnlUsd > 0).length;
  const rate = all.find((r) => Number.isFinite(r.idrRate))?.idrRate ?? Number.NaN;

  return [
    '📜 <b>History</b>',
    '────────────',
    `🏁 Closed: <b>${all.length}</b> · 📈 net PnL <b>${fmtUsd(pnlUsd)}</b> (💵 ${fmtIdr(pnlUsd, rate)})`,
    `🎯 Win rate ${((wins / all.length) * 100).toFixed(0)}% · 💧 fees ${fmtUsd(feesUsd)}`,
    '────────────',
    ...rows.map(historyRow),
    '',
    `📄 Page ${current + 1}/${pages}`,
  ].join('\n');
}

function historyKeyboard(chatId: number, page = 0): InlineKeyboard {
  const all = store.historyFor(chatId);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);
  const kb = new InlineKeyboard();

  const start = current * PAGE_SIZE;
  for (const record of all.slice(start, start + PAGE_SIZE)) {
    kb.text(`${record.pnlUsd >= 0 ? '🟢' : '🔴'} ${record.id} ${fmtUsd(record.pnlUsd)}`, `hist:show:${record.id}`).row();
  }

  if (pages > 1) {
    if (current > 0) kb.text('◀ Newer', `hist:page:${current - 1}`);
    if (current < pages - 1) kb.text('Older ▶', `hist:page:${current + 1}`);
    kb.row();
  }
  return kb.text('🏠 Menu', 'menu:home');
}

export async function showHistory(ctx: Context, page = 0, edit = false): Promise<void> {
  const chatId = ctx.chat!.id;
  await present(ctx, historyText(chatId, page), historyKeyboard(chatId, page), edit);
}

export function recordText(record: ClosedRecord): string {
  const dry = record.dryRun ? ' · 🧪 dry-run' : '';
  const lines = [
    `📜 <b>${esc(record.id)} · ${esc(record.pair)}</b> · ${esc(record.version) || '?'}${dry}`,
    `🏷 Reason: ${reasonIcon(record.reason)}${record.cycle !== undefined ? ` · 🔄 cycle ${record.cycle}` : ''}`,
    '────────────',
    `📥 Entry <code>${fmtPrice(record.entryPrice)}</code> → 🏁 Exit <code>${fmtPrice(record.exitPrice)}</code>`,
    `💰 Value ${fmtUsd(record.entryValueUsd)} → ${fmtUsd(record.exitValueUsd)} · 💧 fees ${fmtUsd(record.feesUsd)}`,
    `📈 PnL <b>${fmtUsd(record.pnlUsd)}</b> (${fmtPct(record.pnlPct)})`,
    `💵 ${fmtIdr(record.pnlUsd, record.idrRate)}${Number.isFinite(record.idrRate) ? ` @ Rp ${Math.round(record.idrRate).toLocaleString('id-ID')}/USD` : ' · rate unknown'}`,
    '────────────',
    `⏳ ${fmtDuration(record.closedAt - record.openedAt)} · 🕒 ${shortDate(record.openedAt)} → ${shortDate(record.closedAt)}`,
    `🔖 tokenId ${esc(record.tokenId)}`,
  ];
  if (record.txHash) lines.push(`<a href="${txLink(record.txHash)}">View transaction</a>`);
  return lines.join('\n');
}

/** Handles `hist:*` and `card:*` callbacks. */
export async function handleHistoryCallback(ctx: Context, data: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const [prefix, action, arg] = data.split(':');

  // The card callback carries no namespace (`card:<id>`), while the history
  // callbacks do (`hist:<action>[:<arg>]`). They cannot share one destructure.
  if (prefix === 'card') {
    if (!action) {
      await answer(ctx, { text: 'No closed position given', show_alert: true });
      return true;
    }
    await answer(ctx);
    await sendPnlCard(ctx, action);
    return true;
  }

  if (action === 'list') {
    await answer(ctx);
    await showHistory(ctx, 0, true);
    return true;
  }

  if (action === 'page') {
    const page = Number(arg);
    await answer(ctx);
    await showHistory(ctx, Number.isFinite(page) ? page : 0, true);
    return true;
  }

  if (action === 'show' && arg) {
    const record = store.findClosed(chatId, arg);
    if (!record) {
      await answer(ctx, { text: 'That record is gone', show_alert: true });
      return true;
    }
    await answer(ctx);
    await present(
      ctx,
      recordText(record),
      new InlineKeyboard()
        .text('🖼 PnL card', `card:${record.id}`)
        .row()
        .text('◀ Back to history', 'hist:list')
        .row()
        .text('🏠 Menu', 'menu:home'),
      true,
    );
    return true;
  }

  await answer(ctx);
  return true;
}
