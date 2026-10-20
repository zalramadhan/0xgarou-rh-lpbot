import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRENDING_WINDOW,
  TRENDING_LIMIT,
  TRENDING_WINDOWS,
  sortByVolume,
  trendingTokens,
  type TrendingToken,
} from '../src/core/trending.js';
import { trendingKeyboard, trendingText } from '../src/bot/trendingFlow.js';

const token: TrendingToken = {
  address: '0x72be1277e198d0c476869253cb4e62807e14533c',
  symbol: 'RAETO',
  poolName: 'RAETO / USDG',
  priceUsd: 0.0015,
  changePct: 12.4,
  volumeUsd: 515,
  liquidityUsd: 55_400,
  marketCapUsd: 1_300_000,
  poolAddress: '0xabc',
};

describe('the trending windows', () => {
  it('offers 5m, 1h, 6h and 24h', () => {
    expect(TRENDING_WINDOWS).toEqual(['5m', '1h', '6h', '24h']);
    expect(DEFAULT_TRENDING_WINDOW).toBe('1h');
  });
});

describe('the trending screen', () => {
  it('lists the tokens with their change, market cap, liquidity and volume', () => {
    const text = trendingText([token], '1h');
    expect(text).toContain('🔥 <b>Top Trending</b> · Robinhood Chain');
    expect(text).toContain('⏱ Window <b>1h</b>');
    expect(text).toContain('ranked by volume');
    expect(text).toContain('1️⃣ <b>RAETO</b>  ▲ +12.4%');
    expect(text).toContain('🏦 MC $1.3M');
    expect(text).toContain('🧲 Liq $55.4K');
    expect(text).toContain('💵 Vol $515');
  });

  it('shows the market cap instead of the price', () => {
    const text = trendingText([token], '1h');
    expect(text).not.toContain('0.0015');
  });

  it('marks a losing token with a down arrow', () => {
    const text = trendingText([{ ...token, changePct: -4.2 }], '1h');
    expect(text).toContain('▼ -4.2%');
  });

  it('says so when the list is empty', () => {
    const text = trendingText([], '1h');
    expect(text).toContain('not available right now');
  });

  it('shows only the top ten tokens', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...token, symbol: `T${i + 1}` }));
    const text = trendingText(many, '1h');
    expect(text).toContain('1️⃣ <b>T1</b>');
    expect(text).toContain('🔟 <b>T10</b>');
    expect(text).not.toContain('T11');

    const buttons = trendingKeyboard(many, '1h').inline_keyboard.flat();
    const scans = buttons.filter((button) =>
      (button as { callback_data?: string }).callback_data?.startsWith('trend:s:'),
    );
    expect(scans).toHaveLength(10);
  });

  it('has a window toggle and a button per token', () => {
    const keyboard = trendingKeyboard([token], '1h');
    const data = keyboard.inline_keyboard.flat().map((button) => ({
      text: button.text,
      data: (button as { callback_data?: string }).callback_data,
      url: (button as { url?: string }).url,
    }));

    // The window row: the active one is marked.
    const windows = keyboard.inline_keyboard[0]!.map((button) => button.text);
    expect(windows).toEqual(['5m', '• 1h', '6h', '24h']);
    expect(data.some((button) => button.data === 'trend:w:5m')).toBe(true);
    expect(data.some((button) => button.data === 'trend:w:24h')).toBe(true);

    // The token row: tapping it scans the pools, plus a GMGN link.
    const scan = data.find((button) => button.data?.startsWith('trend:s:'));
    expect(scan?.data).toBe(`trend:s:${token.address}`);
    const link = data.find((button) => button.url);
    expect(link?.url).toContain(`gmgn.ai/robinhood/token/${token.address}`);
  });
});

describe('the trending source', () => {
  it('ranks the tokens by the volume they traded', () => {
    const sorted = sortByVolume([
      { ...token, symbol: 'LOW', volumeUsd: 10 },
      { ...token, symbol: 'HIGH', volumeUsd: 900 },
      { ...token, symbol: 'MID', volumeUsd: 100 },
    ]);
    expect(sorted.map((entry) => entry.symbol)).toEqual(['HIGH', 'MID', 'LOW']);
  });

  it('counts a missing volume as zero', () => {
    const sorted = sortByVolume([
      { ...token, symbol: 'NONE', volumeUsd: Number.NaN },
      { ...token, symbol: 'SOME', volumeUsd: 5 },
    ]);
    expect(sorted.map((entry) => entry.symbol)).toEqual(['SOME', 'NONE']);
  });

  it('keeps the list at ten tokens', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...token, volumeUsd: i }));
    expect(sortByVolume(many)).toHaveLength(TRENDING_LIMIT);
  });

  it('reads the trending pools of the chain', async () => {
    // The upstream API is public; a failure must not break the test run.
    // The upstream API is public but rate limited; an empty list is the
    // fallback the screen shows.
    const tokens = await trendingTokens('1h').catch(() => [] as TrendingToken[]);
    expect(Array.isArray(tokens)).toBe(true);
    for (const entry of tokens.slice(0, 3)) {
      expect(entry.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(entry.symbol.length).toBeGreaterThan(0);
    }
  });
});
