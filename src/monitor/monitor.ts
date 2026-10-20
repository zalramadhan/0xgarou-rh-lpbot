import { InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { botAddress } from '../chain/client.js';
import { readPosition } from '../core/positions.js';
import { compoundFees, rebalancePosition } from '../core/strategy.js';
import { summarizePnl, valuate } from '../core/valuation.js';
import { EXIT_LABEL, decideExit, performExit } from './exits.js';
import { backInRangeNotification, exitNotification, outOfRangeNotification } from './notifyText.js';
import { store, type ChatSettings, type TrackedPosition } from '../store/store.js';
import { createLogger } from '../logger.js';
import { esc, fmtDuration, fmtUsd } from '../utils/format.js';
import { errorMessage } from '../utils/errors.js';
import { mapLimit } from '../utils/async.js';
import { notify } from '../bot/notify.js';
import { positionNumber, tradedToken } from '../bot/ui.js';
import { tradedRange } from '../core/pairs.js';
import { marketCapUsd as fetchMarketCap } from '../core/scanner.js';
import { usdIdrRate } from '../core/fx.js';
import { txLock } from '../bot/locks.js';

const log = createLogger('monitor');

const EXIT_RETRY_MS = 5 * 60_000;
/** A simulated exit is not repeated every few minutes either. */
const DRY_RUN_EXIT_RETRY_MS = 30 * 60_000;
const COMPOUND_COOLDOWN_MS = 10 * 60_000;
const REBALANCE_COOLDOWN_MS = 5 * 60_000;
const DRY_RUN_COOLDOWN_MS = 30 * 60_000;
/** How often a price sample is taken for the PnL card. */
const SAMPLE_INTERVAL_MS = 5 * 60_000;
/** How many samples a position keeps; the oldest are dropped first. */
const MAX_SAMPLES = 240;

/**
 * Appends a price sample for the PnL card, at most one per interval and never
 * more than the cap.
 */
export function nextPriceSamples(
  tracked: TrackedPosition,
  price: number,
  now = Date.now(),
): { t: number; p: number }[] | undefined {
  if (!Number.isFinite(price)) return undefined;
  const samples = tracked.priceSamples ?? [];
  const last = samples[samples.length - 1];
  if (last && now - last.t < SAMPLE_INTERVAL_MS) return undefined;
  return [...samples, { t: now, p: price }].slice(-MAX_SAMPLES);
}

/** The keyboard under an out-of-range / back-in-range alert. */
export function alertKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('🧾 Details', `pos:show:${id}`)
    .text('🔄 Refresh', `act:refresh:${id}`)
    .row()
    .text('🔁 Rebalance now', `act:rebalance:${id}`)
    .text('🔒 Close', `act:close:${id}`);
}

async function checkPosition(tracked: TrackedPosition): Promise<void> {
  const settings = store.settingsFor(tracked.chatId);
  const snapshot = await readPosition(tracked.version, BigInt(tracked.tokenId));
  if (!snapshot) {
    if (tracked.alerts) {
      await notify(tracked.chatId, `⚪ <b>${positionNumber(tracked.id)}</b> is gone — burned or transferred. Untracking it.`);
    }
    await store.remove(tracked.id);
    return;
  }

  const valuation = await valuate(snapshot);
  const wasInRange = tracked.lastInRange;
  const stateChanged = wasInRange !== snapshot.inRange;
  if (stateChanged) await store.update(tracked.id, { lastInRange: snapshot.inRange });

  // Record the price path for the PnL card.
  const samples = nextPriceSamples(tracked, snapshot.price);
  if (samples) {
    tracked = { ...tracked, priceSamples: samples };
    await store.update(tracked.id, { priceSamples: samples });
  }

  // Alert when a position goes out of range, or comes back after being out.
  // The very first observation only alerts if it is already out of range.
  const enteredOut = !snapshot.inRange && wasInRange !== false;
  const enteredIn = snapshot.inRange && wasInRange === false;

  if ((enteredOut || enteredIn) && tracked.alerts && settings.alertsEnabled) {
    // The market cap is only needed for the alert, so it is fetched here
    // instead of on every tick.
    const marketCap = await fetchMarketCap(tradedToken(snapshot)).catch(() => Number.NaN);
    // The alert shows the PnL under the range, so the position is summarized
    // here as well.
    const pnl = summarizePnl(valuation, {
      basisUsd: tracked.basisUsd,
      feesWithdrawnUsd: tracked.feesWithdrawnUsd,
      compoundedFeesUsd: tracked.compoundedFeesUsd,
      openedAt: tracked.entry.openedAt,
    });
    const idrRate = await usdIdrRate().catch(() => Number.NaN);
    const alert = { tracked, snapshot, valuation, marketCapUsd: marketCap, pnl, idrRate };
    if (enteredIn) {
      await notify(tracked.chatId, backInRangeNotification(alert), alertKeyboard(tracked.id));
    } else {
      await notify(tracked.chatId, outOfRangeNotification(alert), alertKeyboard(tracked.id));
    }
  }

  const owner = botAddress;
  const canTrade = Boolean(owner) && !snapshot.hasNative;

  // Exits run before any other automation: a position that reached its exit
  // must be closed, never rebalanced or compounded.
  const armed =
    tracked.takeProfitPct !== undefined ||
    tracked.stopLossPct !== undefined ||
    tracked.autoTakeProfit ||
    tracked.oorTakeProfit;
  if (armed && canTrade && owner) {
    const pnl = summarizePnl(valuation, {
      basisUsd: tracked.basisUsd,
      feesWithdrawnUsd: tracked.feesWithdrawnUsd,
      compoundedFeesUsd: tracked.compoundedFeesUsd,
      openedAt: tracked.entry.openedAt,
    });
    // "Above the range" means the traded token's price is above the upper
    // bound — the position then holds only the token. The pool price is
    // inverted for a pool that stores the traded token as token1.
    const traded = tradedRange(snapshot, snapshot.price, valuation.lowerPrice, valuation.upperPrice);
    const decision = decideExit({
      pnlPct: pnl.totalPnlPct,
      aboveRange: traded.current >= traded.upper,
      takeProfitPct: tracked.takeProfitPct,
      stopLossPct: tracked.stopLossPct,
      oorTakeProfit: tracked.oorTakeProfit,
      autoTakeProfit: tracked.autoTakeProfit,
      autoTpTargetPct: settings.autoTpTargetPct,
    });
    const since = tracked.lastExitAt ? Date.now() - tracked.lastExitAt : Number.POSITIVE_INFINITY;

    const retryMs = settings.dryRun ? DRY_RUN_EXIT_RETRY_MS : EXIT_RETRY_MS;
    if (decision && since >= retryMs) {
      await txLock.run(`chat:${tracked.chatId}`, async () => {
        try {
          const result = await performExit({
            tracked,
            snapshot,
            valuation,
            pnl,
            settings,
            owner,
            reason: decision,
          });
          if (result.error && !result.closed) throw new Error(result.error);

          const label = EXIT_LABEL[decision];
          const cycle = tracked.cycle ?? 1;
          const limit = tracked.tpCycles ?? settings.tpCycleLimit;
          const text = exitNotification({
            kind: decision,
            tracked,
            snapshot,
            valuation,
            pnl,
            result,
            record: result.record,
            cycle,
            limit,
            dryRun: settings.dryRun,
            explorerUrl: config.explorerUrl,
          });

          if (settings.dryRun) await store.update(tracked.id, { lastExitAt: Date.now() });
          await notify(tracked.chatId, text);
        } catch (err) {
          await store.update(tracked.id, { lastExitAt: Date.now() });
          log.error(`exit automation failed for ${tracked.id}`, err);
          await notify(
            tracked.chatId,
            `⚠️ ${EXIT_LABEL[decision]} failed for <b>${positionNumber(tracked.id)}</b>: ${esc(errorMessage(err))}`,
          );
        }
      });
      return;
    }
  }

  if (tracked.autoCompound && canTrade && owner && snapshot.inRange) {
    const since = tracked.lastCompoundAt ? Date.now() - tracked.lastCompoundAt : Number.POSITIVE_INFINITY;
    const due = since >= tracked.compoundIntervalMs;
    const worthIt = valuation.feesUsd >= tracked.compoundMinFeeUsd;
    if (due && worthIt) {
      await txLock.run(`chat:${tracked.chatId}`, async () => {
        try {
          const result = await compoundFees(snapshot, valuation.feesUsd, {
            owner,
            dryRun: settings.dryRun,
            slippagePct: settings.slippagePct,
          });
          if (result.outcome.error) throw new Error(result.outcome.error);
          await store.update(tracked.id, {
            lastCompoundAt: Date.now(),
            // Compounded fees become part of the position, so both the basis
            // and the compounded counter grow by the same amount.
            ...(result.outcome.dryRun
              ? {}
              : {
                  basisUsd: tracked.basisUsd + result.compoundedUsd,
                  compoundedFeesUsd: tracked.compoundedFeesUsd + result.compoundedUsd,
                }),
          });
          await notify(
            tracked.chatId,
            result.outcome.dryRun
              ? `🧪 Auto-compound for <b>${positionNumber(tracked.id)}</b> simulated: ${fmtUsd(result.compoundedUsd)} (dry-run).`
              : `💧 Auto-compounded <b>${fmtUsd(result.compoundedUsd)}</b> of fees into <b>${positionNumber(tracked.id)}</b>.`,
          );
        } catch (err) {
          log.error(`auto-compound failed for ${tracked.id}`, err);
          await notify(tracked.chatId, `⚠️ Auto-compound of <b>${positionNumber(tracked.id)}</b> failed: ${esc(errorMessage(err))}`);
        }
      });
    } else if (due && !worthIt) {
      // The fees are just below the floor: the timer is not reset, so the next
      // tick tries again instead of waiting a whole interval.
      log.debug(`auto-compound skipped for ${tracked.id}: fees below the floor`);
    }
  }
}

/** One full pass over tracked positions; also used by scripts/smoke.ts. */
export async function runMonitorOnce(): Promise<void> {
  await tick();
}

/**
 * Whether a position can do anything at all this tick.
 *
 * A position with no armed rule, no auto-rebalance, no compound due and no
 * alerts cannot change, so reading it from the chain would only burn RPC calls.
 */
function needsAttention(tracked: TrackedPosition, settings: ChatSettings, now: number): boolean {
  if (tracked.alerts && settings.alertsEnabled) return true;
  if (tracked.takeProfitPct !== undefined || tracked.stopLossPct !== undefined) return true;
  if (tracked.autoTakeProfit || tracked.oorTakeProfit) return true;
  if (tracked.autoCompound) {
    const since = tracked.lastCompoundAt ? now - tracked.lastCompoundAt : Number.POSITIVE_INFINITY;
    if (since >= tracked.compoundIntervalMs) return true;
  }
  return false;
}

async function tick(): Promise<void> {
  const positions = store.allPositions();
  const now = Date.now();
  const active = positions.filter((tracked) => {
    const settings = store.settingsFor(tracked.chatId);
    return needsAttention(tracked, settings, now);
  });
  if (active.length === 0) return;

  // The positions are independent, so they are checked in parallel; the RPC
  // gate in `chain/client.ts` keeps the burst inside the provider's limits.
  await mapLimit(active, config.rpcMaxConcurrency, async (tracked) => {
    try {
      await checkPosition(tracked);
    } catch (err) {
      log.warn(`monitor failed for ${tracked.id}: ${errorMessage(err)}`);
    }
  });
}

/** Runs the monitoring loop; returns a stop function. */
export function startMonitor(): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await tick();
      } catch (err) {
        log.error('monitor tick failed', err);
      }
      schedule();
    }, config.pollIntervalMs);
  };

  log.info(`monitor started, polling every ${fmtDuration(config.pollIntervalMs)}`);
  void tick().catch((err) => log.error('initial tick failed', err));
  schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    log.info('monitor stopped');
  };
}
