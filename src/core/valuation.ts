import { usdPrice } from './prices.js';
import { rangePrices, type PositionSnapshot } from './positions.js';
import { tradedRange } from './pairs.js';
import { pctChange } from '../utils/format.js';

export interface Valuation {
  amount0Human: number;
  amount1Human: number;
  price0Usd: number;
  price1Usd: number;
  principalUsd: number;
  fees0Human: number;
  fees1Human: number;
  feesUsd: number;
  valueUsd: number;
  lowerPrice: number;
  upperPrice: number;
  /** % move still available before the nearer bound; negative when out of range. */
  nearestDistancePct: number;
  distanceToLowerPct: number;
  distanceToUpperPct: number;
}

/** Values a position in USDG and measures how far price is from its bounds. */
export async function valuate(snapshot: PositionSnapshot): Promise<Valuation> {
  const [price0Usd, price1Usd] = await Promise.all([
    usdPrice(snapshot.token0.address),
    usdPrice(snapshot.token1.address),
  ]);
  const amount0Human = Number(snapshot.amount0) / 10 ** snapshot.token0.decimals;
  const amount1Human = Number(snapshot.amount1) / 10 ** snapshot.token1.decimals;
  const fees0Human = Number(snapshot.fees0) / 10 ** snapshot.token0.decimals;
  const fees1Human = Number(snapshot.fees1) / 10 ** snapshot.token1.decimals;

  // A token without a price feed makes the whole position unvaluable. It must
  // stay unknown (NaN) instead of collapsing to zero: a zero would look like a
  // total loss and would fire the stop loss. A side with no balance is worth
  // nothing whatever, so its price does not matter.
  const part = (amount: number, price: number): number =>
    amount === 0 ? 0 : Number.isFinite(amount * price) ? amount * price : Number.NaN;
  const principalUsd = part(amount0Human, price0Usd) + part(amount1Human, price1Usd);
  const feesUsd = part(fees0Human, price0Usd) + part(fees1Human, price1Usd);

  const { lower, upper } = rangePrices(snapshot);
  // The distances are measured in the traded token's own terms: that is the
  // price (and the market cap) the user reads the range against. A pool that
  // stores the traded token as token1 has the pool price inverted.
  const traded = tradedRange(snapshot, snapshot.price, lower, upper);
  const distanceToLowerPct = pctChange(traded.current, traded.lower);
  const distanceToUpperPct = pctChange(traded.current, traded.upper);

  // One denominator (the current price) for every case, so the distance does
  // not jump when the price crosses a bound.
  let nearestDistancePct: number;
  if (traded.current < traded.lower) nearestDistancePct = -Math.abs(distanceToLowerPct);
  else if (traded.current >= traded.upper) nearestDistancePct = -Math.abs(distanceToUpperPct);
  else nearestDistancePct = Math.min(Math.abs(distanceToLowerPct), Math.abs(distanceToUpperPct));

  return {
    amount0Human,
    amount1Human,
    price0Usd,
    price1Usd,
    principalUsd,
    fees0Human,
    fees1Human,
    feesUsd,
    valueUsd: principalUsd + feesUsd,
    lowerPrice: lower,
    upperPrice: upper,
    nearestDistancePct,
    distanceToLowerPct,
    distanceToUpperPct,
  };
}

/**
 * Cost basis for a tracked position.
 *
 * `basisUsd` is every dollar put in (initial deposit plus compounded fees).
 * `feesWithdrawnUsd` is every dollar of fees taken out to the wallet.
 * `compoundedFeesUsd` is the fee portion that stayed in the position; it is
 * informational (it is already part of the basis) and is used for fee APR.
 */
interface BasisInfo {
  basisUsd: number;
  feesWithdrawnUsd: number;
  compoundedFeesUsd: number;
  openedAt: number;
}

export interface PnlSummary {
  /** Pending + withdrawn + compounded since the position was opened. */
  feesEarnedUsd: number;
  pendingFeesUsd: number;
  withdrawnFeesUsd: number;
  compoundedFeesUsd: number;
  /** (principal + pending fees + withdrawn fees) - basis. */
  totalPnlUsd: number;
  totalPnlPct: number;
  /** Annualized fee income on the cost basis. */
  aprPct: number;
}

/**
 * Exact PnL from the cost basis:
 *   pnl = current principal + pending fees + fees already withdrawn - basis
 * Rebalances do not change the basis, so PnL stays continuous across them.
 */
export function summarizePnl(
  valuation: Valuation,
  basis: BasisInfo,
): PnlSummary {
  // An unknown value stays unknown: it must never look like a loss.
  const safe = (n: number) => (Number.isFinite(n) ? n : Number.NaN);
  const pendingFeesUsd = safe(valuation.feesUsd);
  const withdrawn = safe(basis.feesWithdrawnUsd);
  const compounded = safe(basis.compoundedFeesUsd);
  const basisUsd = safe(basis.basisUsd);

  const totalPnlUsd = safe(valuation.principalUsd) + pendingFeesUsd + withdrawn - basisUsd;
  const totalPnlPct = basisUsd > 0 ? (totalPnlUsd / basisUsd) * 100 : 0;

  const feesEarnedUsd = pendingFeesUsd + withdrawn + compounded;
  const days = Math.max((Date.now() - basis.openedAt) / 86_400_000, 1 / 24);
  const aprPct = basisUsd > 0 ? (feesEarnedUsd / basisUsd) * (365 / days) * 100 : 0;

  return {
    feesEarnedUsd,
    pendingFeesUsd,
    withdrawnFeesUsd: withdrawn,
    compoundedFeesUsd: compounded,
    totalPnlUsd,
    totalPnlPct,
    aprPct,
  };
}
