import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const dir = await mkdtemp(join(tmpdir(), 'rhlp-cal-'));
process.env.DB_PATH = join(dir, 'store.json');
process.env.KEYSTORE_PATH = join(dir, 'keystore.json');
process.env.DRY_RUN = 'true';

const { store } = await import('../src/store/store.js');
const { buildCalendarPayload, canGoTo, currentPeriod, localDate, shiftPeriod } = await import(
  '../src/core/calendar.js'
);
const { calendarSvg, renderProfitCalendar } = await import('../src/card/calendarCard.js');
const { formatCompactAmount } = await import('../src/card/format.js');

const CHAT_ID = 424_242;
/** Every test gets its own chat, so the history never leaks between them. */
let chat = CHAT_ID;

/** 2026-10-17T12:00:00Z — a Saturday afternoon in UTC. */
const SATURDAY = Date.UTC(2026, 9, 17, 12, 0);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface RecordOverrides {
  id?: string;
  closedAt?: number;
  pnlUsd?: number;
  pnlPct?: number;
  idrRate?: number;
  dryRun?: boolean;
  pair?: string;
  reason?: 'manual' | 'takeProfit' | 'stopLoss' | 'oorTakeProfit' | 'autoTakeProfit';
  rangeLabel?: string;
  strategy?: 'spot' | 'bidAsk';
  openedAt?: number;
}

async function close(overrides: RecordOverrides = {}) {
  const record = await store.addClosed({
    chatId: chat,
    version: 'v4',
    tokenId: '1',
    pair: overrides.pair ?? 'USDG/RAETO',
    fee: 3000,
    reason: overrides.reason ?? 'autoTakeProfit',
    entryPrice: 0.0015,
    exitPrice: 0.0016,
    entryValueUsd: 100,
    exitValueUsd: 100 + (overrides.pnlUsd ?? 0),
    pnlUsd: overrides.pnlUsd ?? 10,
    pnlPct: overrides.pnlPct ?? 10,
    feesUsd: 1,
    idrRate: overrides.idrRate ?? 16_000,
    openedAt: overrides.openedAt ?? SATURDAY - 60_000,
    closedAt: overrides.closedAt ?? SATURDAY,
    dryRun: overrides.dryRun ?? false,
    rangeLabel: overrides.rangeLabel,
    strategy: overrides.strategy,
  });
  return record;
}

beforeEach(() => {
  chat = CHAT_ID + Math.floor(Math.random() * 1_000_000);
});

describe('local dates', () => {
  it('buckets by the user timezone', () => {
    // 20:00 UTC is already the next day in Jakarta.
    const late = Date.UTC(2026, 9, 17, 20, 0);
    expect(localDate(late, 'Asia/Jakarta').date).toBe('2026-10-18');
    expect(localDate(late, 'UTC').date).toBe('2026-10-17');
    expect(localDate(late, 'Asia/Jakarta').weekday).toBe(6); // Sunday
  });
});

describe('month view', () => {
  it('buckets the positions into days and weeks', async () => {
    await close({ closedAt: SATURDAY, pnlUsd: 10, pnlPct: 10 });
    await close({ closedAt: Date.UTC(2026, 9, 18, 12, 0), pnlUsd: -4, pnlPct: -4 });
    await close({ closedAt: Date.UTC(2026, 9, 20, 12, 0), pnlUsd: 6, pnlPct: 6 });

    const payload = buildCalendarPayload({
      chatId: chat,
      view: 'month',
      period: '2026-10',
      currency: 'USD',
      timeZone: 'Asia/Jakarta',
      now: Date.UTC(2026, 9, 25),
    });

    expect(payload.title).toBe('OKTOBER 2026');
    expect(payload.netPnl).toBeCloseTo(12, 6);
    expect(payload.hasData).toBe(true);
    expect(payload.stats.tradingDays).toBe(3);
    expect(payload.stats.wins).toBe(2);
    expect(payload.stats.best).toBeCloseTo(10, 6);
    expect(payload.stats.worst).toBeCloseTo(-4, 6);

    // The weeks run Monday to Sunday and are numbered inside the month.
    expect(payload.weeks.length).toBeGreaterThanOrEqual(4);
    expect(payload.weeks[0]?.index).toBe(1);
    expect(payload.weeks[0]?.days[0]?.weekday).toBe(0);

    const saturday = payload.days.find((day) => day.date === '2026-10-17');
    expect(saturday?.count).toBe(1);
    expect(saturday?.pnl).toBeCloseTo(10, 6);
    expect(saturday?.isNeutral).toBe(false);
  });

  it('marks a day with positions and a zero net as neutral', async () => {
    await close({ closedAt: SATURDAY, pnlUsd: 0, pnlPct: 0 });
    const payload = buildCalendarPayload({
      chatId: chat,
      view: 'month',
      period: '2026-10',
      currency: 'USD',
      timeZone: 'Asia/Jakarta',
      now: Date.UTC(2026, 9, 25),
    });
    const day = payload.days.find((entry) => entry.date === '2026-10-17');
    expect(day?.hasPositions).toBe(true);
    expect(day?.isNeutral).toBe(true);
    expect(payload.stats.wins).toBe(0);
    expect(payload.stats.tradingDays).toBe(1);
  });

  it('excludes dry-run closes', async () => {
    await close({ closedAt: SATURDAY, pnlUsd: 10, dryRun: true });
    const payload = buildCalendarPayload({
      chatId: chat,
      view: 'month',
      period: '2026-10',
      currency: 'USD',
      timeZone: 'Asia/Jakarta',
      now: Date.UTC(2026, 9, 25),
    });
    expect(payload.hasData).toBe(false);
    expect(payload.netPnl).toBe(0);
  });

  it('uses each position own stored rate for IDR', async () => {
    await close({ closedAt: SATURDAY, pnlUsd: 10, idrRate: 16_000 });
    await close({ closedAt: SATURDAY, pnlUsd: 5, idrRate: 20_000 });
    const payload = buildCalendarPayload({
      chatId: chat,
      view: 'month',
      period: '2026-10',
      currency: 'IDR',
      timeZone: 'Asia/Jakarta',
      now: Date.UTC(2026, 9, 25),
    });
    // 10 × 16 000 + 5 × 20 000 = 260 000
    expect(payload.netPnl).toBeCloseTo(260_000, 6);
  });

  it('shows N/A for a position without a rate and leaves it out of the stats', async () => {
    await close({ closedAt: SATURDAY, pnlUsd: 10, idrRate: Number.NaN });
    const payload = buildCalendarPayload({
      chatId: chat,
      view: 'month',
      period: '2026-10',
      currency: 'IDR',
      timeZone: 'Asia/Jakarta',
      now: Date.UTC(2026, 9, 25),
    });
    const day = payload.days.find((entry) => entry.date === '2026-10-17');
    expect(Number.isNaN(day!.pnl)).toBe(true);
    expect(day!.missing).toBe(1);
    expect(payload.stats.tradingDays).toBe(0);
    expect(payload.stats.wins).toBe(0);
  });
});

describe('week and day views', () => {
  it('shows the seven days of the week', async () => {
    await close({ closedAt: SATURDAY, pnlUsd: 12.5, pnlPct: 8.25 });
    const payload = buildCalendarPayload({
      chatId: chat,
      view: 'week',
      period: '2026-10-12',
      currency: 'USD',
      timeZone: 'Asia/Jakarta',
      now: Date.UTC(2026, 9, 25),
    });
    expect(payload.title).toBe('MINGGU 12–18 OKT');
    expect(payload.weeks[0]?.days).toHaveLength(7);
    expect(payload.netPnl).toBeCloseTo(12.5, 6);
  });

  it('lists the positions of one day with their stored data', async () => {
    await close({
      closedAt: SATURDAY,
      pnlUsd: 16.25,
      pnlPct: 10.83,
      pair: 'FTR/ETH',
      reason: 'autoTakeProfit',
      rangeLabel: '-20% to -10%',
      strategy: 'spot',
      openedAt: SATURDAY - 755_000,
    });
    await close({ closedAt: SATURDAY + 1000, pnlUsd: -3.75, pnlPct: -2.5, pair: 'BONER/ETH', reason: 'manual' });

    const payload = buildCalendarPayload({
      chatId: chat,
      view: 'day',
      period: '2026-10-17',
      currency: 'USD',
      timeZone: 'Asia/Jakarta',
      now: Date.UTC(2026, 9, 25),
    });

    expect(payload.title).toBe('SABTU, 17 OKTOBER');
    expect(payload.positions).toHaveLength(2);
    expect(payload.positions[0]?.pair).toBe('FTR/ETH');
    expect(payload.positions[0]?.reason).toBe('Auto TP');
    expect(payload.positions[0]?.range).toBe('-20% to -10%');
    expect(payload.positions[0]?.durationMs).toBe(755_000);
    expect(payload.positions[0]?.roiPct).toBe(10.83);
    expect(payload.stats.positions).toBe(2);
    expect(payload.stats.positionWins).toBe(1);
    expect(payload.netPnl).toBeCloseTo(12.5, 6);
  });

  it('shows the empty state when nothing closed that day', async () => {
    const payload = buildCalendarPayload({
      chatId: chat,
      view: 'day',
      period: '2026-10-19',
      currency: 'USD',
      timeZone: 'Asia/Jakarta',
      now: Date.UTC(2026, 9, 25),
    });
    expect(payload.hasData).toBe(false);
    expect(payload.positions).toHaveLength(0);
    expect(payload.netPnl).toBe(0);

    // The empty state shows a dash, never a zero, and the grid is still drawn.
    const svg = calendarSvg(payload);
    expect(svg).toContain('>–<');
    expect(svg).toContain('Belum ada posisi ditutup');
    expect(svg).toContain('Tidak ada posisi yang ditutup di hari ini.');
  });
});

describe('navigation', () => {
  it('moves between periods', () => {
    expect(shiftPeriod('month', '2026-10', -1)).toBe('2026-09');
    expect(shiftPeriod('month', '2026-10', 1)).toBe('2026-11');
    expect(shiftPeriod('week', '2026-10-12', 1)).toBe('2026-10-19');
    expect(shiftPeriod('day', '2026-10-17', 1)).toBe('2026-10-24');
  });

  it('knows the current period', () => {
    const now = Date.UTC(2026, 9, 17, 12, 0);
    expect(currentPeriod('month', now, 'UTC')).toBe('2026-10');
    expect(currentPeriod('week', now, 'UTC')).toBe('2026-10-12');
    expect(currentPeriod('day', now, 'UTC')).toBe('2026-10-17');
  });

  it('stops at the current and the first period', async () => {
    await close({ closedAt: Date.UTC(2026, 8, 5, 12, 0), pnlUsd: 5 });
    const now = Date.UTC(2026, 9, 17, 12, 0);
    const limits = canGoTo('month', '2026-10', chat, 'UTC', now);
    expect(limits.next).toBe(false);
    expect(limits.previous).toBe(true);

    const before = canGoTo('month', '2026-07', chat, 'UTC', now);
    expect(before.previous).toBe(false);
  });
});

describe('calendar rendering', () => {
  it('renders a 1080x1350 PNG', () => {
    const payload = buildCalendarPayload({
      chatId: chat,
      view: 'month',
      period: '2026-10',
      currency: 'USD',
      timeZone: 'Asia/Jakarta',
      now: Date.UTC(2026, 9, 25),
    });
    const png = renderProfitCalendar(payload);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.readUInt32BE(16)).toBe(1080);
    expect(png.readUInt32BE(20)).toBe(1350);
  });

  it('draws the header, the grid and the footer', async () => {
    await close({ closedAt: SATURDAY, pnlUsd: 12.5, pnlPct: 8.25 });
    const payload = buildCalendarPayload({
      chatId: chat,
      view: 'month',
      period: '2026-10',
      currency: 'USD',
      timeZone: 'Asia/Jakarta',
      now: Date.UTC(2026, 9, 25),
    });
    const svg = calendarSvg(payload);
    expect(svg).toContain('>0XGAROU<');
    expect(svg).toContain('PROFIT CALENDAR');
    expect(svg).toContain('ROBINHOOD CHAIN · LP');
    expect(svg).toContain('OKTOBER 2026');
    expect(svg).toContain('+$12.50');
    expect(svg).toContain('Hari trading 1');
    expect(svg).toContain('Sen');
    expect(svg).toContain('Mgg');
    expect(svg).toContain('NET PNL SETELAH FEES &amp; GAS · POSISI YANG SUDAH DITUTUP');
    // No logo, no link, no QR.
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('href');
  });

  it('draws the day rows with the pair, the reason and the ROI', async () => {
    await close({ closedAt: SATURDAY, pnlUsd: 16.25, pnlPct: 10.83, pair: 'FTR/ETH' });
    const payload = buildCalendarPayload({
      chatId: chat,
      view: 'day',
      period: '2026-10-17',
      currency: 'USD',
      timeZone: 'Asia/Jakarta',
      now: Date.UTC(2026, 9, 25),
    });
    const svg = calendarSvg(payload);
    expect(svg).toContain('SABTU, 17 OKTOBER');
    expect(svg).toContain('FTR/ETH');
    expect(svg).toContain('Auto TP');
    expect(svg).toContain('+10.83%');
  });
});

describe('compact amounts', () => {
  it('formats the calendar cells', () => {
    expect(formatCompactAmount(12.5, 'USD')).toBe('+12.5');
    expect(formatCompactAmount(-14.2, 'USD')).toBe('-14.2');
    expect(formatCompactAmount(205.4, 'USD')).toBe('+205');
    expect(formatCompactAmount(0, 'USD')).toBe('0');
    expect(formatCompactAmount(205_000, 'IDR')).toBe('+205rb');
    expect(formatCompactAmount(2_100_000, 'IDR')).toBe('+2,1jt');
    expect(formatCompactAmount(-1_500_000_000, 'IDR')).toBe('-1,5M');
  });
});
