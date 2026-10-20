import { positionCard, positionRow } from '../src/bot/ui.js';
import { backInRangeNotification, exitNotification, outOfRangeNotification } from '../src/monitor/notifyText.js';
import type { PositionSnapshot } from '../src/core/positions.js';
import type { PnlSummary, Valuation } from '../src/core/valuation.js';
import type { TrackedPosition } from '../src/store/store.js';

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const TOKEN = '0x72be1277e198d0c476869253cb4e62807e14533c';

const snapshot = {
  version: 'v3', tokenId: 42n, owner: '0x1',
  token0: { address: TOKEN, symbol: 'RAETO', name: 'RAETO', decimals: 18 },
  token1: { address: USDG, symbol: 'USDG', name: 'Global Dollar', decimals: 6 },
  hasNative: false, fee: 500, tickSpacing: 10, tickLower: -2000, tickUpper: 2000,
  liquidity: 1n, sqrtPriceX96: 1n, tick: 0, price: 0.00167,
  amount0: 25n * 10n ** 15n, amount1: 60n * 10n ** 6n,
  fees0: 0n, fees1: 10n ** 5n, inRange: true,
} as unknown as PositionSnapshot;

const valuation = {
  amount0Human: 0.025, amount1Human: 60, price0Usd: 0.0015, price1Usd: 1,
  principalUsd: 48.2, fees0Human: 0, fees1Human: 0.1, feesUsd: 1.25, valueUsd: 48.2,
  lowerPrice: 0.001, upperPrice: 0.002, nearestDistancePct: 40,
  distanceToLowerPct: 40.1, distanceToUpperPct: -19.8,
} as unknown as Valuation;

const pnl = {
  feesEarnedUsd: 1.25, pendingFeesUsd: 1.25, withdrawnFeesUsd: 0, compoundedFeesUsd: 0,
  totalPnlUsd: 2.4, totalPnlPct: 5.1, aprPct: 12.4,
} as unknown as PnlSummary;

const tracked = {
  id: 'p1', chatId: 1, version: 'v3', tokenId: '42',
  entry: { amount0: '1', amount1: '1', valueUsd: 48, price: 0.0015, openedAt: Date.now() - 7_200_000 },
  basisUsd: 48, feesWithdrawnUsd: 0, compoundedFeesUsd: 0, alerts: true,
  autoCompound: true, compoundIntervalMs: 21_600_000, compoundMinFeeUsd: 1, autoRebalance: true,
  takeProfitPct: 30, stopLossPct: -20, autoTakeProfit: true, tpCycles: 3, cycle: 2,
  oorTakeProfit: true, lastRebalanceAt: Date.now() - 3_600_000, createdAt: Date.now(),
} as unknown as TrackedPosition;

console.log('===== /pos 1 =====');
console.log(positionCard(tracked, snapshot, valuation, pnl, { idrRate: 16_000, autoTpTargetPct: 1.5, marketCap: { fdvUsd: 1_300_000, priceUsd: 0.00167 } }));
console.log('\n===== /positions =====');
console.log(positionRow(tracked, snapshot, valuation, pnl));
console.log('\n===== OOR =====');
console.log(outOfRangeNotification({ tracked, snapshot: { ...snapshot, inRange: false, tick: -3000 }, valuation, marketCap: { fdvUsd: 1_300_000, priceUsd: 0.00167 } }));
console.log('\n===== back in range =====');
console.log(backInRangeNotification({ tracked, snapshot, valuation, marketCap: { fdvUsd: 1_300_000, priceUsd: 0.00167 } }));
console.log('\n===== exit (take profit + re-entry) =====');
console.log(exitNotification({
  kind: 'takeProfit', tracked, snapshot, valuation, pnl,
  result: { reentered: { ...tracked, id: 'p7' } },
  cycle: 2, limit: 3, dryRun: false, explorerUrl: 'https://explorer.example',
}));
console.log('\n===== exit (manual, dry-run) =====');
console.log(exitNotification({
  kind: 'manual', tracked, snapshot, valuation, pnl,
  result: {}, cycle: 1, limit: 3, dryRun: true, explorerUrl: 'https://explorer.example',
}));
