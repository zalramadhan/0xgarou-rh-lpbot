import { InlineKeyboard, type Context } from 'grammy';
import { answer } from './answers.js';
import { store, type AddressBookEntry } from '../store/store.js';
import { getToken, normalizeAddress } from '../core/tokens.js';
import { esc, shortAddr } from '../utils/format.js';
import { errorMessage } from '../utils/errors.js';
import { clearSession, getSession, setSession } from './session.js';
import { showPoolScan } from './newFlow.js';
import { present } from './screens.js';

function entryRow(entry: AddressBookEntry): string {
  const used = new Date(entry.lastUsedAt).toISOString().slice(0, 10);
  return `📌 <b>${esc(entry.symbol)}</b> · <code>${esc(shortAddr(entry.address))}</code> · 🕒 ${used}`;
}

export function bookText(chatId: number, matches?: AddressBookEntry[]): string {
  const entries = matches ?? store.addressesFor(chatId);
  if (entries.length === 0) {
    return [
      '📒 <b>Address book</b>',
      '────────────',
      matches ? '🔎 Nothing matched that search.' : '🫙 Empty — every token CA you paste is saved here automatically.',
      '',
      '➕ Tap Add to save a contract address.',
    ].join('\n');
  }
  return [
    `📒 <b>Address book</b>${matches ? ` · 🔎 ${matches.length} match${matches.length === 1 ? '' : 'es'}` : ''}`,
    '────────────',
    ...entries.map(entryRow),
    '────────────',
    matches ? '👇 Tap an entry to scan its pools.' : '👇 Tap a token to scan its pools, or 🗑 to remove it.',
  ].join('\n');
}

export function bookKeyboard(chatId: number, entries?: AddressBookEntry[]): InlineKeyboard {
  const list = entries ?? store.addressesFor(chatId);
  const kb = new InlineKeyboard();
  for (const entry of list) {
    kb.text(`📌 ${entry.symbol}`, `book:open:${entry.address}`).text('🗑', `book:forget:${entry.address}`).row();
  }
  kb.text('➕ Add', 'book:add').text('🔎 Search', 'book:search').row();
  return kb.text('🏠 Menu', 'menu:home');
}

export async function showBook(ctx: Context, edit = false): Promise<void> {
  const chatId = ctx.chat!.id;
  await present(ctx, bookText(chatId), bookKeyboard(chatId), edit);
}

async function startBookAdd(ctx: Context): Promise<void> {
  setSession(ctx.chat!.id, { step: 'addressSearch' });
  await present(
    ctx,
    [
      '➕ <b>Add to address book</b>',
      '────────────',
      '📌 Send the token contract address (0x…).',
      '🔎 It is saved with its symbol so you can find it again without pasting the CA.',
      '',
      '✖ /cancel to stop.',
    ].join('\n'),
    new InlineKeyboard().text('✖ Cancel', 'menu:home'),
    true,
  );
}

async function startBookSearch(ctx: Context): Promise<void> {
  setSession(ctx.chat!.id, { step: 'bookSearch' });
  await present(
    ctx,
    [
      '🔎 <b>Search address book</b>',
      '────────────',
      'Send a symbol, name or address fragment.',
      '',
      '✖ /cancel to stop.',
    ].join('\n'),
    new InlineKeyboard().text('✖ Cancel', 'menu:home'),
    true,
  );
}

/** Text handler for the address-book steps. Returns false when not handled. */
export async function handleBookText(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const session = getSession(chatId);
  if (!session) return false;

  if (session.step === 'addressSearch') {
    let token;
    try {
      token = await getToken(normalizeAddress(text));
    } catch (err) {
      await ctx.reply(`❌ Not a readable ERC-20 contract: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
      return true;
    }
    await store.rememberToken(chatId, token);
    clearSession(chatId);
    await showBook(ctx);
    await present(
      ctx,
      `✅ Saved <b>${esc(token.symbol)}</b> · <code>${esc(token.address)}</code>`,
      new InlineKeyboard().text('🔎 Scan pools', `book:open:${token.address.toLowerCase()}`).row().text('🏠 Menu', 'menu:home'),
    );
    return true;
  }

  if (session.step === 'bookSearch') {
    const needle = text.trim().toLowerCase();
    const matches = store
      .addressesFor(chatId)
      .filter(
        (entry) =>
          entry.symbol.toLowerCase().includes(needle) ||
          entry.name.toLowerCase().includes(needle) ||
          entry.address.includes(needle),
      );
    clearSession(chatId);
    await present(ctx, bookText(chatId, matches), bookKeyboard(chatId, matches), true);
    return true;
  }

  return false;
}

/** Handles `book:*` callbacks: open a token, remove it, add or search. */
export async function handleBookCallback(ctx: Context, data: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const [, action, address] = data.split(':');

  if (action === 'list') {
    await answer(ctx);
    await showBook(ctx, true);
    return true;
  }

  if (action === 'add') {
    await startBookAdd(ctx);
    return true;
  }

  if (action === 'search') {
    await startBookSearch(ctx);
    return true;
  }

  if (action === 'forget' && address) {
    const entry = store.addressFor(chatId, address);
    await store.forgetAddress(chatId, address);
    await answer(ctx, { text: entry ? `Removed ${entry.symbol}` : 'Removed' });
    await present(ctx, bookText(chatId), bookKeyboard(chatId), true);
    return true;
  }

  if (action === 'open' && address) {
    await answer(ctx);
    try {
      const token = await getToken(normalizeAddress(address));
      await store.rememberToken(chatId, token);
      await showPoolScan(ctx, token, true);
    } catch (err) {
      await present(ctx, `❌ Could not read that token: ${esc(errorMessage(err))}`, bookKeyboard(chatId), true);
    }
    return true;
  }

  await answer(ctx);
  return true;
}
