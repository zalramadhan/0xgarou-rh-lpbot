import { isDynamicFee } from '../constants/chain.js';
import { zeroAddress } from 'viem';
import { publicClient } from '../chain/client.js';
import { RISKY_SELECTORS } from '../constants/abis.js';
import { createLogger } from '../logger.js';
import { retryRpc } from '../utils/async.js';
import { esc, fmtUsd } from '../utils/format.js';
import { isRevertError } from '../utils/errors.js';
import { findPools, type Pool } from './pools.js';
import { quoteVia } from './quoter.js';
import { usdPrice } from './prices.js';
import type { TokenInfo } from './tokens.js';

const log = createLogger('safety');

type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';

interface SafetyCheck {
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface SafetyReport {
  /** No check failed. */
  ok: boolean;
  /** At least one check failed: opening here would risk the deposit. */
  danger: boolean;
  /** Round-trip loss beyond the pool fee, in %. NaN when it could not be measured. */
  sellTaxPct: number;
  checks: SafetyCheck[];
}

const ICON: Record<CheckStatus, string> = { pass: '✅', warn: '⚠️', fail: '❌', unknown: '⚪' };

/* --------------------------------- checks -------------------------------- */

/**
 * This deployment's v4 quoter does not expose quoteExactInputSingle, so a v4
 * quote can fail for infrastructure reasons rather than because the token is
 * unsellable. When that happens and a v3 pool exists for the same pair, the
 * round trip is measured there: a transfer tax belongs to the token, not to the
 * pool, so the check still holds.
 */
async function quotePoolFor(pool: Pool, token: TokenInfo, quote: TokenInfo): Promise<Pool> {
  if (pool.version === 'v3') return pool;
  try {
    await quoteVia(pool, quote.address, token.address, 1n);
    return pool;
  } catch {
    const v3Pools = (await findPools(token.address, quote.address)).filter((p) => p.version === 'v3');
    const deepest = v3Pools.sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1))[0];
    if (!deepest) throw new Error('no quoter path for this pair');
    return deepest;
  }
}

/** Target size for the simulated round trip. */
const PROBE_USD = 10;
/** Extra loss on top of the pool fee that counts as taxed. */
const TAX_WARN_PCT = 3;
const TAX_FAIL_PCT = 15;

async function roundTrip(
  pool: Pool,
  token: TokenInfo,
  quote: TokenInfo,
): Promise<{ status: CheckStatus; detail: string; taxPct: number }> {
  const quoteUsd = await usdPrice(quote.address);
  const decimals = quote.decimals;
  const amountIn =
    Number.isFinite(quoteUsd) && quoteUsd > 0
      ? BigInt(Math.max(1, Math.round((PROBE_USD / quoteUsd) * 10 ** decimals)))
      : 10n ** BigInt(Math.max(0, decimals - 3));

  try {
    const route = await quotePoolFor(pool, token, quote);
    const bought = await quoteVia(route, quote.address, token.address, amountIn);
    if (bought === 0n) {
      return { status: 'fail', detail: 'a buy returns nothing at this size', taxPct: 100 };
    }
    const soldBack = await quoteVia(route, token.address, quote.address, bought);

    const rawFee = route.version === 'v3' ? route.fee : route.lpFee;
    // A dynamic-fee pool's current fee is not known here, so 0.3% is assumed.
    const feeFraction = isDynamicFee(rawFee) ? 0.003 : rawFee / 1_000_000;
    const expected = Number(amountIn) * (1 - feeFraction) ** 2;
    const taxPct = expected > 0 ? (1 - Number(soldBack) / expected) * 100 : Number.NaN;
    const where = route.version !== pool.version ? ` (via the ${route.version} ${route.fee / 10_000}% pool)` : '';

    if (!Number.isFinite(taxPct)) {
      return { status: 'unknown', detail: 'could not size the round trip', taxPct: Number.NaN };
    }
    if (taxPct >= TAX_FAIL_PCT) {
      return {
        status: 'fail',
        detail: `round trip loses ${taxPct.toFixed(1)}% beyond fees — taxed or unsellable${where}`,
        taxPct,
      };
    }
    if (taxPct >= TAX_WARN_PCT) {
      return { status: 'warn', detail: `round trip loses ${taxPct.toFixed(1)}% beyond fees${where}`, taxPct };
    }
    return {
      status: 'pass',
      detail: `buy then sell of ${fmtUsd(PROBE_USD)} keeps ${(100 - Math.max(0, taxPct)).toFixed(1)}%${where}`,
      taxPct,
    };
  } catch (err) {
    if (isRevertError(err)) {
      // A token whose sell leg cannot be priced is the classic honeypot shape.
      return { status: 'fail', detail: 'the sell leg of the simulation reverted', taxPct: Number.NaN };
    }
    log.warn(`round trip failed for ${token.address}: ${String(err)}`);
    return { status: 'unknown', detail: 'simulation unavailable (no quoter route)', taxPct: Number.NaN };
  }
}

/** Scans the token bytecode for mint/blacklist style entry points. */
async function bytecodeChecks(token: TokenInfo): Promise<SafetyCheck[]> {
  try {
    const code = await retryRpc(() => publicClient.getBytecode({ address: token.address }));
    if (!code || code === '0x') {
      return [{ label: 'Contract', status: 'fail', detail: 'no code at this address' }];
    }
    const lower = code.toLowerCase();
    const has = (selector: string) => lower.includes(selector.slice(2));
    const checks: SafetyCheck[] = [
      has(RISKY_SELECTORS.mint)
        ? { label: 'Supply', status: 'warn', detail: 'a mint function exists — supply can grow' }
        : { label: 'Supply', status: 'pass', detail: 'no mint entry point found' },
    ];
    if (has(RISKY_SELECTORS.blacklist) || has(RISKY_SELECTORS.burnFrom)) {
      checks.push({ label: 'Controls', status: 'warn', detail: 'blacklist/burn entry points found' });
    }
    return checks;
  } catch (err) {
    log.warn(`bytecode scan failed for ${token.address}`, err);
    return [{ label: 'Contract', status: 'unknown', detail: 'bytecode unavailable' }];
  }
}

/**
 * Screens a token before liquidity is added: a simulated buy/sell round trip
 * through the target pool, a bytecode scan for mint/blacklist entry points and
 * a native-ETH warning. Anything that fails blocks the open.
 */
export async function screenToken(pool: Pool, token: TokenInfo, quote: TokenInfo): Promise<SafetyReport> {
  const checks: SafetyCheck[] = [];

  if (token.address === zeroAddress) {
    checks.push({ label: 'Token', status: 'fail', detail: 'native ETH cannot be screened' });
  }

  const trip = await roundTrip(pool, token, quote);
  checks.push({ label: 'Buy/sell simulation', status: trip.status, detail: trip.detail });
  checks.push(...(await bytecodeChecks(token)));

  const danger = checks.some((c) => c.status === 'fail');
  return { ok: !danger, danger, sellTaxPct: trip.taxPct, checks };
}

/** Renders the safety report for Telegram (HTML). */
export function safetyText(report: SafetyReport, pool: Pool, token: TokenInfo): string {
  const lines = [
    `<b>🛡 Token safety · ${esc(token.symbol)}</b>`,
    `${pool.version} ${esc(pool.token0.symbol)}/${esc(pool.token1.symbol)}`,
    '',
  ];
  for (const check of report.checks) {
    lines.push(`${ICON[check.status]} <b>${esc(check.label)}</b> — ${esc(check.detail)}`);
  }
  lines.push('');
  if (report.danger) {
    lines.push('❌ <b>Blocked.</b> A failed check means opening here can lose your deposit.');
  } else if (report.checks.some((c) => c.status === 'warn')) {
    lines.push('⚠️ Warnings only — review them, then continue if you accept the risk.');
  } else {
    lines.push('✅ No blockers found. This is a heuristic, not a guarantee.');
  }
  return lines.join('\n');
}

export function safetyIcon(report: SafetyReport): string {
  if (report.danger) return '❌';
  return report.checks.some((c) => c.status === 'warn') ? '⚠️' : '✅';
}
