/**
 * Renders the profit calendar from real closed records, so the aggregation and
 * the renderer are checked together.
 *
 *   npm run preview:calendar
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

const dir = await mkdtemp(join(tmpdir(), 'rhlp-cal-'));
process.env.DB_PATH = join(dir, 'store.json');
process.env.KEYSTORE_PATH = join(dir, 'keystore.json');

const { store } = await import('../src/store/store.js');
const { buildCalendarPayload } = await import('../src/core/calendar.js');
const { renderProfitCalendar } = await import('../src/card/calendarCard.js');

const CHAT = 1;
const TZ = 'Asia/Jakarta';

// A month of closes: 17 October 2026 and a few neighbours.
const closes = [
  [3, 12, 10, 16_000],
  [4, 12, -8.4, 16_000],
  [7, 12, 25.1, 16_200],
  [10, 12, 6.3, 16_000],
  [12, 12, -14.2, 15_800],
  [14, 12, 31.8, 16_000],
  [15, 12, 9.7, 16_000],
  [16, 12, 18.4, 16_000],
  [17, 12, -5.1, 16_000],
  [17, 12, 12.5, 16_000],
  [20, 12, 25.1, 16_000],
  [24, 12, -9.8, 16_000],
] as const;

for (const [day, hour, pnl, rate] of closes) {
  const closedAt = Date.UTC(2026, 9, day, hour - 7, 0);
  await store.addClosed({
    chatId: CHAT,
    version: 'v4',
    tokenId: String(day * 100 + hour),
    pair: 'USDG/RAETO',
    fee: 3000,
    reason: 'autoTakeProfit',
    entryPrice: 0.0015,
    exitPrice: 0.0016,
    entryValueUsd: 100,
    exitValueUsd: 100 + pnl,
    pnlUsd: pnl,
    pnlPct: pnl,
    feesUsd: 1,
    idrRate: rate,
    openedAt: closedAt - 12 * 60_000,
    closedAt,
    dryRun: false,
    rangeLabel: '-20% to -10%',
    strategy: 'spot',
  });
}

const now = Date.UTC(2026, 9, 20, 12, 0);
const out = join('data', 'cards');
await mkdir(out, { recursive: true });

for (const [view, period, name] of [
  ['month', '2026-10', 'calendar-month'],
  ['week', '2026-10-12', 'calendar-week'],
  ['day', '2026-10-17', 'calendar-day'],
] as const) {
  const payload = buildCalendarPayload({
    chatId: CHAT,
    view,
    period,
    currency: 'USD',
    timeZone: TZ,
    now,
  });
  const png = renderProfitCalendar(payload);
  await writeFile(join(out, `${name}.png`), png);
  console.log(`${name}: net ${payload.netPnl} · ${payload.stats.tradingDays} trading days`);
}
