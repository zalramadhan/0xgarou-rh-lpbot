import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zeroAddress } from 'viem';

/**
 * The home screen shows the open positions, so the user sees what they hold
 * without tapping anything: the token, the colour of its state, the range,
 * the market cap, the PnL and the fees.
 *
 * The menu must stay instant, so it draws the last view of every position
 * instead of reading the chain on every tap.
 */
const readPosition = vi.fn();
vi.mock('../src/core/positions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/positions.js')>();
  return { ...actual, readPosition };
});

const marketCapUsd = vi.fn();
vi.mock('../src/core/scanner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/scanner.js')>();
  return { ...actual, marketCapUsd };
});

const { showMenu, menuText, menuKeyboard } = await import('../src/bot/menu.js');
const { store } = await import('../src/store/store.js');
const { clearSession } = await import('../src/bot/session.js');
const { setLastView, getLastView, dropLastView } = await import('../src/core/positionViews.js');
const { valuate } = await import('../src/core/valuation.js');
type PositionSnapshot = import('../src/core/positions.js').PositionSnapshot;

const CHAT_ID = 777_030;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const IGNITION = '0x01E6301bc1118be90Cc6Bc2d1B5C0c44Bb883111';

const snapshot = {
  version: 'v4',
  tokenId: 3924053n,
  owner: '0xA934cb8Ae1cDd1b9eC532B83D901219e4169d48b',
  token0: { address: IGNITION, symbol: 'IGNITION', name: 'IGNITION', decimals: 18 },
  token1: { address: USDG, symbol: 'USDG', name: 'Global Dollar', decimals: 6 },
  hasNative: false,
  fee: 49900,
  keyFee: 49900,
  tickSpacing: 1000,
  tickLower: -350_000,
  tickUpper: -340_000,
  liquidity: 9060792770060643n,
  sqrtPriceX96: 1_278_346_572_758_239_747_207_527_829_081_407_476n,
  tick: -345_379,
  price: 0.0010028615852785729,
  amount0: 5_334_923_956_295_308_000_000n,
  amount1: 47_546_884n,
  fees0: 281_949_292_778_529_528_247n,
  fees1: 0n,
  inRange: true,
  poolAddress: zeroAddress,
  poolId: '0xd8034379e2714b380a320c737ccfa210b8bc85307af7732bb22cf1d1ed12e96d',
  hooks: zeroAddress,
} as unknown as PositionSnapshot;

function fakeCtx() {
  const edits: string[] = [];
  const replies: string[] = [];
  return {
    edits,
    replies,
    ctx: {
      chat: { id: CHAT_ID },
      answerCallbackQuery: async () => undefined,
      editMessageText: async (text: string) => {
        edits.push(text);
        return { message_id: 1 };
      },
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 1 };
      },
    } as never,
  };
}

let trackedId = '';

beforeEach(async () => {
  readPosition.mockResolvedValue(snapshot);
  marketCapUsd.mockResolvedValue(1_014_525);
  const tracked = await store.add({
    chatId: CHAT_ID,
    version: 'v4',
    tokenId: '3924053',
    entry: {
      amount0: '0',
      amount1: '52998728',
      valueUsd: 52.998729,
      price: 0.0011147,
      openedAt: Date.now() - 3_600_000,
    },
    basisUsd: 52.998729,
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
    range: { tickLower: -349_000, tickUpper: -345_000 },
  });
  trackedId = tracked.id;
});

afterEach(async () => {
  clearSession(CHAT_ID);
  for (const position of store.positionsFor(CHAT_ID)) await store.remove(position.id);
  dropLastView(trackedId);
  vi.clearAllMocks();
});

describe('the open positions on the home screen', () => {
  it('shows the token, the colour, the range, the market cap, the PnL and the fees', async () => {
    const { ctx, replies } = fakeCtx();
    await showMenu(ctx);
    const text = replies.join('\n');

    // The token and the colour of its state.
    expect(text).toContain('IGNITION/USDG');
    expect(text).toMatch(/🟢|🟠|🔴/);
    // The visual range.
    expect(text).toMatch(/\[[■□|]+\]/);
    // The market cap, with the two decimals and the comma.
    expect(text).toMatch(/MC \$[\d,]+,\d{2}[MK]? → \$[\d,]+,\d{2}[MK]? · now \$[\d,]+,\d{2}[MK]?/);
    // The PnL and the fees.
    expect(text).toContain('PnL');
    expect(text).toContain('Fees');
    expect(text).not.toContain('PnL —');
    expect(text).not.toContain('Fees —');
  });

  it('gives every open position a button', async () => {
    const { ctx } = fakeCtx();
    await showMenu(ctx);
    const views = new Map();
    views.set(trackedId, {
      snapshot,
      valuation: await valuate(snapshot),
      pnl: {
        feesEarnedUsd: 0.28,
        pendingFeesUsd: 0.28,
        withdrawnFeesUsd: 0,
        compoundedFeesUsd: 0,
        totalPnlUsd: 0.18,
        totalPnlPct: 0.34,
        aprPct: 155,
      },
      marketCapUsd: 1_014_525,
      at: Date.now(),
    });
    const buttons = menuKeyboard(store.settingsFor(CHAT_ID), store.positionsFor(CHAT_ID), views)
      .inline_keyboard.flat();
    const positionButton = buttons.find(
      (b) => (b as unknown as { callback_data?: string }).callback_data === `pos:show:${trackedId}`,
    );
    expect(positionButton).toBeDefined();
    expect(positionButton?.text).toContain('IGNITION/USDG');
  });

  it('draws the menu from the last view instead of reading the chain', async () => {
    // A cached view is enough: the home screen must not wait for the chain.
    const view = {
      snapshot,
      valuation: await valuate(snapshot),
      pnl: {
        feesEarnedUsd: 0.28,
        pendingFeesUsd: 0.28,
        withdrawnFeesUsd: 0,
        compoundedFeesUsd: 0,
        totalPnlUsd: 0.18,
        totalPnlPct: 0.34,
        aprPct: 155,
      },
      marketCapUsd: 1_014_525,
      at: Date.now(),
    };
    setLastView(trackedId, view);
    readPosition.mockClear();

    const { ctx, replies } = fakeCtx();
    await showMenu(ctx);

    expect(readPosition).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('IGNITION/USDG');
    expect(getLastView(trackedId)).toBeDefined();
  });

  it('says so when a position has no view yet, instead of breaking', () => {
    // Without a view the token is not even known, so the menu says that the
    // position is being read — it never shows a made-up number.
    const text = menuText(CHAT_ID);
    expect(text).toContain('the position is being read');
    expect(text).not.toContain('Fees —');
  });
});
