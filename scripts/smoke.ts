/**
 * End-to-end smoke test without Telegram:
 *   DB_PATH=/tmp/lp-smoke.json npx tsx scripts/smoke.ts
 *
 * Tracks an existing on-chain position, renders its card and runs one monitor
 * pass. Alerts are disabled so nothing tries to reach Telegram.
 */
import { readPosition } from '../src/core/positions.js';
import { valuate, summarizePnl } from '../src/core/valuation.js';
import { store } from '../src/store/store.js';
import { positionCard } from '../src/bot/ui.js';
import { runMonitorOnce } from '../src/monitor/monitor.js';

async function main() {
  await store.init();

  const version = 'v3' as const;
  const tokenId = 1n;
  const snapshot = await readPosition(version, tokenId);
  if (!snapshot) throw new Error('v3 position #1 not found on chain');

  const valuation = await valuate(snapshot);
  const tracked = await store.add({
    chatId: 0,
    version,
    tokenId: tokenId.toString(),
    entry: {
      amount0: snapshot.amount0.toString(),
      amount1: snapshot.amount1.toString(),
      valueUsd: valuation.valueUsd,
      price: snapshot.price,
      openedAt: Date.now() - 3_600_000,
    },
    basisUsd: valuation.valueUsd,
    feesWithdrawnUsd: 0,
    compoundedFeesUsd: 0,
    alerts: false,
    autoCompound: false,
    compoundIntervalMs: 3_600_000,
    compoundMinFeeUsd: 1_000_000,
  });

  const pnl = summarizePnl(valuation, {
    basisUsd: tracked.basisUsd,
    feesWithdrawnUsd: tracked.feesWithdrawnUsd,
    compoundedFeesUsd: tracked.compoundedFeesUsd,
    openedAt: tracked.entry.openedAt,
  });

  console.log(positionCard(tracked, snapshot, valuation, pnl));
  console.log('\n--- monitor pass ---');
  await runMonitorOnce();
  console.log('tracked after pass:', store.allPositions().length);
  console.log('lastInRange:', store.allPositions()[0]?.lastInRange);

  await store.remove(tracked.id);
  console.log('smoke ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
