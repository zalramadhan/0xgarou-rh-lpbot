import { InlineKeyboard, type Context } from 'grammy';
import { answer } from './answers.js';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { setWalletAccount } from '../chain/client.js';
import { decryptKeystore, encryptKey, loadKeystore, renameWallet, saveKeystore } from '../core/keystore.js';
import { esc, shortAddr } from '../utils/format.js';
import { errorMessage } from '../utils/errors.js';
import { clearSession, getSession, setSession } from './session.js';
import { showWallet, present } from './screens.js';

function prettyAddress(address: string): string {
  return esc(shortAddr(address));
}

/**
 * Starts the in-chat import. The bot can only delete its own messages, so the
 * warning about the key message staying in the chat is explicit.
 */
export async function startWalletImport(ctx: Context): Promise<void> {
  setSession(ctx.chat!.id, { step: 'walletKey' });
  await ctx.reply(
    [
      '🔑 <b>Import wallet</b>',
      '────────────',
      '⚠️ Send the private key as a 0x-prefixed 64-hex string.',
      '⚠️ Telegram keeps your message — delete it yourself afterwards.',
      '🔐 The bot stores only the encrypted keystore, never the raw key.',
      '',
      '✖ /cancel to stop.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('✖ Cancel', 'menu:home') },
  );
}

export async function startUnlock(ctx: Context): Promise<void> {
  const file = await loadKeystore();
  if (!file) {
    await ctx.reply('🔐 No keystore on disk yet. Import a wallet first.');
    return;
  }
  setSession(ctx.chat!.id, { step: 'unlock' });
  await ctx.reply(
    [
      '🔓 <b>Unlock wallet</b>',
      `Keystore: <code>${prettyAddress(file.address)}</code> · ${esc(file.label)}`,
      '',
      'Send the passphrase. The bot deletes its own prompts, but your message stays in the chat.',
      '✖ /cancel to stop.',
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
}

export async function startRename(ctx: Context): Promise<void> {
  const file = await loadKeystore();
  if (!file) {
    await ctx.reply('🏷 No keystore on disk yet. Import a wallet first.');
    return;
  }
  setSession(ctx.chat!.id, { step: 'walletName' });
  await ctx.reply(`🏷 Current name: <b>${esc(file.label)}</b>\nSend the new name (max 32 characters).`, {
    parse_mode: 'HTML',
  });
}

/** Text router for the wallet steps. Returns false when not handled. */
export async function handleWalletText(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const session = getSession(chatId);
  if (!session) return false;

  if (session.step === 'walletKey') {
    const candidate = text.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(candidate)) {
      await ctx.reply('❌ That is not a 0x-prefixed 32-byte private key. Send it again, or /cancel.');
      return true;
    }
    setSession(chatId, { step: 'walletPass', privateKey: candidate as Hex });
    await ctx.reply(
      [
        '🔐 <b>Passphrase</b>',
        'Send a passphrase of at least 8 characters.',
        'It encrypts the key on disk (scrypt + AES-256-GCM).',
        '⚠️ There is no recovery: a forgotten passphrase means re-importing the key.',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
    return true;
  }

  if (session.step === 'walletPass') {
    const passphrase = text.trim();
    if (passphrase.length < 8) {
      await ctx.reply('❌ The passphrase needs at least 8 characters. Send it again.');
      return true;
    }
    try {
      const account = privateKeyToAccount(session.privateKey);
      const file = await encryptKey(session.privateKey, passphrase, shortAddr(account.address));
      await saveKeystore(file);
      setWalletAccount(account);
      clearSession(chatId);
      await ctx.reply(
        [
          '✅ <b>Wallet imported and unlocked</b>',
          '────────────',
          `👛 <code>${esc(account.address)}</code>`,
          '🔐 Key encrypted to the keystore file.',
          '⚠️ Delete the message with your private key and passphrase.',
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
      await showWallet(ctx);
    } catch (err) {
      clearSession(chatId);
      await ctx.reply(`❌ Import failed: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
    }
    return true;
  }

  if (session.step === 'unlock') {
    const passphrase = text.trim();
    try {
      const file = await loadKeystore();
      if (!file) throw new Error('keystore missing');
      const key = await decryptKeystore(file, passphrase);
      const account = privateKeyToAccount(key);
      if (account.address.toLowerCase() !== file.address.toLowerCase()) {
        throw new Error('the decrypted key does not match the stored address');
      }
      setWalletAccount(account);
      clearSession(chatId);
      await ctx.reply(`🔓 Unlocked <code>${esc(account.address)}</code> · ${esc(file.label)}`, {
        parse_mode: 'HTML',
      });
      await showWallet(ctx);
    } catch (err) {
      await presenter(ctx, `❌ ${esc(errorMessage(err))}\nTry again, or /cancel.`);
    }
    return true;
  }

  if (session.step === 'walletName') {
    try {
      const file = await renameWallet(text);
      clearSession(chatId);
      await ctx.reply(`🏷 Wallet renamed to <b>${esc(file.label)}</b>.`, { parse_mode: 'HTML' });
      await showWallet(ctx);
    } catch (err) {
      await presenter(ctx, `❌ ${esc(errorMessage(err))}`);
    }
    return true;
  }

  return false;
}

async function presenter(ctx: Context, text: string): Promise<void> {
  await present(ctx, text);
}

/** Handles `wallet:*` callbacks: import, rename, unlock. */
export async function handleWalletCallback(ctx: Context, data: string): Promise<boolean> {
  const [, action] = data.split(':');
  await answer(ctx);

  switch (action) {
    case 'import':
      await startWalletImport(ctx);
      return true;
    case 'rename':
      await startRename(ctx);
      return true;
    case 'unlock':
      await startUnlock(ctx);
      return true;
    case 'show':
      await showWallet(ctx, true);
      return true;
    default:
      return true;
  }
}
