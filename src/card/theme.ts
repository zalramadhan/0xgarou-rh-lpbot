import { Resvg } from '@resvg/resvg-js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc } from '../utils/format.js';

/* ------------------------------- canvas ---------------------------------- */

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

export const BACKGROUND = '#FBFAF6';
export const BORDER = '#E5E2D8';
export const INK = '#222222';
export const MUTED = '#777777';
export const FOOTER = '#888888';
export const DIVIDER = '#BBBBBB';
export const PROFIT = '#2E7D32';
export const LOSS = '#C62828';

/** The calendar uses a softer divider and a neutral cell colour. */
export const CALENDAR_DIVIDER = '#D5D1C2';
export const NEUTRAL_CELL = '#F3F0E6';

export const FONT_MONO = 'JetBrains Mono';
export const FONT_SANS = 'Inter';

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');
const FONT_FILES = [
  'JetBrainsMono-Regular.ttf',
  'JetBrainsMono-Bold.ttf',
  'Inter-Regular.ttf',
  'Inter-Medium.ttf',
  'Inter-SemiBold.ttf',
].map((file) => join(FONT_DIR, file));

/* ------------------------------ svg helpers ------------------------------ */

interface TextOptions {
  weight?: number;
  fill?: string;
  tracking?: number;
  opacity?: number;
  font?: string;
  anchor?: 'start' | 'middle' | 'end';
}

/** A centered text line. */
export function centered(
  text: string,
  baseline: number,
  size: number,
  options: TextOptions = {},
): string {
  const tracking = options.tracking ? ` letter-spacing="${options.tracking}"` : '';
  const opacity = options.opacity !== undefined ? ` opacity="${options.opacity}"` : '';
  const anchor = options.anchor ?? 'middle';
  const family = options.font ? ` font-family="${options.font}"` : '';
  return (
    `<text x="${CARD_WIDTH / 2}" y="${baseline}" text-anchor="${anchor}" font-size="${size}" ` +
    `font-weight="${options.weight ?? 400}" fill="${options.fill ?? INK}"${family}${tracking}${opacity}>${esc(text)}</text>`
  );
}

/** A text line at an explicit x position. */
export function text(
  content: string,
  x: number,
  baseline: number,
  size: number,
  options: TextOptions = {},
): string {
  const tracking = options.tracking ? ` letter-spacing="${options.tracking}"` : '';
  const opacity = options.opacity !== undefined ? ` opacity="${options.opacity}"` : '';
  const anchor = options.anchor ?? 'start';
  const family = options.font ? ` font-family="${options.font}"` : '';
  return (
    `<text x="${x}" y="${baseline}" text-anchor="${anchor}" font-size="${size}" ` +
    `font-weight="${options.weight ?? 400}" fill="${options.fill ?? INK}"${family}${tracking}${opacity}>${esc(content)}</text>`
  );
}

/** A left/right row: the label on the left, the value on the right. */
export function row(
  label: string,
  value: string,
  baseline: number,
  options: { mutedValue?: boolean; size?: number; left?: number; right?: number } = {},
): string {
  const size = options.size ?? 27;
  const left = options.left ?? 76;
  const right = options.right ?? CARD_WIDTH - 76;
  return (
    text(label, left, baseline, size, { fill: MUTED }) +
    text(value, right, baseline, size, {
      anchor: 'end',
      weight: 500,
      fill: options.mutedValue ? MUTED : INK,
    })
  );
}

/** A dashed horizontal rule. */
export function divider(
  y: number,
  options: { color?: string; width?: number; dash?: string; left?: number; right?: number; stroke?: number } = {},
): string {
  const left = options.left ?? 76;
  const right = options.right ?? CARD_WIDTH - 76;
  return (
    `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${options.color ?? DIVIDER}" ` +
    `stroke-width="${options.stroke ?? 3}" stroke-dasharray="${options.dash ?? '10 12'}" stroke-linecap="butt"/>`
  );
}

/** The card background with its border and rounded corners. */
export function cardBackground(): string {
  return (
    `<rect x="1" y="1" width="${CARD_WIDTH - 2}" height="${CARD_HEIGHT - 2}" rx="22" ` +
    `fill="${BACKGROUND}" stroke="${BORDER}" stroke-width="2"/>`
  );
}

/** Opens an SVG document with both font families available. */
export function openSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" ` +
    `viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" font-family="${FONT_MONO}">`
  );
}

/* -------------------------------- render --------------------------------- */

/** Rasterises an SVG document to a PNG. */
export function renderSvg(svg: string): Buffer {
  const files = FONT_FILES.filter((file) => existsSync(file));
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: {
      fontFiles: files,
      defaultFontFamily: FONT_MONO,
      loadSystemFonts: false,
    },
  });
  return Buffer.from(resvg.render().asPng());
}
