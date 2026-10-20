import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Context } from 'grammy';

const dir = await mkdtemp(join(tmpdir(), 'rhlp-cardflow-'));
process.env.DB_PATH = join(dir, 'store.json');
process.env.KEYSTORE_PATH = join(dir, 'keystore.json');
process.env.DRY_RUN = 'true';

const { store } = await import('../src/store/store.js');
const { handleHistoryCallback } = await import('../src/bot/historyFlow.js');
const { calendarKeyboard } = await import('../src/bot/calendarFlow.js');
const { buildCalendarPayload } = await import('../src/core/calendar.js');

const CHAT_ID = 909_090;
const CLOSED_AT = Date.UTC(2026, 9, 17, 5, 0);
const NOW = Date.UTC(2026, 9, 25, 12, 0);

const record = await store.addClosed({
  chatId: CHAT_ID,
  version: 'v4',
  tokenId: '1',
  pair: 'USDG/RAETO',
  fee: 3000,
  reason: 'autoTakeProfit',
  entryPrice: 0.0015,
  exitPrice: 0.0016,
  entryValueUsd: 100,
  exitValueUsd: 110,
  pnlUsd: 10,
  pnlPct: 10,
  feesUsd: 1,
  idrRate: 16_000,
  openedAt: CLOSED_AT - 3_600_000,
  closedAt: CLOSED_AT,
  dryRun: false,
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface FakeCtx {
  ctx: Context;
  photos: { other?: { caption?: string } }[];
  replies: string[];
  edits: { text: string; markup?: unknown }[];
  answers: { text?: string }[];
}

function fakeCtx(): FakeCtx {
  const photos: FakeCtx['photos'] = [];
  const replies: string[] = [];
  const edits: FakeCtx['edits'] = [];
  const answers: FakeCtx['answers'] = [];

  const ctx = {
    chat: { id: CHAT_ID },
    callbackQuery: { message: { message_id: 1 } },
    answerCallbackQuery: async (arg?: { text?: string }) => {
      answers.push(arg ?? {});
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 2 };
    },
    replyWithPhoto: async (_photo: unknown, other?: { caption?: string }) => {
      photos.push({ other });
      return { message_id: 3 };
    },
    editMessageText: async (text: string, options?: { reply_markup?: unknown }) => {
      edits.push({ text, markup: options?.reply_markup });
      return { message_id: 1 };
    },
  } as never;

  return { ctx, photos, replies, edits, answers };
}

/** The callback data of every button of a keyboard. */
function buttonData(markup: unknown): string[] {
  const rows = (markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard ?? [];
  return rows.flat().map((button) => button.callback_data ?? '');
}

describe('the PnL card button', () => {
  it('sends the card image when the button is tapped', async () => {
    const { ctx, photos, replies } = fakeCtx();

    expect(await handleHistoryCallback(ctx, `card:${record.id}`)).toBe(true);

    expect(photos).toHaveLength(1);
    expect(photos[0]?.other?.caption).toContain('RAETO/USDG');
    expect(replies).toHaveLength(0);
  });

  it('is reachable from the closed-position screen', async () => {
    const { ctx, photos, edits } = fakeCtx();

    // The record screen is opened first, it carries the button.
    await handleHistoryCallback(ctx, `hist:show:${record.id}`);
    expect(edits).toHaveLength(1);
    expect(buttonData(edits[0]?.markup)).toContain(`card:${record.id}`);

    // Then the button is tapped.
    const data = buttonData(edits[0]?.markup).find((entry) => entry.startsWith('card:'));
    expect(data).toBe(`card:${record.id}`);

    await handleHistoryCallback(ctx, data!);
    expect(photos).toHaveLength(1);
  });

  it('is reachable from the calendar day view', async () => {
    const payload = buildCalendarPayload({
      chatId: CHAT_ID,
      view: 'day',
      period: '2026-10-17',
      currency: 'USD',
      timeZone: 'Asia/Jakarta',
      now: NOW,
    });
    const keyboard = calendarKeyboard(payload, CHAT_ID, NOW);
    const data = buttonData(keyboard).find((entry) => entry.startsWith('card:'));
    expect(data).toBe(`card:${record.id}`);

    const { ctx, photos } = fakeCtx();
    await handleHistoryCallback(ctx, data!);
    expect(photos).toHaveLength(1);
  });

  it('still sends the card when Telegram refuses the answer', async () => {
    // Telegram rejects an answer when the update reached the bot too late:
    // "query is too old and response timeout expired". That must not stop
    // the card: the button has to do its job even when the spinner in the
    // chat cannot be taken away.
    const photos: unknown[] = [];
    const ctx = {
      chat: { id: CHAT_ID },
      callbackQuery: { message: { message_id: 1 } },
      answerCallbackQuery: async () => {
        throw new Error('400 Bad Request: query is too old and response timeout expired');
      },
      reply: async () => ({ message_id: 2 }),
      replyWithPhoto: async () => {
        photos.push(1);
        return { message_id: 3 };
      },
    } as never;

    expect(await handleHistoryCallback(ctx, `card:${record.id}`)).toBe(true);
    expect(photos).toHaveLength(1);
  });

  it('renders a record that lost a field instead of crashing', async () => {
    // A record without a tokenId (or any other field) must still open: the
    // screen is the only way back to the card button.
    const stored = store.snapshot.history.find((entry) => entry.id === record.id)!;
    const tokenId = stored.tokenId;
    delete (stored as { tokenId?: string }).tokenId;
    delete (stored as { version?: string }).version;

    try {
      const { ctx, edits } = fakeCtx();
      await handleHistoryCallback(ctx, `hist:show:${record.id}`);
      expect(edits).toHaveLength(1);
      expect(edits[0]?.text).toContain('USDG/RAETO');
    } finally {
      stored.tokenId = tokenId;
      stored.version = 'v4';
    }
  });

  it('says so when the record is gone', async () => {
    const { ctx, photos, replies } = fakeCtx();

    await handleHistoryCallback(ctx, 'card:h999');

    expect(photos).toHaveLength(0);
    expect(replies[0]).toContain('Unknown closed position');
  });
});

describe('the history callbacks', () => {
  it('lists, pages and shows the records', async () => {
    const { ctx, edits } = fakeCtx();

    await handleHistoryCallback(ctx, 'hist:list');
    expect(edits[0]?.text).toContain('📜');

    await handleHistoryCallback(ctx, 'hist:page:0');
    expect(edits[1]?.text).toContain('📜');

    await handleHistoryCallback(ctx, `hist:show:${record.id}`);
    expect(edits[2]?.text).toContain(record.id);
  });

  it('reports a record that is gone', async () => {
    const { ctx, answers, edits } = fakeCtx();

    await handleHistoryCallback(ctx, 'hist:show:h999');

    expect(edits).toHaveLength(0);
    expect(answers[0]?.text).toBe('That record is gone');
  });
});
