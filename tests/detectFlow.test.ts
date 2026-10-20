import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The chain is mocked: this file exercises the Telegram flow, not the RPC.
const detectPositions = vi.fn();

vi.mock('../src/core/detect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/detect.js')>();
  return { ...actual, detectPositions };
});

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

const { handleDetectCallback, runDetect } = await import('../src/bot/detectFlow.js');
const { store } = await import('../src/store/store.js');
const { botAddress } = await import('../src/chain/client.js');

const CHAT_ID = 777_003;
const WALLET = '0xA934cb8Ae1cDd1b9eC532B83D901219e4169d48b';

interface Call {
  text: string;
  messageId?: number;
  markup?: unknown;
}

/** A context that records every reply and edit the flow makes. */
function fakeCtx(messageId = 42) {
  const replies: Call[] = [];
  const edits: Call[] = [];
  const answers: { text?: string }[] = [];
  const ctx = {
    chat: { id: CHAT_ID },
    callbackQuery: { message: { message_id: messageId } },
    answerCallbackQuery: async (arg?: { text?: string }) => {
      answers.push(arg ?? {});
    },
    editMessageText: async (text: string) => {
      edits.push({ text });
    },
    reply: async (text: string) => {
      replies.push({ text });
      return { message_id: messageId };
    },
    api: {
      editMessageText: async (
        _chatId: number,
        id: number,
        text: string,
        options?: { reply_markup?: unknown },
      ) => {
        edits.push({ text, messageId: id, markup: options?.reply_markup });
      },
    },
  } as never;
  return { ctx, replies, edits, answers };
}

const snapshot = {
  version: 'v4',
  tokenId: 11n,
  owner: WALLET,
  token0: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', name: 'Global Dollar', decimals: 6 },
  token1: { address: '0x72be1277e198d0c476869253cb4e62807e14533c', symbol: 'RAETO', name: 'RAETO', decimals: 18 },
  hasNative: false,
  fee: 3000,
  tickSpacing: 60,
  tickLower: -60,
  tickUpper: 60,
  liquidity: 1n,
  sqrtPriceX96: 2n ** 96n,
  tick: 0,
  price: 1,
  amount0: 1_000_000n,
  amount1: 2n,
  fees0: 0n,
  fees1: 0n,
  inRange: true,
} as never;

beforeEach(() => {
  detectPositions.mockReset();
  readPosition.mockReset();
  valuate.mockReset();

  detectPositions.mockResolvedValue({
    tokens: [{ version: 'v4', tokenId: 11n }],
    v4Source: 'indexer',
    scannedTo: 1,
  });
  readPosition.mockResolvedValue(snapshot);
  valuate.mockResolvedValue({ valueUsd: 42, principalUsd: 40, feesUsd: 1, lowerPrice: 0.9, upperPrice: 1.1, nearestDistancePct: 2 });
});

afterEach(async () => {
  for (const position of store.positionsFor(CHAT_ID)) await store.remove(position.id);
});

describe('running a detect scan', () => {
  it('posts a scanning message and edits it with the result', async () => {
    const { ctx, replies, edits } = fakeCtx();

    await runDetect(ctx);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain('Scanning wallet positions');
    expect(edits.at(-1)!.text).toContain('🧩 Found <b>1</b> LP NFT · v3 0 · v4 1');
    expect(edits.at(-1)!.text).toContain('📥 Untracked <b>1</b>');
  });

  it('re-renders into the same message on a rescan and asks for a fresh read', async () => {
    const { ctx, edits, answers } = fakeCtx(77);

    await handleDetectCallback(ctx, 'detect:rescan');

    expect(answers[0]?.text).toBe('Rescanning…');
    expect(detectPositions).toHaveBeenCalledWith(
      botAddress,
      expect.objectContaining({ refresh: true }),
    );
    // The scan renders into the message the button came from.
    expect(edits.some((e) => e.messageId === 77)).toBe(true);
    expect(edits.at(-1)!.text).toContain('🔍 <b>Detected positions</b>');
  });

  it('drops the stale buttons while the rescan runs', async () => {
    const { ctx, edits } = fakeCtx(77);

    await handleDetectCallback(ctx, 'detect:rescan');

    // The first edit is the scanning text: it must not keep the old keyboard,
    // whose buttons point at the previous list.
    const scanning = edits.find((e) => e.text.includes('Scanning wallet positions'));
    expect(scanning).toBeDefined();
    expect(scanning!.markup).toEqual({ inline_keyboard: [] });
  });

  it('reports a failed scan instead of leaving the message hanging', async () => {
    detectPositions.mockRejectedValue(new Error('rpc is down'));
    const { ctx, edits } = fakeCtx();

    await runDetect(ctx);

    expect(edits.at(-1)!.text).toContain('❌ Scan failed: rpc is down');
  });
});

describe('tracking a detected position', () => {
  it('adds it to the book and flips the row to tracked', async () => {
    const { ctx, replies, edits } = fakeCtx();

    await handleDetectCallback(ctx, 'detect:track:v4:11');

    expect(replies.some((r) => r.text.includes('📥 <b>Tracking'))).toBe(true);
    expect(store.positionsFor(CHAT_ID)).toHaveLength(1);
    expect(store.positionsFor(CHAT_ID)[0]!.tokenId).toBe('11');

    // The list is re-rendered: the position is no longer offered.
    const last = edits.at(-1)!.text;
    expect(last).toContain('📥 Untracked <b>0</b>');
    expect(last).toContain('✅ Every found position is already tracked.');
  });

  it('re-renders from the last scan instead of reading the chain again', async () => {
    const { ctx } = fakeCtx();
    await runDetect(ctx);
    const callsAfterScan = detectPositions.mock.calls.length;

    await handleDetectCallback(ctx, 'detect:track:v4:11');

    expect(detectPositions.mock.calls.length).toBe(callsAfterScan);
  });

  it('refuses a position that is already tracked', async () => {
    await store.add({
      chatId: CHAT_ID,
      version: 'v4',
      tokenId: '11',
      entry: { amount0: '0', amount1: '0', valueUsd: 10, price: 1, openedAt: Date.now() },
      basisUsd: 10,
      feesWithdrawnUsd: 0,
      compoundedFeesUsd: 0,
      alerts: true,
      autoCompound: false,
      compoundIntervalMs: 3_600_000,
      compoundMinFeeUsd: 1,
    });

    const { ctx, replies } = fakeCtx();
    await handleDetectCallback(ctx, 'detect:track:v4:11');

    expect(replies.some((r) => r.text.includes('already tracked'))).toBe(true);
    expect(store.positionsFor(CHAT_ID)).toHaveLength(1);
  });
});
