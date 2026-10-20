import { readPosition, type PositionSnapshot } from './positions.js';
import { marketCapUsd as fetchMarketCap } from './scanner.js';
import { summarizePnl, valuate, type PnlSummary, type Valuation } from './valuation.js';
import { tradedToken } from './pairs.js';
import type { TrackedPosition } from '../store/store.js';
import { createLogger } from '../logger.js';

const log = createLogger('views');

export interface PositionView {
  snapshot: PositionSnapshot;
  valuation: Valuation;
  pnl: PnlSummary;
  /** FDV of the traded token, NaN when the indexer has none. */
  marketCapUsd: number;
  /** When the view was read. */
  at: number;
}

/**
 * Reads a position from the chain and values it.
 *
 * `withMarketCap` adds the indexer lookup, which is only needed for the
 * screens that show the market cap.
 */
export async function loadView(
  tracked: TrackedPosition,
  withMarketCap = false,
): Promise<PositionView | undefined> {
  const snapshot = await readPosition(tracked.version, BigInt(tracked.tokenId));
  if (!snapshot) return undefined;
  const valuation = await valuate(snapshot);
  const pnl = summarizePnl(valuation, {
    basisUsd: tracked.basisUsd,
    feesWithdrawnUsd: tracked.feesWithdrawnUsd,
    compoundedFeesUsd: tracked.compoundedFeesUsd,
    openedAt: tracked.entry.openedAt,
  });
  // The market cap only shows on the detail card, so the list stays fast.
  const marketCap = withMarketCap
    ? await fetchMarketCap(tradedToken(snapshot)).catch(() => Number.NaN)
    : Number.NaN;
  return { snapshot, valuation, pnl, marketCapUsd: marketCap, at: Date.now() };
}

/* ------------------------------ the cache -------------------------------- */

/**
 * The last view of every position.
 *
 * The home screen shows the open positions, and it has to be instant: a
 * screen that waits for the chain is a screen people stop using. The monitor
 * reads the positions anyway, so the views it produces are kept here and the
 * menu is drawn from them.
 */
const views = new Map<string, PositionView>();

/** How long a view is good enough to draw the menu with. */
export const VIEW_TTL_MS = 30_000;

export function setLastView(id: string, view: PositionView): void {
  views.set(id, view);
}

export function getLastView(id: string): PositionView | undefined {
  return views.get(id);
}

/** Drops the view of a position that is gone. */
export function dropLastView(id: string): void {
  views.delete(id);
}

/** A refresh that is already running for this position. */
const inflight = new Map<string, Promise<PositionView | undefined>>();

/**
 * Reads a position and keeps the result for the menu.
 *
 * One read per position at a time: two taps on the menu must not send two
 * rounds of requests.
 */
export function refreshView(
  tracked: TrackedPosition,
  withMarketCap = true,
): Promise<PositionView | undefined> {
  const running = inflight.get(tracked.id);
  if (running) return running;
  const promise = loadView(tracked, withMarketCap)
    .then((view) => {
      if (view) setLastView(tracked.id, view);
      else dropLastView(tracked.id);
      return view;
    })
    .catch((err) => {
      log.warn(`could not refresh the view of ${tracked.id}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    })
    .finally(() => inflight.delete(tracked.id));
  inflight.set(tracked.id, promise);
  return promise;
}

/**
 * The views of the given positions, with the stale ones refreshed.
 *
 * The menu never waits for a refresh that is not needed: a view that is
 * still good is drawn as it is, and a stale one is refreshed in the
 * background. Only a cold cache is waited for, because otherwise the menu
 * would show nothing at all.
 */
export async function ensureViews(
  positions: TrackedPosition[],
): Promise<Map<string, PositionView>> {
  const now = Date.now();
  const missing: TrackedPosition[] = [];
  for (const tracked of positions) {
    const view = views.get(tracked.id);
    if (!view || now - view.at > VIEW_TTL_MS) missing.push(tracked);
  }
  if (missing.length > 0) {
    const cold = missing.every((tracked) => !views.has(tracked.id));
    if (cold) {
      // Nothing to draw: the menu waits for the first read.
      await Promise.all(missing.map((tracked) => refreshView(tracked)));
    } else {
      // There is something to draw: the refresh happens in the background.
      for (const tracked of missing) void refreshView(tracked);
    }
  }
  return views;
}
