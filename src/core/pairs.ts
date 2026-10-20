import { TOKENS } from '../constants/chain.js';
import type { TokenInfo } from './tokens.js';

const USDG_ADDRESS = TOKENS.USDG.toLowerCase();

/** A pool's two sides, whatever order they are stored in. */
interface TokenPair {
  token0: TokenInfo;
  token1: TokenInfo;
}

function isUsdg(token: TokenInfo): boolean {
  return token.address.toLowerCase() === USDG_ADDRESS;
}

/** The traded side of the pair: the token that is not USDG. */
export function tradedToken(pair: TokenPair): TokenInfo {
  if (isUsdg(pair.token0)) return pair.token1;
  if (isUsdg(pair.token1)) return pair.token0;
  return pair.token0;
}

/** "TOKEN/USDG" — the traded token first, the USDG quote last. */
export function positionPair(pair: TokenPair): string {
  if (isUsdg(pair.token0)) return `${pair.token1.symbol}/USDG`;
  if (isUsdg(pair.token1)) return `${pair.token0.symbol}/USDG`;
  return `${pair.token0.symbol}/${pair.token1.symbol}`;
}

/**
 * The quote of a pair: the side the traded token is priced in.
 *
 * A pool without USDG has no stable quote, so the other token is used — the
 * price is then shown in that token, never in dollars.
 */
export function quoteToken(pair: TokenPair): TokenInfo {
  const traded = tradedToken(pair);
  return traded.address.toLowerCase() === pair.token0.address.toLowerCase() ? pair.token1 : pair.token0;
}

/**
 * Which way a one-sided range has to sit for the funded token.
 *
 * A position holds `token0` when the price is at or below its lower bound and
 * `token1` when the price is at or above its upper bound, so funding `token0`
 * puts the range above the market and funding `token1` puts it below.
 */
export function oneSidedDirection(pair: TokenPair, side: 'quote' | 'token'): 'up' | 'down' {
  const traded = tradedToken(pair);
  const tradedIsToken0 = traded.address.toLowerCase() === pair.token0.address.toLowerCase();
  const fundedIsToken0 = side === 'token' ? tradedIsToken0 : !tradedIsToken0;
  return fundedIsToken0 ? 'up' : 'down';
}

/**
 * The traded token's price, in quote per traded token.
 *
 * The pool price is `token1 per token0`; the traded token's own price is that
 * number when it is token0 and its inverse when it is token1.
 */
export function tradedPrice(pair: TokenPair, poolPrice: number): number {
  const traded = tradedToken(pair);
  const direct = traded.address.toLowerCase() === pair.token0.address.toLowerCase();
  return direct ? poolPrice : 1 / poolPrice;
}

/**
 * A specific token's price in the quote per token, from the pool price.
 *
 * The same inversion as {@link tradedPrice}, but for the token the user
 * asked about (the review screen works with a pasted token, which is not
 * always the pool's traded side).
 */
export function tokenPrice(pair: TokenPair, token: TokenInfo, poolPrice: number): number {
  const direct = token.address.toLowerCase() === pair.token0.address.toLowerCase();
  return direct ? poolPrice : 1 / poolPrice;
}

/**
 * The range in the traded token's own terms.
 *
 * The pool price is `token1 per token0`. When the traded token is token0 that
 * is its own price; when it is token1 the pool price is the *inverse* of it.
 * Every "left / right / in range" decision has to be made in these terms,
 * because that is what the user sees: the token's price and its market cap.
 * A pool that stores the traded token as token1 would otherwise report the
 * wrong side — "OOR LEFT" while the token is actually above the range.
 */
export interface TradedRange {
  /** The lower bound of the range, in quote per traded token. */
  lower: number;
  /** The upper bound of the range, in quote per traded token. */
  upper: number;
  /** The current price, in quote per traded token. */
  current: number;
  /** True when the traded token is token0: the pool price is its own price. */
  direct: boolean;
}

export function tradedRange(
  pair: TokenPair,
  poolPrice: number,
  lowerPrice: number,
  upperPrice: number,
): TradedRange {
  return rangeForToken(pair, tradedToken(pair), poolPrice, lowerPrice, upperPrice);
}

/**
 * The range in the terms of a specific token.
 *
 * The review screen knows which token the user pasted, which is not always
 * the pool's "traded" side (a pool without USDG has no quote at all).
 */
export function rangeForToken(
  pair: TokenPair,
  token: TokenInfo,
  poolPrice: number,
  lowerPrice: number,
  upperPrice: number,
): TradedRange {
  const direct = token.address.toLowerCase() === pair.token0.address.toLowerCase();
  if (direct) {
    return { lower: lowerPrice, upper: upperPrice, current: poolPrice, direct };
  }
  // The token is token1: its price is the inverse of the pool price, so the
  // bounds swap as well.
  return {
    lower: 1 / upperPrice,
    upper: 1 / lowerPrice,
    current: 1 / poolPrice,
    direct: false,
  };
}
