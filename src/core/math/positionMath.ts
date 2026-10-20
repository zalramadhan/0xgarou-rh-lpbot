import { getAmountsForLiquidity, maxLiquidityForAmounts } from './liquidityMath.js';
import { sqrtRatioX96AtTick, tickToPrice } from './tickMath.js';

interface RangeState {
  sqrtPriceX96: bigint;
  tick: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

interface RawAmounts {
  amount0: bigint;
  amount1: bigint;
}

/** Token amounts currently backing a position. */
export function positionAmounts(state: RangeState): RawAmounts {
  return getAmountsForLiquidity(
    state.sqrtPriceX96,
    sqrtRatioX96AtTick(state.tickLower),
    sqrtRatioX96AtTick(state.tickUpper),
    state.liquidity,
  );
}

/** Liquidity obtainable from token amounts at the current state. */
export function liquidityFromAmounts(
  sqrtPriceX96: bigint,
  tick: number,
  tickLower: number,
  tickUpper: number,
  amount0: bigint,
  amount1: bigint,
): bigint {
  void tick;
  return maxLiquidityForAmounts(
    sqrtPriceX96,
    sqrtRatioX96AtTick(tickLower),
    sqrtRatioX96AtTick(tickUpper),
    amount0,
    amount1,
  );
}

/** Amounts required for a given liquidity, used to build mint previews. */
export function amountsForLiquidity(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): RawAmounts {
  return getAmountsForLiquidity(
    sqrtPriceX96,
    sqrtRatioX96AtTick(tickLower),
    sqrtRatioX96AtTick(tickUpper),
    liquidity,
  );
}

export function isInRange(tick: number, tickLower: number, tickUpper: number): boolean {
  return tick >= tickLower && tick < tickUpper;
}

/** Width of a range in basis points of price, useful for "±x%" labels. */