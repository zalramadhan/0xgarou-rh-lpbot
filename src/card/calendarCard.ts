import { MIN_CALENDAR_ROW_PNL_USD } from '../constants/calendar.js';
import { formatCompactAmount, formatDuration, NA } from './format.js';
import {
  BACKGROUND,
  BORDER,
  CALENDAR_DIVIDER,
  CARD_HEIGHT,
  CARD_WIDTH,
  FONT_MONO,
  FONT_SANS,
  FOOTER,
  INK,
  LOSS,
  MUTED,
  NEUTRAL_CELL,
  PROFIT,
  cardBackground,
  centered,
  divider,
  openSvg,
  renderSvg,
  text,
} from './theme.js';
import { esc } from '../utils/format.js';

/* --------------------------------- types --------------------------------- */

export type CalendarView = 'month' | 'week' | 'day';
export type CalendarCurrency = 'USD' | 'IDR';

export interface CalendarPosition {
  /** The closed-record id, used by the PnL card button. */
  id: string;
  /** The pair, exactly as it is stored. */
  pair: string;
  /** The close reason, as a label. */
  reason: string;
  /** The configured range, only when it was stored. */
  range?: string;
  /** The strategy, only when it was stored. */
  strategy?: string;
  /** How long the position was open. */
  durationMs: number;
  /** The net realized PnL in USD. */
  pnlUsd: number;
  /** The net realized PnL in the display currency; NaN when it cannot be valued. */
  pnl: number;
  /** The stored ROI, in percent. */
  roiPct: number;
  /** True when the position could not be valued in the display currency. */
  missing: boolean;
}

export interface CalendarDay {
  /** The local date, YYYY-MM-DD. */
  date: string;
  /** The day of the month. */
  day: number;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  /** The net PnL in USD. */
  pnlUsd: number;
  /** The net PnL in the display currency. */
  pnl: number;
  /** How many positions closed that day. */
  count: number;
  hasPositions: boolean;
  /** Positions closed, but the net is exactly zero. */
  isNeutral: boolean;
  /** The day has not happened yet. */
  isFuture: boolean;
  /** Positions that could not be valued. */
  missing: number;
}

export interface CalendarWeek {
  /** The Monday of the week, YYYY-MM-DD. */
  start: string;
  /** The week number inside the month, 1-based. */
  index: number;
  pnlUsd: number;
  pnl: number;
  count: number;
  hasPositions: boolean;
  days: CalendarDay[];
}

export interface CalendarStats {
  tradingDays: number;
  wins: number;
  best?: number;
  worst?: number;
  positions: number;
  positionWins: number;
  bestPosition?: number;
  worstPosition?: number;
}

/** Everything the renderer needs; all aggregation happens before this. */
export interface CalendarPayload {
  chain: string;
  chainLabel: string;
  view: CalendarView;
  /** The period key: YYYY-MM for a month, YYYY-MM-DD for a week or a day. */
  period: string;
  currency: CalendarCurrency;
  timezone: string;
  /** The period title, e.g. "OKTOBER 2026". */
  title: string;
  /** The period's net PnL in the display currency. */
  netPnl: number;
  /** The period's net PnL in USD. */
  netPnlUsd: number;
  hasData: boolean;
  stats: CalendarStats;
  days: CalendarDay[];
  weeks: CalendarWeek[];
  /** The positions worth a row of their own. */
  positions: CalendarPosition[];
  /**
   * How many positions were closed in the period, including the ones that are
   * too small to be worth a row.
   */
  totalPositions: number;
}

const PADDING = 56;
const CONTENT_WIDTH = CARD_WIDTH - PADDING * 2;
const BODY_TOP = 372;
const BODY_BOTTOM = 1218;

const WEEKDAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

const MONTHS_ID = [
  'JANUARI',
  'FEBRUARI',
  'MARET',
  'APRIL',
  'MEI',
  'JUNI',
  'JULI',
  'AGUSTUS',
  'SEPTEMBER',
  'OKTOBER',
  'NOVEMBER',
  'DESEMBER',
];

const MONTHS_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MEI', 'JUN', 'JUL', 'AGU', 'SEP', 'OKT', 'NOV', 'DES'];
const DAYS_ID = ['SENIN', 'SELASA', 'RABU', 'KAMIS', 'JUMAT', 'SABTU', 'MINGGU'];

/* ------------------------------ formatting ------------------------------- */

function pnlColor(value: number): string {
  if (!Number.isFinite(value) || value === 0) return INK;
  return value > 0 ? PROFIT : LOSS;
}

/** The big number: the full amount, in the display currency. */
function formatNetPnl(value: number, currency: CalendarCurrency): string {
  if (!Number.isFinite(value)) return '–';
  if (value === 0) return '0';
  const sign = value > 0 ? '+' : '-';
  const abs = Math.abs(value);
  if (currency === 'IDR') {
    return `${sign}Rp ${Math.round(abs).toLocaleString('id-ID')}`;
  }
  return `${sign}$${abs.toFixed(2)}`;
}

/** "Hari trading 15 · Win 9/15 · Best +$41.3 · Worst -$14.2" */
function formatStats(
  stats: CalendarStats,
  currency: CalendarCurrency,
  view: CalendarView,
  hasData: boolean,
): string {
  if (!hasData) return 'Belum ada posisi ditutup';
  const compact = (value: number) => formatCompactAmount(value, currency);
  if (view === 'day') {
    const parts = [`Posisi ${stats.positions}`];
    if (stats.positions > 0) parts.push(`Win ${stats.positionWins}/${stats.positions}`);
    if (stats.bestPosition !== undefined) parts.push(`Best ${compact(stats.bestPosition)}`);
    if (stats.worstPosition !== undefined) parts.push(`Worst ${compact(stats.worstPosition)}`);
    return parts.join(' · ');
  }
  const parts = [`Hari trading ${stats.tradingDays}`];
  if (stats.tradingDays > 0) parts.push(`Win ${stats.wins}/${stats.tradingDays}`);
  if (stats.best !== undefined) parts.push(`Best ${compact(stats.best)}`);
  if (stats.worst !== undefined) parts.push(`Worst ${compact(stats.worst)}`);
  return parts.join(' · ');
}

/* -------------------------------- header --------------------------------- */

function header(payload: CalendarPayload): { parts: string[]; nextY: number } {
  let y = PADDING;
  const brandBaseline = (y += 28);
  const chainBaseline = (y += 30);
  const titleBaseline = (y += 42);
  const pnlBaseline = (y += 108);
  const statsBaseline = (y += 44);

  const netColor = payload.hasData ? pnlColor(payload.netPnl) : INK;
  // A period without trades shows a dash, never a zero.
  const netText = payload.hasData ? formatNetPnl(payload.netPnl, payload.currency) : '–';
  const parts = [
    text('0XGAROU', PADDING, brandBaseline, 34, { weight: 700, tracking: 0.3 * 34 }),
    text('PROFIT CALENDAR', CARD_WIDTH - PADDING, brandBaseline, 22, {
      fill: MUTED,
      tracking: 0.12 * 22,
      anchor: 'end',
    }),
    text(payload.chainLabel, PADDING, chainBaseline, 22, {
      fill: MUTED,
      tracking: 0.14 * 22,
      font: FONT_MONO,
    }),
    text(payload.title, PADDING, titleBaseline, 26, {
      fill: MUTED,
      tracking: 0.12 * 26,
      font: FONT_MONO,
    }),
    centered(netText, pnlBaseline, 88, {
      weight: 700,
      fill: netColor,
      tracking: -0.04 * 88,
    }),
    centered(formatStats(payload.stats, payload.currency, payload.view, payload.hasData), statsBaseline, 26, {
      fill: MUTED,
      font: FONT_SANS,
    }),
  ];
  return { parts, nextY: statsBaseline };
}

/* ------------------------------ month view ------------------------------- */

function monthView(payload: CalendarPayload): string[] {
  const parts: string[] = [];
  const weeks = payload.weeks;
  if (weeks.length === 0) return parts;

  // 7 day columns plus a wider week-total column.
  const units = 7 + 1.25;
  const gap = 9;
  const unit = (CONTENT_WIDTH - gap * 7) / units;
  const dayWidth = unit;
  const weekWidth = unit * 1.25;

  const headerBaseline = BODY_TOP + 18;
  let x = PADDING;
  for (const label of WEEKDAYS) {
    parts.push(text(label, x + dayWidth / 2, headerBaseline, 22, { fill: '#999999', anchor: 'middle', font: FONT_SANS }));
    x += dayWidth + gap;
  }
  parts.push(text('Mgg', x + weekWidth / 2, headerBaseline, 22, { fill: '#999999', anchor: 'middle', font: FONT_SANS }));

  const gridTop = BODY_TOP + 40;
  const rows = weeks.length;
  const cellHeight = Math.min(128, (BODY_BOTTOM - gridTop) / rows);

  // The strongest day decides how saturated the cells are.
  let maxAbs = 0;
  for (const week of weeks) {
    for (const day of week.days) {
      if (day.hasPositions && !day.isNeutral) maxAbs = Math.max(maxAbs, Math.abs(day.pnl));
    }
  }

  weeks.forEach((week, rowIndex) => {
    const top = gridTop + rowIndex * cellHeight;
    const bottom = top + cellHeight - gap;

    week.days.forEach((day, columnIndex) => {
      const cellX = PADDING + columnIndex * (dayWidth + gap);
      const inMonth = day.date !== '';
      if (!inMonth) return;

      const radius = 18;
      const cell = (
        fill: string,
        stroke?: string,
        strokeWidth = 2,
        dash?: string,
        dim = false,
        fillOpacity?: number,
      ) =>
        `<rect x="${cellX.toFixed(2)}" y="${top.toFixed(2)}" width="${dayWidth.toFixed(2)}" ` +
        `height="${(bottom - top).toFixed(2)}" rx="${radius}" fill="${fill}"` +
        (fillOpacity !== undefined ? ` fill-opacity="${fillOpacity.toFixed(3)}"` : '') +
        (stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : '') +
        (dash ? ` stroke-dasharray="${dash}"` : '') +
        (dim ? ' stroke-opacity="0.35"' : '') +
        '/>';

      const opacity = day.isFuture ? 0.35 : 1;
      const dayBaseline = top + 30;
      const valueBaseline = bottom - 16;

      if (!day.hasPositions || day.isFuture) {
        // No positions closed (or the day has not happened yet): an empty cell.
        parts.push(cell('none', BORDER, 2, '6 7', day.isFuture));
        parts.push(text(String(day.day), cellX + dayWidth / 2, dayBaseline, 22, {
          fill: '#888888',
          anchor: 'middle',
          font: FONT_SANS,
          opacity,
        }));
        return;
      }

      if (day.isNeutral) {
        parts.push(cell(NEUTRAL_CELL));
      } else {
        // The strongest day of the month is the most saturated one.
        const ratio = maxAbs > 0 ? Math.abs(day.pnl) / maxAbs : 0;
        const alpha = 0.1 + 0.3 * ratio;
        parts.push(cell(pnlColor(day.pnl), undefined, 0, undefined, false, alpha));
      }

      parts.push(text(String(day.day), cellX + dayWidth / 2, dayBaseline, 22, {
        fill: '#888888',
        anchor: 'middle',
        font: FONT_SANS,
        opacity,
      }));
      const value = day.missing > 0 && !day.isNeutral ? NA : formatCompactAmount(day.pnl, payload.currency);
      parts.push(text(value, cellX + dayWidth / 2, valueBaseline, 24, {
        weight: 700,
        fill: day.isNeutral ? MUTED : pnlColor(day.pnl),
        anchor: 'middle',
        font: FONT_MONO,
        opacity,
      }));
    });

    // The week total column.
    const weekX = PADDING + 7 * (dayWidth + gap);
    const color = week.hasPositions ? pnlColor(week.pnl) : BORDER;
    parts.push(
      `<rect x="${weekX.toFixed(2)}" y="${top.toFixed(2)}" width="${weekWidth.toFixed(2)}" ` +
        `height="${(bottom - top).toFixed(2)}" rx="18" fill="none" stroke="${color}" stroke-width="2"/>`,
    );
    parts.push(text(`W${week.index}`, weekX + weekWidth / 2, top + 30, 22, {
      fill: '#888888',
      anchor: 'middle',
      font: FONT_SANS,
    }));
    const weekValue = !week.hasPositions
      ? '–'
      : formatCompactAmount(week.pnl, payload.currency);
    parts.push(text(weekValue, weekX + weekWidth / 2, bottom - 16, 24, {
      weight: 700,
      fill: week.hasPositions ? color : MUTED,
      anchor: 'middle',
      font: FONT_MONO,
    }));
  });

  return parts;
}

/* ------------------------------- week view ------------------------------- */

function weekView(payload: CalendarPayload): string[] {
  const parts: string[] = [];
  const week = payload.weeks[0];
  if (!week) return parts;

  const gap = 9;
  const columnWidth = (CONTENT_WIDTH - gap * 6) / 7;
  const barZoneTop = BODY_TOP + 56;
  const barZoneHeight = 300;
  const baseline = barZoneTop + barZoneHeight / 2;
  const maxBar = 145;

  let maxAbs = 0;
  for (const day of week.days) {
    if (day.hasPositions && !day.isNeutral) maxAbs = Math.max(maxAbs, Math.abs(day.pnl));
  }

  week.days.forEach((day, index) => {
    const center = PADDING + index * (columnWidth + gap) + columnWidth / 2;
    const inMonth = day.date !== '';
    const opacity = day.isFuture ? 0.35 : 1;

    if (inMonth) {
      const value = !day.hasPositions
        ? '–'
        : day.missing > 0 && !day.isNeutral
          ? NA
          : formatCompactAmount(day.pnl, payload.currency);
      parts.push(text(value, center, BODY_TOP + 26, 22, {
        weight: 700,
        fill: day.hasPositions && !day.isNeutral ? pnlColor(day.pnl) : MUTED,
        anchor: 'middle',
        font: FONT_MONO,
        opacity,
      }));
    }

    // The dashed centre line of the bar zone.
    parts.push(
      `<line x1="${(center - columnWidth / 2).toFixed(2)}" y1="${baseline}" ` +
        `x2="${(center + columnWidth / 2).toFixed(2)}" y2="${baseline}" stroke="${CALENDAR_DIVIDER}" ` +
        'stroke-width="2" stroke-dasharray="6 7"/>',
    );

    if (inMonth && day.hasPositions && !day.isNeutral && maxAbs > 0) {
      const height = (Math.abs(day.pnl) / maxAbs) * maxBar;
      const barWidth = columnWidth * 0.64;
      const color = pnlColor(day.pnl);
      const top = day.pnl > 0 ? baseline - height : baseline;
      parts.push(
        `<rect x="${(center - barWidth / 2).toFixed(2)}" y="${top.toFixed(2)}" ` +
          `width="${barWidth.toFixed(2)}" height="${Math.max(4, height).toFixed(2)}" rx="10" fill="${color}"` +
          (day.isFuture ? ' opacity="0.35"' : '') +
          '/>',
      );
    }

    const nameBaseline = barZoneTop + barZoneHeight + 40;
    const dateBaseline = nameBaseline + 34;
    if (inMonth) {
      parts.push(text(WEEKDAYS[day.weekday] ?? '', center, nameBaseline, 22, {
        fill: '#999999',
        anchor: 'middle',
        font: FONT_SANS,
        opacity,
      }));
      parts.push(text(String(day.day), center, dateBaseline, 22, {
        fill: '#999999',
        anchor: 'middle',
        font: FONT_SANS,
        opacity,
      }));
    }
  });

  return parts;
}

/* -------------------------------- day view -------------------------------- */

function dayView(payload: CalendarPayload): string[] {
  const parts: string[] = [];
  const positions = payload.positions.slice(0, 8);
  if (positions.length === 0) {
    // The day may have closed positions that were too small to be worth a
    // row. Saying "nothing was closed" then would be a lie.
    const message =
      payload.totalPositions > 0
        ? `Semua PnL hari ini di bawah $${MIN_CALENDAR_ROW_PNL_USD.toFixed(2)}.`
        : 'Tidak ada posisi yang ditutup di hari ini.';
    parts.push(
      centered(message, BODY_TOP + 120, 26, {
        fill: MUTED,
        font: FONT_SANS,
      }),
    );
    return parts;
  }

  const rowHeight = 120;
  positions.forEach((position, index) => {
    const top = BODY_TOP + index * rowHeight;
    const pairBaseline = top + 46;
    const detailBaseline = top + 84;
    const pnlBaseline = top + 46;
    const roiBaseline = top + 84;

    const detail = [position.reason, position.range ?? position.strategy, formatDuration(position.durationMs)]
      .filter((part): part is string => Boolean(part))
      .join(' · ');

    parts.push(text(position.pair, PADDING, pairBaseline, 34, { weight: 700, font: FONT_MONO }));
    if (detail) {
      parts.push(text(detail, PADDING, detailBaseline, 24, { fill: '#888888', font: FONT_SANS }));
    }

    const value = position.missing ? NA : formatCompactAmount(position.pnl, payload.currency);
    parts.push(text(value, CARD_WIDTH - PADDING, pnlBaseline, 34, {
      weight: 700,
      fill: position.missing ? MUTED : pnlColor(position.pnl),
      anchor: 'end',
      font: FONT_MONO,
    }));
    if (Number.isFinite(position.roiPct)) {
      parts.push(
        text(`${position.roiPct > 0 ? '+' : ''}${position.roiPct.toFixed(2)}%`, CARD_WIDTH - PADDING, roiBaseline, 24, {
          fill: position.missing ? MUTED : pnlColor(position.roiPct),
          anchor: 'end',
          font: FONT_SANS,
        }),
      );
    }

    if (index < positions.length - 1) {
      parts.push(divider(top + rowHeight - 14, { color: CALENDAR_DIVIDER, stroke: 2, dash: '8 9' }));
    }
  });

  const extra = payload.positions.length - positions.length;
  if (extra > 0) {
    parts.push(
      text(`+${extra} posisi lainnya`, PADDING, BODY_TOP + positions.length * rowHeight + 30, 24, {
        fill: '#888888',
        font: FONT_SANS,
      }),
    );
  }

  return parts;
}

/* --------------------------------- card ---------------------------------- */

const FOOTER_TEXT = 'NET PNL SETELAH FEES & GAS · POSISI YANG SUDAH DITUTUP';

/** Builds the calendar as an SVG document. */
export function calendarSvg(payload: CalendarPayload): string {
  const { parts: headerParts } = header(payload);
  const body =
    payload.view === 'month' ? monthView(payload) : payload.view === 'week' ? weekView(payload) : dayView(payload);

  const footerBaseline = CARD_HEIGHT - PADDING - 18;
  return [
    openSvg(),
    cardBackground(),
    ...headerParts,
    divider(BODY_TOP - 24, { color: CALENDAR_DIVIDER, stroke: 2, dash: '8 9', left: PADDING, right: CARD_WIDTH - PADDING }),
    ...body,
    divider(footerBaseline - 30, { color: CALENDAR_DIVIDER, stroke: 2, dash: '8 9', left: PADDING, right: CARD_WIDTH - PADDING }),
    centered(FOOTER_TEXT, footerBaseline, 22, { fill: '#999999', tracking: 0.04 * 22 }),
    '</svg>',
  ].join('\n');
}

/** Renders the calendar as a PNG. */
export function renderProfitCalendar(payload: CalendarPayload): Buffer {
  return renderSvg(calendarSvg(payload));
}

/* ------------------------------- period labels ---------------------------- */

export function monthTitle(year: number, month: number): string {
  return `${MONTHS_ID[month - 1] ?? ''} ${year}`;
}

export function weekTitle(startDate: Date): string {
  const end = new Date(startDate.getTime());
  end.setDate(end.getDate() + 6);
  const sameMonth = startDate.getMonth() === end.getMonth();
  const month = MONTHS_SHORT[startDate.getMonth()] ?? '';
  if (sameMonth) {
    return `MINGGU ${startDate.getDate()}–${end.getDate()} ${month}`;
  }
  const endMonth = MONTHS_SHORT[end.getMonth()] ?? '';
  return `MINGGU ${startDate.getDate()} ${month}–${end.getDate()} ${endMonth}`;
}

export function dayTitle(date: Date): string {
  return `${DAYS_ID[date.getDay() === 0 ? 6 : date.getDay() - 1] ?? ''}, ${date.getDate()} ${MONTHS_ID[date.getMonth()] ?? ''}`;
}

