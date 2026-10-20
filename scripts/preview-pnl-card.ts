import { writeFile } from 'node:fs/promises';
import { renderPnlCard, type PnlCardData } from '../src/card/pnlCard.js';

const now = Date.now();

function base(overrides: Partial<PnlCardData> = {}): PnlCardData {
  return {
    pair: 'RAETO/USDG',
    reason: 'Auto TP',
    dex: 'Robinhood',
    pnlUsd: 12.5,
    pnlPct: 8.25,
    currency: 'USD',
    idrRate: 16_000,
    solRateUsd: 150,
    initialUsd: 150,
    feesEarnedUsd: 1.25,
  gasOpenUsd: 0.2,
  gasCloseUsd: 0.22,
  gasSwapUsd: Number.NaN,
  pnlNetUsd: Number.NaN,
  pnlNetPct: Number.NaN,
  dryRun: false,
  gasUsd: 0.42,
    entryMcapUsd: 150_000,
    exitMcapUsd: 162_500,
    rangeLabel: '-20% to -10%',
    strategy: 'spot',
    openedAt: now - 12 * 60_000 - 35_000,
    closedAt: now,
    contract: '0x72be1277e198d0c476869253cb4e62807e14533c',
    ...overrides,
  };
}

const chart = {
  rangeLower: 0.0012,
  rangeUpper: 0.0014,
  samples: Array.from({ length: 24 }, (_, i) => ({
    t: now - 12 * 60_000 - 35_000 + i * 30_000,
    p: 0.00135 + Math.sin(i / 3) * 0.00008 + i * 0.000004,
  })),
};

await writeFile('/tmp/opencode/card-profit.png', renderPnlCard(base({ chart })));
await writeFile(
  '/tmp/opencode/card-loss.png',
  renderPnlCard(
    base({
      pnlUsd: -8.4,
      pnlPct: -5.6,
      strategy: 'bidAsk',
      rangeLabel: '-35% to 0%',
      exitMcapUsd: 141_600,
      chart: {
        ...chart,
        samples: chart.samples.map((s, i) => ({ t: s.t, p: s.p - i * 0.000008 })),
      },
    }),
  ),
);
await writeFile(
  '/tmp/opencode/card-idr.png',
  renderPnlCard(base({ currency: 'IDR', pnlUsd: 12.5, pnlPct: 8.25 })),
);
console.log('wrote the three preview cards');
