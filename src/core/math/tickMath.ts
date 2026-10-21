/**
 * Tick <-> price <-> sqrtPriceX96 conversions.
 *
 * The on-chain values (ticks, sqrtPriceX96) are exact; conversions to human
 * prices use double precision (relative error ~1e-15), which is far below any
 * slippage tolerance and only affects sizing/display. Minting always uses
 * integer ticks aligned to the pool's tick spacing.
 */

export const Q96 = 1n << 96n;
const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const LOG_1_0001 = Math.log(1.0001);

function clampTick(tick: number): number {
  return Math.max(MIN_TICK, Math.min(MAX_TICK, Math.trunc(tick)));
}

/** Raw (unadjusted) price of token0 in token1 units from a sqrt price. */
function sqrtRatioX96ToRawPrice(sqrtPriceX96: bigint): number {
  const sqrt = Number(sqrtPriceX96) / Number(Q96);
  return sqrt * sqrt;
}

/** Human price: token1 per 1 token0. */
export function sqrtRatioX96ToPrice(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const raw = sqrtRatioX96ToRawPrice(sqrtPriceX96);
  return raw * 10 ** (dec0 - dec1);
}

/** Inverse of `sqrtRatioX96ToPrice`. */
/** Human price at a tick (token1 per token0). */
export function tickToPrice(tick: number, dec0: number, dec1: number): number {
  return 1.0001 ** tick * 10 ** (dec0 - dec1);
}

/** Tick whose price is closest to the given human price. */
export function priceToTick(price: number, dec0: number, dec1: number): number {
  if (!Number.isFinite(price) || price <= 0) throw new Error('Price must be a positive number');
  const raw = price * 10 ** (dec1 - dec0);
  const tick = Math.log(raw) / LOG_1_0001;
  return clampTick(Math.round(tick));
}

/** Exact-enough sqrtPriceX96 at a tick (used for liquidity sizing). */
export function sqrtRatioX96AtTick(tick: number): bigint {
  const clamped = clampTick(tick);
  const sqrt = 1.0001 ** (clamped / 2);
  const scaled = sqrt * Number(Q96);
  if (scaled <= Number(MIN_SQRT_RATIO)) return MIN_SQRT_RATIO;
  if (scaled >= Number(MAX_SQRT_RATIO)) return MAX_SQRT_RATIO;
  return BigInt(Math.floor(scaled));
}

const normalizeZero = (n: number): number => (n === 0 ? 0 : n);

export function alignTickDown(tick: number, spacing: number): number {
  const t = Math.trunc(tick);
  return clampTick(normalizeZero(Math.floor(t / spacing) * spacing));
}

export function alignTickUp(tick: number, spacing: number): number {
  const t = Math.trunc(tick);
  return clampTick(normalizeZero(Math.ceil(t / spacing) * spacing));
}

interface TickRange {
  tickLower: number;
  tickUpper: number;
}

/**
 * Builds an aligned tick range from human prices of token0 in token1 units.
 * Enforces a non-empty range after alignment.
 */
export function tickRangeFromPrices(
  lowerPrice: number,
  upperPrice: number,
  dec0: number,
  dec1: number,
  spacing: number,
): TickRange {
  if (!(lowerPrice > 0) || !(upperPrice > 0)) throw new Error('Prices must be positive');
  const low = Math.min(lowerPrice, upperPrice);
  const high = Math.max(lowerPrice, upperPrice);
  if (low === high) throw new Error('Range is empty: lower and upper price are equal');

  let tickLower = alignTickDown(priceToTick(low, dec0, dec1), spacing);
  let tickUpper = alignTickUp(priceToTick(high, dec0, dec1), spacing);

  if (tickUpper <= tickLower) tickUpper = tickLower + spacing;
  if (tickUpper > MAX_TICK) {
    tickUpper = alignTickDown(MAX_TICK, spacing);
    if (tickUpper <= tickLower) tickLower = tickUpper - spacing;
  }
  return { tickLower: clampTick(tickLower), tickUpper: clampTick(tickUpper) };
}

/** Range around the current price, e.g. ±10%. */
export function tickRangeFromPercent(
  currentPrice: number,
  pctBelow: number,
  pctAbove: number,
  dec0: number,
  dec1: number,
  spacing: number,
): TickRange {
  const lower = currentPrice * (1 - pctBelow / 100);
  const upper = currentPrice * (1 + pctAbove / 100);
  return tickRangeFromPrices(lower, upper, dec0, dec1, spacing);
}

/** Full-range bounds aligned to the spacing. */
export function fullRangeTicks(spacing: number): TickRange {
  const maxUsable = Math.floor(MAX_TICK / spacing) * spacing;
  return { tickLower: -maxUsable, tickUpper: maxUsable };
}

/**
 * A range that sits entirely on one side of the live price, so the deposit is
 * funded in a single token.
 *
 * Uniswap takes `token0` when the price is at or above the upper bound, and
 * `token1` when it is at or below the lower bound. The bound that touches the
 * live price therefore has to be aligned *away* from it — down for the upper
 * bound, up for the lower one — or the range straddles the price and the mint
 * quietly demands both tokens.
 *
 * @param currentPrice the pool's price (token1 per token0)
 * @param pct width of the range as a percentage of the **traded token's** price
 * @param above true = range sits above the pool price (funded in token0),
 *              false = range sits below the pool price (funded in token1)
 * @param tradedIsToken0 which side of the pool the traded token is on. The
 *        pool price is the *inverse* of the token's own price when the token is
 *        token1, so the width has to be measured in the token's terms —
 *        otherwise a 50% range comes out as a 33% one.
 */
export function oneSidedTicks(
  currentPrice: number,
  pct: number,
  above: boolean,
  dec0: number,
  dec1: number,
  spacing: number,
  tradedIsToken0 = true,
): TickRange {
  if (!(pct > 0) || pct >= 100) throw new Error('One-sided width must be between 0 and 100%');
  const current = priceToTick(currentPrice, dec0, dec1);

  // The far end is the requested distance from the **live price** of the
  // traded token, and in the traded token's own terms — that is the price the
  // user reads and the price the range label shows. Adding the width to the
  // aligned near end instead would make the range narrower than it was asked
  // to be whenever the price does not sit exactly on a tick boundary — and
  // with a wide tick spacing (1000 ticks is 10.5% a step) a 50% range came
  // out as a 33% one.
  const tradedPrice = tradedIsToken0 ? currentPrice : 1 / currentPrice;
  const aboveInTradedTerms = tradedIsToken0 ? above : !above;
  const farTradedPrice = aboveInTradedTerms
    ? tradedPrice * (1 + pct / 100)
    : tradedPrice * (1 - pct / 100);
  const farPrice = tradedIsToken0 ? farTradedPrice : 1 / farTradedPrice;
  const far = priceToTick(farPrice, dec0, dec1);

  if (above) {
    // The range sits above the price: the near bound is aligned up, the far
    // bound is aligned up as well, so the range is at least as wide as asked.
    const tickLower = alignTickUp(current, spacing);
    const tickUpper = Math.max(tickLower + spacing, alignTickUp(far, spacing));
    return { tickLower, tickUpper: clampTick(tickUpper) };
  }
  // The range sits below the price: the near bound is the upper one, aligned
  // down; the far bound is aligned down as well.
  const tickUpper = alignTickDown(current, spacing);
  const tickLower = Math.min(tickUpper - spacing, alignTickDown(far, spacing));
  return { tickLower: clampTick(tickLower), tickUpper };
}

/**
 * Re-anchors a range to the live price.
 *
 * A range that is still valid is left alone. A one-sided range that the price
 * has moved into is moved with the market — the width is kept and the near
 * bound follows the price — so the mint stays one-sided. A two-sided range the
 * price has left is re-centred on the price. The result is always a valid,
 * spacing-aligned range.
 */
export function reanchorRange(
  range: { tickLower: number; tickUpper: number },
  currentTick: number,
  direction: 'up' | 'down' | 'both',
  spacing: number,
): { tickLower: number; tickUpper: number; changed: boolean } {
  const width = Math.max(spacing, range.tickUpper - range.tickLower);

  if (direction === 'up') {
    // The range has to stay above the market.
    if (range.tickLower > currentTick) return { ...range, changed: false };
    const near = alignTickUp(currentTick, spacing);
    return { tickLower: near, tickUpper: near + width, changed: true };
  }
  if (direction === 'down') {
    // The range has to stay below the market.
    if (range.tickUpper <= currentTick) return { ...range, changed: false };
    const near = alignTickDown(currentTick, spacing);
    return { tickLower: near - width, tickUpper: near, changed: true };
  }

  // A two-sided range is kept while the price is inside it.
  if (currentTick >= range.tickLower && currentTick < range.tickUpper) {
    return { ...range, changed: false };
  }
  const lower = alignTickDown(currentTick - Math.floor(width / 2), spacing);
  return { tickLower: lower, tickUpper: lower + width, changed: true };
}
