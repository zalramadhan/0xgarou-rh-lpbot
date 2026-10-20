import { InlineKeyboard, type Context } from 'grammy';
import { config } from '../config.js';
import { botAddress, publicClient, rpcStatus } from '../chain/client.js';
import { TOKENS } from '../constants/chain.js';
import { erc20BalanceOf, ethBalance } from '../core/wallet.js';
import { usdPrice } from '../core/prices.js';
import { store } from '../store/store.js';
import { esc, fmtAmount, fmtUsd, shortAddr } from '../utils/format.js';
import { errorMessage } from '../utils/errors.js';
import { settingsKeyboard, settingsText, walletKeyboard, withHome } from './ui.js';
import { loadKeystore } from '../core/keystore.js';

/** True when Telegram refused an edit because the message is already that. */
function isNotModified(err: unknown): boolean {
  const message = String((err as { description?: string; message?: string })?.description ?? err ?? '');
  return message.includes('message is not modified');
}

/**
 * Replies with a screen, or edits the message the button came from.
 *
 * An edit that Telegram refuses because the text is unchanged is **not** an
 * error: the screen is already on screen, so no second copy is sent.
 */
export async function present(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
  edit = false,
): Promise<void> {
  const options = {
    parse_mode: 'HTML' as const,
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  };
  if (edit) {
    const edited = await ctx
      .editMessageText(text, options)
      .then(() => true)
      .catch((err) => isNotModified(err));
    if (edited) return;
    await ctx.reply(text, options).catch(() => undefined);
    return;
  }
  await ctx.reply(text, options);
}

/**
 * Shows a loading note in the message the button came from.
 *
 * The work behind a button (a chain read, an indexer call, a card) can take a
 * second or two. Putting a "⏳" in the message right away means the user
 * sees that the bot got the tap, so the button is not tapped a second time.
 */
export async function showLoading(ctx: Context, text: string): Promise<void> {
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (!messageId) return;
  await ctx.api
    .editMessageText(ctx.chat!.id, messageId, text, { parse_mode: 'HTML' })
    .catch(() => undefined);
}

export function helpText(): string {
  return [
    'ℹ️ <b>Help</b>',
    'Uniswap v3 + v4 · Robinhood Chain (4663)',
    '────────────',
    '🚀 <b>Liquidity</b>',
    '/menu — main menu with buttons',
    '/new — open a position (paste a token CA; Spot or Bid Ask)',
    '/scan &lt;CA&gt; — every pool for a token, sortable',
    '/safety &lt;CA&gt; — buy/sell simulation + contract checks',
    '',
    '📊 <b>Positions</b>',
    '/positions — open positions with range bar and PnL',
    '/portfolio — totals: value, fees, PnL, allocation',
    '/history — closed positions with USD + IDR PnL',
    '/pos &lt;id&gt; — details, TP/SL, collect, close, rebalance',
    '/detect — every LP NFT the wallet holds, track the missing ones',
    '/import &lt;tokenId&gt; — track an existing v3/v4 position',
    '/claim — claim fees from every position',
    '',
    '👛 <b>Bot</b>',
    '/wallet — address, balances, import / rename / unlock',
    '/book — saved token CAs (address book)',
    '/settings — dry-run, slippage, auto-swap, TP target, cycles, Bid Ask entries',
    '/importwallet · /unlock · /rename — encrypted keystore',
    '/status — RPC, block, gas',
    '/cancel — abort the current flow',
    '────────────',
    '🤖 Automation per position: range alerts, auto-compound, auto-rebalance, TP/SL.',
    '⚡ Auto-TP re-enters with the same range and size until the cycle limit,',
    '📈 OOR take profit closes when price leaves the range on the upper side.',
    '💱 Auto-swap turns closed proceeds into USDG with the slippage guard.',
  ].join('\n');
}

export async function showHelp(ctx: Context, edit = false): Promise<void> {
  await present(ctx, helpText(), withHome(new InlineKeyboard()), edit);
}

async function statusText(): Promise<string> {
  const [block, gasPrice] = await Promise.all([publicClient.getBlockNumber(), publicClient.getGasPrice()]);
  const rpc = rpcStatus();
  const rpcLine =
    rpc.total > 1
      ? `🛰 RPC ${esc(new URL(rpc.active).host)} (${rpc.index + 1}/${rpc.total}${rpc.cooling ? ` · ${rpc.cooling} cooling` : ''})`
      : `🛰 RPC ${esc(new URL(config.rpcUrl).host)}`;
  return [
    '📡 <b>Status</b>',
    '────────────',
    '⛓ Robinhood Chain · chainId 4663',
    `🧱 Block <code>${block}</code> · ⛽ <code>${gasPrice}</code> wei`,
    rpcLine,
    `⏱ Poll ${Math.round(config.pollIntervalMs / 1000)}s`,
  ].join('\n');
}

export async function showStatus(ctx: Context, edit = false): Promise<void> {
  try {
    await present(ctx, await statusText(), withHome(new InlineKeyboard()), edit);
  } catch (err) {
    await present(ctx, `❌ Status failed: ${esc(errorMessage(err))}`, withHome(new InlineKeyboard()), edit);
  }
}

export async function walletText(chatId: number): Promise<string> {
  if (!botAddress) {
    return '👛 <b>Wallet</b>\n────────────\n⚠️ No PRIVATE_KEY configured — the bot can only watch positions.';
  }
  const [eth, usdg, weth, usdgPrice, wethPrice] = await Promise.all([
    ethBalance(botAddress),
    erc20BalanceOf(TOKENS.USDG, botAddress),
    erc20BalanceOf(TOKENS.WETH, botAddress),
    usdPrice(TOKENS.USDG),
    usdPrice(TOKENS.WETH),
  ]);
  const usdgUsd = (Number(usdg) / 1e6) * usdgPrice;
  const wethUsd = (Number(weth) / 1e18) * wethPrice;
  const settings = store.settingsFor(chatId);
  const positions = store.positionsFor(chatId);
  const keystore = await loadKeystore().catch(() => undefined);
  return [
    `👛 <b>Wallet</b> <code>${esc(botAddress)}</code>`,
    `🔐 Keystore: ${keystore ? `🏷 ${esc(keystore.label)}` : '📭 none imported'}`,
    '────────────',
    `${settings.dryRun ? '🧪 Mode DRY-RUN' : '⚡ Mode LIVE'}`,
    `⛽ ETH ${fmtAmount(eth, 18)}`,
    `💵 USDG ${fmtAmount(usdg, 6)} ≈ ${fmtUsd(usdgUsd)}`,
    `🟣 WETH ${fmtAmount(weth, 18)} ≈ ${fmtUsd(wethUsd)}`,
    '────────────',
    `📊 Open positions: ${positions.length}`,
    `🎯 Armed exit rules: ${positions.filter((p) => p.takeProfitPct !== undefined || p.stopLossPct !== undefined).length}`,
  ].join('\n');
}

export async function showWallet(ctx: Context, edit = false): Promise<void> {
  if (!botAddress) {
    await present(ctx, await walletText(ctx.chat!.id), walletKeyboard(), edit);
    return;
  }
  try {
    await present(ctx, await walletText(ctx.chat!.id), walletKeyboard(), edit);
  } catch (err) {
    await present(ctx, `❌ Wallet read failed: ${esc(errorMessage(err))}`, walletKeyboard(), edit);
  }
}

export async function showSettings(ctx: Context, edit = false): Promise<void> {
  const settings = store.settingsFor(ctx.chat!.id);
  const keystore = await loadKeystore().catch(() => undefined);
  await present(
    ctx,
    settingsText(settings, botAddress, keystore ? { label: keystore.label, address: keystore.address } : undefined),
    settingsKeyboard(settings),
    edit,
  );
}

/** Short one-line identity for logs and the menu footer. */