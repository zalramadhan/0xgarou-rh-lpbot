import type { CloseReason, ClosedRecord } from '../store/store.js';
import { gasTotalUsd } from '../core/history.js';
import type { CardChart, CardStrategy, PnlCardData } from './pnlCard.js';

/** The DEX the position traded on. */
const CARD_DEX = 'Robinhood';

/** "RAETO/USDG" — the traded token first, the USDG quote last. */
export function cardPairLabel(pair: string): string {
  const parts = pair.split('/').map((part) => part.trim());
  if (parts.length !== 2) return pair;
  const [left = '', right = ''] = parts;
  if (left.toUpperCase() === 'USDG') return `${right}/USDG`;
  if (right.toUpperCase() === 'USDG') return `${left}/USDG`;
  return pair;
}

/** The close reason, as it is written on the card. */
export function closeReasonLabel(reason: CloseReason | string): string {
  switch (reason) {
    case 'manual':
      return 'Manual';
    case 'takeProfit':
      return 'Take Profit';
    case 'stopLoss':
      return 'Stop Loss';
    case 'oorTakeProfit':
      return 'OOR TP';
    case 'autoTakeProfit':
      return 'Auto TP';
    case 'rebalance':
      return 'Rebalance';
    default:
      return String(reason);
  }
}

/**
 * The configured range, as percentages of the entry price.
 *
 *   "-20% to -10%"
 */
export function formatRangeLabel(lowerPrice: number, upperPrice: number, entryPrice: number): string {
  if (!Number.isFinite(lowerPrice) || !Number.isFinite(upperPrice) || !Number.isFinite(entryPrice)) {
    return '';
  }
  if (lowerPrice <= 0 || upperPrice <= 0 || entryPrice <= 0) return '';
  const low = Math.min(lowerPrice, upperPrice);
  const high = Math.max(lowerPrice, upperPrice);
  const pct = (price: number) => {
    const value = ((price / entryPrice) - 1) * 100;
    return `${value >= 0 ? '+' : ''}${Math.round(value)}%`;
  };
  return `${pct(low)} to ${pct(high)}`;
}

/** The chart, when the position's price path was recorded. */
function cardChart(record: ClosedRecord): CardChart | undefined {
  const samples = (record.priceSamples ?? []).filter(
    (sample) => Number.isFinite(sample.p) && Number.isFinite(sample.t),
  );
  const lower = record.rangePriceLower;
  const upper = record.rangePriceUpper;
  if (samples.length < 2) return undefined;
  if (lower === undefined || upper === undefined) return undefined;
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return undefined;
  return { samples, rangeLower: lower, rangeUpper: upper };
}

/** Builds the card data from a frozen closed-position record. */
export function cardDataFromRecord(record: ClosedRecord): PnlCardData {
  const basis = record.basisUsd ?? record.entryValueUsd;
  const strategy: CardStrategy = record.strategy ?? 'spot';
  return {
    pair: cardPairLabel(record.pair),
    reason: closeReasonLabel(record.reason),
    dex: CARD_DEX,
    pnlUsd: record.pnlUsd,
    pnlPct: record.pnlPct,
    currency: record.currency ?? 'USD',
    idrRate: record.idrRate,
    solRateUsd: record.solRateUsd ?? Number.NaN,
    initialUsd: Number.isFinite(basis) ? basis : Number.NaN,
    // The fees the position earned and the gas the round trip cost are two
    // different things: one is a gain, the other a cost.
    feesEarnedUsd: Number.isFinite(record.feesUsd) ? record.feesUsd : Number.NaN,
    gasUsd: gasTotalUsd(record),
    gasOpenUsd: record.openGasUsd ?? Number.NaN,
    gasCloseUsd: record.closeGasUsd ?? Number.NaN,
    gasSwapUsd: record.swapGasUsd ?? Number.NaN,
    pnlNetUsd: record.pnlNetUsd ?? Number.NaN,
    pnlNetPct: record.pnlNetPct ?? Number.NaN,
    dryRun: record.dryRun,
    entryMcapUsd: record.entryMcapUsd ?? Number.NaN,
    exitMcapUsd: record.exitMcapUsd ?? Number.NaN,
    rangeLabel: record.rangeLabel ?? '',
    strategy,
    openedAt: record.openedAt,
    closedAt: record.closedAt,
    contract: record.contract ?? '',
    chart: cardChart(record),
  };
}
