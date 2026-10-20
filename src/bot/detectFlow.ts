import { InlineKeyboard, type Context } from 'grammy';
import { answer } from './answers.js';
import { botAddress } from '../chain/client.js';
import { detectPositions, type DetectedToken } from '../core/detect.js';
import { readPosition, type PositionSnapshot, type PositionVersion } from '../core/positions.js';
import { valuate } from '../core/valuation.js';
import { store } from '../store/store.js';
import { esc, fmtAmount, fmtUsd, shortAddr } from '../utils/format.js';
import { errorMessage } from '../utils/errors.js';
import { createLogger } from '../logger.js';
import { trackPosition } from './positionsFlow.js';

const log = createLogger('detect');

/** One scan per chat at a time — a second tap must not start a second scan. */
const running = new Set<number>();

/** How many positions get their on-chain details read for the list. */
const DETAILS_LIMIT = 12;

/** How many track buttons the list carries. */
const BUTTON_LIMIT = 10;

/**
 * The rows of the last scan per chat, kept so a re-render after tracking does
 * not have to read every position from the chain again.
 */
const lastScan = new Map<number, { rows: DetectedRow[]; source: string }>();

interface DetectedRow {
  version: PositionVersion;
  tokenId: bigint;
  tracked: boolean;
  snapshot?: PositionSnapshot;
  valueUsd?: number;
}

/** Splits a scan result into tracked / untracked rows. */
export function splitRows(tokens: DetectedToken[]): DetectedRow[] {
  const trackedIds = new Set(store.allPositions().map((p) => `${p.version}:${p.tokenId}`));
  return tokens.map((token) => ({
    version: token.version,
    tokenId: token.tokenId,
    tracked: trackedIds.has(`${token.version}:${token.tokenId.toString()}`),
  }));
}

/**
 * Reads the on-chain details of the first untracked positions so the list can
 * show pair and value. Reading every position of a heavy wallet would mean
 * thousands of RPC calls, so the rest stay as bare ids.
 */
async function loadDetails(rows: DetectedRow[]): Promise<DetectedRow[]> {
  const targets = rows.filter((row) => !row.tracked && !row.snapshot).slice(0, DETAILS_LIMIT);
  await Promise.all(
    targets.map(async (row) => {
      const snapshot = await readPosition(row.version, row.tokenId).catch((err) => {
        log.warn(`could not read ${row.version} #${row.tokenId}`, err);
        return undefined;
      });
      if (!snapshot) return;
      row.snapshot = snapshot;
      const valuation = await valuate(snapshot).catch(() => undefined);
      row.valueUsd = valuation?.valueUsd;
    }),
  );
  return rows;
}

/** Where the v4 ids came from, as shown under the counts. */
function sourceLabel(v4Source: string): string {
  if (v4Source === 'indexer') return 'indexed via RPC';
  if (v4Source === 'scan') return 'v4 scanned on-chain';
  return 'v4 not available';
}

export function detectedText(owner: string, rows: DetectedRow[], source: string): string {
  const untracked = rows.filter((r) => !r.tracked);
  const v3 = rows.filter((r) => r.version === 'v3').length;
  const v4 = rows.length - v3;
  const lines = [
    '🔍 <b>Detected positions</b>',
    '────────────',
    `👛 <code>${esc(shortAddr(owner))}</code>`,
    `🧩 Found <b>${rows.length}</b> LP NFT${rows.length === 1 ? '' : 's'} · v3 ${v3} · v4 ${v4}`,
    `📥 Untracked <b>${untracked.length}</b> · ${esc(source)}`,
    '────────────',
  ];

  if (rows.length === 0) {
    lines.push('🫙 No LP position NFTs in this wallet.', '', 'Open one with 🚀 Open position.');
    return lines.join('\n');
  }

  const shown = rows.filter((row) => !row.tracked).slice(0, DETAILS_LIMIT);
  for (const row of shown) {
    const label = `<b>${esc(row.version)} #${row.tokenId}</b>`;
    if (!row.snapshot) {
      lines.push(`${label} · 📥 not tracked`);
      continue;
    }
    const { snapshot } = row;
    const pair = `${snapshot.token0.symbol}/${snapshot.token1.symbol}`;
    const value = row.valueUsd !== undefined && Number.isFinite(row.valueUsd) ? fmtUsd(row.valueUsd) : '—';
    lines.push(
      `${snapshot.inRange ? '🟢' : '🔴'} ${label} ${esc(pair)} · ${value} · 📥 not tracked`,
    );
    lines.push(
      `   ${fmtAmount(snapshot.amount0, snapshot.token0.decimals)} ${esc(snapshot.token0.symbol)} + ${fmtAmount(snapshot.amount1, snapshot.token1.decimals)} ${esc(snapshot.token1.symbol)}`,
    );
  }

  const remaining = untracked.length - shown.length;
  if (remaining > 0) {
    lines.push(`…and ${remaining} more.`);
  }

  const trackedCount = rows.length - untracked.length;
  lines.push('────────────');
  if (untracked.length > 0) {
    lines.push('👇 Tap to start tracking one:');
  } else {
    lines.push('✅ Every found position is already tracked.');
  }
  if (trackedCount > 0) {
    lines.push(`✅ ${trackedCount} already tracked.`);
  }
  return lines.join('\n');
}

export function detectedKeyboard(rows: DetectedRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  const untracked = rows.filter((r) => !r.tracked);
  for (const row of untracked.slice(0, BUTTON_LIMIT)) {
    const pair = row.snapshot
      ? `${row.snapshot.token0.symbol}/${row.snapshot.token1.symbol}`
      : `${row.version} #${row.tokenId}`;
    kb.text(`📥 ${esc(pair)} #${row.tokenId}`, `detect:track:${row.version}:${row.tokenId}`).row();
  }
  return kb.row().text('🔄 Rescan', 'detect:rescan').row().text('🏠 Menu', 'menu:home');
}

/** The message shown while the wallet is being read. */
const SCAN_TEXT = [
  '🔍 <b>Scanning wallet positions…</b>',
  '────────────',
  'Listing the LP NFTs held by the bot wallet.',
  '⏳ v3 is enumerated on-chain; v4 needs an indexer or a full id walk.',
].join('\n');

interface RunDetectOptions {
  /** Ignore the cached scan and read the chain again. */
  refresh?: boolean;
  /** Render into this message instead of posting a new one. */
  messageId?: number;
}

/** Runs the wallet scan and posts the result as a new message. */
export async function runDetect(ctx: Context, options: RunDetectOptions = {}): Promise<void> {
  const chatId = ctx.chat!.id;
  if (!botAddress) {
    await ctx.reply('⚠️ No wallet configured — set PRIVATE_KEY or unlock a keystore first.');
    return;
  }
  if (running.has(chatId)) {
    const notice = '⏳ A scan is already running for this chat.';
    if (options.messageId) {
      await ctx.api.editMessageText(chatId, options.messageId, notice).catch(() => undefined);
    } else {
      await ctx.reply(notice);
    }
    return;
  }

  running.add(chatId);
  // The scan renders into one message: the one it came from on a rescan, a new
  // one otherwise.
  let messageId = options.messageId ?? 0;
  try {
    if (options.messageId) {
      await ctx.api
        .editMessageText(chatId, messageId, SCAN_TEXT, {
          parse_mode: 'HTML',
          // The old buttons point at a stale list; drop them until the new
          // result is in.
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => undefined);
    } else {
      const status = await ctx.reply(SCAN_TEXT, { parse_mode: 'HTML' });
      messageId = status.message_id;
    }

    let lastEdit = 0;
    const { tokens, v4Source } = await detectPositions(botAddress, {
      refresh: options.refresh,
      onProgress: ({ phase, scanned, total }) => {
        // Telegram rate-limits edits; refresh at most every 8 seconds.
        const now = Date.now();
        if (now - lastEdit < 8_000) return;
        lastEdit = now;
        const pct = total > 0 ? Math.floor((scanned / total) * 100) : 0;
        ctx.api
          .editMessageText(
            chatId,
            messageId!,
            [
              '🔍 <b>Scanning wallet positions…</b>',
              '────────────',
              `⏳ ${phase === 'v4-scan' ? 'v4 manager' : phase} · ${pct}% (${scanned.toLocaleString('en-US')} / ${total.toLocaleString('en-US')})`,
              phase === 'v4-scan' ? '🐢 No indexer on this RPC — walking every v4 id.' : '',
            ]
              .filter(Boolean)
              .join('\n'),
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
          )
          .catch(() => undefined);
      },
    });

    const rows = await loadDetails(splitRows(tokens));
    const source = sourceLabel(v4Source);
    lastScan.set(chatId, { rows, source });
    const text = detectedText(botAddress, rows, source);
    const keyboard = detectedKeyboard(rows);
    await ctx.api
      .editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      })
      .catch(() =>
        ctx.reply(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: true },
        }),
      );
  } catch (err) {
    log.error('detect failed', err);
    await ctx.api
      .editMessageText(chatId, messageId, `❌ Scan failed: ${esc(errorMessage(err))}`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🏠 Menu', 'menu:home'),
      })
      .catch(() => undefined);
  } finally {
    running.delete(chatId);
  }
}

/**
 * Re-renders the detected list in the message the button came from, using the
 * rows of the last scan. Used after a position was tracked so the row flips to
 * tracked without reading the chain again.
 */
async function refreshDetectedMessage(ctx: Context): Promise<void> {
  const chatId = ctx.chat!.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (!botAddress || !messageId) return;
  try {
    const previous = lastScan.get(chatId);
    const rows = previous
      ? // Keep the details already read; only the tracked flag changes.
        previous.rows.map((row) => ({ ...row }))
      : await loadDetails(splitRows((await detectPositions(botAddress)).tokens));
    const trackedIds = new Set(store.allPositions().map((p) => `${p.version}:${p.tokenId}`));
    for (const row of rows) {
      row.tracked = trackedIds.has(`${row.version}:${row.tokenId.toString()}`);
    }
    const source = previous?.source ?? 'last scan';
    lastScan.set(chatId, { rows, source });
    await ctx.api
      .editMessageText(chatId, messageId, detectedText(botAddress, rows, source), {
        parse_mode: 'HTML',
        reply_markup: detectedKeyboard(rows),
        link_preview_options: { is_disabled: true },
      })
      .catch(() => undefined);
  } catch (err) {
    log.warn('could not refresh the detected list', err);
  }
}

/** Handles the buttons under the detected-positions list. */
export async function handleDetectCallback(ctx: Context, data: string): Promise<boolean> {
  const [, verb, version, rawTokenId] = data.split(':');

  if (verb === 'track' && version && rawTokenId) {
    await answer(ctx, { text: 'Tracking…' });
    const tokenId = BigInt(rawTokenId);
    // `trackPosition` reads the position and replies with the summary itself.
    const tracked = await trackPosition(ctx, version as PositionVersion, tokenId);
    if (tracked) await refreshDetectedMessage(ctx);
    return true;
  }

  if (verb === 'rescan') {
    await answer(ctx, { text: 'Rescanning…' });
    await runDetect(ctx, {
      refresh: true,
      messageId: ctx.callbackQuery?.message?.message_id,
    });
    return true;
  }

  await answer(ctx);
  return true;
}
