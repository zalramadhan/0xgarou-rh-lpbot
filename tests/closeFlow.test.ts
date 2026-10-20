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

const performExit = vi.fn();
vi.mock('../src/monitor/exits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/monitor/exits.js')>();
  return { ...actual, performExit };
});

const swapProceedsToUsdg = vi.fn();
vi.mock('../src/core/swap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/swap.js')>();
  return { ...actual, swapProceedsToUsdg };
});

const erc20BalanceOf = vi.fn();
vi.mock('../src/core/wallet.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/wallet.js')>();
  return { ...actual, erc20BalanceOf };
});

const { handlePositionCallback } = await import('../src/bot/positionsFlow.js');
const { store } = await import('../src/store/store.js');
const { clearSession, getSession } = await import('../src/bot/session.js');

const CHAT_ID = 777_004;
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

interface Call {
  text: string;
  markup?: { inline_keyboard?: { callback_data?: string; text?: string; url?: string }[][] };
}

function fakeCtx() {
  const replies: Call[] = [];
  const edits: Call[] = [];
  const answers: { text?: string }[] = [];
  const ctx = {
    chat: { id: CHAT_ID },
    callbackQuery: { message: { message_id: 42 } },
    answerCallbackQuery: async (arg?: { text?: string }) => {
      answers.push(arg ?? {});
    },
    editMessageText: async (text: string) => {
      edits.push({ text });
    },
    reply: async (text: string, extra?: { reply_markup?: Call['markup'] }) => {
      replies.push({ text, markup: extra?.reply_markup });
      return { message_id: 99 };
    },
    api: {
      editMessageText: async (
        _chatId: number,
        _id: number,
        text: string,
        options?: { reply_markup?: Call['markup'] },
      ) => {
        edits.push({ text, markup: options?.reply_markup });
      },
    },
  } as never;
  return { ctx, replies, edits, answers };
}

/** The callback data of every button of a keyboard. */
function buttonData(markup: unknown): string[] {
  const rows = (markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard ?? [];
  return rows.flat().map((button) => button.callback_data ?? '');
}

let trackedId: string;

beforeEach(async () => {
  readPosition.mockResolvedValue(snapshot);
  valuate.mockResolvedValue(valuation);
  erc20BalanceOf.mockResolvedValue(25n * 10n ** 15n);
  performExit.mockResolvedValue({
    closed: true,
    reason: 'manual',
    recordId: 'h1',
    txHash: '0xabc',
  });
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
  // A live close: the receipt only says "Position closed" when it was not a
  // simulation.
  await store.updateSettings(CHAT_ID, { dryRun: false });
});

afterEach(async () => {
  clearSession(CHAT_ID);
  for (const position of store.positionsFor(CHAT_ID)) await store.remove(position.id);
  vi.clearAllMocks();
});

describe('the close confirmation', () => {
  it('does not close the position and states the slippage', async () => {
    const { ctx, replies } = fakeCtx();

    await handlePositionCallback(ctx, `act:close:${trackedId}`);

    expect(performExit).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    const text = replies[0]?.text ?? '';
    expect(text).toContain('Close');
    expect(text).toContain('RAETO/USDG');
    expect(text).toContain('slippage');
    // The slippage that would be used is on the screen before the close.
    expect(text).toMatch(/\d+(\.\d+)?%/);
    expect(buttonData(replies[0]?.markup)).toEqual([
      `act:closeConfirm:${trackedId}`,
      `act:refresh:${trackedId}`,
    ]);
  });

  it('closes the position and then asks what to do with the tokens', async () => {
    const { ctx, replies } = fakeCtx();

    await handlePositionCallback(ctx, `act:closeConfirm:${trackedId}`);

    expect(performExit).toHaveBeenCalledTimes(1);
    // The automatic swap must not run: the user decides.
    expect(performExit.mock.calls[0]?.[0]?.skipAutoSwap).toBe(true);
    const choice = replies.find((reply) => reply.text.includes('Keep both'));
    expect(choice).toBeDefined();
    expect(buttonData(choice?.markup)).toEqual([
      `act:closeSwap:${trackedId}`,
      `act:closeKeep:${trackedId}`,
    ]);
  });
});

describe('choosing what to do with the withdrawn tokens', () => {
  it('keeps both tokens without swapping when the user says so', async () => {
    const { ctx, edits } = fakeCtx();
    await handlePositionCallback(ctx, `act:closeConfirm:${trackedId}`);

    await handlePositionCallback(ctx, `act:closeKeep:${trackedId}`);

    expect(swapProceedsToUsdg).not.toHaveBeenCalled();
    // The receipt of the close carries the final status and the actions.
    const receipt = edits.find((edit) => edit.text.includes('Position closed'));
    expect(receipt).toBeDefined();
    const data = buttonData(receipt?.markup);
    expect(data).toContain('card:h1');
    expect(data).toContain('hist:show:h1');
    expect(data).toContain('menu:home');
    // The choice message says that the tokens were kept.
    expect(edits.some((edit) => edit.text.includes('Kept both'))).toBe(true);
  });

  it('offers the two routes when the user wants to swap', async () => {
    const { ctx, replies } = fakeCtx();
    await handlePositionCallback(ctx, `act:closeConfirm:${trackedId}`);

    await handlePositionCallback(ctx, `act:closeSwap:${trackedId}`);

    const route = replies.find((reply) => reply.text.includes('Which route'));
    expect(route).toBeDefined();
    expect(buttonData(route?.markup)).toEqual([
      `act:closeRoute:${trackedId}:0x`,
      `act:closeRoute:${trackedId}:uniswap-v3`,
      `act:closeKeep:${trackedId}`,
    ]);
    // The routes are labelled with the names the user picked.
    const labels = (route?.markup?.inline_keyboard ?? []).flat().map((b) => b.text);
    expect(labels).toContain('0x API');
    expect(labels).toContain('V3 Pool');
  });
});

describe('the swap on the chosen route', () => {
  it('uses the 0x route the user picked', async () => {
    const { ctx, replies } = fakeCtx();
    await handlePositionCallback(ctx, `act:closeConfirm:${trackedId}`);
    await handlePositionCallback(ctx, `act:closeSwap:${trackedId}`);

    await handlePositionCallback(ctx, `act:closeRoute:${trackedId}:0x`);

    expect(swapProceedsToUsdg).toHaveBeenCalledTimes(1);
    expect(swapProceedsToUsdg.mock.calls[0]?.[0]?.route).toBe('0x');
    expect(replies[replies.length - 1]?.text).toContain('Swapped');
  });

  it('uses the v3 route the user picked', async () => {
    const { ctx } = fakeCtx();
    await handlePositionCallback(ctx, `act:closeConfirm:${trackedId}`);
    await handlePositionCallback(ctx, `act:closeSwap:${trackedId}`);

    await handlePositionCallback(ctx, `act:closeRoute:${trackedId}:uniswap-v3`);

    expect(swapProceedsToUsdg.mock.calls[0]?.[0]?.route).toBe('uniswap-v3');
  });

  it('reports a failed swap truthfully and keeps the close separate from it', async () => {
    swapProceedsToUsdg.mockResolvedValue({
      ok: false,
      route: '0x',
      note: '⚠️ The 0x API could not swap RAETO → USDG (api_error).',
      error: 'api_error',
    });
    const { ctx, replies, edits } = fakeCtx();
    await handlePositionCallback(ctx, `act:closeConfirm:${trackedId}`);
    await handlePositionCallback(ctx, `act:closeSwap:${trackedId}`);

    await handlePositionCallback(ctx, `act:closeRoute:${trackedId}:0x`);

    // The close succeeded: its own receipt says so.
    const receipt = edits.find((edit) => edit.text.includes('Position closed'));
    expect(receipt?.text).toContain('Position closed');
    // The swap failed: a separate message, never reported as a success.
    const swap = replies[replies.length - 1]?.text ?? '';
    expect(swap).toContain('The swap did not go through');
    expect(swap).toContain('RAETO');
    expect(swap).not.toContain('Swapped RAETO');
  });
});
