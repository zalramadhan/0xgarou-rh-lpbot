/**
 * Recomputes the PnL of the closed records that had a swap.
 *
 * The swap accounting had two mistakes:
 *
 * 1. The 0x route never said what it sold, so the whole withdrawal looked
 *    unsold and the swapped tokens were valued a second time.
 * 2. The quote that the close withdrew next to the token — and the fees it
 *    collected — were never counted, so the money that stayed in the wallet
 *    was missing from the position's value.
 *
 * Together they turned a close with a swap into a loss of 71%. Both are fixed
 * in the code; this script brings the records that were closed in the meantime
 * in line, reading the amounts from the transactions themselves.
 *
 *   npm run repair:swap-pnl
 */
import { publicClient } from '../src/chain/client.js';
import { store, type ClosedRecord } from '../src/store/store.js';
import { swapAccounting, withSwap } from '../src/core/history.js';
import { getToken } from '../src/core/tokens.js';
import { botAddress } from '../src/chain/client.js';
import { TOKENS } from '../src/constants/chain.js';
import { createLogger } from '../src/logger.js';
import type { Address, Hex } from 'viem';

const log = createLogger('repair');

/** Nothing is written unless the script is called with --write. */
const WRITE = process.argv.includes('--write');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const USDG = TOKENS.USDG.toLowerCase();

interface TokenFlow {
  /** What went to the wallet, in base units. */
  received: bigint;
  /** What went from the wallet, in base units. */
  sent: bigint;
}

async function flows(hash: Hex, token: string, wallet: string): Promise<TokenFlow> {
  const receipt = await publicClient.getTransactionReceipt({ hash });
  const flow: TokenFlow = { received: 0n, sent: 0n };
  for (const log of receipt.logs) {
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    const from = ('0x' + (log.topics[1] ?? '').slice(-40)).toLowerCase();
    const to = ('0x' + (log.topics[2] ?? '').slice(-40)).toLowerCase();
    const value = BigInt(log.data);
    if (to === wallet) flow.received += value;
    if (from === wallet) flow.sent += value;
  }
  return flow;
}

async function repair(record: ClosedRecord): Promise<boolean> {
  if (!record.swapHash || !record.txHash) return false;
  const token = record.contract?.toLowerCase();
  if (!token) return false;
  const wallet = botAddress?.toLowerCase();
  if (!wallet) {
    log.warn('no wallet configured — nothing to compare the flows against');
    return false;
  }

  // What the close put in the wallet, and what the swap took out of it again.
  const closed = await flows(record.txHash as Hex, token, wallet);
  const swapped = await flows(record.swapHash as Hex, token, wallet);
  const quote = await flows(record.txHash as Hex, USDG, wallet);

  const decimals = (await getToken(token as Address)).decimals;
  const scale = 10 ** decimals;

  // The gas the swap cost is on the record; the native amount comes from the
  // receipt, and the ETH price follows from the two.
  const receipt = await publicClient.getTransactionReceipt({ hash: record.swapHash as Hex });
  const nativeGas = receipt.gasUsed * receipt.effectiveGasPrice;
  const ethPriceUsd =
    record.swapGasUsd && nativeGas > 0n
      ? (record.swapGasUsd / Number(nativeGas)) * 1e18
      : Number.NaN;

  const accounting = swapAccounting(
    {
      ok: true,
      route: record.swapRoute === '0x' ? '0x' : 'uniswap-v3',
      hash: record.swapHash as Hex,
      receivedUsdg: BigInt(Math.round((record.swapReceivedUsd ?? 0) * 1e6)),
      gasNative: nativeGas,
      soldAmount: swapped.sent,
      note: '',
    },
    {
      withdrawnAmount: closed.received,
      decimals,
      ethPriceUsd,
      exitPrice: record.exitPrice,
      quoteUsd: Number(quote.received) / 1e6,
    },
  );

  const updated = withSwap(record, accounting);
  log.info(
    `${record.id}: net PnL ${record.pnlNetUsd?.toFixed(2) ?? '—'} → ${updated.pnlNetUsd?.toFixed(2) ?? '—'}` +
      ` (${updated.pnlNetPct?.toFixed(2) ?? '—'}%)`,
  );
  if (WRITE) await store.updateClosed(record.id, updated);
  return true;
}

async function main(): Promise<void> {
  await store.init();
  const history = store.allHistory();
  let repaired = 0;
  for (const record of history) {
    if (!record.swapHash) continue;
    if (await repair(record)) repaired++;
  }
  log.info(
    repaired === 0
      ? 'nothing to repair'
      : WRITE
        ? `repaired ${repaired} record(s)`
        : `would repair ${repaired} record(s) — run it with --write to save`,
  );
}

await main();
