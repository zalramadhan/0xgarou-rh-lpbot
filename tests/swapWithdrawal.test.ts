import { describe, expect, it } from 'vitest';
import { withdrawnToken, withdrawnQuote, type PositionSnapshot } from '../src/core/positions.js';
import { routeDiscountPct } from '../src/core/swap.js';
import { marketPriceUsd, type Valuation } from '../src/core/valuation.js';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const IGNITION = '0x01E6301bc1118be90Cc6Bc2d1B5C0c44Bb883111';

/**
 * A position that held only USDG, with the fees it collected: the close
 * withdraws both, and the swap has to sell both.
 */
const snapshot = {
  version: 'v4',
  tokenId: 3925747n,
  owner: '0xA934cb8Ae1cDd1b9eC532B83D901219e4169d48b',
  token0: { address: IGNITION, symbol: 'IGNITION', name: 'IGNITION', decimals: 18 },
  token1: { address: USDG, symbol: 'USDG', name: 'Global Dollar', decimals: 6 },
  hasNative: false,
  fee: 49900,
  keyFee: 49900,
  tickSpacing: 1000,
  tickLower: -352_000,
  tickUpper: -345_000,
  liquidity: 9060792770060643n,
  sqrtPriceX96: 1_278_346_572_758_239_747_207_527_829_081_407_476n,
  tick: -344_554,
  price: 0.0010959249666466393,
  amount0: 8_107_600_000_000_000_000n,
  amount1: 46_482_863n,
  fees0: 1_457_467_313_017_149n,
  fees1: 0n,
  inRange: true,
  poolAddress: '0x0000000000000000000000000000000000000000',
  poolId: '0xd8034379e2714b380a320c737ccfa210b8bc85307af7732bb22cf1d1ed12e96d',
  hooks: '0x0000000000000000000000000000000000000000',
} as unknown as PositionSnapshot;

describe('what a close withdraws', () => {
  it('includes the fees the close collected', () => {
    // The swap used to sell the position's liquidity only, and left the fees
    // behind: 1,457 IGNITION, about $1.39, that never became USDG.
    const side = withdrawnToken(snapshot);
    expect(side?.token.symbol).toBe('IGNITION');
    expect(side?.amount).toBe(8_107_600_000_000_000_000n + 1_457_467_313_017_149n);
  });

  it('knows what the quote left in the wallet', () => {
    const quote = withdrawnQuote(snapshot);
    expect(quote?.token.symbol).toBe('USDG');
    expect(quote?.amount).toBe(46_482_863n);
  });

  it('prices the market from the live pool, not from the feed', () => {
    const valuation = {
      price0Usd: 0.001,
      price1Usd: 1,
      amount0Human: 9564.81,
      amount1Human: 46.48,
      fees0Human: 1.45,
      fees1Human: 0,
      feesUsd: 0.3,
      principalUsd: 52,
      valueUsd: 52,
      lowerPrice: 0.0005,
      upperPrice: 0.0014,
      nearestDistancePct: 0,
      distanceToLowerPct: 0,
      distanceToUpperPct: 0,
    } as unknown as Valuation;
    // IGNITION is token0 here, so the pool price is the token's own price.
    expect(marketPriceUsd(snapshot, valuation)).toBeCloseTo(0.0010959249666466393, 12);
  });
});

describe('a route that is priced below the market', () => {
  it('measures the discount', () => {
    expect(routeDiscountPct(0.99, 1)).toBeCloseTo(1, 6);
    expect(routeDiscountPct(0.97, 1)).toBeCloseTo(3, 6);
    // A better than market route is a negative discount.
    expect(routeDiscountPct(1.01, 1)).toBeCloseTo(-1, 6);
  });

  it('does not judge a route when a price is unknown', () => {
    expect(routeDiscountPct(Number.NaN, 1)).toBeNaN();
    expect(routeDiscountPct(1, Number.NaN)).toBeNaN();
    expect(routeDiscountPct(0, 1)).toBeNaN();
  });
});
