import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The chain is mocked: this file exercises the Telegram flow, not the RPC.
const readPosition = vi.fn();
vi.mock('../src/core/positions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/positions.js')>();
  return { ...actual, readPosition };
});

const valuate = vi.fn();
vi.mock('../src/core/valuation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/valuation.js')>();
  return { ...actual, valuate };
});

const marketCapUsd = vi.fn();
vi.mock('../src/core/scanner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/scanner.js')>();
  return { ...actual, marketCapUsd };
});

const swapProceedsToUsdg = vi.fn();
vi.mock('../src/core/swap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/swap.js')>();
  return { ...actual, swapProceedsToUsdg };
});

const { handlePositionCallback } = await import('../src/bot/positionsFlow.js');
const { handleMenuCallback } = await import('../src/bot/menu.js');
const { handleNewCallback } = await import('../src/bot/newFlow.js');
const { handleHistoryCallback } = await import('../src/bot/historyFlow.js');
const { store } = await import('../src/store/store.js');
const { clearSession, setSession } = await import('../src/bot/session.js');

const CHAT_ID = 777_010;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const TOKEN = '0x72be1277e198d0c476869253cb4e62807e14533c';

const snapshot = {
  version: 'v4' as const,
  tokenId: 42n,
  owner: '0xA934cb8Ae1cDd1b9eC532B83D901219e4169d48b',
  token0: { address: USDG, symbol: 'USDG', name: 'Global Dollar', decimals: 6 },
  token1: { address: TOKEN, symbol: 'RAETO', name: 'RAETO', decimals: 18 },
  hasNative: false,
  fee: 3000,
  keyFee: 3000,
  tickSpacing: 100,
  tickLower: -2000,
  tickUpper: 2000,
  liquidity: 10n ** 18n,
  sqrtPriceX96: 2n ** 96n,
  tick: 0,
  price: 663,
  amount0: 13_235_538n,
  amount1: 25n * 10n ** 15n,
  fees0: 10n ** 14n,
  fees1: 10n ** 5n,
  inRange: true,
  poolAddress: '0x0',
  poolId: `0x${'0'.repeat(64)}`,
  hooks: '0x0000000000000000000000000000000000000000',
};

const valuation = {
  amount0Human: 13.235538,
  amount1Human: 0.025,
  price0Usd: 1,
  price1Usd: 0.0015,
  principalUsd: 13.27,
  fees0Human: 0.0001,
  fees1Human: 0.1,
  feesUsd: 0.25,
  valueUsd: 13.52,
  lowerPrice: 600,
  upperPrice: 700,
  nearestDistancePct: 3.2,
  distanceToLowerPct: 3.2,
  distanceToUpperPct: -19.8,
};

/** A context that records the order of the answers, the edits and the replies. */
function fakeCtx() {
  const order: string[] = [];
  const answers: { text?: string }[] = [];
  const edits: { text: string; markup?: unknown }[] = [];
  const replies: { text: string; markup?: unknown }[] = [];
  const ctx = {
    chat: { id: CHAT_ID },
    callbackQuery: { message: { message_id: 42 } },
    answerCallbackQuery: async (arg?: { text?: string }) => {
      order.push('answer');
      answers.push(arg ?? {});
    },
    editMessageText: async (text: string) => {
      order.push('edit');
      edits.push({ text });
    },
    reply: async (text: string, extra?: { reply_markup?: unknown }) => {
      order.push('reply');
      replies.push({ text, markup: extra?.reply_markup });
      return { message_id: 99 };
    },
    api: {
      editMessageText: async (
        _chatId: number,
        _id: number,
        text: string,
        options?: { reply_markup?: unknown },
      ) => {
        order.push('edit');
        edits.push({ text, markup: options?.reply_markup });
      },
    },
  } as never;
  return { ctx, order, answers, edits, replies };
}

let trackedId: string;

beforeEach(async () => {
  readPosition.mockResolvedValue(snapshot);
  valuate.mockResolvedValue(valuation);
  marketCapUsd.mockResolvedValue(1_300_000);
  swapProceedsToUsdg.mockResolvedValue({ ok: true, route: '0x', note: '💱 Swapped RAETO → USDG via 0x.' });
  const tracked = await store.add({
    chatId: CHAT_ID,
    version: 'v4',
    tokenId: '42',
    entry: { amount0: '13235538', amount1: '25000000000000000', valueUsd: 13.25, price: 0.0015, openedAt: Date.now() - 60_000 },
    basisUsd: 13.25,
    feesWithdrawnUsd: 0,
    compoundedFeesUsd: 0,
    alerts: true,
    autoCompound: false,
    compoundIntervalMs: 3_600_000,
    compoundMinFeeUsd: 1,
    autoTakeProfit: false,
    oorTakeProfit: false,
    tpCycles: 3,
    cycle: 1,
    range: { tickLower: -2000, tickUpper: 2000 },
  });
  trackedId = tracked.id;
  await store.updateSettings(CHAT_ID, { dryRun: false });
});

afterEach(async () => {
  clearSession(CHAT_ID);
  for (const position of store.positionsFor(CHAT_ID)) await store.remove(position.id);
  vi.clearAllMocks();
});

describe('the callback answer', () => {
  it('acknowledges the main menu before it does the work', async () => {
    const { ctx, order, answers } = fakeCtx();

    await handleMenuCallback(ctx, 'menu:home');

    expect(answers).toHaveLength(1);
    expect(order[0]).toBe('answer');
  });

  it('acknowledges a position refresh before the position is read', async () => {
    // The read takes a moment; the answer must not wait for it.
    readPosition.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return snapshot;
    });
    const { ctx, order, answers } = fakeCtx();

    await handlePositionCallback(ctx, `act:refresh:${trackedId}`);

    expect(answers.length).toBeGreaterThan(0);
    expect(order[0]).toBe('answer');
  });

  it('shows a loading note while a slow screen is built', async () => {
    readPosition.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return snapshot;
    });
    const { ctx, edits } = fakeCtx();

    await handlePositionCallback(ctx, `act:refresh:${trackedId}`);

    // The user sees something happen at once, so the button is not tapped twice.
    expect(edits[0]?.text).toContain('⏳');
    // And the finished screen replaces it.
    expect(edits[edits.length - 1]?.text).toContain('RAETO/USDG');
  });

  it('acknowledges the close button before the confirmation is built', async () => {
    const { ctx, order, answers, replies } = fakeCtx();

    await handlePositionCallback(ctx, `act:close:${trackedId}`);

    expect(answers).toHaveLength(1);
    expect(order[0]).toBe('answer');
    expect(replies[0]?.text).toContain('Close');
  });

  it('acknowledges a range button and does not open anything', async () => {
    const { ctx, order, answers } = fakeCtx();
    setSession(CHAT_ID, {
      step: 'range',
      token: { address: TOKEN, symbol: 'RAETO', name: 'RAETO', decimals: 18 },
      scan: {
        token: { address: TOKEN, symbol: 'RAETO', name: 'RAETO', decimals: 18 },
        pools: [],
        listed: 0,
        totalTvlUsd: 0,
        marketCapUsd: 0,
        tvlToMcap: 0,
        referencePriceUsd: 0,
      },
      page: 0,
      selected: 0,
      sort: 'tvl',
      hideBroken: false,
      side: 'quote',
    });

    await handleNewCallback(ctx, 'new:range:q20');

    expect(answers.length).toBeGreaterThan(0);
    expect(order[0]).toBe('answer');
    // A range button never mints: no position was tracked.
    expect(store.positionsFor(CHAT_ID)).toHaveLength(1);
  });

  it('acknowledges the PnL card button of a closed position', async () => {
    const record = await store.addClosed({
      chatId: CHAT_ID,
      version: 'v4',
      tokenId: '42',
      pair: 'RAETO/USDG',
      fee: 3000,
      reason: 'manual',
      entryPrice: 0.0015,
      exitPrice: 0.0016,
      entryValueUsd: 13.25,
      exitValueUsd: 13.5,
      pnlUsd: 0.25,
      pnlPct: 1.9,
      feesUsd: 0.25,
      idrRate: 16_000,
      openedAt: Date.now() - 60_000,
      closedAt: Date.now(),
      dryRun: false,
    });
    const { ctx, order, answers } = fakeCtx();

    await handleHistoryCallback(ctx, `card:${record.id}`);

    expect(answers.length).toBeGreaterThan(0);
    expect(order[0]).toBe('answer');
  });
});

describe('a failed button', () => {
  it('reports an error instead of leaving the button unanswered', async () => {
    readPosition.mockRejectedValue(new Error('RPC is down'));
    const { ctx, answers, replies } = fakeCtx();

    await handlePositionCallback(ctx, `act:refresh:${trackedId}`);

    // The tap was acknowledged …
    expect(answers.length).toBeGreaterThan(0);
    // … and the user was told what went wrong.
    expect(replies.map((reply) => reply.text).join('\n')).toContain('RPC is down');
  });

  it('tells the user that a position is gone', async () => {
    readPosition.mockResolvedValue(undefined);
    const { ctx, answers, edits, replies } = fakeCtx();

    await handlePositionCallback(ctx, `act:refresh:${trackedId}`);

    expect(answers.length).toBeGreaterThan(0);
    const said = [...replies.map((reply) => reply.text), ...edits.map((edit) => edit.text)].join('\n');
    expect(said).toContain('gone');
  });
});
