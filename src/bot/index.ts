import { Bot, InlineKeyboard, type Context } from 'grammy';
import { answer } from './answers.js';
import { assertRuntimeConfig, config } from '../config.js';
import { TOKENS } from '../constants/chain.js';
import { botAddress, publicClient } from '../chain/client.js';
import { detectVersion, readPosition } from '../core/positions.js';
import { valuate } from '../core/valuation.js';
import { usdPrice } from '../core/prices.js';

import { getToken, normalizeAddress } from '../core/tokens.js';
import { scanToken } from '../core/scanner.js';
import { safetyText, screenToken } from '../core/safety.js';
import { erc20BalanceOf, ethBalance } from '../core/wallet.js';
import { store } from '../store/store.js';
import { createLogger } from '../logger.js';
import { esc, fmtAmount, fmtPrice, fmtUsd, shortAddr } from '../utils/format.js';
import { errorMessage } from '../utils/errors.js';
import { setBotApi } from './notify.js';
import { clearSession, getSession, setSession } from './session.js';
import {
  handleLooseText,
  handleNewCallback,
  handleNewText,
  scanPastedAddress,
  showPoolScan,
  startNew,
} from './newFlow.js';
import {
  claimAllFees,
  handlePositionCallback,
  handlePositionText,
  listPositions,
  portfolioSummary,
  showPosition,
  trackPosition,
} from './positionsFlow.js';
import { handleDetectCallback, runDetect } from './detectFlow.js';
import { sendPnlCard } from './cardFlow.js';
import { handleCalendarCallback, showCalendar } from './calendarFlow.js';
import { handleTrendingCallback, showTrending } from './trendingFlow.js';
import { showHelp, showSettings, showStatus, showWallet } from './screens.js';
import {
  autoSwapMinKeyboard,
  autoSwapMinText,
  routeImpactKeyboard,
  routeImpactText,
  bidAskConfirmKeyboard,
  bidAskConfirmText,
  bidAskEntriesKeyboard,
  bidAskEntriesText,
  currencyKeyboard,
  currencyText,
  settingsKeyboard,
  settingsText,
  timeZoneKeyboard,
  timeZoneText,
} from './ui.js';
import { isValidBidAskEntries } from '../constants/bidAsk.js';
import { normalizeAutoSwapMin } from '../constants/autoSwap.js';
import { normalizeRouteDiscount } from '../constants/routeImpact.js';
import { normalizeCurrency } from '../constants/currency.js';
import { normalizeTimeZone } from '../constants/timezone.js';
import { handleMenuCallback, showMenu } from './menu.js';
import { handleHistoryCallback, showHistory } from './historyFlow.js';
import { handleBookCallback, handleBookText, showBook } from './addressBookFlow.js';
import { handleWalletCallback, handleWalletText, startRename, startUnlock, startWalletImport } from './walletFlow.js';
import { loadKeystore } from '../core/keystore.js';
import { parseCycleLimit, parseTpTarget } from './parsers.js';

const log = createLogger('bot');

async function guard(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;
  if (store.isAllowed(chatId)) return true;
  const command = ctx.message?.text?.split(/\s+/)[0]?.split('@')[0];
  if (command === '/start') {
    const claimed = await store.claim(chatId);
    if (claimed) {
      await ctx.reply(
        `🔐 This bot is now locked to chat ${chatId}.\nAdd it to ALLOWED_CHAT_IDS in .env to share access.`,
        { parse_mode: 'HTML' },
      );
      await showMenu(ctx);
      return false;
    }
  }
  await ctx.reply('🚫 Not authorized for this bot.');
  return false;
}

export function createBot(): Bot {
  assertRuntimeConfig();
  const bot = new Bot(config.telegramToken);
  setBotApi(bot.api);

  bot.use(async (ctx, next) => {
    if (!(await guard(ctx))) return;
    await next();
  });

  bot.command('start', async (ctx) => {
    await showMenu(ctx);
  });

  bot.command('menu', async (ctx) => {
    await showMenu(ctx);
  });

  bot.command('help', async (ctx) => {
    await showHelp(ctx);
  });

  bot.command('cancel', async (ctx) => {
    clearSession(ctx.chat.id);
    await ctx.reply('✖ Flow cancelled. Use /menu to start again.');
  });

  bot.command('new', async (ctx) => startNew(ctx));

  bot.command('positions', async (ctx) => {
    try {
      await listPositions(ctx);
    } catch (err) {
      await ctx.reply(`Could not load positions: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('pos', async (ctx) => {
    const arg = ctx.match.trim();
    const target = arg || store.positionsFor(ctx.chat.id)[0]?.id;
    if (!target) {
      await ctx.reply('Usage: /pos <id> — see /positions for ids.');
      return;
    }
    await showPosition(ctx, target);
  });

  bot.command('portfolio', async (ctx) => {
    await portfolioSummary(ctx);
  });

  bot.command('detect', async (ctx) => {
    await runDetect(ctx);
  });

  bot.command('history', async (ctx) => {
    await showHistory(ctx);
  });

  bot.command('card', async (ctx) => {
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply('Usage: /card <id> — see /history for the closed ids.');
      return;
    }
    await sendPnlCard(ctx, arg);
  });

  bot.command('calendar', async (ctx) => {
    try {
      await showCalendar(ctx);
    } catch (err) {
      await ctx.reply(`Could not open the calendar: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('trending', async (ctx) => {
    try {
      await showTrending(ctx);
    } catch (err) {
      await ctx.reply(`Could not load the trending list: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('book', async (ctx) => {
    const arg = ctx.match.trim();
    if (arg) {
      setSession(ctx.chat.id, { step: 'addressSearch' });
      await handleBookText(ctx, arg);
      return;
    }
    await showBook(ctx);
  });

  bot.command('importwallet', async (ctx) => startWalletImport(ctx));
  bot.command('unlock', async (ctx) => startUnlock(ctx));
  bot.command('rename', async (ctx) => startRename(ctx));

  bot.command('claim', async (ctx) => {
    const positions = store.positionsFor(ctx.chat.id);
    if (positions.length === 0) {
      await ctx.reply('No positions tracked. Use /new to open one.');
      return;
    }
    const settings = store.settingsFor(ctx.chat.id);
    await ctx.reply(
      [
        `💧 <b>Claim fees from ${positions.length} position${positions.length === 1 ? '' : 's'}</b>`,
        settings.dryRun ? 'Dry-run: every collection is simulated, nothing is sent.' : 'LIVE: each position sends its own transaction.',
        '',
        'Positions with no pending fees are skipped.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('✅ Claim now', 'act:claimAllConfirm')
          .text('✖ Cancel', 'act:noop'),
      },
    );
  });

  bot.command('import', async (ctx) => {
    const arg = ctx.match.trim();
    if (!arg) {
      setSession(ctx.chat.id, { step: 'import' });
      await ctx.reply('📥 Send the position <b>tokenId</b> you want to track.', { parse_mode: 'HTML' });
      return;
    }
    await importPosition(ctx, arg);
  });

  bot.command('scan', async (ctx) => {
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply('Usage: /scan <token address>');
      return;
    }
    try {
      await scanPastedAddress(ctx, arg);
    } catch (err) {
      await ctx.reply(`Scan failed: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('safety', async (ctx) => {
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply('Usage: /safety <token address>');
      return;
    }
    try {
      const token = await getToken(normalizeAddress(arg));
      await store.rememberToken(ctx.chat.id, token);
      const scan = await scanToken(token);
      const target = scan.pools.find((entry) => entry.health !== 'broken') ?? scan.pools[0];
      if (!target) {
        await ctx.reply(`No tradable Uniswap pool found for ${esc(token.symbol)}.`, { parse_mode: 'HTML' });
        return;
      }
      const quote =
        target.pool.token0.address.toLowerCase() === token.address.toLowerCase()
          ? target.pool.token1
          : target.pool.token0;
      const report = await screenToken(target.pool, token, quote);
      await ctx.reply(safetyText(report, target.pool, token), { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`Safety check failed: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
    }
  });  bot.command('wallet', async (ctx) => {
    await showWallet(ctx);
  });

  bot.command('settings', async (ctx) => {
    await showSettings(ctx);
  });

  bot.command('status', async (ctx) => {
    await showStatus(ctx);
  });

  /* ------------------------------ callbacks ------------------------------ */

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    try {
      if (data.startsWith('menu:')) {
        await handleMenuCallback(ctx, data);
        return;
      }
      if (data.startsWith('new:')) {
        const handled = await handleNewCallback(ctx, data);
        if (!handled) await answer(ctx, { text: 'This step expired. Send /new again.', show_alert: true });
        return;
      }
      if (data.startsWith('detect:')) {
        await handleDetectCallback(ctx, data);
        return;
      }
      if (data.startsWith('pos:') || data.startsWith('act:')) {
        const handled = await handlePositionCallback(ctx, data);
        if (!handled) await answer(ctx);
        return;
      }
      if (data.startsWith('hist:') || data.startsWith('card:')) {
        await handleHistoryCallback(ctx, data);
        return;
      }
      if (data.startsWith('cal:')) {
        await handleCalendarCallback(ctx, data);
        return;
      }
      if (data.startsWith('trend:')) {
        await handleTrendingCallback(ctx, data);
        return;
      }
      if (data.startsWith('book:')) {
        await handleBookCallback(ctx, data);
        return;
      }
      if (data.startsWith('wallet:')) {
        await handleWalletCallback(ctx, data);
        return;
      }
      if (data.startsWith('set:')) {
        await handleSettingsCallback(ctx, data);
        return;
      }
      await answer(ctx);
    } catch (err) {
      log.error('callback failed', err);
      // The alert is the first way to tell the user what went wrong. When the
      // callback query is already dead the alert cannot be shown either, so
      // the reason is also written into the chat — a silent button is the
      // worst possible answer.
      await answer(ctx, { text: errorMessage(err), show_alert: true });
      await ctx.reply(`⚠️ ${esc(errorMessage(err))}`).catch(() => undefined);
    }
  });

  /* --------------------------- free text router -------------------------- */

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    const session = getSession(ctx.chat.id);
    if (!session) {
      // A pasted contract address is enough: the pools are scanned right away.
      if (await handleLooseText(ctx, text)) return;
      await ctx.reply('Paste a token contract address to see its pools, or use /new to open a position.');
      return;
    }

    if (session.step === 'import') {
      clearSession(ctx.chat.id);
      await importPosition(ctx, text);
      return;
    }

    try {
      const handled =
        (await handleWalletText(ctx, text)) ||
        (await handleBookText(ctx, text)) ||
        (await handleSettingsText(ctx, text)) ||
        (await handleNewText(ctx, text)) ||
        (await handlePositionText(ctx, text));
      if (!handled) await ctx.reply('Use /cancel to abort, or /help.');
    } catch (err) {
      await ctx.reply(`Something went wrong: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
    }
  });

  bot.catch((err) => {
    log.error('bot error', err.error);
  });

  return bot;
}

async function handleSettingsCallback(ctx: Context, data: string): Promise<void> {
  const chatId = ctx.chat!.id;
  const settings = store.settingsFor(chatId);
  const [, key, value] = data.split(':');

  if (key === 'dryRun') {
    const next = !settings.dryRun;
    await store.updateSettings(chatId, { dryRun: next });
    await answer(ctx, { text: next ? 'Dry-run enabled' : 'LIVE trading enabled' });
  } else if (key === 'slip' && value) {
    const slip = Number(value);
    if (!Number.isFinite(slip) || slip < 0 || slip > 50) {
      await answer(ctx, { text: 'Invalid slippage', show_alert: true });
      return;
    }
    await store.updateSettings(chatId, { slippagePct: slip });
    await answer(ctx, { text: `Slippage ${slip}%` });
  } else if (key === 'alerts') {
    await store.updateSettings(chatId, { alertsEnabled: !settings.alertsEnabled });
    await answer(ctx, { text: `Range alerts ${settings.alertsEnabled ? 'off' : 'on'}` });
  } else if (key === 'autoSwap') {
    const next = !settings.autoSwapToUsdg;
    await store.updateSettings(chatId, { autoSwapToUsdg: next });
    await answer(ctx, { text: next ? 'Auto-swap on' : 'Auto-swap off' });
  } else if (key === 'autoTp') {
    await answer(ctx);
    setSession(chatId, { step: 'autoTpTarget' });
    await presentPrompt(
      ctx,
      [
        '⚡ <b>Auto-TP target</b>',
        '────────────',
        `Now: +${settings.autoTpTargetPct}% over the cost basis.`,
        '',
        'Send the profit % that arms the auto take-profit (0.1–10 000).',
        'Each position can still override it by turning ⚡ Auto-TP on or off.',
      ],
      'set:back',
    );
    return;
  } else if (key === 'cycles') {
    await answer(ctx);
    setSession(chatId, { step: 'tpCycle' });
    await presentPrompt(
      ctx,
      [
        '🔄 <b>Auto-TP cycles</b>',
        '────────────',
        `Now: ${settings.tpCycleLimit} cycles.`,
        '',
        'Send how many cycles a new position runs (1–99).',
        'Cycle 1 is the opening position; each auto-TP re-enters with the same range and size.',
      ],
      'set:back',
    );
    return;
  } else if (key === 'bidask') {
    await answer(ctx);
    await ctx
      .editMessageText(bidAskEntriesText(settings.bidAskEntries), {
        parse_mode: 'HTML',
        reply_markup: bidAskEntriesKeyboard(settings.bidAskEntries),
        link_preview_options: { is_disabled: true },
      })
      .catch(() => undefined);
    return;
  } else if (key === 'bidaskSelect' && value) {
    const next = Number(value);
    if (!isValidBidAskEntries(next)) {
      await answer(ctx, { text: 'Pick between 4 and 10 entries', show_alert: true });
      return;
    }
    if (next === settings.bidAskEntries) {
      await answer(ctx, { text: `Already ${next} entries` });
      return;
    }
    await answer(ctx);
    await ctx
      .editMessageText(bidAskConfirmText(settings.bidAskEntries, next), {
        parse_mode: 'HTML',
        reply_markup: bidAskConfirmKeyboard(next),
        link_preview_options: { is_disabled: true },
      })
      .catch(() => undefined);
    return;
  } else if (key === 'bidAskApply' && value) {
    const next = Number(value);
    if (!isValidBidAskEntries(next)) {
      await answer(ctx, { text: 'Pick between 4 and 10 entries', show_alert: true });
      return;
    }
    await store.updateSettings(chatId, { bidAskEntries: next });
    await answer(ctx, { text: `Bid Ask entries set to ${next}` });
    await ctx
      .editMessageText(bidAskEntriesText(next), {
        parse_mode: 'HTML',
        reply_markup: bidAskEntriesKeyboard(next),
        link_preview_options: { is_disabled: true },
      })
      .catch(() => undefined);
    return;
  } else if (key === 'currency') {
    if (!value) {
      await answer(ctx);
      await ctx
        .editMessageText(currencyText(settings.currency), {
          parse_mode: 'HTML',
          reply_markup: currencyKeyboard(settings.currency),
          link_preview_options: { is_disabled: true },
        })
        .catch(() => undefined);
      return;
    }
    const next = normalizeCurrency(value);
    if (next === settings.currency) {
      await answer(ctx, { text: `Already ${next}` });
      return;
    }
    await store.updateSettings(chatId, { currency: next });
    await answer(ctx, { text: `Display currency: ${next}` });
  } else if (key === 'swapImpact') {
    if (!value) {
      await answer(ctx);
      await ctx
        .editMessageText(routeImpactText(settings.maxRouteDiscountPct), {
          parse_mode: 'HTML',
          reply_markup: routeImpactKeyboard(settings.maxRouteDiscountPct),
          link_preview_options: { is_disabled: true },
        })
        .catch(() => undefined);
      return;
    }
    const next = normalizeRouteDiscount(Number(value));
    await store.updateSettings(chatId, { maxRouteDiscountPct: next });
    await answer(ctx, { text: `Route impact: at most ${next}% below the market` });
  } else if (key === 'swapMin') {
    if (!value) {
      await answer(ctx);
      await ctx
        .editMessageText(autoSwapMinText(settings.autoSwapMinUsd), {
          parse_mode: 'HTML',
          reply_markup: autoSwapMinKeyboard(settings.autoSwapMinUsd),
          link_preview_options: { is_disabled: true },
        })
        .catch(() => undefined);
      return;
    }
    const next = normalizeAutoSwapMin(Number(value));
    await store.updateSettings(chatId, { autoSwapMinUsd: next });
    await answer(ctx, { text: `Smallest swap: $${next.toFixed(2)}` });
  } else if (key === 'timezone') {
    if (!value) {
      await answer(ctx);
      await ctx
        .editMessageText(timeZoneText(settings.timezone), {
          parse_mode: 'HTML',
          reply_markup: timeZoneKeyboard(settings.timezone),
          link_preview_options: { is_disabled: true },
        })
        .catch(() => undefined);
      return;
    }
    const next = normalizeTimeZone(value);
    if (next === settings.timezone) {
      await answer(ctx, { text: 'Already that timezone' });
      return;
    }
    await store.updateSettings(chatId, { timezone: next });
    await answer(ctx, { text: `Timezone: ${next}` });
  } else if (key === 'back') {
    await answer(ctx);
    clearSession(chatId);
    await showSettings(ctx, true);
    return;
  } else {
    await answer(ctx);
    return;
  }

  const updated = store.settingsFor(chatId);
  const keystore = await loadKeystore().catch(() => undefined);
  await ctx
    .editMessageText(settingsText(updated, botAddress, keystore ? { label: keystore.label, address: keystore.address } : undefined), {
      parse_mode: 'HTML',
      reply_markup: settingsKeyboard(updated),
      link_preview_options: { is_disabled: true },
    })
    .catch(() => undefined);
}

/** Prompt with a single back button, used by the settings text steps. */
async function presentPrompt(ctx: Context, lines: string[], back: string): Promise<void> {
  await ctx
    .reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('◀ Back to settings', back).row().text('🏠 Menu', 'menu:home'),
    })
    .catch(() => undefined);
}

/** Text handler for the settings steps. Returns false when not handled. */
async function handleSettingsText(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const session = getSession(chatId);
  if (!session || (session.step !== 'autoTpTarget' && session.step !== 'tpCycle')) return false;

  if (session.step === 'autoTpTarget') {
    const parsed = parseTpTarget(text);
    if (parsed.error || parsed.pct === undefined) {
      await ctx.reply(`❌ ${esc(parsed.error ?? 'Invalid value')}`, { parse_mode: 'HTML' });
      return true;
    }
    await store.updateSettings(chatId, { autoTpTargetPct: parsed.pct });
  } else {
    const parsed = parseCycleLimit(text);
    if (parsed.error || parsed.limit === undefined) {
      await ctx.reply(`❌ ${esc(parsed.error ?? 'Invalid value')}`, { parse_mode: 'HTML' });
      return true;
    }
    await store.updateSettings(chatId, { tpCycleLimit: parsed.limit });
  }

  clearSession(chatId);
  await showSettings(ctx);
  return true;
}

async function importPosition(ctx: Context, raw: string): Promise<void> {
  let tokenId: bigint;
  try {
    tokenId = BigInt(raw.replace(/[^\d]/g, ''));
  } catch {
    await ctx.reply('Send a numeric tokenId.');
    return;
  }
  if (tokenId <= 0n) {
    await ctx.reply('Send a numeric tokenId.');
    return;
  }

  try {
    const version = await detectVersion(tokenId);
    if (!version) {
      await ctx.reply(`tokenId ${tokenId} is not held by the v3 or v4 position manager.`);
      return;
    }
    await trackPosition(ctx, version, tokenId);
  } catch (err) {
    await ctx.reply(`Import failed: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
  }
}
