/** Number/units formatting helpers shared by the bot and the monitor. */

export function toDecimalString(value: bigint, decimals: number, maxFrac = 6): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  let whole = abs / base;
  const frac = abs % base;
  if (frac === 0n || maxFrac <= 0) return `${negative ? '-' : ''}${whole}`;

  let fracStr: string;
  if (maxFrac >= decimals) {
    fracStr = frac.toString().padStart(decimals, '0');
  } else {
    // Round half-up at the requested precision instead of truncating.
    const divisor = 10n ** BigInt(decimals - maxFrac);
    const rounded = (frac + divisor / 2n) / divisor;
    const limit = 10n ** BigInt(maxFrac);
    const carry = rounded === limit;
    if (carry) whole += 1n;
    fracStr = (carry ? 0n : rounded).toString().padStart(maxFrac, '0');
  }
  fracStr = fracStr.slice(0, maxFrac).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fracStr ? `.${fracStr}` : ''}`;
}

/** Formats a raw token amount with a sensible precision for its magnitude. */
export function fmtAmount(value: bigint, decimals: number): string {
  const abs = value < 0n ? -value : value;
  const magnitude = abs === 0n ? 0 : Number(abs) / 10 ** decimals;
  let frac = 4;
  if (magnitude >= 1000) frac = 2;
  else if (magnitude >= 1) frac = 4;
  else if (magnitude >= 0.01) frac = 5;
  else frac = 8;
  return toDecimalString(value, decimals, frac);
}

export function fmtUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  let digits = 2;
  if (abs < 1) digits = 4;
  else if (abs >= 100_000) digits = 0;
  return `${value < 0 ? '-' : ''}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/**
 * "$150K" / "$1.2M" / "$1.5B" / "$12.34" — a compact USD amount.
 *
 * The same function is used for market caps, pool TVL and the card, so the
 * same number is never printed two different ways.
 */
export function fmtCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) {
    const thousands = abs / 1e3;
    return `${sign}$${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}K`;
  }
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs === 0) return '$0.00';
  return `${sign}$${abs.toPrecision(2)}`;
}

/**
 * "$1,05M" / "$684,45K" — a market cap with two decimals.
 *
 * The market cap is a large, precise number, so it gets two decimals and the
 * comma as the decimal mark, the same way the rupiah amounts are written.
 */
export function fmtMcapUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const two = (n: number): string => n.toFixed(2).replace('.', ',');
  if (abs >= 1e9) return `${sign}$${two(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}$${two(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}$${two(abs / 1e3)}K`;
  return `${sign}$${two(abs)}`;
}

export function fmtPct(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

/** "+$2.40" / "-$2.40" — a signed USD amount. */
export function fmtSignedUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${fmtUsd(value)}`;
}

/** "6h", "30m", "2d" — a duration without the minute remainder. */
export function fmtCompactDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function shortAddr(address: string): string {
  if (address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function fmtPrice(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '—';
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return value.toFixed(4);
  if (abs >= 0.0001) return value.toFixed(6);
  return value.toExponential(4);
}

/**
 * Escapes text for Telegram HTML parse mode.
 *
 * A missing value is shown as an empty string instead of crashing the
 * screen: a record that lost a field must still be readable.
 */
export function esc(text: string | undefined | null): string {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function parseDecimalToBigInt(input: string, decimals: number): bigint {
  const trimmed = input.trim().replace(/_/g, '').replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new Error(`"${input}" is not a valid number`);
  }
  const [whole = '0', frac = ''] = trimmed.split('.');
  if (frac.length > decimals) {
    throw new Error(`Too many decimals: this token supports ${decimals}`);
  }
  const padded = frac.padEnd(decimals, '0');
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

/** Applies a slippage tolerance to a minimum-out amount. */
export function applySlippageDown(amount: bigint, slippagePct: number): bigint {
  if (amount <= 0n) return 0n;
  const bps = BigInt(Math.round(Math.max(0, slippagePct) * 100));
  return (amount * (10_000n - bps)) / 10_000n;
}

export function pctChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) return Number.NaN;
  return ((to - from) / from) * 100;
}
