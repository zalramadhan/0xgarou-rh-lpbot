import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const dir = await mkdtemp(join(tmpdir(), 'rhlp-calrow-'));
process.env.DB_PATH = join(dir, 'store.json');
process.env.KEYSTORE_PATH = join(dir, 'keystore.json');
process.env.DRY_RUN = 'true';

const { store } = await import('../src/store/store.js');
const { buildCalendarPayload } = await import('../src/core/calendar.js');
const { MIN_DUST_PNL_USD, isDust } = await import('../src/constants/dust.js');
const { historyText } = await import('../src/bot/historyFlow.js');

const CHAT_ID = 515_151;
let chat = CHAT_ID;

/** 2026-10-17T12:00:00Z — a Saturday afternoon in UTC. */
const SATURDAY = Date.UTC(2026, 9, 17, 12, 0);
const DAY = '2026-10-17';

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  chat = CHAT_ID + Math.floor(Math.random() * 1_000_000);
});

async function close(pnlUsd: number, pair: string) {
  await store.addClosed({
    chatId: chat,
    version: 'v4',
    tokenId: '1',
    pair,
    fee: 3000,
    reason: 'manual',
    entryPrice: 0.0015,
    exitPrice: 0.0016,
    entryValueUsd: 53,
    exitValueUsd: 53 + pnlUsd,
    pnlUsd,
    pnlPct: (pnlUsd / 53) * 100,
    feesUsd: 1,
    idrRate: 16_000,
    openedAt: SATURDAY - 60_000,
    closedAt: SATURDAY,
    dryRun: false,
    rangeLabel: '-20% to -10%',
    strategy: 'spot',
  });
}

function dayPayload() {
  return buildCalendarPayload({
    chatId: chat,
    view: 'day',
    period: DAY,
    currency: 'USD',
    timeZone: 'UTC',
    now: SATURDAY,
  });
}

describe('a day in the calendar', () => {
  it('does not give a row to a close that is worth less than a few cents', async () => {
    // The dry-run closes: a PnL of a fraction of a cent says nothing.
    await close(-0.000001, 'USDG/RAETO');
    await close(-0.000001, 'USDG/IGNITION');
    await close(0.574, 'USDG/IGNITION');
    await close(1.883, 'USDG/IGNITION');

    const payload = dayPayload();
    // Only the two real closes are worth a row.
    expect(payload.positions).toHaveLength(2);
    expect(payload.positions.map((p) => p.pair)).toEqual(['USDG/IGNITION', 'USDG/IGNITION']);
    // The day did close four positions, though.
    expect(payload.totalPositions).toBe(4);
  });

  it('does not count the dust as a loss', async () => {
    // Without this the day reads "1/6 wins": four dust closes counted as
    // losses that never happened.
    await close(-0.000001, 'USDG/RAETO');
    await close(-0.000001, 'USDG/RAETO');
    await close(0.574, 'USDG/IGNITION');

    const payload = dayPayload();
    expect(payload.stats.positions).toBe(1);
    expect(payload.stats.positionWins).toBe(1);
  });

  it('keeps a real loss on the screen', async () => {
    // Hiding a real loss would leave the day's net not matching the rows.
    await close(-2.5, 'USDG/IGNITION');
    await close(-0.000001, 'USDG/RAETO');

    const payload = dayPayload();
    expect(payload.positions).toHaveLength(1);
    expect(payload.positions[0]?.pnlUsd).toBeCloseTo(-2.5, 6);
    // The net still counts every close, the dust included.
    expect(payload.netPnlUsd).toBeCloseTo(-2.500001, 6);
  });

  it('keeps the net as the truth', async () => {
    // The dust is worth a fraction of a cent, but the net still counts every
    // close.
    await close(1.5, 'USDG/IGNITION');
    await close(0.02, 'USDG/IGNITION');

    const payload = dayPayload();
    expect(payload.positions).toHaveLength(1);
    expect(payload.netPnlUsd).toBeCloseTo(1.52, 6);
  });

  it('leaves the dust out of the history as well', async () => {
    // The history is the same list: the dust rows and the dust buttons go.
    await close(-0.000001, 'USDG/RAETO');
    await close(-0.000001, 'USDG/IGNITION');
    await close(1.883, 'USDG/IGNITION');

    const text = historyText(chat, 0);
    // The two real closes are listed, the dust is not.
    expect(text).toContain('$1.88');
    expect(text).not.toContain('-$0.00');
    // The win rate counts what is shown.
    expect(text).toContain('Win rate 100%');
    // The net is still the truth.
    expect(text).toContain('net PnL <b>$1.88</b>');
  });

  it('says so when every close is dust', async () => {
    await close(-0.000001, 'USDG/RAETO');
    const text = historyText(chat, 0);
    expect(text).toContain('worth less than $0.10');
    expect(text).not.toContain('No closed positions yet');
  });

  it('uses a threshold of ten cents', () => {
    expect(MIN_DUST_PNL_USD).toBe(0.1);
    expect(isDust(0.09)).toBe(true);
    expect(isDust(-0.09)).toBe(true);
    expect(isDust(0.1)).toBe(false);
    expect(isDust(-2.5)).toBe(false);
    // A PnL that is unknown is not dust: it is shown as missing.
    expect(isDust(Number.NaN)).toBe(false);
  });
});
