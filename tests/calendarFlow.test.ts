import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dir = await mkdtemp(join(tmpdir(), 'rhlp-calflow-'));
process.env.DB_PATH = join(dir, 'store.json');
process.env.KEYSTORE_PATH = join(dir, 'keystore.json');
process.env.DRY_RUN = 'true';

const { store } = await import('../src/store/store.js');
const { buildCalendarPayload } = await import('../src/core/calendar.js');
const { calendarKeyboard } = await import('../src/bot/calendarFlow.js');

const CHAT_ID = 515_151;
const NOW = Date.UTC(2026, 9, 25, 12, 0);

// One closed position, so the calendar has a first period to navigate back to.
await store.addClosed({
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
  openedAt: Date.UTC(2026, 7, 5, 12, 0),
  closedAt: Date.UTC(2026, 7, 5, 13, 0),
  dryRun: false,
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function payload(view: 'month' | 'week' | 'day', period: string) {
  return buildCalendarPayload({
    chatId: CHAT_ID,
    view,
    period,
    currency: 'USD',
    timeZone: 'Asia/Jakarta',
    now: NOW,
  });
}

function buttons(keyboard: ReturnType<typeof calendarKeyboard>) {
  return keyboard.inline_keyboard.flat().map((button) => ({
    text: button.text,
    data: (button as { callback_data?: string }).callback_data ?? '',
  }));
}

describe('calendar keyboard', () => {
  it('marks the active tab and offers the three views', () => {
    const rows = calendarKeyboard(payload('month', '2026-10'), CHAT_ID, NOW).inline_keyboard;
    const tabs = rows[0]!.map((button) => button.text);
    expect(tabs).toEqual(['• Bulan', 'Minggu', 'Hari']);
  });

  it('hides the arrow that is not allowed', () => {
    const month = buttons(calendarKeyboard(payload('month', '2026-10'), CHAT_ID, NOW));
    // The current month cannot go forward.
    expect(month.some((button) => button.text === '›')).toBe(false);
    expect(month.some((button) => button.text === '‹')).toBe(true);

    const past = buttons(calendarKeyboard(payload('month', '2026-08'), CHAT_ID, NOW));
    expect(past.some((button) => button.text === '‹')).toBe(true);
    expect(past.some((button) => button.text === '›')).toBe(true);
  });

  it('offers the weeks of the month and the days of the week', () => {
    const monthRows = calendarKeyboard(payload('month', '2026-10'), CHAT_ID, NOW).inline_keyboard;
    const monthDrill = monthRows[2]!.map((button) => (button as { callback_data?: string }).callback_data ?? '');
    expect(monthDrill.some((data) => data.startsWith('cal:w:'))).toBe(true);
    expect(monthDrill.some((data) => data.startsWith('cal:d:'))).toBe(false);

    const weekRows = calendarKeyboard(payload('week', '2026-10-12'), CHAT_ID, NOW).inline_keyboard;
    const weekDrill = weekRows[2]!.map((button) => (button as { callback_data?: string }).callback_data ?? '');
    expect(weekDrill.some((data) => data.startsWith('cal:d:'))).toBe(true);
  });

  it('offers USD and IDR, marking the active one', () => {
    const rows = calendarKeyboard(payload('month', '2026-10'), CHAT_ID, NOW).inline_keyboard;
    const last = rows[rows.length - 1]!.map((button) => button.text);
    expect(last).toEqual(['• USD', 'IDR']);
  });

  it('keeps every callback under 64 bytes', () => {
    const month = buttons(calendarKeyboard(payload('month', '2026-10'), CHAT_ID, NOW));
    const week = buttons(calendarKeyboard(payload('week', '2026-10-12'), CHAT_ID, NOW));
    const day = buttons(calendarKeyboard(payload('day', '2026-10-17'), CHAT_ID, NOW));
    for (const button of [...month, ...week, ...day]) {
      expect(Buffer.byteLength(button.data, 'utf8')).toBeLessThan(64);
    }
  });

  it('encodes the whole state in the callback data', () => {
    const month = buttons(calendarKeyboard(payload('month', '2026-10'), CHAT_ID, NOW));
    expect(month.some((button) => button.data === 'cal:m:2026-10:usd')).toBe(true);
    expect(month.some((button) => button.data === 'cal:m:2026-10:idr')).toBe(true);
    // The day tab of the current month opens the current day.
    expect(month.some((button) => button.data === 'cal:d:2026-10-25:usd')).toBe(true);
    // The week tab of the current month opens the current week.
    expect(month.some((button) => button.data === 'cal:w:2026-10-19:usd')).toBe(true);
  });
});
