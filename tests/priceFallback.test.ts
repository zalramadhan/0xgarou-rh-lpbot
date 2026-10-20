import { describe, expect, it, vi } from 'vitest';

/**
 * A token whose only pool has an exotic fee tier and tick spacing (IGNITION:
 * 4.99%, spacing 1000) is not found by the standard probes. The price feed
 * used to come up empty for it, and the position then showed no PnL and no
 * fees at all — a position the bot holds, with money in it, that read as
 * "nothing".
 *
 * The pool the position is in always knows the rate between its two tokens,
 * so the missing side of the price is taken from there. These tests pin that
 * rule, including the case where nothing is known at all: an unknown price
 * must never turn into a zero, because a zero looks like a total loss and
 * would fire the stop loss.
 */
const usdPrice = vi.fn();
vi.mock('../src/core/prices.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/prices.js')>();
  return { ...actual, usdPrice };
});

const { valuate, summarizePnl } = await import('../src/core/valuation.js');
const { positionCard } = await import('../src/bot/ui.js');
const type = await import('../src/core/positions.js');
type PositionSnapshot = import('../src/core/positions.js').PositionSnapshot;

const IGNITION = '0x01E6301bc1118be90Cc6Bc2d1B5C0c44Bb883111';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

/** The live IGNITION/USDG position, as the chain reports it. */
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
  poolAddress: '0x0000000000000000000000000000000000000000',
  poolId: '0xd8034379e2714b380a320c737ccfa210b8bc85307af7732bb22cf1d1ed12e96d',
  hooks: '0x0000000000000000000000000000000000000000',
} as unknown as PositionSnapshot;

/** The feed knows USDG (it is the dollar) but not the token. */
function feedKnowsOnlyUsdg(): void {
  usdPrice.mockImplementation(async (address: string) =>
    address.toLowerCase() === USDG.toLowerCase() ? 1 : Number.NaN,
  );
}

describe('a position whose token has no price feed', () => {
  it('takes the missing price from the pool the position is in', async () => {
    feedKnowsOnlyUsdg();
    const valuation = await valuate(snapshot);

    // The pool's own rate: one IGNITION is worth 0.00100286 USDG.
    expect(valuation.price0Usd).toBeCloseTo(0.0010028615852785729, 12);
    expect(valuation.price1Usd).toBe(1);

    // 5334.92 IGNITION + 47.55 USDG, and the fees are valued too.
    expect(valuation.principalUsd).toBeCloseTo(52.897074, 5);
    expect(valuation.feesUsd).toBeCloseTo(0.282756, 5);
    expect(valuation.valueUsd).toBeCloseTo(53.17983, 4);
    expect(Number.isNaN(valuation.valueUsd)).toBe(false);
  });

  it('shows a PnL and fees instead of dashes', async () => {
    feedKnowsOnlyUsdg();
    const valuation = await valuate(snapshot);
    const pnl = summarizePnl(valuation, {
      basisUsd: 52.998729,
      feesWithdrawnUsd: 0,
      compoundedFeesUsd: 0,
      openedAt: Date.now() - 86_400_000,
    });

    expect(Number.isNaN(pnl.totalPnlUsd)).toBe(false);
    expect(pnl.totalPnlUsd).toBeCloseTo(0.181101, 5);
    expect(pnl.feesEarnedUsd).toBeCloseTo(0.282756, 5);

    const tracked = {
      id: 'p6',
      chatId: 1,
      version: 'v4',
      tokenId: '3924053',
      entry: { amount0: '0', amount1: '52998728', valueUsd: 52.998729, price: 0.0011147, openedAt: Date.now() - 86_400_000 },
      basisUsd: 52.998729,
      feesWithdrawnUsd: 0,
      compoundedFeesUsd: 0,
      alerts: true,
      autoCompound: false,
      compoundIntervalMs: 3_600_000,
      compoundMinFeeUsd: 1,
      tpCycles: 3,
      cycle: 1,
    } as never;

    const text = positionCard(tracked, snapshot, valuation, pnl);
    expect(text).toContain('Fees $0.28');
    expect(text).not.toContain('—');
  });

  it('keeps the value unknown when neither side has a price', async () => {
    // Nothing to derive from: an unknown value must stay unknown, never zero.
    usdPrice.mockImplementation(async () => Number.NaN);
    const valuation = await valuate(snapshot);
    expect(Number.isNaN(valuation.principalUsd)).toBe(true);
    expect(Number.isNaN(valuation.feesUsd)).toBe(true);
    expect(Number.isNaN(valuation.valueUsd)).toBe(true);
  });

  it('prefers the price feed over the pool rate', async () => {
    // The feed knows both sides: the pool rate must not override it.
    usdPrice.mockImplementation(async (address: string) =>
      address.toLowerCase() === USDG.toLowerCase() ? 1 : 0.5,
    );
    const valuation = await valuate(snapshot);
    expect(valuation.price0Usd).toBe(0.5);
  });
});
