const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const configured = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';
const threshold = LEVELS[configured] ?? LEVELS.info;

/** ANSI colours, applied only when the stream is a terminal. */
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

const STYLE: Record<Level, { tag: string; color: string }> = {
  debug: { tag: 'DBG', color: C.gray },
  info: { tag: 'INF', color: C.cyan },
  warn: { tag: 'WRN', color: C.yellow },
  error: { tag: 'ERR', color: C.red },
};

/** Compact clock: HH:MM:SS.mmm in local time. */
function clock(): string {
  const now = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function paint(text: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${text}${C.reset}` : text;
}

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const style = STYLE[level];
  const parts = [
    paint(clock(), C.dim, tty),
    paint(style.tag, `${C.bold}${style.color}`, tty),
    paint(`[${scope}]`, C.gray, tty),
    msg,
  ];
  const line = parts.join(' ');
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) sink(line);
  else sink(line, extra);
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra),
  };
}

type Logger = ReturnType<typeof createLogger>;
