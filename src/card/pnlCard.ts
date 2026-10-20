import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatCloseDate,
  formatCloseTime,
  formatDuration,
  formatMainAmount,
  formatMcap,
  formatRoi,
  formatSecondaryAmount,
  formatShortContract,
  formatSignedMainAmount,
  NA,
  type CardCurrency,
} from './format.js';
import {
  BACKGROUND,
  BORDER,
  CARD_HEIGHT,
  CARD_WIDTH,
  DIVIDER,
  FOOTER,
  INK,
  LOSS,
  MUTED,
  PROFIT,
  cardBackground,
  centered,
  divider,
  openSvg,
  renderSvg,
  row,
  text,
} from './theme.js';
import { esc } from '../utils/format.js';

/* ------------------------------- canvas ---------------------------------- */

const PADDING_X = 76;
const PADDING_Y = 54;
const CONTENT_WIDTH = CARD_WIDTH - PADDING_X * 2;

/* -------------------------------- data ----------------------------------- */

export type CardStrategy = 'spot' | 'bidAsk' | 'curve';

interface CardPriceSample {
  /** Milliseconds since the epoch. */
  t: number;
  /** The pool price at that moment, in the same terms as the range bounds. */
  p: number;
}

export interface CardChart {
  samples: CardPriceSample[];
  /** The range's lower price bound. */
  rangeLower: number;
  /** The range's upper price bound. */
  rangeUpper: number;
}

/** Everything the card shows, frozen at close time. */
export interface PnlCardData {
  /** "RAETO/USDG" */
  pair: string;
  /** "Manual" | "Auto TP" | "OOR TP" | … */
  reason: string;
  /** "Robinhood" */
  dex: string;
  /** Net realized PnL in USD. */
  pnlUsd: number;
  /** ROI in percent of the invested capital. */
  pnlPct: number;
  currency: CardCurrency;
  /** USD → IDR, frozen at close time. */
  idrRate: number;
  /** USD → SOL, frozen at close time. */
  solRateUsd: number;
  /** The capital that was invested. */
  initialUsd: number;
  /** The fees the position earned. */
  feesEarnedUsd: number;
  /** The gas of the whole round trip: the open, the close and the swap. */
  gasUsd: number;
  /** The gas of each transaction, for the breakdown. */
  gasOpenUsd: number;
  gasCloseUsd: number;
  gasSwapUsd: number;
  /** The PnL after every cost, when it could be measured. */
  pnlNetUsd: number;
  pnlNetPct: number;
  /** True when the position was a simulation: no gas was spent. */
  dryRun: boolean;
  /** The traded token's market cap when the position was opened. */
  entryMcapUsd: number;
  /** The traded token's market cap when the position was closed. */
  exitMcapUsd: number;
  /** The configured range, exactly as stored, e.g. "-20% to -10%". */
  rangeLabel: string;
  strategy: CardStrategy;
  openedAt: number;
  closedAt: number;
  /** The traded token's contract, shown short in the footer. */
  contract: string;
  /** The price path, when it was recorded. */
  chart?: CardChart;
}

/* ------------------------------ svg helpers ------------------------------ */

/**
 * A smooth path through the samples (Catmull-Rom converted to cubic beziers).
 */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

/** The price chart: range bounds, the price path and the entry/exit markers. */
function chartSvg(chart: CardChart, pnlColor: string, top: number, height: number): string {
  const samples = chart.samples.filter((s) => Number.isFinite(s.p));
  if (samples.length < 2) return '';

  const times = samples.map((s) => s.t);
  const prices = samples.map((s) => s.p);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tSpan = tMax - tMin || 1;

  const pMin = Math.min(...prices, chart.rangeLower, chart.rangeUpper);
  const pMax = Math.max(...prices, chart.rangeLower, chart.rangeUpper);
  const pSpan = pMax - pMin || 1;
  const pad = pSpan * 0.12;

  const x = (t: number) => PADDING_X + ((t - tMin) / tSpan) * CONTENT_WIDTH;
  const y = (p: number) => top + height - ((p - (pMin - pad)) / (pSpan + pad * 2)) * height;

  const points = samples.map((s) => ({ x: x(s.t), y: y(s.p) }));
  const entry = points[0]!;
  const exit = points[points.length - 1]!;

  const marker = (point: { x: number; y: number }, label: string, filled: boolean) => {
    const fill = filled ? pnlColor : BACKGROUND;
    const stroke = filled ? pnlColor : INK;
    const anchor = point.x > CARD_WIDTH / 2 + CONTENT_WIDTH * 0.3 ? 'end' : 'start';
    const dx = anchor === 'end' ? -14 : 14;
    // A card-coloured plate keeps the label readable where the price line
    // runs underneath it.
    const labelWidth = label.length * 14 + 8;
    const plateX = anchor === 'end' ? point.x + dx - labelWidth : point.x + dx - 4;
    return (
      `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="8" fill="${fill}" stroke="${stroke}" stroke-width="2.4"/>` +
      `<rect x="${plateX.toFixed(2)}" y="${(point.y - 32).toFixed(2)}" width="${labelWidth}" height="26" fill="${BACKGROUND}"/>` +
      `<text x="${(point.x + dx).toFixed(2)}" y="${(point.y - 14).toFixed(2)}" text-anchor="${anchor}" ` +
      `font-size="20" letter-spacing="2" fill="${FOOTER}">${label}</text>`
    );
  };

  return [
    `<line x1="${PADDING_X}" y1="${y(chart.rangeUpper).toFixed(2)}" x2="${CARD_WIDTH - PADDING_X}" y2="${y(chart.rangeUpper).toFixed(2)}" ` +
      `stroke="${pnlColor}" stroke-width="1.2" stroke-dasharray="8 9"/>`,
    `<line x1="${PADDING_X}" y1="${y(chart.rangeLower).toFixed(2)}" x2="${CARD_WIDTH - PADDING_X}" y2="${y(chart.rangeLower).toFixed(2)}" ` +
      `stroke="#999999" stroke-width="1.2" stroke-dasharray="8 9"/>`,
    `<path d="${smoothPath(points)}" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
    marker(entry, 'ENTRY', false),
    marker(exit, 'EXIT', true),
  ].join('');
}

/* --------------------------------- card ---------------------------------- */

/** "open $0.031 · close $0.028 · swap $0.012" — the gas of each transaction. */
function gasBreakdownText(data: PnlCardData): string {
  if (data.dryRun) return '';
  const parts: string[] = [];
  const push = (label: string, value: number): void => {
    if (!Number.isFinite(value)) return;
    parts.push(`${label} ${formatMainAmount(value, data.currency, { idrRate: data.idrRate, solRateUsd: data.solRateUsd })}`);
  };
  push('open', data.gasOpenUsd);
  push('close', data.gasCloseUsd);
  push('swap', data.gasSwapUsd);
  if (parts.length === 0) return '';
  return parts.join(' · ');
}

/** Builds the card as an SVG document. */
export function pnlCardSvg(data: PnlCardData): string {
  const rates = { idrRate: data.idrRate, solRateUsd: data.solRateUsd };

  // The hero is the PnL that is really left: after the gas of the open, the
  // close and the swap. The number before the gas is the secondary line.
  const net = Number.isFinite(data.pnlNetUsd);
  const headlineUsd = net ? data.pnlNetUsd : data.pnlUsd;
  const headlinePct = net ? data.pnlNetPct : data.pnlPct;
  const profit = Number.isFinite(headlineUsd) && headlineUsd >= 0;
  const pnlColor = profit ? PROFIT : LOSS;
  const hero = formatSignedMainAmount(headlineUsd, data.currency, rates);
  const roi = formatRoi(headlinePct);
  const secondary = formatSecondaryAmount(data.pnlUsd, data.currency, rates);
  const roiLine = net
    ? secondary === NA
      ? `${roi} ROI · ${NA}`
      : `${roi} ROI · ${secondary} before gas`
    : secondary === NA
      ? `${roi} ROI · ${NA}`
      : `${roi} ROI · ${secondary}`;

  // Vertical rhythm. The chart is anchored to the bottom of the card.
  let y = PADDING_Y;
  const brandBaseline = (y += 30);
  const subtitleBaseline = (y += 42);
  const pairBaseline = (y += 92);
  const reasonBaseline = (y += 44);
  const heroBaseline = (y += 150);
  const roiBaseline = (y += 70);
  const divider1 = (y += 36);

  const rows: string[] = [];
  let rowBaseline = (y += 56);
  rows.push(row('Entry MCAP', formatMcap(data.entryMcapUsd), rowBaseline, { mutedValue: !Number.isFinite(data.entryMcapUsd) }));
  rowBaseline += 45;
  rows.push(row('Exit MCAP', formatMcap(data.exitMcapUsd), rowBaseline, { mutedValue: !Number.isFinite(data.exitMcapUsd) }));
  rowBaseline += 45;
  rows.push(row('Initial', formatMainAmount(data.initialUsd, data.currency, rates), rowBaseline));
  rowBaseline += 45;
  rows.push(
    row('Received', formatMainAmount(data.initialUsd + headlineUsd, data.currency, rates), rowBaseline, {
      mutedValue: !Number.isFinite(headlineUsd),
    }),
  );
  rowBaseline += 45;
  rows.push(
    row('Fees Earned', formatMainAmount(data.feesEarnedUsd, data.currency, rates), rowBaseline, {
      mutedValue: !Number.isFinite(data.feesEarnedUsd),
    }),
  );
  rowBaseline += 45;
  rows.push(
    row(
      'Gas',
      data.dryRun
        ? 'not incurred'
        : formatMainAmount(data.gasUsd, data.currency, rates),
      rowBaseline,
      { mutedValue: !data.dryRun && !Number.isFinite(data.gasUsd) },
    ),
  );

  // The gas of each transaction, in a small muted line under the total.
  const gasBreakdown = gasBreakdownText(data);
  if (gasBreakdown) {
    rowBaseline += 34;
    rows.push(text(gasBreakdown, 76, rowBaseline, 19, { fill: MUTED }));
  }

  const divider2 = (rowBaseline += 80);
  let setupBaseline = divider2 + 56;
  rows.push(row('Duration', formatDuration(data.closedAt - data.openedAt), setupBaseline));
  setupBaseline += 45;
  rows.push(row('Range', data.rangeLabel || NA, setupBaseline, { mutedValue: !data.rangeLabel }));
  setupBaseline += 45;
  rows.push(row('Strategy', strategyLabel(data.strategy), setupBaseline));

  const chartHeight = 185;
  const chartTop = CARD_HEIGHT - PADDING_Y - chartHeight;
  const footerBaseline = chartTop - 18;

  const parts = [
    openSvg(),
    cardBackground(),
    centered('0XGAROU', brandBaseline, 32, { weight: 700, tracking: 0.3 * 32 }),
    centered('— POSITION CLOSED —', subtitleBaseline, 22, { fill: MUTED, tracking: 0.14 * 22 }),
    centered(data.pair, pairBaseline, 48, { weight: 700 }),
    centered(`${data.reason} · ${data.dex}`, reasonBaseline, 22, { fill: MUTED }),
    centered(hero, heroBaseline, 124, { weight: 700, fill: pnlColor, tracking: -0.05 * 124 }),
    centered(roiLine, roiBaseline, 39, { weight: 700, fill: pnlColor }),
    divider(divider1),
    ...rows.slice(0, 5),
    divider(divider2),
    ...rows.slice(5),
    centered(
      `${formatShortContract(data.contract)} · ${formatCloseDate(data.closedAt)} · ${formatCloseTime(data.closedAt)}`,
      footerBaseline,
      20,
      { fill: FOOTER },
    ),
  ];

  if (data.chart) {
    const chart = chartSvg(data.chart, pnlColor, chartTop, chartHeight);
    if (chart) parts.push(chart);
  }

  parts.push('</svg>');
  return parts.join('\n');
}

/** "Spot" | "Bid/Ask" | "Curve" */
export function strategyLabel(strategy: CardStrategy): string {
  if (strategy === 'bidAsk') return 'Bid/Ask';
  if (strategy === 'curve') return 'Curve';
  return 'Spot';
}

/** Renders the card as a PNG. */
export function renderPnlCard(data: PnlCardData): Buffer {
  return renderSvg(pnlCardSvg(data));
}
