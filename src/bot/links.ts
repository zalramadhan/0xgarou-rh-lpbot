import { TOKENS } from '../constants/chain.js';
import type { PositionSnapshot } from '../core/positions.js';

/** LP Agent's chain key for Robinhood Chain, as used in its portfolio URL. */
const LP_AGENT_CHAIN = 'ROBINHOOD';
const LP_AGENT_BASE = 'https://app.lpagent.io';
const GMGN_BASE = 'https://gmgn.ai';

/** LP Agent portfolio for one wallet: value, PnL, open and closed positions. */
export function lpAgentPortfolioLink(address: string): string {
  return `${LP_AGENT_BASE}/portfolio?address=${encodeURIComponent(address)}&chain=${LP_AGENT_CHAIN}`;
}

/** GMGN price chart for a token on Robinhood Chain. */
export function gmgnTokenLink(address: string): string {
  return `${GMGN_BASE}/robinhood/token/${address}`;
}

/** GMGN wallet view: holdings and realised PnL. */
export function gmgnAddressLink(address: string): string {
  return `${GMGN_BASE}/robinhood/address/${address}`;
}

const QUOTE_TOKENS = new Set<string>([TOKENS.USDG.toLowerCase(), TOKENS.WETH.toLowerCase()]);

/**
 * The token a chart link should point at. A pool holds one quote asset and one
 * traded token, so the interesting series is the non-quote side; a pool of two
 * quote assets falls back to token0.
 */
export function chartTokenAddress(snapshot: PositionSnapshot): string {
  const token0 = snapshot.token0.address.toLowerCase();
  const token1 = snapshot.token1.address.toLowerCase();
  if (QUOTE_TOKENS.has(token0) && !QUOTE_TOKENS.has(token1)) return snapshot.token1.address;
  return snapshot.token0.address;
}
