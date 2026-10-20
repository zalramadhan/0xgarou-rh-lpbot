import { describe, expect, it } from 'vitest';
import { cardDataFromRecord, cardPairLabel, closeReasonLabel, formatRangeLabel } from '../src/card/data.js';
import { pnlCardSvg, renderPnlCard, strategyLabel } from '../src/card/pnlCard.js';
import { nextPriceSamples } from '../src/monitor/monitor.js';
import {
  formatDuration,
  formatMcap,
  formatRoi,
  formatSecondaryAmount,
  formatSignedMainAmount,
} from '../src/card/format.js';
import type { ClosedRecord } from '../src/store/store.js';

const now = Date.UTC(2026, 9, 16, 14, 32);

function cardData(overrides: Partial<Parameters<typeof pnlCardSvg>[0]> = {}) {
  return {
    pair: 'RAETO/USDG',
    reason: 'Auto TP',
    dex: 'Robinhood',
    pnlUsd: 12.5,
    pnlPct: 8.25,
    currency: 'USD' as const,
    idrRate: 16_000,
    solRateUsd: 150,
    initialUsd: 150,
    feesEarnedUsd: 1.25,
    gasUsd: 0.42,
    gasOpenUsd: 0.2,
    gasCloseUsd: 0.22,
    gasSwapUsd: Number.NaN,
    pnlNetUsd: Number.NaN,
    pnlNetPct: Number.NaN,
    dryRun: false,
    entryMcapUsd: 150_000,
    exitMcapUsd: 162_500,
    rangeLabel: '-20% to -10%',
    strategy: 'spot' as const,
    openedAt: now - (12 * 60_000 + 35_000),
    closedAt: now,
    contract: '0x72be1277e198d0c476869253cb4e62807e14533c',
    ...overrides,
  };
}

function closedRecord(overrides: Partial<ClosedRecord> = {}): ClosedRecord {
  return {
    id: 'h1',
    chatId: 1,
    version: 'v3',
    tokenId: '42',
    pair: 'USDG/RAETO',
    fee: 3000,
    reason: 'autoTakeProfit',
    entryPrice: 0.0015,
    exitPrice: 0.0017,
    entryValueUsd: 150,
    exitValueUsd: 162.5,
    pnlUsd: 12.5,
    pnlPct: 8.25,
    feesUsd: 1.25,
    idrRate: 16_000,
    openedAt: now - 755_000,
    closedAt: now,
    cycle: 2,
    dryRun: false,
    ...overrides,
  };
}

describe('card content', () => {
  it('keeps the sections in the specified order', () => {
    const svg = pnlCardSvg(cardData());
    const order = [
      '0XGAROU',
      '— POSITION CLOSED —',
      'RAETO/USDG',
      'Auto TP · Robinhood',
      '+$12.50',
      '+8.25% ROI · +Rp 200.000',
      'Entry MCAP',
      'Exit MCAP',
      'Initial',
      'Received',
      'Fees Earned',
      'Gas',
      'Duration',
      'Range',
      'Strategy',
      '0x72be...533c',
    ];
    let cursor = -1;
    for (const piece of order) {
      const at = svg.indexOf(piece, cursor + 1);
      expect(at, `"${piece}" is missing or out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('never shows the entry or exit price', () => {
    const svg = pnlCardSvg(cardData());
    expect(svg).not.toContain('Entry Price');
    expect(svg).not.toContain('Exit Price');
    expect(svg).not.toContain('0.0015');
  });

  it('brands the card as text only', () => {
    const svg = pnlCardSvg(cardData());
    expect(svg).toContain('>0XGAROU<');
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('t.me');
    expect(svg).not.toContain('href');
  });

  it('paints the PnL green for a profit and red for a loss', () => {
    expect(pnlCardSvg(cardData({ pnlUsd: 12.5, pnlPct: 8.25 }))).toContain('#2E7D32');
    const loss = pnlCardSvg(cardData({ pnlUsd: -8.4, pnlPct: -5.6 }));
    expect(loss).toContain('#C62828');
    expect(loss).toContain('-$8.40');
    expect(loss).toContain('-5.60% ROI');
  });

  it('keeps the same layout in the loss state', () => {
    const profit = pnlCardSvg(cardData());
    const loss = pnlCardSvg(cardData({ pnlUsd: -8.4, pnlPct: -5.6 }));
    const count = (svg: string) => (svg.match(/<text /g) ?? []).length;
    expect(count(loss)).toBe(count(profit));
  });

  it('shows the market cap and hides it when it is unknown', () => {
    expect(pnlCardSvg(cardData())).toContain('$150,00K');
    expect(pnlCardSvg(cardData())).toContain('$162,50K');
    const missing = pnlCardSvg(cardData({ entryMcapUsd: Number.NaN, exitMcapUsd: Number.NaN }));
    expect(missing).toContain('N/A');
    // A missing value never turns into a zero.
    expect(missing).not.toContain('$0.00');
  });

  it('shows N/A for anything that is missing', () => {
    const svg = pnlCardSvg(
      cardData({
        initialUsd: Number.NaN,
        gasUsd: Number.NaN,
        rangeLabel: '',
        idrRate: Number.NaN,
      }),
    );
    expect(svg).toContain('N/A');
    expect(svg).not.toContain('$0.00');
  });

  it('respects the display currency', () => {
    const usd = pnlCardSvg(cardData({ currency: 'USD' }));
    expect(usd).toContain('$150.00');
    expect(usd).toContain('+$12.50');
    expect(usd).toContain('+Rp 200.000');

    const idr = pnlCardSvg(cardData({ currency: 'IDR' }));
    expect(idr).toContain('Rp 2.400.000');
    // The USD equivalent is shown next to the ROI, never the same number twice.
    expect(idr).toContain('+8.25% ROI · +$12.50');

    const sol = pnlCardSvg(cardData({ currency: 'SOL' }));
    expect(sol).toContain('SOL');
  });

  it('shows the strategy of every mode', () => {
    expect(strategyLabel('spot')).toBe('Spot');
    expect(strategyLabel('bidAsk')).toBe('Bid/Ask');
    expect(strategyLabel('curve')).toBe('Curve');
    expect(pnlCardSvg(cardData({ strategy: 'bidAsk' }))).toContain('Bid/Ask');
  });

  it('draws the chart only when a price path was stored', () => {
    const samples = [
      { t: now - 600_000, p: 0.0012 },
      { t: now - 300_000, p: 0.0014 },
      { t: now, p: 0.0013 },
    ];
    const withChart = pnlCardSvg(
      cardData({ chart: { samples, rangeLower: 0.001, rangeUpper: 0.0015 } }),
    );
    expect(withChart).toContain('ENTRY');
    expect(withChart).toContain('EXIT');
    expect(withChart).toContain('<path');

    const without = pnlCardSvg(cardData());
    expect(without).not.toContain('ENTRY');
    expect(without).not.toContain('<path');
    // The footer still closes the card.
    expect(without).toContain('0x72be...533c');
  });
});

describe('card rendering', () => {
  it('renders a 1080x1350 PNG', () => {
    const png = renderPnlCard(cardData());
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // The IHDR chunk holds the dimensions right after the signature.
    expect(png.readUInt32BE(16)).toBe(1080);
    expect(png.readUInt32BE(20)).toBe(1350);
  });
});

describe('card values', () => {
  it('formats a market cap', () => {
    expect(formatMcap(150_000)).toBe('$150,00K');
    expect(formatMcap(162_500)).toBe('$162,50K');
    expect(formatMcap(1_200_000)).toBe('$1,20M');
    expect(formatMcap(1_500_000_000)).toBe('$1,50B');
    expect(formatMcap(Number.NaN)).toBe('N/A');
  });

  it('formats a duration with the two largest units', () => {
    expect(formatDuration(12 * 60_000 + 35_000)).toBe('12m 35s');
    expect(formatDuration(2 * 3_600_000 + 15 * 60_000)).toBe('2h 15m');
    expect(formatDuration(28 * 3_600_000 + 4 * 60_000)).toBe('1d 4h');
  });

  it('formats the ROI and the secondary amount', () => {
    expect(formatRoi(8.25)).toBe('+8.25%');
    expect(formatRoi(-5.6)).toBe('-5.60%');
    expect(formatSecondaryAmount(12.5, 'USD', { idrRate: 16_000 })).toBe('+Rp 200.000');
    expect(formatSecondaryAmount(12.5, 'IDR', { idrRate: 16_000 })).toBe('+$12.50');
    expect(formatSecondaryAmount(12.5, 'USD', { idrRate: Number.NaN })).toBe('N/A');
  });

  it('signs the main amount', () => {
    expect(formatSignedMainAmount(12.5, 'USD', {})).toBe('+$12.50');
    expect(formatSignedMainAmount(-8.4, 'USD', {})).toBe('-$8.40');
  });

  it('labels the range and the pair', () => {
    expect(formatRangeLabel(0.9, 1.1, 1)).toBe('-10% to +10%');
    expect(formatRangeLabel(0.8, 0.9, 1)).toBe('-20% to -10%');
    expect(formatRangeLabel(0, 0, 1)).toBe('');
    expect(cardPairLabel('USDG/RAETO')).toBe('RAETO/USDG');
    expect(cardPairLabel('RAETO/USDG')).toBe('RAETO/USDG');
    expect(closeReasonLabel('autoTakeProfit')).toBe('Auto TP');
    expect(closeReasonLabel('manual')).toBe('Manual');
  });
});

describe('price sampling', () => {
  const tracked = { priceSamples: undefined } as unknown as Parameters<typeof nextPriceSamples>[0];

  it('takes one sample per interval', () => {
    const first = nextPriceSamples(tracked, 0.0012, 1_000_000);
    expect(first).toEqual([{ t: 1_000_000, p: 0.0012 }]);

    const tooSoon = nextPriceSamples({ ...tracked, priceSamples: first } as never, 0.0013, 1_100_000);
    expect(tooSoon).toBeUndefined();

    const later = nextPriceSamples({ ...tracked, priceSamples: first } as never, 0.0013, 1_400_000);
    expect(later).toHaveLength(2);
  });

  it('never keeps more than the cap', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ t: i * 600_000, p: 0.001 + i * 1e-6 }));
    const next = nextPriceSamples({ ...tracked, priceSamples: many } as never, 0.002, 500 * 600_000);
    expect(next).toHaveLength(240);
    expect(next?.at(-1)?.p).toBe(0.002);
  });

  it('ignores a price that is not a number', () => {
    expect(nextPriceSamples(tracked, Number.NaN, 1_000_000)).toBeUndefined();
  });
});

describe('card data from a closed record', () => {
  it('uses the stored numbers and never re-derives them', () => {
    const data = cardDataFromRecord(
      closedRecord({
        basisUsd: 150,
        entryMcapUsd: 150_000,
        exitMcapUsd: 162_500,
        rangeLabel: '-20% to -10%',
        strategy: 'bidAsk',
        currency: 'IDR',
        solRateUsd: 150,
        feesAndGasUsd: 0.42,
        contract: '0x72be1277e198d0c476869253cb4e62807e14533c',
      }),
    );

    expect(data.pnlUsd).toBe(12.5);
    expect(data.pnlPct).toBe(8.25);
    expect(data.initialUsd).toBe(150);
    expect(data.currency).toBe('IDR');
    expect(data.idrRate).toBe(16_000);
    expect(data.strategy).toBe('bidAsk');
    expect(data.pair).toBe('RAETO/USDG');
    expect(data.reason).toBe('Auto TP');
  });

  it('marks unknown values as missing instead of zero', () => {
    const data = cardDataFromRecord(closedRecord({ entryValueUsd: Number.NaN, idrRate: Number.NaN }));
    expect(data.initialUsd).toBe(Number.NaN);
    expect(data.entryMcapUsd).toBe(Number.NaN);
    expect(data.gasUsd).toBe(Number.NaN);
    expect(data.idrRate).toBe(Number.NaN);
  });

  it('keeps the chart only when the samples and the range are stored', () => {
    const samples = [
      { t: now - 600_000, p: 0.0012 },
      { t: now, p: 0.0013 },
    ];
    const withChart = cardDataFromRecord(
      closedRecord({ priceSamples: samples, rangePriceLower: 0.001, rangePriceUpper: 0.0015 }),
    );
    expect(withChart.chart?.samples).toHaveLength(2);

    const without = cardDataFromRecord(closedRecord({ priceSamples: samples }));
    expect(without.chart).toBeUndefined();
  });
});
