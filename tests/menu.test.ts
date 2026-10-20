import { afterEach, describe, expect, it, vi } from 'vitest';
import { zeroAddress } from 'viem';

// The wallet screen reads the chain and the price feeds. Mocking them keeps
// the test fast and free of rate limits.
vi.mock('../src/core/wallet.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/wallet.js')>();
  return { ...actual, erc20BalanceOf: async () => 1_000_000n, ethBalance: async () => 10n ** 18n };
});
vi.mock('../src/core/prices.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/prices.js')>();
  return { ...actual, usdPrice: async () => 1 };
});
import { handleMenuCallback, menuKeyboard, menuText, showMenu } from '../src/bot/menu.js';
import { helpText, walletText } from '../src/bot/screens.js';
import {
  amountKeyboard,
  confirmKeyboard,
  positionKeyboard,
  rangeKeyboard,
  settingsKeyboard,
  settingsText,
} from '../src/bot/ui.js';
import { scanKeyboard } from '../src/bot/poolList.js';
import { getSession, setSession, clearSession } from '../src/bot/session.js';
import { store } from '../src/store/store.js';
import type { ScannedPool, TokenScan } from '../src/core/scanner.js';
import type { TokenInfo } from '../src/core/tokens.js';
import type { V4Pool } from '../src/core/pools.js';
import type { TrackedPosition } from '../src/store/store.js';

const CHAT_ID = 777_001;

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

function v4Pool(): V4Pool {
  return {
    version: 'v4',
    poolId: `0x${'ab'.repeat(32)}` as `0x${string}`,
    key: { currency0: USDG.address, currency1: RAETO.address, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
    token0: USDG,
    token1: RAETO,
    fee: 3000,
    lpFee: 3000,
    tickSpacing: 60,
    sqrtPriceX96: 1n << 96n,
    tick: 0,
    liquidity: 10n ** 18n,
    price: 663,
    label: 'v4 0.3%',
  };
}

const scanned: ScannedPool = {
  pool: v4Pool(),
  tvlUsd: 60_000,
  volume24hUsd: 190_000,
  aprPct: 5_800,
  priceUsd: 0.0015,
  deviationPct: 0,
  health: 'ok',
};

const scan: TokenScan = {
  token: RAETO,
  pools: [scanned],
  listed: 1,
  totalTvlUsd: 60_000,
  marketCapUsd: 1_500_000,
  tvlToMcap: 0.04,
  referencePriceUsd: 0.0015,
};

const tracked: TrackedPosition = {
  id: 'p1',
  chatId: CHAT_ID,
  version: 'v4',
  tokenId: '1',
  entry: { amount0: '0', amount1: '0', valueUsd: 10, price: 1, openedAt: Date.now() },
  basisUsd: 10,
  feesWithdrawnUsd: 0,
  compoundedFeesUsd: 0,
  alerts: true,
  autoCompound: false,
  compoundIntervalMs: 3_600_000,
  compoundMinFeeUsd: 1,
  takeProfitPct: 30,
  createdAt: Date.now(),
};

function fakeCtx() {
  const edits: string[] = [];
  const replies: string[] = [];
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
      editMessageText: async (text: string) => {
        edits.push(text);
      },
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 1 };
      },
    } as never,
  };
}

afterEach(() => clearSession(CHAT_ID));

describe('main menu', () => {
  it('shows mode, wallet, counts and a call to action', () => {
    const text = menuText(CHAT_ID);
    expect(text).toContain('🏠 ROBINHOOD LP BOT');
    expect(text).toMatch(/🧪 Mode: <b>DRY-RUN<\/b>|⚡ Mode: <b>LIVE<\/b>/);
    expect(text).toContain('👛 Wallet:');
    expect(text).toContain('📊 Open positions: <b>0</b>');
    expect(text).toContain('👇 Pick an action:');
  });

  it('has every requested button wired to a menu callback', () => {
    const buttons = menuKeyboard().inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual([
      '🚀 Open position',
      '📅 Profit Calendar',
      '📊 Positions',
      '🔥 Top Trending',
      '💼 Portfolio',
      '🔍 Detect',
      '📜 History',
      '👛 Wallet',
      '⚙️ Settings',
      '📒 Address book',
      '📡 Status',
      'ℹ️ Help',
    ]);
    for (const button of buttons) {
      expect((button as unknown as { callback_data: string }).callback_data.startsWith('menu:')).toBe(true);
    }
  });

  it('has a button that switches the range alerts on and off', async () => {
    const settings = store.settingsFor(CHAT_ID);
    const buttons = menuKeyboard(settings).inline_keyboard.flat();
    const toggle = buttons.find((b) => (b as unknown as { callback_data?: string }).callback_data === 'menu:alerts');
    expect(toggle).toBeDefined();
    // The button says what it will do, the text says the state.
    expect(toggle?.text).toBe(settings.alertsEnabled ? '🔕 Range alerts off' : '🔔 Range alerts on');
    expect(menuText(CHAT_ID)).toContain('🔔 Range alerts:');

    const { ctx, edits } = fakeCtx();
    await handleMenuCallback(ctx, 'menu:alerts');
    expect(store.settingsFor(CHAT_ID).alertsEnabled).toBe(!settings.alertsEnabled);
    expect(edits.length).toBeGreaterThan(0);
  });

  it('is sent as a new message on /start', async () => {
    const { ctx, replies, edits } = fakeCtx();
    await showMenu(ctx);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('🏠 ROBINHOOD LP BOT');
    expect(edits).toHaveLength(0);
  });
});

describe('home navigation', () => {
  it('returns to the menu by editing the current message and dropping the flow', async () => {
    setSession(CHAT_ID, { step: 'range', token: RAETO, scan, page: 0, selected: 0, sort: 'tvl', hideBroken: false, side: 'both' });
    const { ctx, edits, replies } = fakeCtx();

    expect(await handleMenuCallback(ctx, 'menu:home')).toBe(true);

    expect(replies).toHaveLength(0);
    expect(edits[0]).toContain('🏠 ROBINHOOD LP BOT');
    expect(getSession(CHAT_ID)).toBeUndefined();
  });

  it('routes the other buttons without leaving the message', async () => {
    for (const action of ['positions', 'portfolio', 'history', 'wallet', 'settings', 'book', 'status', 'help']) {
      const { ctx, replies } = fakeCtx();
      expect(await handleMenuCallback(ctx, `menu:${action}`)).toBe(true);
      expect(replies).toHaveLength(0);
    }
  }, 30_000);

  it('opens the position flow when Open is tapped', async () => {
    const { ctx, replies } = fakeCtx();
    await handleMenuCallback(ctx, 'menu:open');
    expect(replies.some((text) => text.includes('🚀 <b>Open a position</b>'))).toBe(true);
  });
});

describe('every screen can go home', () => {
  const hasHome = (kb: { inline_keyboard: { text: string; callback_data?: string }[][] }) =>
    kb.inline_keyboard.flat().some((b) => b.text === '🏠 Menu' && b.callback_data === 'menu:home');

  it('adds the home button to position, range, amount, confirm and settings keyboards', () => {
    expect(hasHome(positionKeyboard('p1', tracked, true))).toBe(true);
    expect(hasHome(positionKeyboard('p1', tracked, false))).toBe(true);
    expect(hasHome(rangeKeyboard())).toBe(true);
    expect(hasHome(amountKeyboard())).toBe(true);
    expect(hasHome(confirmKeyboard())).toBe(true);
    expect(hasHome(settingsKeyboard(store.settingsFor(CHAT_ID)))).toBe(true);
    expect(hasHome(scanKeyboard(scan, 0))).toBe(true);
  });
});

describe('emoji-first text', () => {
  it('keeps every screen emoji-labelled', () => {
    expect(helpText()).toContain('ℹ️ <b>Help</b>');
    expect(helpText()).toContain('/menu');
    const settings = settingsText(store.settingsFor(CHAT_ID), undefined);
    expect(settings).toContain('⚙️ <b>Settings</b>');
    expect(settings).toContain('📊 Bid Ask entries:');
    expect(menuText(CHAT_ID)).toContain('────────────');
  });

  it('renders the wallet screen with balances and counters', async () => {
    const text = await walletText(CHAT_ID);
    expect(text).toContain('👛 <b>Wallet</b>');
    expect(text).toMatch(/🧪 Mode DRY-RUN|⚡ Mode LIVE/);
    expect(text).toContain('📊 Open positions:');
    expect(text).toContain('🎯 Armed exit rules:');
  });
});
