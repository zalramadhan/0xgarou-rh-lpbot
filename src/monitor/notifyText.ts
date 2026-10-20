import type { PositionSnapshot } from '../core/positions.js';
import type { PnlSummary, Valuation } from '../core/valuation.js';
import type { ClosedRecord, TrackedPosition } from '../store/store.js';
import { esc, fmtPct, fmtSignedUsd, fmtUsd } from '../utils/format.js';
import { gasTotalUsd } from '../core/history.js';
import { fmtIdr } from '../core/fx.js';
import {
  holdsOnlyUsdg,
  marketCapLine,
  positionNumber,
  positionPair,
  priceRangeLine,
  RANGE_FRAME,
  rangeVisual,
} from '../bot/ui.js';
import { EXIT_LABEL, type ExitKind } from './exits.js';

interface RangeAlertInput {
  tracked: TrackedPosition;
  snapshot: PositionSnapshot;
  valuation: Valuation;
  /** FDV of the traded token, NaN when the indexer has none. */
  marketCapUsd: number;
  /** The position's PnL, so the alert can show it under the range. */
  pnl?: PnlSummary;
  /** USD → IDR rate, when the chat shows money in IDR. */
  idrRate?: number;
}

/**
 * Alert for a position that left its range.
 *
 *   🔴 TOKEN/USDG
 *   [■■■■■■■■■|□] OOR RIGHT
 *   🏦 MC $1.12M → $1.40M · now $1.48M
 *   📊 +$2.40 (+5.10%) · 💵 Rp 38.400
 *   📐 3.20% above the upper bound
 *
 *   🔄 Auto-rebalance ON · Cooldown pending
 */
export function outOfRangeNotification(input: RangeAlertInput): string {
  const { tracked, snapshot, valuation } = input;
  const visual = rangeVisual(valuation, snapshot);
  const side = visual.oor === 'right' ? 'RIGHT' : 'LEFT';

  const lines = [
    `🔴 ${esc(positionPair(snapshot))}`,
    RANGE_FRAME,
    `${visual.bar} ${visual.label}`,
  ];

  const marketCap = marketCapLine(snapshot, valuation, input.marketCapUsd);
  if (marketCap) lines.push(`🏦 ${marketCap}`);
  const priceRange = priceRangeLine(snapshot, valuation);
  if (priceRange) lines.push(priceRange);
  lines.push(RANGE_FRAME);

  if (input.pnl) {
    const pnlLine = `📊 ${fmtSignedUsd(input.pnl.totalPnlUsd)} (${fmtPct(input.pnl.totalPnlPct)})`;
    const idr =
      input.idrRate !== undefined && Number.isFinite(input.idrRate)
        ? fmtIdr(input.pnl.totalPnlUsd, input.idrRate)
        : undefined;
    lines.push(idr ? `${pnlLine} · ${idr}` : pnlLine);
  }

  lines.push(
    `📐 ${visual.distancePct.toFixed(2)}% ${side === 'RIGHT' ? 'above the upper bound' : 'below the lower bound'}`,
    '',
  );

  // The rebalance is manual: the alert says what can be done about it.
  lines.push('🔄 Rebalance is manual — tap Rebalance now, or close it from the panel below.');

  return lines.join('\n');
}

/**
 * Alert for a position that came back into its range.
 *
 *   🟢 TOKEN/USDG
 *   [■■■■■■■|□□□] 67% Left
 *   🏦 MC $1.12M → $1.40M · now $1.30M
 *   📐 3.20% from the nearest bound
 */
export function backInRangeNotification(input: RangeAlertInput): string {
  const { tracked, snapshot, valuation } = input;
  const visual = rangeVisual(valuation, snapshot);

  const lines = [
    `🟢 ${esc(positionPair(snapshot))}`,
    RANGE_FRAME,
    `${visual.bar} ${visual.label}`,
  ];

  const marketCap = marketCapLine(snapshot, valuation, input.marketCapUsd);
  if (marketCap) lines.push(`🏦 ${marketCap}`);
  const priceRange = priceRangeLine(snapshot, valuation);
  if (priceRange) lines.push(priceRange);
  lines.push(RANGE_FRAME);
  lines.push(`📐 ${visual.distancePct.toFixed(2)}% from the nearest bound`);

  return lines.join('\n');
}

interface ExitNotificationInput {
  kind: ExitKind;
  tracked: TrackedPosition;
  snapshot: PositionSnapshot;
  valuation: Valuation;
  pnl: PnlSummary;
  result: {
    reentered?: TrackedPosition;
    error?: string;
    swapNote?: string;
    txHash?: string;
  };
  /** The closed record, when it was written: it carries the real costs. */
  record?: ClosedRecord;
  /** Cycle that just closed. */
  cycle: number;
  /** Cycle limit for the auto-TP loop. */
  limit: number;
  dryRun: boolean;
  /** Explorer base URL, for the transaction link. */
  explorerUrl: string;
}

/**
 * The costs of a closed position: the gas of the whole round trip and the
 * PnL that is left after them.
 *
 * The gas is what the transactions actually cost. A dry run spent nothing, so
 * it says so; a cost that could not be measured says "unknown" instead of
 * being counted as zero.
 */
export function costLines(record: ClosedRecord | undefined): string[] {
  if (!record) return [];
  const lines: string[] = [];

  const open = record.openGasUsd;
  const close = record.closeGasUsd;
  const swap = record.swapGasUsd;
  const parts: string[] = [];
  if (open !== undefined) parts.push(`open ${fmtUsd(open)}`);
  else if (!record.dryRun) parts.push('open unknown');
  if (close !== undefined) parts.push(`close ${fmtUsd(close)}`);
  else if (!record.dryRun) parts.push('close unknown');
  if (swap !== undefined) parts.push(`swap ${fmtUsd(swap)}`);

  const total = gasTotalUsd(record);
  if (record.dryRun) {
    lines.push('⛽ Gas: not incurred (dry run)');
  } else if (Number.isFinite(total)) {
    lines.push(`⛽ Gas: ${fmtUsd(total)} (${parts.join(' + ')})`);
  } else {
    lines.push(`⛽ Gas: incomplete (${parts.join(' + ')})`);
  }

  if (record.swapFeeUsd !== undefined && Number.isFinite(record.swapFeeUsd)) {
    lines.push(`🏷 Provider fee ${fmtUsd(record.swapFeeUsd)} (already netted out of the received USDG)`);
  }

  if (record.pnlNetUsd !== undefined && Number.isFinite(record.pnlNetUsd)) {
    const gross = fmtSignedUsd(record.pnlUsd);
    lines.push(
      `📊 PnL after the costs: ${fmtSignedUsd(record.pnlNetUsd)} (${fmtPct(record.pnlNetPct ?? Number.NaN)}) · before the gas ${gross}`,
    );
  }
  return lines;
}

/**
 * Receipt for a closed position.
 *
 *   🎯 Take Profit · #1
 *   TOKEN/USDG · +40.00%
 *
 *   💰 Closed $52.40 · Fees $1.25
 *   ✅ Position closed · USDG recovered
 *   🔄 Re-entered as #7 · Cycle 3/3
 *   Same range width and allocation
 */
export function exitNotification(input: ExitNotificationInput): string {
  return exitNotificationLines(input).join('\n');
}

/** The same receipt as {@link exitNotification}, as separate lines. */
export function exitNotificationLines(input: ExitNotificationInput): string[] {
  const { kind, tracked, snapshot, valuation, pnl, result, cycle, limit, dryRun } = input;

  const lines = [
    `<b>${EXIT_LABEL[kind]} · ${positionNumber(tracked.id)}</b>`,
    `${esc(positionPair(snapshot))} · ${fmtPct(pnl.totalPnlPct)}`,
    '',
    `💰 Closed ${fmtUsd(valuation.valueUsd)} · Fees ${fmtUsd(valuation.feesUsd)}`,
  ];

  if (dryRun) {
    lines.push('🧪 Simulated (dry-run) — switch to LIVE in /settings to execute.');
  } else if (holdsOnlyUsdg(snapshot)) {
    lines.push('✅ Position closed · USDG recovered');
  } else {
    lines.push('✅ Position closed');
  }

  // The swap note only matters when the proceeds were not USDG already.
  if (result.swapNote && !result.swapNote.startsWith('🤝')) {
    lines.push(result.swapNote);
  }

  // The gas of the whole round trip and the PnL that is left after it.
  lines.push(...costLines(input.record));

  if (result.reentered) {
    lines.push(
      `🔄 Re-entered as <b>${positionNumber(result.reentered.id)}</b> · Cycle ${cycle + 1}/${limit}`,
      'Same range width and allocation',
    );
  } else if (kind === 'autoTakeProfit') {
    lines.push(`🏁 Cycle ${cycle}/${limit} was the last one — not re-entering.`);
  }

  if (result.error) {
    const reason = result.error.replace(/^re-entry failed:\s*/i, '');
    lines.push(`⚠️ Re-entry failed: ${esc(reason)}`);
  }

  if (result.txHash) {
    lines.push(`<a href="${input.explorerUrl}/tx/${result.txHash}">View transaction</a>`);
  }

  return lines;
}
