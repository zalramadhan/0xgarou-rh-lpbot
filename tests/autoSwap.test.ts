import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_SWAP_MIN_CHOICES,
  DEFAULT_AUTO_SWAP_MIN_USD,
  MAX_AUTO_SWAP_MIN_USD,
  normalizeAutoSwapMin,
} from '../src/constants/autoSwap.js';
import { autoSwapMinKeyboard, autoSwapMinText } from '../src/bot/ui.js';

// The store is written to, so it gets its own file.
const dir = await mkdtemp(join(tmpdir(), 'rhlp-swap-'));
process.env.DB_PATH = join(dir, 'store.json');
process.env.KEYSTORE_PATH = join(dir, 'keystore.json');
process.env.DRY_RUN = 'true';

const { store } = await import('../src/store/store.js');

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the auto-swap minimum', () => {
  it('defaults to $0.30', () => {
    expect(DEFAULT_AUTO_SWAP_MIN_USD).toBe(0.3);
  });

  it('keeps a sane, non-negative amount', () => {
    expect(normalizeAutoSwapMin(0.3)).toBe(0.3);
    expect(normalizeAutoSwapMin(1)).toBe(1);
    expect(normalizeAutoSwapMin('2.5')).toBe(2.5);
    expect(normalizeAutoSwapMin(-1)).toBe(DEFAULT_AUTO_SWAP_MIN_USD);
    expect(normalizeAutoSwapMin(Number.NaN)).toBe(DEFAULT_AUTO_SWAP_MIN_USD);
    expect(normalizeAutoSwapMin('abc')).toBe(DEFAULT_AUTO_SWAP_MIN_USD);
    expect(normalizeAutoSwapMin(1e9)).toBe(MAX_AUTO_SWAP_MIN_USD);
  });

  it('offers the common thresholds', () => {
    expect(AUTO_SWAP_MIN_CHOICES).toContain(0.3);
    expect(AUTO_SWAP_MIN_CHOICES.length).toBeGreaterThan(1);
  });
});

describe('the auto-swap minimum setting', () => {
  it('ships the default and survives a write', async () => {
    const chatId = 616_161;
    expect(store.settingsFor(chatId).autoSwapMinUsd).toBe(0.3);

    const updated = await store.updateSettings(chatId, { autoSwapMinUsd: 5 });
    expect(updated.autoSwapMinUsd).toBe(5);
    expect(store.settingsFor(chatId).autoSwapMinUsd).toBe(5);

    const bad = await store.updateSettings(chatId, { autoSwapMinUsd: -3 });
    expect(bad.autoSwapMinUsd).toBe(0.3);

    await store.updateSettings(chatId, { autoSwapMinUsd: 0.3 });
  });

  it('shows the current value and the choices', () => {
    const text = autoSwapMinText(0.3);
    expect(text).toContain('Current: <b>$0.30</b>');
    expect(text).toContain('stays in your wallet');

    const data = autoSwapMinKeyboard(0.3)
      .inline_keyboard.flat()
      .map((button) => (button as { callback_data?: string }).callback_data);
    for (const amount of AUTO_SWAP_MIN_CHOICES) {
      expect(data).toContain(`set:swapMin:${amount}`);
    }
    expect(data).toContain('set:back');
  });
});
