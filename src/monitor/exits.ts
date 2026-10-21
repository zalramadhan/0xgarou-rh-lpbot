import type { Address } from 'viem';
import { TOKENS } from '../constants/chain.js';
import { closePosition } from '../core/actions.js';
import { recordClose, swapAccounting, withSwap } from '../core/history.js';
import { withdrawnQuote, withdrawnToken, type PositionSnapshot } from '../core/positions.js';
import { reenterSameRange } from '../core/strategy.js';
import { swapProceedsToUsdg, type SwapOutcome } from '../core/swap.js';
import { usdPrice } from '../core/prices.js';
import { marketPriceUsd, type PnlSummary, type Valuation } from '../core/valuation.js';
import {
  store,
  type ChatSettings,
  type ClosedRecord,
  type CloseReason,
  type TrackedPosition,
} from '../store/store.js';
import { createLogger } from '../logger.js';

const log = createLogger('exits');

/** `manual` never fires from the monitor; it is the user pressing Close. */
export type ExitKind = 'manual' | 'takeProfit' | 'stopLoss' | 'oorTakeProfit' | 'autoTakeProfit';

interface ExitInputs {
  /** PnL as a percentage of the cost basis. */
  pnlPct: number;
  /** Current price is above the position's upper bound. */
  aboveRange: boolean;
  takeProfitPct?: number;
  stopLossPct?: number;
  oorTakeProfit?: boolean;
  autoTakeProfit?: boolean;
  autoTpTargetPct: number;
}

/**
 * Which armed rule should fire this tick, if any. Stop loss is checked first,
 * then the OOR-right take profit, then the explicit TP, and finally auto-TP
 * (which re-enters instead of stopping).
 */
export function decideExit(input: ExitInputs): ExitKind | undefined {
  if (!Number.isFinite(input.pnlPct)) return undefined;
  if (input.stopLossPct !== undefined && input.pnlPct <= input.stopLossPct) return 'stopLoss';
  if (input.oorTakeProfit && input.aboveRange) return 'oorTakeProfit';
  if (input.takeProfitPct !== undefined && input.pnlPct >= input.takeProfitPct) return 'takeProfit';
  if (input.autoTakeProfit && input.pnlPct >= input.autoTpTargetPct) return 'autoTakeProfit';
  return undefined;
}

export const EXIT_LABEL: Record<ExitKind, string> = {
  manual: '🔒 Manual Close',
  takeProfit: '🎯 Take Profit',
  stopLoss: '🛑 Stop Loss',
  oorTakeProfit: '📈 OOR Take Profit',
  autoTakeProfit: '⚡ Auto-TP',
};

interface ExitResult {
  closed: boolean;
  reason: ExitKind;
  error?: string;
  txHash?: string;
  recordId?: string;
  /** The frozen close record, with the costs it measured. */
  record?: ClosedRecord;
  cycle?: number;
  reentered?: TrackedPosition;
  swapNote?: string;
}

/**
 * What the close put in the wallet: the token the swap sells, and the quote
 * that stays there.
 *
 * The close withdraws the position's amounts **and** the fees it collected, so
 * both sides are worth counting. The quote stayed in the wallet, and the fees
 * on the token side are part of what the position was worth. Leaving them out
 * made a close with a swap look like a total loss: the money was in the
 * wallet, but the PnL did not count it.
 */
function withdrawal(
  snapshot: PositionSnapshot,
  valuation: Valuation,
): { tokenAmount: bigint; quoteUsd: number } {
  const side = withdrawnToken(snapshot);
  const quote = withdrawnQuote(snapshot);
  if (!side || !quote) return { tokenAmount: 0n, quoteUsd: Number.NaN };
  const quoteIsToken0 = quote.token.address.toLowerCase() === snapshot.token0.address.toLowerCase();
  const quoteAmount = quoteIsToken0 ? valuation.amount0Human : valuation.amount1Human;
  const quoteFees = quoteIsToken0 ? valuation.fees0Human : valuation.fees1Human;
  const quotePrice = quoteIsToken0 ? valuation.price0Usd : valuation.price1Usd;
  const quoteTotal = (quoteAmount + quoteFees) * quotePrice;
  return {
    tokenAmount: side.amount,
    quoteUsd: Number.isFinite(quoteTotal) ? quoteTotal : Number.NaN,
  };
}

/** Swaps the position's own token proceeds into USDG, best effort. */
async function autoSwap(
  snapshot: PositionSnapshot,
  owner: Address,
  settings: ChatSettings,
  valuation: Valuation,
  key: string,
): Promise<{ note: string; outcome?: SwapOutcome }> {
  // The whole withdrawal, fees included: the close collected them, so they
  // are part of what the swap can turn into USDG.
  const side = withdrawnToken(snapshot);
  if (!side) return { note: '🤝 Both sides are USDG — nothing to swap.' };
  if (side.amount <= 0n) return { note: '🤏 Nothing to swap.' };

  // An amount below the threshold is left in the wallet: the gas of the swap
  // would cost more than the swap is worth.
  const priceUsd =
    side.token.address.toLowerCase() === snapshot.token0.address.toLowerCase()
      ? valuation.price0Usd
      : valuation.price1Usd;
  const valueUsd = (Number(side.amount) / 10 ** side.token.decimals) * priceUsd;
  if (!Number.isFinite(valueUsd)) {
    return {
      note: `⚠️ Could not price ${side.token.symbol} — the tokens stayed in your wallet.`,
    };
  }
  const threshold = settings.autoSwapMinUsd;
  if (valueUsd < threshold) {
    return {
      note: `🏏 ${side.token.symbol} proceeds are below $${threshold.toFixed(2)} — the tokens stayed in your wallet.`,
    };
  }

  const outcome = await swapProceedsToUsdg({
    token: side.token,
    amount: side.amount,
    owner,
    slippagePct: settings.slippagePct,
    dryRun: settings.dryRun,
    key,
    valueUsd,
    minUsd: threshold,
    // USDG is the USD unit of this chain, so it is worth one dollar.
    buyTokenUsd: 1,
    // The live market price, so a route that is priced far below it is
    // refused instead of taken.
    sellTokenUsd: marketPriceUsd(snapshot, valuation),
    maxDiscountPct: settings.maxRouteDiscountPct,
  });
  return { note: outcome.note, outcome };
}

/**
 * The auto-swap only runs for a live close that is **not** about to re-enter:
 * the re-entry needs the very tokens the swap would sell.
 */
export function shouldAutoSwap(input: {
  enabled: boolean;
  dryRun: boolean;
  canReenter: boolean;
}): boolean {
  return input.enabled && !input.dryRun && !input.canReenter;
}

interface ExitParams {
  tracked: TrackedPosition;
  snapshot: PositionSnapshot;
  valuation: Valuation;
  pnl: PnlSummary;
  settings: ChatSettings;
  owner: Address;
  reason: ExitKind;
  /**
   * Skip the automatic swap. A manual close asks the user what to do with
   * the withdrawn tokens, so the swap must not happen behind their back.
   */
  skipAutoSwap?: boolean;
}

/**
 * Executes an exit: close, freeze a history record, swap proceeds when armed,
 * then either re-enter (auto-TP within the cycle limit) or stop tracking.
 */
export async function performExit(params: ExitParams): Promise<ExitResult> {
  const { tracked, snapshot, valuation, pnl, settings, owner, reason } = params;
  const dryRun = settings.dryRun;

  const closed = await closePosition({
    snapshot,
    slippagePct: settings.slippagePct,
    recipient: owner,
    dryRun,
  });
  if (closed.error) return { closed: false, reason, error: closed.error };

  const cycle = tracked.cycle ?? 1;
  const limit = tracked.tpCycles ?? settings.tpCycleLimit;
  const cycleOnRecord = reason === 'autoTakeProfit';
  const canReenter = cycleOnRecord && cycle < limit;

  // The auto-swap would swap away the tokens the re-entry needs, so it only
  // runs when the position is not going to be re-entered.
  let swapNote: string | undefined;
  let swapOutcome: SwapOutcome | undefined;
  if (
    !params.skipAutoSwap &&
    shouldAutoSwap({ enabled: settings.autoSwapToUsdg, dryRun, canReenter })
  ) {
    const swap: { note: string; outcome?: SwapOutcome } = await autoSwap(
      snapshot,
      owner,
      settings,
      valuation,
      tracked.id,
    ).catch((err) => ({ note: `⚠️ Swap failed: ${String(err)}` }));
    swapNote = swap.note;
    swapOutcome = swap.outcome;
  }

  let recordId: string | undefined;
  let closedRecord: ClosedRecord | undefined;
  if (!dryRun) {
    const record = await recordClose({
      tracked,
      snapshot,
      valuation,
      pnl,
      reason,
      dryRun,
      txHash: closed.hash,
      currency: settings.currency,
    });
    recordId = record.id;
    closedRecord = record;

    // The swap happened before the record was written, so what it cost and
    // what it delivered are added to the record now.
    if (swapOutcome) {
      // A swap that failed still cost its gas, so the record is updated for
      // it as well.
      const side = withdrawnToken(snapshot);
      const ethPriceUsd = await usdPrice(TOKENS.WETH).catch(() => Number.NaN);
      const taken = withdrawal(snapshot, valuation);
      const accounting = swapAccounting(swapOutcome, {
        withdrawnAmount: taken.tokenAmount,
        decimals: side?.token.decimals ?? 18,
        ethPriceUsd,
        exitPrice: record.exitPrice,
        // The quote that stayed in the wallet is part of the position's value.
        quoteUsd: taken.quoteUsd,
      });
      closedRecord = (await store.updateClosed(record.id, withSwap(record, accounting))) ?? record;
    }
  }

  if (dryRun) {
    return {
      closed: true,
      reason,
      txHash: closed.hash,
      recordId,
      record: closedRecord,
      cycle,
      swapNote,
      reentered: undefined,
    };
  }

  if (canReenter) {
    try {
      const reentry = await reenterSameRange(snapshot, {
        owner,
        dryRun: false,
        slippagePct: settings.slippagePct,
      });
      if (reentry.outcome.error) throw new Error(reentry.outcome.error);
      const tokenId = reentry.outcome.tokenId;
      if (!tokenId) throw new Error('re-entry minted no visible tokenId');

      const fresh = await store.add({
        chatId: tracked.chatId,
        version: snapshot.version,
        tokenId: tokenId.toString(),
        entry: {
          amount0: reentry.amount0.toString(),
          amount1: reentry.amount1.toString(),
          valueUsd: valuation.principalUsd,
          price: snapshot.price,
          openedAt: Date.now(),
          txHash: reentry.outcome.hash,
        },
        basisUsd: valuation.principalUsd,
        feesWithdrawnUsd: 0,
        compoundedFeesUsd: 0,
        alerts: tracked.alerts,
        autoCompound: tracked.autoCompound,
        compoundIntervalMs: tracked.compoundIntervalMs,
        compoundMinFeeUsd: tracked.compoundMinFeeUsd,
        takeProfitPct: tracked.takeProfitPct,
        stopLossPct: tracked.stopLossPct,
        autoTakeProfit: true,
        tpCycles: limit,
        cycle: cycle + 1,
        oorTakeProfit: tracked.oorTakeProfit,
        range: { tickLower: reentry.tickLower, tickUpper: reentry.tickUpper },
        // The card of the next cycle needs these too.
        entryMcapUsd: tracked.entryMcapUsd,
        rangeLabel: tracked.rangeLabel,
        strategy: tracked.strategy,
        contract: tracked.contract,
        priceSamples: tracked.priceSamples,
      });
      await store.update(tracked.id, { closedReason: reason });
      await store.remove(tracked.id);
      log.info(`auto-TP cycle ${cycle}→${cycle + 1} for chat ${tracked.chatId}: ${tracked.id} → ${fresh.id}`);
      return {
        closed: true,
        reason,
        txHash: closed.hash,
        recordId,
        record: closedRecord,
        cycle,
        swapNote,
        reentered: fresh,
      };
    } catch (err) {
      // The close already landed; report the re-entry failure instead of hiding it.
      await store.update(tracked.id, { closedReason: reason });
      await store.remove(tracked.id);
      return {
        closed: true,
        reason,
        txHash: closed.hash,
        recordId,
        record: closedRecord,
        cycle,
        swapNote,
        error: `re-entry failed: ${String(err)}`,
      };
    }
  }

  await store.update(tracked.id, { closedReason: reason });
  await store.remove(tracked.id);
  return { closed: true, reason, txHash: closed.hash, recordId, record: closedRecord, cycle, swapNote };
}
