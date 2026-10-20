import { MAX_UINT128, Q128 } from '../../constants/chain.js';
import { Q96 } from './tickMath.js';

/** Integral of 1/sqrt(P) between two prices, times liquidity -> token0 amount. */
function getAmount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (liquidity <= 0n) return 0n;
  const [low, high] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (low === 0n) return 0n;
  return (liquidity * Q96 * (high - low)) / high / low;
}

/** Integral of sqrt(P) between two prices, times liquidity -> token1 amount. */
function getAmount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (liquidity <= 0n) return 0n;
  const [low, high] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  return (liquidity * (high - low)) / Q96;
}

/** Token amounts backing `liquidity` for a range, given the current sqrt price. */
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtLowerX96: bigint,
  sqrtUpperX96: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  if (liquidity <= 0n) return { amount0: 0n, amount1: 0n };
  if (sqrtLowerX96 > sqrtUpperX96) {
    [sqrtLowerX96, sqrtUpperX96] = [sqrtUpperX96, sqrtLowerX96];
  }
  if (sqrtPriceX96 <= sqrtLowerX96) {
    return { amount0: getAmount0ForLiquidity(sqrtLowerX96, sqrtUpperX96, liquidity), amount1: 0n };
  }
  if (sqrtPriceX96 < sqrtUpperX96) {
    return {
      amount0: getAmount0ForLiquidity(sqrtPriceX96, sqrtUpperX96, liquidity),
      amount1: getAmount1ForLiquidity(sqrtLowerX96, sqrtPriceX96, liquidity),
    };
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(sqrtLowerX96, sqrtUpperX96, liquidity) };
}

function getLiquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  if (amount0 <= 0n) return 0n;
  const [low, high] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  const intermediate = (low * high) / Q96;
  if (high === low) return 0n;
  return (amount0 * intermediate) / (high - low);
}

function getLiquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  if (amount1 <= 0n) return 0n;
  const [low, high] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (high === low) return 0n;
  return (amount1 * Q96) / (high - low);
}

/**
 * Largest liquidity mintable from the given token amounts at the current price.
 * Mirrors Uniswap's `LiquidityAmounts.getLiquidityForAmounts`.
 */
export function maxLiquidityForAmounts(
  sqrtPriceX96: bigint,
  sqrtLowerX96: bigint,
  sqrtUpperX96: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtLowerX96 > sqrtUpperX96) {
    [sqrtLowerX96, sqrtUpperX96] = [sqrtUpperX96, sqrtLowerX96];
  }
  let liquidity: bigint;
  if (sqrtPriceX96 <= sqrtLowerX96) {
    liquidity = getLiquidityForAmount0(sqrtLowerX96, sqrtUpperX96, amount0);
  } else if (sqrtPriceX96 < sqrtUpperX96) {
    const liquidity0 = getLiquidityForAmount0(sqrtPriceX96, sqrtUpperX96, amount0);
    const liquidity1 = getLiquidityForAmount1(sqrtLowerX96, sqrtPriceX96, amount1);
    liquidity = liquidity0 < liquidity1 ? liquidity0 : liquidity1;
  } else {
    liquidity = getLiquidityForAmount1(sqrtLowerX96, sqrtUpperX96, amount1);
  }
  return liquidity > MAX_UINT128 ? MAX_UINT128 : liquidity;
}

/** Fee growth inside a range, following Uniswap's unchecked uint256 arithmetic. */
export function feeGrowthInside(
  currentTick: number,
  tickLower: number,
  tickUpper: number,
  feeGrowthGlobal0X128: bigint,
  feeGrowthGlobal1X128: bigint,
  lowerOutside0X128: bigint,
  lowerOutside1X128: bigint,
  upperOutside0X128: bigint,
  upperOutside1X128: bigint,
): { inside0X128: bigint; inside1X128: bigint } {
  const wrap = (x: bigint) => ((x % (1n << 256n)) + (1n << 256n)) % (1n << 256n);
  let inside0: bigint;
  let inside1: bigint;
  if (currentTick < tickLower) {
    inside0 = wrap(lowerOutside0X128 - upperOutside0X128);
    inside1 = wrap(lowerOutside1X128 - upperOutside1X128);
  } else if (currentTick < tickUpper) {
    inside0 = wrap(feeGrowthGlobal0X128 - lowerOutside0X128 - upperOutside0X128);
    inside1 = wrap(feeGrowthGlobal1X128 - lowerOutside1X128 - upperOutside1X128);
  } else {
    inside0 = wrap(upperOutside0X128 - lowerOutside0X128);
    inside1 = wrap(upperOutside1X128 - lowerOutside1X128);
  }
  return { inside0X128: inside0, inside1X128: inside1 };
}

/**
 * Fees accrued since the last checkpoint:
 * liquidity * (feeGrowthInside - lastCheckpoint) / 2^128 + already-owed.
 */
export function accruedFees(
  liquidity: bigint,
  insideNowX128: bigint,
  insideLastX128: bigint,
  owed: bigint,
): bigint {
  if (liquidity <= 0n) return owed;
  const wrap = (x: bigint) => ((x % (1n << 256n)) + (1n << 256n)) % (1n << 256n);
  const delta = wrap(insideNowX128 - insideLastX128);
  return (liquidity * delta) / Q128 + owed;
}
