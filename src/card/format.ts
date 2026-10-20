/** Value formatting for the PnL card. Every number on the card comes from here. */

/** How the main amounts of the card are shown. */
export type CardCurrency = 'USD' | 'IDR' | 'SOL';

import {
  fmtCompactUsd,
  fmtMcapUsd,
} from '../utils/format.js';
import { formatIdrValue } from '../core/fx.js';

/** Shown wherever a value is unknown — never a zero, never an estimate. */
export const NA = 'N/A';

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

/** "$150.00" / "-$8.40" — always two decimals. */
function formatUsdAmount(value: number): string {
  if (!finite(value)) return NA;
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
}

/** "Rp 2.400.000" — dot thousands separators, no decimals. */
function formatIdrAmount(value: number): string {
  if (!finite(value)) return NA;
  return formatIdrValue(value);
}

/** "+12.5" / "+205" / "-14.2" — a compact USD amount for the calendar cells. */
function formatCompactUsd(value: number): string {
  if (!finite(value)) return NA;
  if (value === 0) return '0';
  const sign = value > 0 ? '+' : '-';
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : 1;
  return `${sign}${abs.toFixed(digits)}`;
}

/** "+205rb" / "+2,1jt" — a compact IDR amount for the calendar cells. */
function formatCompactIdr(value: number): string {
  if (!finite(value)) return NA;
  if (value === 0) return '0';
  const sign = value > 0 ? '+' : '-';
  const abs = Math.abs(value);
  const decimals = (scaled: number) => {
    const text = scaled.toFixed(1);
    return text.endsWith('.0') ? text.slice(0, -2) : text.replace('.', ',');
  };
  if (abs >= 1e12) return `${sign}${decimals(abs / 1e12)}T`;
  if (abs >= 1e9) return `${sign}${decimals(abs / 1e9)}M`;
  if (abs >= 1e6) return `${sign}${decimals(abs / 1e6)}jt`;
  if (abs >= 1e3) return `${sign}${Math.round(abs / 1e3)}rb`;
  return `${sign}${Math.round(abs)}`;
}

/** A compact amount in the calendar's currency. */
export function formatCompactAmount(value: number, currency: 'USD' | 'IDR'): string {
  if (currency === 'IDR') return formatCompactIdr(value);
  return formatCompactUsd(value);
}

/** "0.1234 SOL" — the amount of the chain's native token. */
function formatSolAmount(value: number): string {
  if (!finite(value)) return NA;
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  const sign = value < 0 ? '-' : '';
  return `${sign}${abs.toFixed(digits)} SOL`;
}

/**
 * The main amount in the user's currency.
 *
 * IDR and SOL amounts are derived from the USD value with the rate frozen in
 * the close snapshot, so a card never changes when the market does.
 */
export function formatMainAmount(
  valueUsd: number,
  currency: CardCurrency,
  rates: { idrRate?: number; solRateUsd?: number },
): string {
  if (!finite(valueUsd)) return NA;
  if (currency === 'USD') return formatUsdAmount(valueUsd);
  if (currency === 'IDR') {
    if (!finite(rates.idrRate)) return NA;
    return formatIdrAmount(valueUsd * rates.idrRate);
  }
  if (!finite(rates.solRateUsd) || rates.solRateUsd <= 0) return NA;
  return formatSolAmount(valueUsd / rates.solRateUsd);
}

/** "+$12.50" / "-$12.50" — a signed main amount. */
export function formatSignedMainAmount(
  valueUsd: number,
  currency: CardCurrency,
  rates: { idrRate?: number; solRateUsd?: number },
): string {
  const text = formatMainAmount(valueUsd, currency, rates);
  if (text === NA) return NA;
  if (valueUsd < 0) return text; // the sign is already part of the amount
  return `+${text}`;
}

/** "+8.25%" — the ROI, always signed. */
export function formatRoi(pct: number): string {
  if (!finite(pct)) return NA;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/**
 * The amount beside the ROI.
 *
 * In USD mode the IDR value is shown; in IDR mode the USD equivalent, so the
 * same number is never printed twice. SOL mode falls back to the SOL amount.
 */
export function formatSecondaryAmount(
  valueUsd: number,
  currency: CardCurrency,
  rates: { idrRate?: number; solRateUsd?: number },
): string {
  if (!finite(valueUsd)) return NA;
  if (currency === 'IDR') {
    const usd = formatUsdAmount(valueUsd);
    return usd === NA ? NA : `${valueUsd < 0 ? '' : '+'}${usd}`;
  }
  if (currency === 'SOL') {
    if (!finite(rates.solRateUsd) || rates.solRateUsd <= 0) return NA;
    const sol = valueUsd / rates.solRateUsd;
    return `${sol < 0 ? '' : '+'}${formatSolAmount(sol)}`;
  }
  if (!finite(rates.idrRate)) return NA;
  // The sign is always shown next to the ROI.
  const idr = formatIdrAmount(valueUsd * rates.idrRate);
  return valueUsd < 0 ? idr : `+${idr}`;
}

/** "$150K" / "$162.5K" / "$1.2M" / "$1.5B" — a market cap. */
export function formatMcap(usd: number): string {
  if (!finite(usd)) return NA;
  // A market cap is a large, precise number: two decimals and a comma.
  return fmtMcapUsd(usd);
}

/** "12m 35s" / "2h 15m" / "1d 4h" — the two largest units only. */
export function formatDuration(ms: number): string {
  if (!finite(ms) || ms < 0) return NA;
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "16 Oct 2026" and "14:32" in the server's local time. */
export function formatCloseDate(ms: number): string {
  if (!finite(ms)) return NA;
  const date = new Date(ms);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatCloseTime(ms: number): string {
  if (!finite(ms)) return NA;
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** "0x1234...abcd" — the short contract shown in the footer. */
export function formatShortContract(address: string): string {
  if (!address || address.length < 12) return NA;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
