import type { Context } from 'grammy';
import { answer } from './answers.js';
import { InlineKeyboard } from 'grammy';
import type { Address } from 'viem';
import { botAddress } from '../chain/client.js';
import { config } from '../config.js';
import { collectFees } from '../core/actions.js';
import {
  swapProceedsToUsdg,
  SWAP_ROUTE_LABEL,
  type SwapOutcome,
  type SwapRoute,
} from '../core/swap.js';
import { swapAccounting, withSwap } from '../core/history.js';
import { usdPrice } from '../core/prices.js';
import { costLines } from '../monitor/notifyText.js';
import { erc20BalanceOf } from '../core/wallet.js';
import { TOKENS } from '../constants/chain.js';
import { performExit } from '../monitor/exits.js';
import { exitNotificationLines } from '../monitor/notifyText.js';
import { usdIdrRate } from '../core/fx.js';
import { parseCycleLimit } from './parsers.js';
import { readPosition, withdrawnToken, type PositionSnapshot, type PositionVersion } from '../core/positions.js';
import { marketCapInfo as fetchMarketCap, UNKNOWN_MARKET_CAP, type MarketCap } from '../core/scanner.js';
import { hasV3Pool } from '../core/pools.js';
import { rebalancePosition } from '../core/strategy.js';
import { marketPriceUsd, summarizePnl, valuate, type PnlSummary, type Valuation } from '../core/valuation.js';
import { loadView, type PositionView } from '../core/positionViews.js';
import { store, type TrackedPosition } from '../store/store.js';
import { esc, fmtAmount, fmtCompactUsd, fmtPct, fmtSignedUsd, fmtUsd } from '../utils/format.js';
import { showLoading } from './screens.js';
import { clearSession, getSession, setSession } from './session.js';
import { errorMessage } from '../utils/errors.js';
import {
  marketCapLine,
  positionCard,
  positionKeyboard,
  positionNumber,
  positionPair,
  statusEmoji,
  positionRow,
  tradedToken,
  txLink,
} from './ui.js';
import { txLock } from './locks.js';



/**
 * The button of a position in the list: its number, a colour for the state
 * and the pair with the value.
 *
 *   #5 🟢 IGNITION/USDG · $53
 *
 * Green for a profit, red for a loss and orange when the position left its
 * range — that one needs attention, whatever the PnL says.
 */
export function positionButton(
  tracked: TrackedPosition,
  view: { snapshot: PositionSnapshot; valuation: Valuation; pnl: PnlSummary },
): string {
  const emoji = statusEmoji(view.snapshot, view.pnl);
  return `${positionNumber(tracked.id)} ${emoji} ${positionPair(view.snapshot)} · ${valueLabel(view.valuation.valueUsd)}`;
}

/** "$53" — the value of a position, short enough for a button. */
function valueLabel(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  if (Math.abs(usd) >= 1000) return fmtCompactUsd(usd);
  return `$${Math.round(usd)}`;
}

export async function listPositions(ctx: Context, edit = false): Promise<void> {
  const chatId = ctx.chat!.id;
  const positions = store.positionsFor(chatId);
  if (positions.length === 0) {
    const empty = [
      '📊 <b>Positions</b>',
      '────────────',
      '🫙 Nothing tracked yet.',
      '',
      '🚀 Use /new to open a position,',
      '📥 or /import &lt;tokenId&gt; to track an existing one.',
    ].join('\n');
    if (edit) await ctx.editMessageText(empty, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🚀 Open position', 'menu:open').row().text('🏠 Menu', 'menu:home') }).catch(() => undefined);
    else await ctx.reply(empty, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🚀 Open position', 'menu:open').row().text('🏠 Menu', 'menu:home') });
    return;
  }

  if (!edit) await ctx.reply('⏳ Loading positions…');
  const rows: string[] = [];
  const kb = new InlineKeyboard();
  let pending = 0;
  for (const tracked of positions) {
    try {
      const view = await loadView(tracked);
      if (!view) {
        rows.push(`⚪ <b>${positionNumber(tracked.id)}</b> — position no longer exists (burned or transferred)`);
        continue;
      }
      // The pending fees are added up from the views that were just read,
      // instead of reading every position a second time.
      pending += view.valuation.feesUsd;
      rows.push(positionRow(tracked, view.snapshot, view.valuation, view.pnl));
      kb.text(positionButton(tracked, view), `pos:show:${tracked.id}`).row();
    } catch (err) {
      rows.push(`⚠️ <b>${positionNumber(tracked.id)}</b> — ${esc(errorMessage(err))}`);
    }
  }

  rows.unshift('📊 <b>Positions</b>', '────────────');
  rows.push(
    '────────────',
    `📦 Tracked: ${positions.length} position${positions.length === 1 ? '' : 's'} · 💧 pending fees ${fmtUsd(pending)}`,
  );
  if (botAddress) kb.row().text('💧 Claim all fees', 'act:claimAll');
  kb.row().text('🏠 Menu', 'menu:home');
  const text = rows.join('\n');
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => undefined);
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

/**
 * The position screen: the card text and its keyboard.
 *
 * Used by the position panel and by the open flow, so a freshly opened
 * position is shown exactly like an existing one.
 */
export async function positionScreen(
  tracked: TrackedPosition,
): Promise<{ text: string; keyboard: InlineKeyboard } | undefined> {
  const view = await loadView(tracked, true);
  if (!view) return undefined;
  const idrRate = await usdIdrRate().catch(() => Number.NaN);
  const settings = store.settingsFor(tracked.chatId);
  const text = positionCard(tracked, view.snapshot, view.valuation, view.pnl, {
    idrRate,
    autoTpTargetPct: settings.autoTpTargetPct,
    marketCap: view.marketCap,
    cycleLimit: settings.tpCycleLimit,
  });
  const keyboard = positionKeyboard(
    tracked.id,
    tracked,
    Boolean(botAddress),
    botAddress ? { snapshot: view.snapshot, wallet: botAddress } : undefined,
    settings.tpCycleLimit,
  );
  return { text, keyboard };
}

export async function showPosition(ctx: Context, id: string, edit = false): Promise<void> {
  const chatId = ctx.chat!.id;
  const tracked = store.find(chatId, id);
  if (!tracked) {
    await ctx.reply('Unknown position id. Use /positions.');
    return;
  }

  // The position is read from the chain and the market cap comes from an
  // indexer: that takes a moment. Say so at once, so nobody taps again.
  if (edit) await showLoading(ctx, '⏳ <b>Loading the position…</b>');

  let view: PositionView | undefined;
  try {
    view = await loadView(tracked, true);
  } catch (err) {
    await ctx.reply(`Could not read ${esc(tracked.id)}: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
    return;
  }

  if (!view) {
    const kb = new InlineKeyboard().text('Untrack', `act:untrack:${tracked.id}`);
    const text = `Position ${esc(tracked.id)} (tokenId ${esc(tracked.tokenId)}) is gone — burned or transferred.`;
    if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => undefined);
    else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    return;
  }

  const idrRate = await usdIdrRate().catch(() => Number.NaN);
  const settings = store.settingsFor(chatId);
  const text = positionCard(tracked, view.snapshot, view.valuation, view.pnl, {
    idrRate,
    autoTpTargetPct: settings.autoTpTargetPct,
    marketCap: view.marketCap,
    cycleLimit: settings.tpCycleLimit,
  });
  const kb = positionKeyboard(
    tracked.id,
    tracked,
    Boolean(botAddress),
    botAddress ? { snapshot: view.snapshot, wallet: botAddress } : undefined,
    settings.tpCycleLimit,
  );
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => undefined);
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } });
}

/* ------------------------------- callbacks ------------------------------- */

export async function handlePositionCallback(ctx: Context, data: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const [, verb, id, arg] = data.split(':');

  if (verb === 'noop') {
    await answer(ctx);
    return true;
  }

  if (verb === 'claimAll') {
    await answer(ctx);
    const positions = store.positionsFor(chatId);
    const settings = store.settingsFor(chatId);
    await ctx.reply(
      [
        `💧 <b>Claim fees from ${positions.length} position${positions.length === 1 ? '' : 's'}</b>`,
        settings.dryRun ? 'Dry-run: every collection is simulated, nothing is sent.' : 'LIVE: each position sends its own transaction.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('✅ Claim now', 'act:claimAllConfirm')
          .text('✖ Cancel', 'act:noop'),
      },
    );
    return true;
  }

  if (verb === 'claimAllConfirm') {
    await answer(ctx, { text: 'Claiming…' });
    await claimAllFees(ctx);
    return true;
  }

  if (!verb || !id) return false;

  // The close flow runs in steps, and the position is already untracked after
  // the close, so these callbacks work from the session, not from the store.
  if (verb === 'closeSwap' || verb === 'closeKeep' || verb === 'closeRoute') {
    await answer(ctx);
    await handleCloseStep(ctx, verb, id, arg);
    return true;
  }

  const tracked = store.find(chatId, id);
  if (!tracked) {
    await answer(ctx, { text: 'Unknown position' });
    return true;
  }

  switch (verb) {
    case 'show':
      await answer(ctx);
      await showPosition(ctx, tracked.id);
      return true;

    case 'refresh':
      await answer(ctx, { text: 'Refreshed' });
      await showPosition(ctx, tracked.id, true);
      return true;

    case 'toggleAlerts': {
      await store.update(tracked.id, { alerts: !tracked.alerts });
      await answer(ctx, { text: `Alerts ${tracked.alerts ? 'off' : 'on'}` });
      await showPosition(ctx, tracked.id, true);
      return true;
    }

    case 'toggleCompound': {
      await store.update(tracked.id, { autoCompound: !tracked.autoCompound });
      await answer(ctx, { text: `Auto-compound ${tracked.autoCompound ? 'off' : 'on'}` });
      await showPosition(ctx, tracked.id, true);
      return true;
    }

    case 'untrack': {
      await store.remove(tracked.id);
      await answer(ctx, { text: 'Untracked' });
      await ctx.editMessageText(`🗑 Untracked ${tracked.id}. The on-chain position is untouched.`).catch(() => undefined);
      return true;
    }

    case 'close': {
      await answer(ctx);
      await showCloseConfirmation(ctx, tracked);
      return true;
    }

    case 'closeConfirm':
      await answer(ctx);
      await runClose(ctx, tracked);
      return true;

    case 'collect':
      await answer(ctx);
      await runCollect(ctx, tracked);
      return true;

    case 'toggleAutoTp': {
      await store.update(tracked.id, { autoTakeProfit: !tracked.autoTakeProfit });
      await answer(ctx, { text: `Auto-TP ${tracked.autoTakeProfit ? 'off' : 'on'}` });
      await showPosition(ctx, tracked.id, true);
      return true;
    }

    case 'toggleOor': {
      await store.update(tracked.id, { oorTakeProfit: !tracked.oorTakeProfit });
      await answer(ctx, { text: `OOR take profit ${tracked.oorTakeProfit ? 'off' : 'on'}` });
      await showPosition(ctx, tracked.id, true);
      return true;
    }

    case 'cycles': {
      setSession(chatId, { step: 'cycles', positionId: tracked.id });
      await answer(ctx);
      await ctx.reply(
        [
          `🔄 <b>Auto-TP cycles · ${esc(tracked.id)}</b>`,
          `Now: cycle ${tracked.cycle ?? 1}/${tracked.tpCycles ?? store.settingsFor(chatId).tpCycleLimit}`,
          '',
          'Send the cycle limit (1–99), or <code>default</code> to follow Settings.',
          'ℹ️ Cycle 1 is the initial position; the last cycle closes without re-entering.',
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
      return true;
    }

    case 'tpsl': {
      setSession(chatId, { step: 'tpsl', positionId: tracked.id });
      await answer(ctx);
      await ctx.reply(tpSlPrompt(tracked), { parse_mode: 'HTML' });
      return true;
    }

    case 'rebalance':
      await answer(ctx);
      await runRebalance(ctx, tracked);
      return true;

    default:
      return false;
  }
}



/**
 * Step 1 of the close flow: what closing the position will do.
 *
 * The user sees the value, the fees, the PnL and the slippage that a later
 * swap would use before anything is sent.
 */
async function showCloseConfirmation(ctx: Context, tracked: TrackedPosition): Promise<void> {
  const chatId = ctx.chat!.id;
  const settings = store.settingsFor(chatId);

  const snapshot = await readPosition(tracked.version, BigInt(tracked.tokenId)).catch(() => undefined);
  const valuation = snapshot ? await valuate(snapshot).catch(() => undefined) : undefined;
  const pnl = valuation
    ? summarizePnl(valuation, {
        basisUsd: tracked.basisUsd,
        feesWithdrawnUsd: tracked.feesWithdrawnUsd,
        compoundedFeesUsd: tracked.compoundedFeesUsd,
        openedAt: tracked.entry.openedAt,
      })
    : undefined;
  const marketCap = snapshot
    ? await fetchMarketCap(tradedToken(snapshot)).catch(() => UNKNOWN_MARKET_CAP)
    : UNKNOWN_MARKET_CAP;

  const lines = [
    `🔒 <b>Close ${esc(snapshot ? positionPair(snapshot) : tracked.id)}?</b>`,
    `🏷 ${esc(tracked.id)} · ${esc(tracked.version)}`,
    '────────────',
  ];

  if (valuation) {
    lines.push(
      `💰 Value ${fmtUsd(valuation.valueUsd)} · Fees ${fmtUsd(valuation.feesUsd)}`,
      `📊 PnL ${fmtSignedUsd(pnl?.totalPnlUsd ?? Number.NaN)} (${fmtPct(pnl?.totalPnlPct ?? Number.NaN)})`,
    );
    const mcap = marketCapLine(snapshot!, valuation, marketCap);
    if (mcap) lines.push(`🏦 ${mcap}`);
  }

  lines.push(
    '────────────',
    'ℹ️ Closing removes all liquidity, collects the fees and burns the NFT.',
    '   The withdrawn tokens stay in your wallet — you choose what happens to them.',
    '',
    `🔁 A swap to USDG would use at most <b>${settings.slippagePct}%</b> slippage (⚙️ Settings).`,
  );

  // A token that only trades in v4 pools cannot be swapped through the V3
  // route at all. Saying so now is much better than finding out after the
  // close, with the tokens already in the wallet.
  if (snapshot) {
    const v3 = await hasV3Pool(snapshot.token0.address, snapshot.token1.address).catch(() => true);
    const quote = snapshot.token0.address.toLowerCase() === TOKENS.USDG.toLowerCase()
      ? snapshot.token1
      : snapshot.token0;
    if (!v3) {
      lines.push(
        '',
        `⚠️ <b>${esc(quote.symbol)} has no Uniswap v3 pool</b> — only the 0x API can swap it.`,
      );
    }
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .text('✅ Yes, close it', `act:closeConfirm:${tracked.id}`)
      .text('✖ Cancel', `act:refresh:${tracked.id}`),
  });
}

/**
 * Step 2 and 3 of the close flow: what to do with the withdrawn tokens, and
 * which route should swap them.
 */
async function handleCloseStep(
  ctx: Context,
  step: 'closeSwap' | 'closeKeep' | 'closeRoute',
  positionId: string,
  arg?: string,
): Promise<void> {
  const chatId = ctx.chat!.id;
  const session = getSession(chatId);
  if (!session || (session.step !== 'closeChoice' && session.step !== 'closeRoute')) {
    await ctx.reply('✖ This close expired. Tap **Close** on the position again.', { parse_mode: 'HTML' });
    return;
  }
  if (session.positionId !== positionId) {
    await ctx.reply('✖ This close expired. Tap **Close** on the position again.', { parse_mode: 'HTML' });
    return;
  }

  if (step === 'closeKeep') {
    clearSession(chatId);
    // The tokens stay in the wallet — that is what the user asked for. The
    // gas of the round trip is still reported.
    const record = session.recordId ? store.findClosed(chatId, session.recordId) : undefined;
    const lines = [
      `💎 <b>Kept both</b> — ${fmtAmount(session.amount, session.token.decimals)} ${esc(session.token.symbol)} stay in your wallet.`,
      ...costLines(record),
    ];
    await ctx
      .editMessageText(lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: closeActions(session.recordId),
      })
      .catch(() => undefined);
    return;
  }

  if (step === 'closeSwap') {
    setSession(chatId, { ...session, step: 'closeRoute' });
    const settings = store.settingsFor(chatId);
    const lines = [
      `🔄 <b>Swap ${esc(session.token.symbol)} → USDG</b>`,
      `💵 ${fmtAmount(session.amount, session.token.decimals)} ${esc(session.token.symbol)} · ≈ ${fmtUsd(session.valueUsd)}`,
      '',
      `🔁 Maximum slippage: <b>${settings.slippagePct}%</b>`,
      '────────────',
      'Which route should do the swap?',
    ];
    if (session.v3Route === false) {
      lines.push(
        '',
        `⚠️ <b>${esc(session.token.symbol)} has no Uniswap v3 pool</b> — the V3 route cannot swap it.`,
      );
    }
    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('0x API', `act:closeRoute:${positionId}:0x`)
        .text('V3 Pool', `act:closeRoute:${positionId}:uniswap-v3`)
        .row()
        .text('💎 Keep Both — No Swap', `act:closeKeep:${positionId}`),
    });
    return;
  }

  // Step 4: the swap itself, on the route the user picked.
  const route: SwapRoute = arg === 'uniswap-v3' ? 'uniswap-v3' : '0x';
  const owner = botAddress;
  if (!owner) {
    await ctx.reply('⚠️ No wallet configured.');
    return;
  }
  const settings = store.settingsFor(chatId);
  const status = await ctx.reply(
    settings.dryRun
      ? `🧪 Simulating the ${SWAP_ROUTE_LABEL[route]} swap…`
      : `⚡ Swapping ${esc(session.token.symbol)} via ${SWAP_ROUTE_LABEL[route]}…`,
  );

  let note: string | undefined;
  let swapped = false;
  try {
    const outcome = await swapProceedsToUsdg({
      token: session.token,
      amount: session.amount,
      owner,
      slippagePct: settings.slippagePct,
      dryRun: settings.dryRun,
      key: session.positionId,
      valueUsd: session.valueUsd,
      minUsd: 0,
      buyTokenUsd: 1,
      // The live market price, so a route that is priced far below it is
      // refused instead of taken.
      sellTokenUsd: session.marketUsd,
      route,
    });
    swapped = outcome.ok;
    note = outcome.ok ? outcome.note : await swapFailureNote(outcome, session.token, owner);
    if (outcome.ok) {
      note = await recordSwap(ctx, session, outcome, note);
    }
  } catch (err) {
    note = await swapFailureNote(
      { note: `⚠️ The swap failed: ${errorMessage(err)}`, error: 'failed' },
      session.token,
      owner,
    );
  }
  clearSession(chatId);
  await ctx.api
    .editMessageText(chatId, status.message_id, note, { parse_mode: 'HTML' })
    .catch(() => undefined);
  // The close and the swap are two separate outcomes: the close receipt above
  // says the position is closed, this message says what the swap did.
  await ctx
    .reply(
      [
        swapped ? '💱 <b>Swap done</b>' : '❌ <b>The swap did not go through</b>',
        note,
        '',
        'The position itself was closed — see the receipt above.',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: closeActions(session.recordId) },
    )
    .catch(() => undefined);
}

/**
 * Adds what a swap did to the closed record: its gas, what it delivered and
 * the PnL that is left after every cost.
 */
async function recordSwap(
  ctx: Context,
  session: { positionId: string; recordId?: string; token: { decimals: number }; amount: bigint },
  outcome: SwapOutcome,
  note: string,
): Promise<string> {
  const record = session.recordId ? store.findClosed(ctx.chat!.id, session.recordId) : undefined;
  if (!record) return note;
  const ethPriceUsd = await usdPrice(TOKENS.WETH).catch(() => Number.NaN);
  const accounting = swapAccounting(outcome, {
    withdrawnAmount: session.amount,
    decimals: session.token.decimals,
    ethPriceUsd,
    exitPrice: record.exitPrice,
  });
  const updated = await store.updateClosed(record.id, withSwap(record, accounting));
  if (!updated) return note;
  return [note, ...costLines(updated)].join('\n');
}

/**
 * The truth about a failed swap: the tokens are only said to be in the wallet
 * when the wallet says so.
 */
async function swapFailureNote(
  outcome: { note: string; error?: string },
  token: { symbol: string; address: `0x${string}`; decimals: number },
  owner: Address,
): Promise<string> {
  const balance = await erc20BalanceOf(token.address, owner).catch(() => 0n);
  const human = fmtAmount(balance, token.decimals);
  if (balance > 0n) {
    return [
      `${esc(token.symbol)} was <b>not</b> swapped into USDG.`,
      `💎 Still in your wallet: ${human} ${esc(token.symbol)}`,
      '↩️ Swap them by hand on GMGN or Uniswap.',
    ].join('\n');
  }
  return [
    `${esc(token.symbol)} was <b>not</b> swapped into USDG.`,
    '⚠️ The wallet balance could not be confirmed — check your wallet before retrying.',
  ].join('\n');
}

/**
 * The actions that still work after the close: the PnL card of the frozen
 * record, the closed-position summary and the menu.
 */
function closeActions(recordId?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (recordId) {
    kb.text('📊 Generate PnL Card', `card:${recordId}`).row();
    kb.text('↩️ Back to Position', `hist:show:${recordId}`).text('🏠 Back to Home', 'menu:home');
  } else {
    kb.text('🏠 Back to Home', 'menu:home');
  }
  return kb;
}

async function runCollect(ctx: Context, tracked: TrackedPosition): Promise<void> {
  const chatId = ctx.chat!.id;
  const settings = store.settingsFor(chatId);
  if (!botAddress) {
    await ctx.reply('No wallet configured.');
    return;
  }

  await txLock.run(`chat:${chatId}`, async () => {
    const status = await ctx.reply(settings.dryRun ? '🧪 Simulating fee collection…' : '⚡ Collecting fees…');
    try {
      const snapshot = await readPosition(tracked.version, BigInt(tracked.tokenId));
      if (!snapshot) throw new Error('Position no longer exists');
      const valuation = await valuate(snapshot);
      const result = await collectFees(snapshot, botAddress!, settings.dryRun);
      if (result.error) throw new Error(result.error);

      if (!result.dryRun) {
        await store.update(tracked.id, { feesWithdrawnUsd: tracked.feesWithdrawnUsd + valuation.feesUsd });
      }
      const lines = [
        result.dryRun ? '🧪 <b>Collection simulated</b> (not sent)' : '💧 <b>Fees collected</b>',
        `≈ ${fmtUsd(valuation.feesUsd)}: ${fmtAmount(snapshot.fees0, snapshot.token0.decimals)} ${esc(snapshot.token0.symbol)} + ${fmtAmount(snapshot.fees1, snapshot.token1.decimals)} ${esc(snapshot.token1.symbol)}`,
      ];
      if (result.hash) lines.push(`<a href="${txLink(result.hash)}">View transaction</a>`);
      await ctx.api.editMessageText(chatId, status.message_id, lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      await ctx.api.editMessageText(chatId, status.message_id, `❌ ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
    }
  });
}

async function runClose(ctx: Context, tracked: TrackedPosition): Promise<void> {
  const chatId = ctx.chat!.id;
  const settings = store.settingsFor(chatId);
  if (!botAddress) {
    await ctx.reply('⚠️ No wallet configured.');
    return;
  }

  await txLock.run(`chat:${chatId}`, async () => {
    const status = await ctx.reply(settings.dryRun ? '🧪 Simulating close…' : '⚡ Closing position…');
    try {
      const snapshot = await readPosition(tracked.version, BigInt(tracked.tokenId));
      if (!snapshot) {
        // A second tap on Close queues behind the first one. The position is
        // gone and untracked, so it was already closed.
        if (!store.find(chatId, tracked.id)) {
          await ctx.api.editMessageText(chatId, status.message_id, '✅ <b>This position was already closed.</b>', {
            parse_mode: 'HTML',
            reply_markup: closeActions(),
          });
          return;
        }
        throw new Error('Position no longer exists');
      }
      const valuation = await valuate(snapshot);
      const pnl = summarizePnl(valuation, {
        basisUsd: tracked.basisUsd,
        feesWithdrawnUsd: tracked.feesWithdrawnUsd,
        compoundedFeesUsd: tracked.compoundedFeesUsd,
        openedAt: tracked.entry.openedAt,
      });
      const result = await performExit({
        tracked,
        snapshot,
        valuation,
        pnl,
        settings,
        owner: botAddress!,
        reason: 'manual',
        // The user decides what happens to the withdrawn tokens, so the
        // automatic swap must not run behind their back.
        skipAutoSwap: true,
      });
      if (result.error && !result.closed) throw new Error(result.error);

      const lines = exitNotificationLines({
        kind: 'manual',
        tracked,
        snapshot,
        valuation,
        pnl,
        result,
        record: result.record,
        cycle: tracked.cycle ?? 1,
        limit: tracked.tpCycles ?? settings.tpCycleLimit,
        dryRun: settings.dryRun,
        explorerUrl: config.explorerUrl,
      });
      lines.push(
        `🪙 Withdrew ≈ ${fmtAmount(snapshot.amount0, snapshot.token0.decimals)} ${esc(snapshot.token0.symbol)} + ${fmtAmount(snapshot.amount1, snapshot.token1.decimals)} ${esc(snapshot.token1.symbol)}`,
      );
      if (!settings.dryRun) lines.push(`📜 Recorded in history · 🗑 untracked ${positionNumber(tracked.id)}.`);

      // The closed position is the final status of this message, with the
      // actions that still work: the PnL card, the closed-position summary
      // and the menu.
      await ctx.api.editMessageText(chatId, status.message_id, lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: closeActions(result.recordId),
        link_preview_options: { is_disabled: true },
      });

      // What is left in the wallet, and what should happen to it?
      const side = withdrawnToken(snapshot);
      const priceUsd =
        side && side.token.address.toLowerCase() === snapshot.token0.address.toLowerCase()
          ? valuation.price0Usd
          : valuation.price1Usd;
      const valueUsd = side
        ? (Number(side.amount) / 10 ** side.token.decimals) * priceUsd
        : 0;

      if (!side || side.amount <= 0n) {
        // Nothing but USDG came out: there is nothing to swap.
        clearSession(chatId);
        return;
      }

      // Whether the V3 route can swap this token at all — a token that only
      // trades in v4 pools cannot.
      const v3Route = await hasV3Pool(
        snapshot.token0.address,
        snapshot.token1.address,
      ).catch(() => true);

      const flow = {
        positionId: tracked.id,
        recordId: result.recordId,
        token: side.token,
        amount: side.amount,
        valueUsd: Number.isFinite(valueUsd) ? valueUsd : 0,
        pair: positionPair(snapshot),
        v3Route,
        marketUsd: valuation ? marketPriceUsd(snapshot, valuation) : undefined,
        receipt: lines,
      };
      setSession(chatId, { step: 'closeChoice', ...flow });

      const choice = [
        `💎 <b>What should happen to the ${esc(side.token.symbol)}?</b>`,
        `🪙 ${fmtAmount(side.amount, side.token.decimals)} ${esc(side.token.symbol)} was withdrawn into your wallet.`,
        '',
        '• 🔄 Swap it to USDG',
        '• 💎 Keep both — the tokens stay in your wallet',
      ];
      await ctx.reply(choice.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('🔄 Swap Token to USDG', `act:closeSwap:${tracked.id}`)
          .text('💎 Keep Both — No Swap', `act:closeKeep:${tracked.id}`),
      });
    } catch (err) {
      await ctx.api.editMessageText(chatId, status.message_id, `❌ ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
    }
  });
}

async function runRebalance(ctx: Context, tracked: TrackedPosition): Promise<void> {
  const chatId = ctx.chat!.id;
  const settings = store.settingsFor(chatId);
  if (!botAddress) {
    await ctx.reply('No wallet configured.');
    return;
  }

  await txLock.run(`chat:${chatId}`, async () => {
    const status = await ctx.reply(settings.dryRun ? '🧪 Simulating rebalance…' : '⚡ Rebalancing…');
    try {
      const snapshot = await readPosition(tracked.version, BigInt(tracked.tokenId));
      if (!snapshot) {
        // A second tap on Rebalance queues behind the first one, which already
        // replaced the NFT. The position is tracked, but with a new tokenId.
        const current = store.find(chatId, tracked.id);
        if (current && current.tokenId !== tracked.tokenId) {
          await ctx.api.editMessageText(chatId, status.message_id, '✅ <b>This position was already rebalanced.</b>', {
            parse_mode: 'HTML',
            reply_markup: closeActions(),
          });
          return;
        }
        throw new Error('Position no longer exists');
      }
      const valuation = await valuate(snapshot);
      const result = await rebalancePosition(snapshot, {
        owner: botAddress!,
        dryRun: settings.dryRun,
        slippagePct: settings.slippagePct,
      });
      if (result.outcome.error && !result.closedWithoutRemint) throw new Error(result.outcome.error);

      if (result.closedWithoutRemint) {
        // Closed, but the re-mint failed: the capital is in the wallet and
        // the position has to be untracked.
        await store.update(tracked.id, { closedReason: 'rebalance' });
        await store.remove(tracked.id);
        // The reason is shown: "it failed" without a reason is a dead end.
        const reason = (result.outcome.error ?? '').replace(
          /^the position was closed but the re-mint failed:\s*/i,
          '',
        );
        await ctx.api.editMessageText(
          chatId,
          status.message_id,
          [
            '⚠️ <b>Closed, but the re-mint failed</b>',
            reason ? `Reason: ${esc(reason)}` : '',
            'The capital is in your wallet — open a new position when you are ready.',
          ]
            .filter(Boolean)
            .join('\n'),
          { parse_mode: 'HTML' },
        );
        return;
      }

      const lines = [
        result.outcome.dryRun ? '🧪 <b>Rebalance simulated</b> (not sent)' : '🔁 <b>Rebalanced</b>',
        `New range ${result.tickLower} → ${result.tickUpper}`,
      ];
      if (!result.outcome.dryRun) {
        // The basis is unchanged: the same capital is simply re-minted in a new
        // range, so PnL stays continuous across the rebalance.
        await store.update(tracked.id, {
          tokenId: result.newTokenId ? result.newTokenId.toString() : tracked.tokenId,
          entry: {
            amount0: result.amount0.toString(),
            amount1: result.amount1.toString(),
            valueUsd: valuation.principalUsd,
            price: snapshot.price,
            openedAt: tracked.entry.openedAt,
            txHash: result.outcome.hash,
          },
          lastRebalanceAt: Date.now(),
          lastInRange: true,
        });
        lines.push(`Compounded ${fmtUsd(valuation.feesUsd)} of fees into the new range`);
      }
      if (result.outcome.hash) lines.push(`<a href="${txLink(result.outcome.hash)}">View transaction</a>`);
      await ctx.api.editMessageText(chatId, status.message_id, lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      await ctx.api.editMessageText(chatId, status.message_id, `❌ ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
    }
  });
}

/* ----------------------------- TP / SL rules ----------------------------- */

interface ExitRulePatch {
  takeProfitPct?: number;
  stopLossPct?: number;
  /** The user asked to remove both rules. */
  clear?: boolean;
  error?: string;
}

/**
 * Parses an exit-rule message:
 *   `30 -20`   take profit at +30%, stop loss at -20%
 *   `tp 30`    take profit only
 *   `sl -20`   stop loss only
 *   `clear`    remove both
 * Percentages are measured against the position's cost basis.
 *
 * Only the rules the user actually mentioned are returned, so setting a
 * take-profit never removes the stop loss that was already armed.
 */
export function parseExitRules(input: string): ExitRulePatch {
  const text = input.trim().toLowerCase();
  if (['clear', 'off', 'none', 'reset', 'cancel'].includes(text)) return { clear: true };
  if (!text) return { error: 'Send `30 -20`, `tp 30`, `sl -20` or `clear`.' };

  // `tp 30` and `tp30` are the same rule: glue the label to its number first.
  const parts = text
    .replace(/\b(tp|take|profit|sl|stop|loss)\s*([+-]?\d)/g, '$1$2')
    .split(/[\s,]+/)
    .filter(Boolean);
  let takeProfitPct: number | undefined;
  let stopLossPct: number | undefined;

  for (const part of parts) {
    const match = /^(tp|take|profit|sl|stop|loss)?\s*([+-]?\d+(?:\.\d+)?)%?$/.exec(part);
    if (!match) return { error: `Could not read “${part}”.` };
    const label = match[1];
    const value = Number(match[2]);
    if (!Number.isFinite(value)) return { error: `Could not read “${part}”.` };

    if (label === 'tp' || label === 'take' || label === 'profit') {
      if (value <= 0) return { error: 'Take profit must be a positive % (e.g. tp 30).' };
      takeProfitPct = value;
    } else if (label === 'sl' || label === 'stop' || label === 'loss') {
      if (value >= 0) stopLossPct = -value;
      else stopLossPct = value;
    } else if (value > 0) {
      takeProfitPct = value;
    } else if (value < 0) {
      stopLossPct = value;
    } else {
      return { error: 'Zero is not a valid threshold.' };
    }
  }

  if (takeProfitPct !== undefined && (takeProfitPct <= 0 || takeProfitPct > 100_000)) {
    return { error: 'Take profit must be between 0 and 100000%.' };
  }
  if (stopLossPct !== undefined && (stopLossPct >= 0 || stopLossPct <= -100)) {
    return { error: 'Stop loss must be between -0.1% and -99.9%.' };
  }
  // Only the rules that were mentioned are returned; a rule the user did not
  // mention keeps its current value.
  const patch: ExitRulePatch = {};
  if (takeProfitPct !== undefined) patch.takeProfitPct = takeProfitPct;
  if (stopLossPct !== undefined) patch.stopLossPct = stopLossPct;
  return patch;
}

function tpSlPrompt(tracked: TrackedPosition): string {
  const current =
    tracked.takeProfitPct === undefined && tracked.stopLossPct === undefined
      ? 'No exit rules set.'
      : [
          tracked.takeProfitPct !== undefined ? `TP +${tracked.takeProfitPct}%` : undefined,
          tracked.stopLossPct !== undefined ? `SL ${tracked.stopLossPct}%` : undefined,
        ]
          .filter(Boolean)
          .join(' · ');
  return [
    `🎯 <b>TP/SL · ${esc(tracked.id)}</b>`,
    `Current: ${esc(current)}`,
    '',
    'Send thresholds as % of your cost basis:',
    '• <code>30 -20</code> — take profit +30%, stop loss -20%',
    '• <code>tp 30</code> — take profit only',
    '• <code>sl -20</code> — stop loss only',
    '• <code>clear</code> — remove both',
    '',
    'The monitor closes the position for you when a threshold is hit.',
  ].join('\n');
}

/** Text input while a TP/SL prompt is open. Returns false when not handled. */
export async function handlePositionText(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const session = getSession(chatId);
  if (!session || (session.step !== 'tpsl' && session.step !== 'cycles')) return false;

  const tracked = store.find(chatId, session.positionId);
  if (!tracked) {
    clearSession(chatId);
    await ctx.reply('That position is no longer tracked.');
    return true;
  }

  if (session.step === 'cycles') {
    const parsedCycle = parseCycleLimit(text);
    if (parsedCycle.error) {
      await ctx.reply(`❌ ${esc(parsedCycle.error)}`, { parse_mode: 'HTML' });
      return true;
    }
    const fallback = store.settingsFor(chatId).tpCycleLimit;
    await store.update(tracked.id, { tpCycles: parsedCycle.limit });
    clearSession(chatId);
    await ctx.reply(
      parsedCycle.limit !== undefined
        ? `🔄 <b>${esc(tracked.id)}</b> will run ${parsedCycle.limit} cycle${parsedCycle.limit === 1 ? '' : 's'} — cycle ${tracked.cycle ?? 1} now.`
        : `🔄 <b>${esc(tracked.id)}</b> now follows the Settings default (${fallback} cycles).`,
      { parse_mode: 'HTML' },
    );
    await showPosition(ctx, tracked.id);
    return true;
  }

  const parsed = parseExitRules(text);
  if (parsed.error) {
    await ctx.reply(`❌ ${esc(parsed.error)}\n\n${tpSlPrompt(tracked)}`, { parse_mode: 'HTML' });
    return true;
  }

  // Only the rules the user mentioned are written; `clear` removes both.
  const patch: Partial<TrackedPosition> = {};
  if (parsed.clear) {
    patch.takeProfitPct = undefined;
    patch.stopLossPct = undefined;
  } else {
    if (parsed.takeProfitPct !== undefined) patch.takeProfitPct = parsed.takeProfitPct;
    if (parsed.stopLossPct !== undefined) patch.stopLossPct = parsed.stopLossPct;
  }
  await store.update(tracked.id, patch);
  clearSession(chatId);

  const takeProfit = patch.takeProfitPct ?? tracked.takeProfitPct;
  const stopLoss = patch.stopLossPct ?? tracked.stopLossPct;
  const lines = [
    `✅ Exit rules updated for <b>${esc(tracked.id)}</b>`,
    `🎯 Take profit: ${takeProfit !== undefined ? `+${takeProfit}%` : 'off'}`,
    `🛑 Stop loss: ${stopLoss !== undefined ? `${stopLoss}%` : 'off'}`,
    '',
    'Measured on PnL over the cost basis. The monitor checks every tick.',
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  await showPosition(ctx, tracked.id);
  return true;
}

/* ------------------------- portfolio & batch claim ------------------------ */

/** Aggregated view of every tracked position: value, fees, PnL, allocation. */
export async function portfolioSummary(ctx: Context, edit = false): Promise<void> {
  const chatId = ctx.chat!.id;
  const positions = store.positionsFor(chatId);
  if (positions.length === 0) {
    const empty = '💼 <b>Portfolio</b>\n────────────\n🫙 Empty.\n\n🚀 Use /new to open a position.';
    const kb = new InlineKeyboard().text('🚀 Open position', 'menu:open').row().text('🏠 Menu', 'menu:home');
    if (edit) await ctx.editMessageText(empty, { parse_mode: 'HTML', reply_markup: kb }).catch(() => undefined);
    else await ctx.reply(empty, { parse_mode: 'HTML', reply_markup: kb });
    return;
  }

  if (!edit) await ctx.reply('⏳ Building portfolio…');
  const rows: { tracked: TrackedPosition; valueUsd: number; positive?: boolean }[] = [];
  let valueUsd = 0;
  let principalUsd = 0;
  let pendingFeesUsd = 0;
  let withdrawnUsd = 0;
  let basisUsd = 0;
  let inRange = 0;
  // The portfolio adds up the per-position PnL the bot already computed, so
  // there is only ever one PnL formula.
  let netPnl = 0;
  let pnlKnown = true;

  for (const tracked of positions) {
    try {
      const view = await loadView(tracked);
      if (!view) {
        rows.push({ tracked, valueUsd: 0 });
        continue;
      }
      valueUsd += view.valuation.valueUsd;
      principalUsd += view.valuation.principalUsd;
      pendingFeesUsd += view.valuation.feesUsd;
      withdrawnUsd += tracked.feesWithdrawnUsd;
      basisUsd += tracked.basisUsd;
      if (view.snapshot.inRange) inRange += 1;
      if (Number.isFinite(view.pnl.totalPnlUsd)) netPnl += view.pnl.totalPnlUsd;
      else pnlKnown = false;
      rows.push({ tracked, valueUsd: view.valuation.valueUsd, positive: view.pnl.totalPnlUsd >= 0 });
    } catch {
      rows.push({ tracked, valueUsd: 0 });
    }
  }

  const pnlPct = basisUsd > 0 ? (netPnl / basisUsd) * 100 : 0;

  const lines = [
    '💼 <b>Portfolio</b>',
    '────────────',
    `💰 Value <b>${fmtUsd(valueUsd)}</b> · 💧 pending fees ${fmtUsd(pendingFeesUsd)}`,
    `🧮 Basis ${fmtUsd(basisUsd)} · 📈 net PnL <b>${pnlKnown ? fmtUsd(netPnl) : '—'}</b>${pnlKnown ? ` (${fmtPct(pnlPct)})` : ''}`,
    `🏦 Collected ${fmtUsd(withdrawnUsd)} · 🎯 in range ${inRange}/${positions.length}`,
    '────────────',
  ];

  const seen = new Set<string>();
  for (const row of rows.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0))) {
    if (seen.has(row.tracked.id)) continue;
    seen.add(row.tracked.id);
    const share = valueUsd > 0 && Number.isFinite(row.valueUsd) ? (row.valueUsd / valueUsd) * 100 : 0;
    const badge = row.positive === undefined ? '⚪' : row.positive ? '🟢' : '🔴';
    lines.push(
      `${badge} <b>${esc(row.tracked.id)}</b> ${fmtUsd(row.valueUsd)} · ${share.toFixed(1)}% of book`,
    );
  }

  const kb = new InlineKeyboard();
  for (const tracked of positions.slice(0, 10)) kb.text(tracked.id, `pos:show:${tracked.id}`).row();
  if (botAddress) kb.text('💧 Claim all fees', 'act:claimAll').row();
  kb.text('🏠 Menu', 'menu:home');

  const text = lines.join('\n');
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => undefined);
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

/** Collects fees from every tracked position, one transaction each. */
export async function claimAllFees(ctx: Context): Promise<void> {
  const chatId = ctx.chat!.id;
  const settings = store.settingsFor(chatId);
  const owner = botAddress;
  if (!owner) {
    await ctx.reply('No wallet configured.');
    return;
  }
  const positions = store.positionsFor(chatId);
  if (positions.length === 0) {
    await ctx.reply('No positions tracked. Use /new to open one.');
    return;
  }

  await txLock.run(`chat:${chatId}`, async () => {
    const status = await ctx.reply(
      settings.dryRun ? '🧪 Simulating fee collection for all positions…' : '⚡ Claiming fees from all positions…',
    );
    const lines: string[] = [];
    let totalUsd = 0;
    let claimed = 0;

    for (const tracked of positions) {
      try {
        const snapshot = await readPosition(tracked.version, BigInt(tracked.tokenId));
        if (!snapshot) {
          lines.push(`⚪ ${esc(tracked.id)} — no longer exists`);
          continue;
        }
        const valuation = await valuate(snapshot);
        if (snapshot.fees0 === 0n && snapshot.fees1 === 0n) {
          lines.push(`· ${esc(tracked.id)} — nothing to claim`);
          continue;
        }
        const result = await collectFees(snapshot, owner, settings.dryRun);
        if (result.error) throw new Error(result.error);
        if (!result.dryRun) {
          await store.update(tracked.id, {
            feesWithdrawnUsd: tracked.feesWithdrawnUsd + valuation.feesUsd,
          });
        }
        totalUsd += valuation.feesUsd;
        claimed += 1;
        lines.push(`✅ ${esc(tracked.id)} — ${fmtUsd(valuation.feesUsd)}${result.hash ? ` (${result.hash.slice(0, 10)}…)` : ''}`);
      } catch (err) {
        lines.push(`❌ ${esc(tracked.id)} — ${esc(errorMessage(err))}`);
      }
    }

    const header = [
      settings.dryRun ? '🧪 <b>Claim all fees (dry-run)</b>' : '💧 <b>Claim all fees</b>',
      `${claimed} position${claimed === 1 ? '' : 's'} · ${fmtUsd(totalUsd)} total`,
      '',
    ];
    await ctx.api.editMessageText(chatId, status.message_id, [...header, ...lines].join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });
}

export { loadView };

/**
 * Starts tracking an existing position NFT. PnL is measured from the import
 * moment, so the cost basis is the position's value right now.
 */
export async function trackPosition(
  ctx: Context,
  version: PositionVersion,
  tokenId: bigint,
): Promise<TrackedPosition | undefined> {
  const chatId = ctx.chat!.id;
  // A position NFT is a single on-chain asset shared by every chat, so it is
  // tracked once: two chats managing it would close it twice.
  const existing = store.findByToken(version, tokenId.toString());
  if (existing) {
    await ctx.reply(
      existing.chatId === chatId
        ? `tokenId ${tokenId} is already tracked.`
        : `tokenId ${tokenId} is already tracked in another chat.`,
    );
    return undefined;
  }

  const snapshot = await readPosition(version, tokenId);
  if (!snapshot) {
    await ctx.reply(`Could not read position ${tokenId}.`);
    return undefined;
  }
  const valuation = await valuate(snapshot);
  const tracked = await store.add({
    chatId,
    version,
    tokenId: tokenId.toString(),
    entry: {
      amount0: snapshot.amount0.toString(),
      amount1: snapshot.amount1.toString(),
      valueUsd: valuation.valueUsd,
      price: snapshot.price,
      openedAt: Date.now(),
    },
    basisUsd: valuation.principalUsd,
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
    range: { tickLower: snapshot.tickLower, tickUpper: snapshot.tickUpper },
  });

  await ctx.reply(
    [
      `📥 <b>Tracking ${esc(tracked.id)}</b> · ${version} tokenId ${tokenId}`,
      `📌 ${esc(snapshot.token0.symbol)}/${esc(snapshot.token1.symbol)} · 💰 value ${fmtUsd(valuation.valueUsd)}`,
      'ℹ️ PnL is measured from the import moment, not the original deposit.',
    ].join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('📊 Open details', `pos:show:${tracked.id}`)
        .row()
        .text('🏠 Menu', 'menu:home'),
    },
  );
  return tracked;
}
