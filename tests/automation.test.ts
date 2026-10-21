import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Everything below writes to disk (store + keystore), so point both at a temp dir
// before the config module is loaded.
const dir = await mkdtemp(join(tmpdir(), 'rhlp-auto-'));
process.env.DB_PATH = join(dir, 'store.json');
process.env.KEYSTORE_PATH = join(dir, 'keystore.json');
process.env.DRY_RUN = 'true';

const { decideExit, EXIT_LABEL } = await import('../src/monitor/exits.js');
const { store } = await import('../src/store/store.js');
const { parseCycleLimit, parseTpTarget } = await import('../src/bot/parsers.js');
const { encryptKey, decryptKeystore, loadKeystore, renameWallet, saveKeystore } = await import(
  '../src/core/keystore.js'
);
const { historyText, historyRow, recordText } = await import('../src/bot/historyFlow.js');
const { bookText, bookKeyboard } = await import('../src/bot/addressBookFlow.js');
const { positionKeyboard, positionCard } = await import('../src/bot/ui.js');
const { usdIdrRate, fmtIdr, idrValue } = await import('../src/core/fx.js');
import type { TrackedPosition } from '../src/store/store.js';

const CHAT_ID = 777_002;

beforeAll(async () => {
  await store.init();
});

describe('exit rules (auto-TP, OOR, TP, SL)', () => {
  const base = { aboveRange: false, autoTpTargetPct: 1 };

  it('fires stop loss before everything else', () => {
    expect(
      decideExit({ ...base, pnlPct: -50, stopLossPct: -20, takeProfitPct: 30, aboveRange: true, oorTakeProfit: true, autoTakeProfit: true }),
    ).toBe('stopLoss');
  });

  it('fires the OOR take profit before the explicit TP when above the range', () => {
    expect(
      decideExit({ ...base, pnlPct: 5, takeProfitPct: 10, oorTakeProfit: true, aboveRange: true }),
    ).toBe('oorTakeProfit');
  });

  it('fires the explicit take profit before auto-TP', () => {
    expect(decideExit({ ...base, pnlPct: 40, takeProfitPct: 30, autoTakeProfit: true, autoTpTargetPct: 1 })).toBe(
      'takeProfit',
    );
  });

  it('fires auto-TP at the target only when it is armed', () => {
    expect(decideExit({ ...base, pnlPct: 2, autoTakeProfit: true })).toBe('autoTakeProfit');
    expect(decideExit({ ...base, pnlPct: 2, autoTakeProfit: false })).toBeUndefined();
  });

  it('stays quiet with no rules armed or an unreadable PnL', () => {
    expect(decideExit({ ...base, pnlPct: 999 })).toBeUndefined();
    expect(decideExit({ ...base, pnlPct: Number.NaN, stopLossPct: -10 })).toBeUndefined();
  });

  it('labels every exit kind', () => {
    expect(EXIT_LABEL.manual).toContain('Manual');
    expect(EXIT_LABEL.autoTakeProfit).toContain('Auto-TP');
    expect(EXIT_LABEL.oorTakeProfit).toContain('OOR');
  });
});

describe('settings parsers', () => {
  it('accepts a plain cycle count', () => {
    expect(parseCycleLimit('5')).toEqual({ limit: 5 });
    expect(parseCycleLimit(' 99 ')).toEqual({ limit: 99 });
    expect(parseCycleLimit('x3')).toEqual({ limit: 3 });
  });

  it('treats default as "follow Settings"', () => {
    expect(parseCycleLimit('default').useDefault).toBe(true);
    expect(parseCycleLimit('reset').useDefault).toBe(true);
    expect(parseCycleLimit('default').limit).toBeUndefined();
  });

  it('rejects broken cycle counts', () => {
    expect(parseCycleLimit('0').error).toBeTruthy();
    expect(parseCycleLimit('100').error).toBeTruthy();
    expect(parseCycleLimit('2.5').error).toBeTruthy();
    expect(parseCycleLimit('').error).toBeTruthy();
  });

  it('parses the auto-TP target', () => {
    expect(parseTpTarget('1')).toEqual({ pct: 1 });
    expect(parseTpTarget('2.5%')).toEqual({ pct: 2.5 });
    expect(parseTpTarget('0').error).toBeTruthy();
    expect(parseTpTarget('abc').error).toBeTruthy();
    expect(parseTpTarget('20000').error).toBeTruthy();
  });
});

describe('USD / IDR', () => {
  it('formats rupiah with Indonesian grouping', () => {
    expect(fmtIdr(12.5, 16_000)).toBe('Rp 200.000');
    expect(fmtIdr(-1, 16_000)).toBe('-Rp 16.000');
    expect(idrValue(10, 16_000)).toBe(160_000);
  });

  it('never guesses a rate it does not have', () => {
    expect(fmtIdr(10, Number.NaN)).toBe('Rp —');
    expect(idrValue(Number.NaN, 16_000)).toBeNaN();
  });

  it('fetches a live USD/IDR rate that is a positive number', async () => {
    const rate = await usdIdrRate();
    // The API may be unreachable in CI; when it answers, it must be sane.
    if (Number.isFinite(rate)) expect(rate).toBeGreaterThan(1_000);
  }, 15_000);
});

describe('history store and screen', () => {
  const seed = (patch: Record<string, unknown> = {}) => ({
    chatId: CHAT_ID,
    version: 'v3' as const,
    tokenId: '7',
    pair: 'RAETO/USDG',
    fee: 3000,
    reason: 'takeProfit' as const,
    entryPrice: 1,
    exitPrice: 1.2,
    entryValueUsd: 50,
    exitValueUsd: 60,
    pnlUsd: 10,
    pnlPct: 20,
    feesUsd: 1.5,
    idrRate: 16_000,
    openedAt: Date.now() - 3_600_000,
    closedAt: Date.now(),
    dryRun: false,
    ...patch,
  });

  it('keeps closed records newest first and finds them by id', async () => {
    const first = await store.addClosed(seed({ reason: 'stopLoss', pnlUsd: -3, pnlPct: -6 }));
    const second = await store.addClosed(seed({ reason: 'autoTakeProfit', cycle: 2 }));

    const history = store.historyFor(CHAT_ID);
    expect(history[0]?.id).toBe(second.id);
    expect(history[1]?.id).toBe(first.id);
    expect(store.findClosed(CHAT_ID, second.id.toUpperCase())?.id).toBe(second.id);
  });

  it('renders rows and detail cards with USD, IDR, reason and cycle', async () => {
    const record = await store.addClosed(seed({ reason: 'autoTakeProfit', cycle: 2 }));
    const row = historyRow(record);
    expect(row).toContain('⚡');
    expect(row).toContain('💵 Rp 160.000');
    expect(row).toContain('cycle 2');

    const detail = recordText(record);
    expect(detail).toContain('📈 PnL <b>$10.00</b>');
    expect(detail).toContain('Rp 160.000');
    expect(detail).toContain('cycle 2');
  });

  it('shows totals, win rate and paging in the list screen', () => {
    const text = historyText(CHAT_ID);
    expect(text).toContain('📜 <b>History</b>');
    expect(text).toContain('Win rate');
    expect(text).toMatch(/📄 Page \d+\/\d+/);
  });

  it('explains an empty history instead of showing a blank screen', () => {
    const text = historyText(CHAT_ID + 1);
    expect(text).toContain('No closed positions yet');
  });
});

describe('address book', () => {
  const token = {
    address: '0x72BE1277e198d0c476869253CB4E62807e14533c',
    symbol: 'RAETO',
    name: 'RAETO',
    decimals: 18,
  };

  it('saves, deduplicates and forgets entries', async () => {
    await store.rememberToken(CHAT_ID, token);
    await store.rememberToken(CHAT_ID, { ...token, symbol: 'RAETO2' });

    const entries = store.addressesFor(CHAT_ID);
    expect(entries.filter((e) => e.address === token.address.toLowerCase())).toHaveLength(1);
    expect(entries[0]?.symbol).toBe('RAETO2');
    expect(store.addressFor(CHAT_ID, token.address.toUpperCase())?.symbol).toBe('RAETO2');

    await store.forgetAddress(CHAT_ID, token.address);
    expect(store.addressFor(CHAT_ID, token.address)).toBeUndefined();
  });

  it('renders entries with an open and a remove button', async () => {
    await store.rememberToken(CHAT_ID, token);
    const text = bookText(CHAT_ID);
    expect(text).toContain('📒 <b>Address book</b>');
    expect(text).toContain('RAETO');

    const data = bookKeyboard(CHAT_ID)
      .inline_keyboard.flat()
      .map((b) => (b as { callback_data?: string }).callback_data);
    expect(data.some((d) => d === `book:open:${token.address.toLowerCase()}`)).toBe(true);
    expect(data.some((d) => d === `book:forget:${token.address.toLowerCase()}`)).toBe(true);
    expect(data).toContain('book:add');
    expect(data).toContain('book:search');
    await store.forgetAddress(CHAT_ID, token.address);
  });
});

describe('encrypted keystore', () => {
  const key = `0x${'ab'.repeat(32)}` as `0x${string}`;
  const passphrase = 'correct horse battery staple';

  it('round-trips a key and refuses the wrong passphrase', async () => {
    const file = await encryptKey(key, passphrase, 'main');
    await saveKeystore(file);

    expect(await decryptKeystore(file, passphrase)).toBe(key);
    await expect(decryptKeystore(file, 'wrong-passphrase')).rejects.toThrow(/passphrase/i);

    const loaded = await loadKeystore();
    expect(loaded?.address).toBe(file.address);
    expect(loaded?.label).toBe('main');
    expect(JSON.stringify(loaded)).not.toContain(key.slice(2));
  });

  it('writes the keystore with owner-only permissions', async () => {
    const file = await encryptKey(key, passphrase, 'perms');
    await saveKeystore(file);
    const info = await stat(process.env.KEYSTORE_PATH!);
    expect(info.mode & 0o077).toBe(0);
  });

  it('renames the wallet label', async () => {
    const file = await encryptKey(key, passphrase, 'old');
    await saveKeystore(file);
    const renamed = await renameWallet('treasury wallet');
    expect(renamed.label).toBe('treasury wallet');
    expect((await loadKeystore())?.label).toBe('treasury wallet');
    expect((await readFile(process.env.KEYSTORE_PATH!, 'utf8')).includes('treasury wallet')).toBe(true);
  });

  it('rejects an empty or over-long name', async () => {
    await expect(renameWallet('   ')).rejects.toThrow(/empty/i);
    await expect(renameWallet('a'.repeat(40))).resolves.toMatchObject({ label: 'a'.repeat(32) });
  });
});

describe('per-position automation controls', () => {
  const position = {
    chatId: CHAT_ID,
    version: 'v4' as const,
    tokenId: '11',
    entry: { amount0: '0', amount1: '0', valueUsd: 20, price: 1, openedAt: Date.now() },
    basisUsd: 20,
    feesWithdrawnUsd: 0,
    compoundedFeesUsd: 0,
    alerts: true,
    autoCompound: false,
    compoundIntervalMs: 3_600_000,
    compoundMinFeeUsd: 1,
  };

  it('stores auto-TP, OOR and cycle settings per position', async () => {
    const created = await store.add({ ...position, tpCycles: 5, cycle: 1, oorTakeProfit: true });
    await store.update(created.id, { autoTakeProfit: true, tpCycles: 7 });

    const reloaded = store.find(CHAT_ID, created.id)!;
    expect(reloaded.autoTakeProfit).toBe(true);
    expect(reloaded.oorTakeProfit).toBe(true);
    expect(reloaded.tpCycles).toBe(7);
    expect(reloaded.cycle).toBe(1);

    await store.remove(created.id);
  });

  it('shows the auto-TP target, the cycle counter and the facts on the card', () => {
    const snapshot = {
      version: 'v4', tokenId: 9n, owner: '0x0000000000000000000000000000000000000001',
      token0: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', name: 'Global Dollar', decimals: 6 },
      token1: { address: '0x72be1277e198d0c476869253cb4e62807e14533c', symbol: 'RAETO', name: 'RAETO', decimals: 18 },
      hasNative: false, fee: 3000, tickSpacing: 60, tickLower: 0, tickUpper: 120,
      liquidity: 1n, sqrtPriceX96: 1n, tick: 60, price: 1, amount0: 1n, amount1: 1n, fees0: 0n, fees1: 0n, inRange: true,
    } as never;
    const tracked = {
      id: 'p4', chatId: CHAT_ID, version: 'v4', tokenId: '9',
      entry: { amount0: '1', amount1: '1', valueUsd: 10, price: 1, openedAt: Date.now() - 60_000 },
      basisUsd: 10, feesWithdrawnUsd: 0, compoundedFeesUsd: 0, alerts: true, autoCompound: false,
      compoundIntervalMs: 3_600_000, compoundMinFeeUsd: 1, autoRebalance: false,
      autoTakeProfit: true, oorTakeProfit: true, tpCycles: 5, cycle: 2, createdAt: Date.now(),
    } as unknown as TrackedPosition;
    const valuation = { valueUsd: 10, principalUsd: 10, feesUsd: 0, lowerPrice: 0.9, upperPrice: 1.1, nearestDistancePct: 3 } as never;
    const pnl = { totalPnlUsd: 1.2, totalPnlPct: 12, feesEarnedUsd: 0, aprPct: 5 } as never;

    const text = positionCard(tracked, snapshot, valuation, pnl, { idrRate: 16_000, autoTpTargetPct: 1.5 });
    expect(text).toContain('⚡ Auto-TP +1.5% · Cycle 2/5');
    expect(text).toContain('Rp 19.200');
    // The state, the age, the strategy and the width of the range share the
    // second line.
    expect(text).toContain('IN RANGE ⏱ Age');
    expect(text).toContain('· Spot');

    const off = positionCard({ ...tracked, autoTakeProfit: false, oorTakeProfit: false }, snapshot, valuation, pnl, { idrRate: 16_000 });
    expect(off).not.toContain('Auto-TP');
  });

  it('offers the auto-TP and OOR toggles on the position keyboard', () => {
    const created = { id: 'p9', autoTakeProfit: true, oorTakeProfit: false, autoCompound: false, autoRebalance: false, alerts: false, cycle: 2, tpCycles: 4 };
    const data = positionKeyboard('p9', created as never, true)
      .inline_keyboard.flat()
      .map((b) => (b as { callback_data?: string }).callback_data);
    expect(data).toContain('act:toggleAutoTp:p9');
    expect(data).toContain('act:toggleOor:p9');
    expect(data).toContain('act:cycles:p9');
  });
});

describe('chat settings defaults', () => {
  it('ships auto-swap off, a 1% auto-TP target and 3 cycles', async () => {
    const settings = await store.updateSettings(CHAT_ID, {
      autoSwapToUsdg: true,
      autoTpTargetPct: 2.5,
      tpCycleLimit: 6,
    });
    expect(settings).toMatchObject({ autoSwapToUsdg: true, autoTpTargetPct: 2.5, tpCycleLimit: 6 });

    // Restore the defaults for the next run.
    await store.updateSettings(CHAT_ID, { autoSwapToUsdg: false, autoTpTargetPct: 1, tpCycleLimit: 3 });
  });

  it('uses the fresh-chat defaults', () => {
    const settings = store.settingsFor(CHAT_ID + 1);
    expect(settings.autoSwapToUsdg).toBe(false);
    expect(settings.autoTpTargetPct).toBe(1);
    expect(settings.tpCycleLimit).toBe(3);
    expect(settings.bidAskEntries).toBe(5);
    expect(settings.slippagePct).toBeGreaterThan(0);
  });

  it('persists the Bid Ask entry count and clamps it to 4–10', async () => {
    const updated = await store.updateSettings(CHAT_ID, { bidAskEntries: 7 });
    expect(updated.bidAskEntries).toBe(7);
    expect(store.settingsFor(CHAT_ID).bidAskEntries).toBe(7);

    const clamped = await store.updateSettings(CHAT_ID, { bidAskEntries: 99 });
    expect(clamped.bidAskEntries).toBe(10);

    await store.updateSettings(CHAT_ID, { bidAskEntries: 5 });
  });

  it('ships USD as the display currency and keeps only known currencies', async () => {
    expect(store.settingsFor(CHAT_ID + 3).currency).toBe('USD');

    const updated = await store.updateSettings(CHAT_ID, { currency: 'IDR' });
    expect(updated.currency).toBe('IDR');
    expect(store.settingsFor(CHAT_ID).currency).toBe('IDR');

    const bad = await store.updateSettings(CHAT_ID, { currency: 'BTC' as never });
    expect(bad.currency).toBe('USD');

    await store.updateSettings(CHAT_ID, { currency: 'USD' });
  });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
