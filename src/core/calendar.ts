import { CHAINS } from '../constants/chain.js';
import { isDust } from '../constants/dust.js';
import { store, type ClosedRecord } from '../store/store.js';
import {
  closeReasonLabel,
} from '../card/data.js';
import { strategyLabel } from '../card/pnlCard.js';
import type {
  CalendarCurrency,
  CalendarDay,
  CalendarPayload,
  CalendarPosition,
  CalendarStats,
  CalendarView,
  CalendarWeek,
} from '../card/calendarCard.js';
import { dayTitle, monthTitle, weekTitle } from '../card/calendarCard.js';
import { createLogger } from '../logger.js';

const log = createLogger('calendar');

/* ------------------------------- time zones ------------------------------ */

interface LocalDate {
  year: number;
  /** 1-based. */
  month: number;
  day: number;
  /** YYYY-MM-DD */
  date: string;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  formatterCache.set(timeZone, fmt);
  return fmt;
}

/** The calendar's local date for a timestamp, in the user's timezone. */
export function localDate(timestamp: number, timeZone: string): LocalDate {
  const parts = formatterFor(timeZone).formatToParts(new Date(timestamp));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const year = read('year');
  const month = read('month');
  const day = read('day');
  // The weekday of a local date, without a timezone: UTC midnight is safe.
  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return { year, month, day, date: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`, weekday };
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/** The Monday of the week a local date belongs to. */
export function mondayOf(date: LocalDate): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day - date.weekday));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    date: `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(shifted.getUTCDate(), 2)}`,
    weekday: 0,
  };
}

/** The Monday of the week a YYYY-MM-DD belongs to. */
export function mondayOfPeriod(period: string): string {
  const [year, month, day] = period.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  const weekday = (date.getUTCDay() + 6) % 7;
  const monday = new Date(date.getTime() - weekday * 86_400_000);
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1, 2)}-${pad(monday.getUTCDate(), 2)}`;
}

/** The Monday of the first week of a YYYY-MM month. */
export function mondayOfMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year ?? 1970, (monthNumber ?? 1) - 1, 1));
  const weekday = (first.getUTCDay() + 6) % 7;
  const monday = new Date(first.getTime() - weekday * 86_400_000);
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1, 2)}-${pad(monday.getUTCDate(), 2)}`;
}

/** A Date at UTC midnight for a local date, used for the week titles. */
function plainDate(date: LocalDate): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

/* ------------------------------ daily index ------------------------------ */

interface IndexEntry {
  version: number;
  days: Map<string, ClosedRecord[]>;
}

const indexCache = new Map<string, IndexEntry>();

/**
 * The closed records of a chat, bucketed by their local close date.
 *
 * The index is rebuilt only when the chat's history changes, so a month view
 * does not scan every record on every click.
 */
export function closedRecordsByDay(chatId: number, timeZone: string): Map<string, ClosedRecord[]> {
  const key = `${chatId}:${timeZone}`;
  const version = store.historyVersion;
  const cached = indexCache.get(key);
  if (cached && cached.version === version) return cached.days;

  const days = new Map<string, ClosedRecord[]>();
  for (const record of store.historyFor(chatId)) {
    // A simulated close is not a real close.
    if (record.dryRun) continue;
    if (chainOf(record) !== CHAINS.robinhood.id) continue;
    const date = localDate(record.closedAt, timeZone).date;
    const bucket = days.get(date);
    if (bucket) bucket.push(record);
    else days.set(date, [record]);
  }
  for (const bucket of days.values()) bucket.sort((a, b) => a.closedAt - b.closedAt);

  indexCache.set(key, { version, days });
  return days;
}

/** The chain a record belongs to; old records default to Robinhood. */
export function chainOf(record: ClosedRecord): string {
  return record.chain ?? CHAINS.robinhood.id;
}

/* ------------------------------- valuation ------------------------------- */

/** The net PnL of a record in the display currency; NaN when it cannot be valued. */
export function positionPnl(record: ClosedRecord, currency: CalendarCurrency): number {
  if (!Number.isFinite(record.pnlUsd)) return Number.NaN;
  if (currency === 'USD') return record.pnlUsd;
  if (!Number.isFinite(record.idrRate) || record.idrRate <= 0) return Number.NaN;
  return record.pnlUsd * record.idrRate;
}

/** True when the position is worth a row of its own. */
export function isWorthACalendarRow(position: CalendarPosition): boolean {
  if (position.missing) return true;
  return !isDust(position.pnlUsd);
}

function toPosition(record: ClosedRecord, currency: CalendarCurrency): CalendarPosition {
  const pnl = positionPnl(record, currency);
  if (!Number.isFinite(pnl)) {
    // The record cannot be valued in this currency; never estimate it.
    log.warn(
      `calendar: position ${record.id} has no ${currency} value (pnl ${record.pnlUsd}, rate ${record.idrRate})`,
    );
  }
  return {
    id: record.id,
    pair: record.pair,
    reason: closeReasonLabel(record.reason),
    range: record.rangeLabel || undefined,
    strategy: record.strategy ? strategyLabel(record.strategy) : undefined,
    durationMs: record.closedAt - record.openedAt,
    pnlUsd: record.pnlUsd,
    pnl,
    roiPct: record.pnlPct,
    missing: !Number.isFinite(pnl),
  };
}

/** Parses a period key into its parts; undefined when it is malformed. */
function parsePeriod(period: string): { year: number; month: number; day: number } | undefined {
  const parts = period.split('-').map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (!year || !month) return undefined;
  return { year, month, day: day ?? 1 };
}

/* -------------------------------- buckets -------------------------------- */

function emptyDay(date: LocalDate | undefined, isFuture: boolean): CalendarDay {
  return {
    date: date?.date ?? '',
    day: date?.day ?? 0,
    weekday: date?.weekday ?? 0,
    pnlUsd: 0,
    pnl: 0,
    count: 0,
    hasPositions: false,
    isNeutral: false,
    isFuture,
    missing: 0,
  };
}

function buildDay(
  date: LocalDate,
  records: ClosedRecord[],
  currency: CalendarCurrency,
  isFuture: boolean,
): CalendarDay {
  const day = emptyDay(date, isFuture);
  if (records.length === 0) return day;

  const positions = records.map((record) => toPosition(record, currency));
  const missing = positions.filter((position) => position.missing).length;
  const valued = positions.filter((position) => !position.missing);

  day.count = positions.length;
  day.hasPositions = true;
  day.missing = missing;
  day.pnlUsd = valued.reduce((sum, position) => sum + position.pnlUsd, 0);
  if (missing > 0) {
    // The bucket cannot be valued without estimating, so it stays unknown.
    day.pnl = Number.NaN;
    day.isNeutral = false;
    return day;
  }
  day.pnl = valued.reduce((sum, position) => sum + position.pnl, 0);
  day.isNeutral = day.pnl === 0;
  return day;
}

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    date: `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(shifted.getUTCDate(), 2)}`,
    weekday: 0,
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/* --------------------------------- stats --------------------------------- */

function monthStats(days: CalendarDay[]): CalendarStats {
  const trading = days.filter((day) => day.hasPositions && Number.isFinite(day.pnl));
  const values = trading.map((day) => day.pnl);
  return {
    tradingDays: trading.length,
    wins: values.filter((value) => value > 0).length,
    best: values.length > 0 ? Math.max(...values) : undefined,
    worst: values.length > 0 ? Math.min(...values) : undefined,
    positions: days.reduce((sum, day) => sum + day.count, 0),
    positionWins: 0,
    bestPosition: undefined,
    worstPosition: undefined,
  };
}

function positionStats(positions: CalendarPosition[]): CalendarStats {
  const valued = positions.filter((position) => !position.missing);
  const values = valued.map((position) => position.pnl);
  return {
    tradingDays: 0,
    wins: 0,
    best: undefined,
    worst: undefined,
    positions: positions.length,
    positionWins: values.filter((value) => value > 0).length,
    bestPosition: values.length > 0 ? Math.max(...values) : undefined,
    worstPosition: values.length > 0 ? Math.min(...values) : undefined,
  };
}

/* -------------------------------- payload -------------------------------- */

interface CalendarRequest {
  chatId: number;
  view: CalendarView;
  /** YYYY-MM for a month, YYYY-MM-DD (a Monday) for a week, YYYY-MM-DD for a day. */
  period: string;
  currency: CalendarCurrency;
  timeZone: string;
  now?: number;
}

/** Builds the render payload for a period. All aggregation happens here. */
export function buildCalendarPayload(request: CalendarRequest): CalendarPayload {
  const { chatId, view, period, currency, timeZone } = request;
  const now = request.now ?? Date.now();
  const index = closedRecordsByDay(chatId, timeZone);
  const today = localDate(now, timeZone);

  const chain = CHAINS.robinhood;
  const base: CalendarPayload = {
    chain: chain.id,
    chainLabel: chain.label,
    view,
    period,
    currency,
    timezone: timeZone,
    title: '',
    netPnl: 0,
    netPnlUsd: 0,
    hasData: false,
    stats: { tradingDays: 0, wins: 0, positions: 0, positionWins: 0 },
    days: [],
    weeks: [],
    positions: [],
    totalPositions: 0,
  };

  if (view === 'month') {
    const parsed = parsePeriod(period);
    if (!parsed) return base;
    const { year, month } = parsed;

    const total = daysInMonth(year, month);
    const first: LocalDate = { year, month, day: 1, date: `${year}-${pad(month, 2)}-01`, weekday: 0 };
    first.weekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;

    const weeks: CalendarWeek[] = [];
    let cursor = addDays(first, -first.weekday);
    while (cursor.month === month || cursor.year === year) {
      const weekDays: CalendarDay[] = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(cursor, i);
        const inMonth = date.year === year && date.month === month;
        const dayDate: LocalDate = { ...date, weekday: i };
        if (!inMonth) {
          weekDays.push(emptyDay(undefined, false));
          continue;
        }
        const records = index.get(date.date) ?? [];
        weekDays.push(buildDay(dayDate, records, currency, isFuture(date, today)));
      }
      const valued = weekDays.filter((day) => day.hasPositions && Number.isFinite(day.pnl));
      weeks.push({
        start: cursor.date,
        index: weeks.length + 1,
        pnlUsd: valued.reduce((sum, day) => sum + day.pnlUsd, 0),
        pnl: valued.some((day) => day.missing > 0)
          ? Number.NaN
          : valued.reduce((sum, day) => sum + day.pnl, 0),
        count: weekDays.reduce((sum, day) => sum + day.count, 0),
        hasPositions: weekDays.some((day) => day.hasPositions),
        days: weekDays,
      });
      if (cursor.year === year && cursor.month > month) break;
      cursor = addDays(cursor, 7);
      if (cursor.year > year || (cursor.year === year && cursor.month > month)) break;
    }

    const allDays = weeks.flatMap((week) => week.days).filter((day) => day.date !== '');
    const valued = allDays.filter((day) => day.hasPositions && Number.isFinite(day.pnl));
    const hasMissing = allDays.some((day) => day.hasPositions && !Number.isFinite(day.pnl));

    return {
      ...base,
      title: monthTitle(year, month),
      days: allDays,
      weeks,
      hasData: allDays.some((day) => day.hasPositions),
      netPnl: hasMissing ? Number.NaN : valued.reduce((sum, day) => sum + day.pnl, 0),
      netPnlUsd: valued.reduce((sum, day) => sum + day.pnlUsd, 0),
      stats: monthStats(allDays),
    };
  }

  if (view === 'week') {
    const parsed = parsePeriod(period);
    if (!parsed) return base;
    const { year, month, day } = parsed;
    const start: LocalDate = { year, month, day, date: period, weekday: 0 };

    const weekDays: CalendarDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      const inMonth = date.year === year && date.month === month;
      if (!inMonth) {
        weekDays.push(emptyDay(undefined, false));
        continue;
      }
      const dayDate: LocalDate = { ...date, weekday: i };
      const records = index.get(date.date) ?? [];
      weekDays.push(buildDay(dayDate, records, currency, isFuture(date, today)));
    }

    const valued = weekDays.filter((day) => day.hasPositions && Number.isFinite(day.pnl));
    const hasMissing = weekDays.some((day) => day.hasPositions && !Number.isFinite(day.pnl));
    const week: CalendarWeek = {
      start: period,
      index: 1,
      pnlUsd: valued.reduce((sum, d) => sum + d.pnlUsd, 0),
      pnl: hasMissing ? Number.NaN : valued.reduce((sum, d) => sum + d.pnl, 0),
      count: weekDays.reduce((sum, d) => sum + d.count, 0),
      hasPositions: weekDays.some((day) => day.hasPositions),
      days: weekDays,
    };

    return {
      ...base,
      title: weekTitle(plainDate(start)),
      weeks: [week],
      days: weekDays.filter((day) => day.date !== ''),
      hasData: weekDays.some((day) => day.hasPositions),
      netPnl: hasMissing ? Number.NaN : valued.reduce((sum, d) => sum + d.pnl, 0),
      netPnlUsd: valued.reduce((sum, d) => sum + d.pnlUsd, 0),
      stats: monthStats(weekDays),
    };
  }

  // Day view.
  const records = index.get(period) ?? [];
  const all = records.map((record) => toPosition(record, currency));
  // A close whose PnL is a fraction of a cent is not worth a row, and it must
  // not count as a loss either.
  const positions = all.filter((position) => isWorthACalendarRow(position));
  // The day's net is the truth: it counts every close, the dust included.
  const valued = all.filter((position) => !position.missing);
  const [year, month, day] = period.split('-').map(Number);
  const date: LocalDate = { year: year ?? 1970, month: month ?? 1, day: day ?? 1, date: period, weekday: 0 };

  return {
    ...base,
    title: dayTitle(plainDate(date)),
    positions,
    days: [],
    weeks: [],
    totalPositions: all.length,
    hasData: all.length > 0,
    netPnl: valued.length === all.length ? valued.reduce((sum, p) => sum + p.pnl, 0) : Number.NaN,
    netPnlUsd: valued.reduce((sum, p) => sum + p.pnlUsd, 0),
    stats: positionStats(positions),
  };
}

function isFuture(date: LocalDate, today: LocalDate): boolean {
  if (date.year !== today.year) return date.year > today.year;
  if (date.month !== today.month) return date.month > today.month;
  return date.day > today.day;
}

/* ------------------------------- navigation ------------------------------ */

/** The first month that has a closed position, as YYYY-MM. */
export function firstPeriod(chatId: number, timeZone: string): string | undefined {
  const index = closedRecordsByDay(chatId, timeZone);
  const dates = [...index.keys()].sort();
  const first = dates[0];
  return first ? first.slice(0, 7) : undefined;
}

/** The current period key for a view. */
export function currentPeriod(view: CalendarView, now = Date.now(), timeZone = 'Asia/Jakarta'): string {
  const today = localDate(now, timeZone);
  if (view === 'month') return `${today.year}-${pad(today.month, 2)}`;
  if (view === 'week') return mondayOf(today).date;
  return today.date;
}

/** Moves a period key by whole steps. */
export function shiftPeriod(view: CalendarView, period: string, steps: number): string {
  if (view === 'month') {
    const parsed = parsePeriod(period);
    if (!parsed) return period;
    const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1 + steps, 1));
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1, 2)}`;
  }
  const parsed = parsePeriod(period);
  if (!parsed) return period;
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + steps * 7));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(shifted.getUTCDate(), 2)}`;
}

/** Whether a period may be shown, given the navigation limits. */
export function canGoTo(
  view: CalendarView,
  period: string,
  chatId: number,
  timeZone: string,
  now = Date.now(),
): { previous: boolean; next: boolean } {
  const current = currentPeriod(view, now, timeZone);
  const first = firstPeriod(chatId, timeZone);
  const previous = first ? period >= first : false;
  const next = period < current;
  return { previous, next };
}
