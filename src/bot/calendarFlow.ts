import { InputFile, InlineKeyboard, type Context } from 'grammy';
import { answer } from './answers.js';
import { showLoading } from './screens.js';
import { renderProfitCalendar } from '../card/calendarCard.js';
import type { CalendarCurrency, CalendarPayload, CalendarView } from '../card/calendarCard.js';
import {
  buildCalendarPayload,
  canGoTo,
  currentPeriod,
  firstPeriod,
  localDate,
  mondayOfMonth,
  mondayOfPeriod,
  shiftPeriod,
} from '../core/calendar.js';
import { store } from '../store/store.js';
import { createLogger } from '../logger.js';
import { errorMessage } from '../utils/errors.js';
import { esc } from '../utils/format.js';

const log = createLogger('calendar');

/** The views the calendar can show, in the order of the tab row. */
const VIEWS: CalendarView[] = ['month', 'week', 'day'];
const VIEW_LABEL: Record<CalendarView, string> = {
  month: 'Bulan',
  week: 'Minggu',
  day: 'Hari',
};
/** The weekday buttons of the week view, Monday first. */
const WEEKDAY_NAMES = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

/* -------------------------------- caching -------------------------------- */

const imageCache = new Map<string, Buffer>();
/** The renders that are running right now, so a repeat click can wait. */
const inFlight = new Map<string, Promise<Buffer>>();
const MAX_CACHED = 24;

function cacheKey(
  chatId: number,
  payload: CalendarPayload,
  isCurrent: boolean,
): string {
  // A period in the past can never change, so it is cached without the
  // history version; the current period is dropped when a position closes.
  const version = isCurrent ? store.historyVersion : 0;
  return [
    chatId,
    payload.view,
    payload.period,
    payload.currency,
    payload.timezone,
    version,
  ].join(':');
}

/* ------------------------------- navigation ------------------------------ */

/** The period a view switch should open. */
function periodForView(
  from: CalendarView,
  period: string,
  to: CalendarView,
  timeZone: string,
  now: number,
): string {
  if (from === to) return period;
  if (to === 'month') return period.slice(0, 7);

  // A month opens the current week or day when it is the month on screen.
  const currentMonth = currentPeriod('month', now, timeZone);
  const isCurrentMonth = period === currentMonth;

  if (to === 'week') {
    if (from === 'day') return mondayOfPeriod(period);
    if (isCurrentMonth) return currentPeriod('week', now, timeZone);
    return mondayOfMonth(period.slice(0, 7));
  }
  // The day view.
  if (from === 'month') {
    if (isCurrentMonth) return currentPeriod('day', now, timeZone);
    return `${period.slice(0, 7)}-01`;
  }
  if (from === 'week') return period;
  return period;
}

/** Makes sure a period key has the shape its view expects. */
function normalizePeriod(view: CalendarView, period: string): string {
  if (view === 'month') return period.slice(0, 7);
  if (period.length === 7) {
    return view === 'day' ? `${period}-01` : mondayOfMonth(period);
  }
  if (view === 'week') return mondayOfPeriod(period);
  return period;
}

/** Clamps a period to the navigation limits. */
function clampPeriod(
  view: CalendarView,
  period: string,
  chatId: number,
  timeZone: string,
  now: number,
): string {
  const current = currentPeriod(view, now, timeZone);
  const first = firstPeriod(chatId, timeZone);
  let result = period;
  if (result > current) result = current;
  if (first) {
    const limit = view === 'month' ? first : `${first}-01`;
    if (result < limit) result = limit;
  }
  return result;
}

/* -------------------------------- keyboard ------------------------------- */

/** The keyboard under the calendar image. */
export function calendarKeyboard(
  payload: CalendarPayload,
  chatId: number,
  now: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const { previous, next } = canGoTo(payload.view, payload.period, chatId, payload.timezone, now);

  // The tabs. Each one opens the same period in its own view.
  for (const view of VIEWS) {
    const target = normalizePeriod(
      view,
      periodForView(payload.view, payload.period, view, payload.timezone, now),
    );
    kb.text(
      view === payload.view ? `• ${VIEW_LABEL[view]}` : VIEW_LABEL[view],
      `cal:${view[0]}:${target}:${payload.currency.toLowerCase()}`,
    );
  }
  kb.row();

  // The period arrows. An arrow is left out when that way is not allowed.
  if (previous) {
    kb.text('‹', `cal:${payload.view[0]}:${shiftPeriod(payload.view, payload.period, -1)}:${payload.currency.toLowerCase()}`);
  }
  kb.text(payload.title, 'cal:noop');
  if (next) {
    kb.text('›', `cal:${payload.view[0]}:${shiftPeriod(payload.view, payload.period, 1)}:${payload.currency.toLowerCase()}`);
  }
  kb.row();

  // The drill-down.
  if (payload.view === 'month') {
    for (const week of payload.weeks) {
      kb.text(`W${week.index}`, `cal:w:${week.start}:${payload.currency.toLowerCase()}`);
    }
    kb.row();
  } else if (payload.view === 'week') {
    const week = payload.weeks[0];
    if (week) {
      for (const day of week.days) {
        if (!day.date || day.isFuture) continue;
        kb.text(WEEKDAY_NAMES[day.weekday] ?? '', `cal:d:${day.date}:${payload.currency.toLowerCase()}`);
      }
      kb.row();
    }
  } else {
    const buttons = payload.positions.slice(0, 4);
    for (const position of buttons) {
      kb.text(`📊 ${position.pair}`, `card:${position.id}`);
    }
    if (buttons.length > 0) kb.row();
  }

  // The currency switch.
  kb.text(payload.currency === 'USD' ? '• USD' : 'USD', `cal:${payload.view[0]}:${payload.period}:usd`).text(
    payload.currency === 'IDR' ? '• IDR' : 'IDR',
    `cal:${payload.view[0]}:${payload.period}:idr`,
  );

  return kb;
}

/* -------------------------------- rendering ------------------------------ */

function captionFor(payload: CalendarPayload): string {
  const net = !payload.hasData
    ? '–'
    : payload.currency === 'IDR'
      ? `Rp ${Math.round(Math.abs(payload.netPnl)).toLocaleString('id-ID')}`
      : `$${Math.abs(payload.netPnl).toFixed(2)}`;
  const signed = !payload.hasData ? '' : payload.netPnl >= 0 ? '+' : '-';
  const wins =
    payload.view === 'day'
      ? `${payload.stats.positionWins}/${payload.stats.positions}`
      : `${payload.stats.wins}/${payload.stats.tradingDays}`;
  return `📅 ${payload.title} · Net ${signed}${net} · Win ${wins}`;
}

/** Renders (or reuses) the calendar image. */
async function renderImage(payload: CalendarPayload, chatId: number, now: number): Promise<Buffer> {
  const current = currentPeriod(payload.view, now, payload.timezone);
  const key = cacheKey(chatId, payload, payload.period === current);
  const cached = imageCache.get(key);
  if (cached) return cached;

  const png = renderProfitCalendar(payload);
  imageCache.set(key, png);
  if (imageCache.size > MAX_CACHED) {
    const oldest = imageCache.keys().next().value;
    if (oldest) imageCache.delete(oldest);
  }
  return png;
}

/* --------------------------------- views --------------------------------- */

interface CalendarState {
  view: CalendarView;
  period: string;
  currency: CalendarCurrency;
}

/** Opens the calendar with the month of the current month. */
export async function showCalendar(ctx: Context, state?: Partial<CalendarState>): Promise<void> {
  const chatId = ctx.chat!.id;
  const settings = store.settingsFor(chatId);
  const now = Date.now();
  const currency: CalendarCurrency = settings.currency === 'IDR' ? 'IDR' : 'USD';
  const view = state?.view ?? 'month';
  const period = clampPeriod(
    view,
    state?.period ?? currentPeriod(view, now, settings.timezone),
    chatId,
    settings.timezone,
    now,
  );

  await renderInto(ctx, { view, period, currency }, undefined, now);
}

/** Handles the `cal:*` callbacks. */
export async function handleCalendarCallback(ctx: Context, data: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const [, action, period, currencyRaw] = data.split(':');

  if (action === 'noop') {
    await answer(ctx);
    return true;
  }

  const view = VIEWS.find((candidate) => candidate[0] === action);
  if (!view || !period) {
    await answer(ctx);
    return true;
  }

  const settings = store.settingsFor(chatId);
  const now = Date.now();
  const currency: CalendarCurrency = currencyRaw === 'idr' ? 'IDR' : 'USD';

  // Switching the currency also updates the saved setting.
  if (currency !== settings.currency) {
    await store.updateSettings(chatId, { currency });
  }

  const target = clampPeriod(
    view,
    normalizePeriod(view, period),
    chatId,
    settings.timezone,
    now,
  );
  await answer(ctx);
  await renderInto(ctx, { view, period: target, currency }, ctx.callbackQuery?.message, now);
  return true;
}

/**
 * Renders the calendar and either edits the message that was clicked or sends
 * a new one.
 */
async function renderInto(
  ctx: Context,
  state: CalendarState,
  message: { message_id: number } | undefined,
  now: number,
): Promise<void> {
  const chatId = ctx.chat!.id;
  const settings = store.settingsFor(chatId);
  const payload = buildCalendarPayload({
    chatId,
    view: state.view,
    period: state.period,
    currency: state.currency,
    timeZone: settings.timezone,
    now,
  });

  const key = `${chatId}:${payload.view}:${payload.period}:${payload.currency}`;
  // A repeat click waits for the render that is already running instead of
  // silently doing nothing.
  const running = inFlight.get(key);
  // Drawing the calendar takes a moment: say so at once, so the button is not
  // tapped a second time.
  if (message?.message_id && !running) await showLoading(ctx, '⏳ <b>Drawing the calendar…</b>');
  const png = running ? await running : await startRender(key, payload, chatId, now);

  try {
    const caption = captionFor(payload);
    const keyboard = calendarKeyboard(payload, chatId, now);
    const file = new InputFile(png, 'profit-calendar.png');

    if (message?.message_id) {
      try {
        await ctx.editMessageMedia(
          { type: 'photo', media: file, caption, parse_mode: 'HTML' },
          { reply_markup: keyboard },
        );
        return;
      } catch (err) {
        log.warn(`could not edit the calendar message: ${errorMessage(err)}`);
      }
    }

    await ctx.replyWithPhoto(file, {
      caption,
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } catch (err) {
    log.error(`calendar render failed for chat ${chatId}: ${errorMessage(err)}`);
    await ctx.reply(`❌ Could not build the calendar: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
  }
}

/** Renders an image once, sharing the result with repeat clicks. */
function startRender(key: string, payload: CalendarPayload, chatId: number, now: number): Promise<Buffer> {
  const promise = renderImage(payload, chatId, now).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
