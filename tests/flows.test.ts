import { afterEach, describe, expect, it, vi } from 'vitest';
import { zeroAddress } from 'viem';
import { handleLooseText, handleNewCallback, showPoolScan } from '../src/bot/newFlow.js';
import { clearSession, getSession, setSession } from '../src/bot/session.js';
import type { V4Pool } from '../src/core/pools.js';
import type { PoolHealth, ScannedPool, TokenScan } from '../src/core/scanner.js';
import type { TokenInfo } from '../src/core/tokens.js';

const CHAT_ID = 4242;

const RAETO: TokenInfo = {
  address: '0x72be1277e198d0c476869253cb4e62807e14533c',
  symbol: 'RAETO',
  name: 'RAETO',
  decimals: 18,
};
const USDG: TokenInfo = {
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  symbol: 'USDG',
  name: 'Global Dollar',
  decimals: 6,
};

function pool(id: string, fee: number): V4Pool {
  return {
    version: 'v4',
    poolId: `0x${id.padEnd(64, '0')}` as `0x${string}`,
    key: { currency0: USDG.address, currency1: RAETO.address, fee, tickSpacing: 100, hooks: zeroAddress },
    token0: USDG,
    token1: RAETO,
    fee,
    lpFee: fee,
    tickSpacing: 100,
    sqrtPriceX96: 1n << 96n,
    tick: 0,
    liquidity: 10n ** 18n,
    price: 663,
    label: `v4 ${fee / 10_000}%`,
  };
}

function entry(id: string, health: PoolHealth, tvlUsd: number): ScannedPool {
  return {
    pool: pool(id, 3000),
    tvlUsd,
    volume24hUsd: 1_000,
    aprPct: 100,
    priceUsd: 0.0015,
    deviationPct: health === 'broken' ? -40 : 0,
    health,
  };
}

const scan: TokenScan = {
  token: RAETO,
  pools: [
    entry('a1', 'ok', 60_000),
    entry('a2', 'broken', 400),
    entry('a3', 'warn', 300),
    entry('a4', 'ok', 200),
    entry('a5', 'ok', 150),
    entry('a6', 'blocked', 20),
  ],
  listed: 6,
  totalTvlUsd: 61_070,
  marketCapUsd: 1_500_000,
  tvlToMcap: 0.0407,
  referencePriceUsd: 0.0015,
};

interface CapturedMarkup {
  inline_keyboard?: { callback_data?: string }[][];
}

function fakeCtx() {
  const edits: { text: string; markup?: CapturedMarkup }[] = [];
  const replies: { text: string; markup?: CapturedMarkup }[] = [];
  const answers: { text?: string }[] = [];
  return {
    edits,
    replies,
    answers,
    ctx: {
      chat: { id: CHAT_ID },
      answerCallbackQuery: async (arg?: { text?: string }) => {
        answers.push(arg ?? {});
      },
      editMessageText: async (text: string, extra?: { reply_markup?: CapturedMarkup }) => {
        edits.push({ text, markup: extra?.reply_markup });
      },
      reply: async (text: string, extra?: { reply_markup?: CapturedMarkup }) => {
        replies.push({ text, markup: extra?.reply_markup });
      },
    } as never,
  };
}

afterEach(() => clearSession(CHAT_ID));

describe('pool list callbacks', () => {
  it('pages through the scan and remembers the page', async () => {
    setSession(CHAT_ID, { step: 'range', token: RAETO, scan, page: 0, selected: 0, sort: 'tvl', hideBroken: false, side: 'both' });
    const { ctx, edits } = fakeCtx();

    expect(await handleNewCallback(ctx, 'new:page:1')).toBe(true);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain('page 2/2');
    expect(edits[0]!.text).toContain('<b>6.</b>');
    const session = getSession(CHAT_ID);
    expect(session?.step === 'range' && session.page).toBe(1);
  });

  it('ignores a page outside the range', async () => {
    setSession(CHAT_ID, { step: 'range', token: RAETO, scan, page: 0, selected: 0, sort: 'tvl', hideBroken: false, side: 'both' });
    const { ctx, edits } = fakeCtx();

    await handleNewCallback(ctx, 'new:page:9');

    expect(edits[0]!.text).toContain('page 2/2');
  });

  it('refuses a pool whose price is broken', async () => {
    setSession(CHAT_ID, { step: 'range', token: RAETO, scan, page: 0, selected: 0, sort: 'tvl', hideBroken: false, side: 'both' });
    const { ctx, replies } = fakeCtx();

    expect(await handleNewCallback(ctx, 'new:pool:1')).toBe(true);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain('trades at $0.0015');
    expect(replies[0]!.text).toContain('Pick another pool');
  });

  it('opens the side picker for a healthy pool and keeps the selection', async () => {
    setSession(CHAT_ID, { step: 'range', token: RAETO, scan, page: 0, selected: 0, sort: 'tvl', hideBroken: false, side: 'both' });
    const { ctx, replies } = fakeCtx();

    expect(await handleNewCallback(ctx, 'new:pool:0')).toBe(true);

    expect(replies[0]!.text).toContain('Which side do you fund');
    expect(replies[0]!.markup?.inline_keyboard?.flat().map((b) => b?.callback_data)).toEqual(
      expect.arrayContaining(['new:side:quote', 'new:side:token', 'new:side:both']),
    );
    const session = getSession(CHAT_ID);
    expect(session?.step === 'side' && session.selected).toBe(0);
  });

  it('reaches the range picker after choosing a side', async () => {
    setSession(CHAT_ID, { step: 'range', token: RAETO, scan, page: 0, selected: 0, sort: 'tvl', hideBroken: false, side: 'both' });
    const { ctx, replies } = fakeCtx();

    await handleNewCallback(ctx, 'new:pool:0');
    expect(await handleNewCallback(ctx, 'new:side:both')).toBe(true);

    expect(replies[1]!.text).toContain('How wide should the range be');
    expect(replies[1]!.text).toContain('Side: ⚖️ Both sides');
    const session = getSession(CHAT_ID);
    expect(session?.step === 'range' && session.side).toBe('both');
  });

  it('rejects stale flows', async () => {
    clearSession(CHAT_ID);
    const { ctx, answers } = fakeCtx();

    expect(await handleNewCallback(ctx, 'new:pool:0')).toBe(true);

    expect(answers[0]!.text).toContain('flow expired');
  });
});

describe('one-sided entry strategy', () => {
  async function pickSide(side: 'quote' | 'token') {
    setSession(CHAT_ID, { step: 'range', token: RAETO, scan, page: 0, selected: 0, sort: 'tvl', hideBroken: false, side: 'both' });
    const harness = fakeCtx();
    await handleNewCallback(harness.ctx, 'new:pool:0');
    await handleNewCallback(harness.ctx, `new:side:${side}`);
    return harness;
  }

  it('offers Spot and Bid Ask after a one-sided choice', async () => {
    const { ctx, replies } = await pickSide('quote');

    expect(replies[1]!.text).toContain('Entry strategy');
    expect(replies[1]!.text).toContain('Bid Ask');
    expect(replies[1]!.markup?.inline_keyboard?.flat().map((b) => b?.callback_data)).toEqual(
      expect.arrayContaining(['new:strategy:spot', 'new:strategy:bidAsk']),
    );
    const session = getSession(CHAT_ID);
    expect(session?.step === 'strategy' && session.side).toBe('quote');
  });

  it('carries Bid Ask into the range picker', async () => {
    const { ctx, replies } = await pickSide('token');

    expect(await handleNewCallback(ctx, 'new:strategy:bidAsk')).toBe(true);

    expect(replies[2]!.text).toContain('Strategy: Bid Ask');
    expect(replies[2]!.text).toContain('entries');
    const session = getSession(CHAT_ID);
    expect(session?.step === 'range' && session.strategy).toBe('bidAsk');
    expect(session?.step === 'range' && session.side).toBe('token');
  });

  it('keeps Spot as the single-range option', async () => {
    const { ctx, replies } = await pickSide('quote');

    expect(await handleNewCallback(ctx, 'new:strategy:spot')).toBe(true);

    expect(replies[2]!.text).toContain('Strategy: Spot');
    const session = getSession(CHAT_ID);
    expect(session?.step === 'range' && session.strategy).toBe('spot');
  });

  it('refuses a full range for a one-sided entry', async () => {
    const { ctx, answers } = await pickSide('quote');
    await handleNewCallback(ctx, 'new:strategy:bidAsk');

    expect(await handleNewCallback(ctx, 'new:range:full')).toBe(true);

    expect(answers.at(-1)!.text).toContain('Full range needs both tokens');
  });
});

describe('scan entrypoint', () => {
  it('stores the scan in the session and replies with the first page', async () => {
    vi.spyOn(await import('../src/core/scanner.js'), 'scanToken').mockResolvedValue(scan);
    const { ctx, replies } = fakeCtx();

    await showPoolScan(ctx, RAETO);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain('Pools · 6 found (by TVL) · page 1/2');
    const session = getSession(CHAT_ID);
    expect(session?.step).toBe('range');
  });
});

describe('a pasted contract address', () => {
  it('scans the pools without needing /new', async () => {
    vi.spyOn(await import('../src/core/scanner.js'), 'scanToken').mockResolvedValue(scan);
    vi.spyOn(await import('../src/core/tokens.js'), 'getToken').mockResolvedValue(RAETO);
    const { ctx, replies } = fakeCtx();
    clearSession(CHAT_ID);

    expect(await handleLooseText(ctx, RAETO.address)).toBe(true);

    expect(replies[0]!.text).toContain('Scanning every Uniswap pool for');
    expect(replies[1]!.text).toContain('Pools · 6 found');
    // The pool list is now open, so the flow can continue as usual.
    expect(getSession(CHAT_ID)?.step).toBe('range');
  });

  it('ignores text that is not an address', async () => {
    const { ctx, replies } = fakeCtx();
    clearSession(CHAT_ID);

    expect(await handleLooseText(ctx, 'hello there')).toBe(false);
    expect(replies).toHaveLength(0);
  });
});
