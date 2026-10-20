import type { Address } from 'viem';
import { store, type CloseReason, type ClosedRecord, type TrackedPosition } from '../store/store.js';
import type { PositionSnapshot } from './positions.js';
import type { PnlSummary, Valuation } from './valuation.js';
import { usdIdrRate, usdSolRate } from './fx.js';
import { marketCapUsd } from './scanner.js';
import { tickToPrice } from './math/tickMath.js';
import { positionPair, tradedPrice, tradedToken } from './pairs.js';
import type { SwapOutcome } from './swap.js';
import { TOKENS, CHAINS } from '../constants/chain.js';
import { publicClient } from '../chain/client.js';
import { usdPrice } from './prices.js';
import { gmgnKline, type GmgnCandle } from './gmgn.js';
import { createLogger } from '../logger.js';

const log = createLogger('history');

interface CloseRecordInput {
  tracked: TrackedPosition;
  snapshot: PositionSnapshot;
  valuation: Valuation;
  pnl: PnlSummary;
  reason: CloseReason;
  dryRun: boolean;
  txHash?: string;
  /** The chat's display currency at close time. */
  currency?: 'USD' | 'IDR' | 'SOL';
}

/**
 * The gas a transaction cost, in USD.
 *
 * The chain's native token is ETH, priced through WETH. The price is passed in
 * so the open's gas can be priced at the time it was spent. Anything that
 * cannot be measured stays NaN, so the card can say "N/A" instead of
 * guessing.
 */
async function gasUsd(txHash: string | undefined, ethPriceUsd: number): Promise<number> {
  if (!txHash) return Number.NaN;
  if (!Number.isFinite(ethPriceUsd) || ethPriceUsd <= 0) return Number.NaN;
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
    const gas = Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice);
    if (!Number.isFinite(gas) || gas <= 0) return Number.NaN;
    return (gas / 1e18) * ethPriceUsd;
  } catch (err) {
    log.warn(`could not read the gas of ${txHash}: ${String(err)}`);
    return Number.NaN;
  }
}

/**
 * The gas of a transaction, or zero when it was never sent.
 *
 * A dry run spends nothing, so the cost is zero and not unknown. An
 * imported position has no entry transaction, so its open gas is unknown —
 * and an unknown cost is never counted as zero.
 */
async function transactionGasUsd(
  txHash: string | undefined,
  ethPriceUsd: number,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) return 0;
  return gasUsd(txHash, ethPriceUsd);
}

/**
 * The price path of the position, for the PnL card.
 *
 * GMGN's candles are used when a key is configured, so the card shows real
 * candles. The bot's own samples are the fallback. Either way the path is
 * frozen here, so the card never changes afterwards.
 */
async function capturePricePath(
  token: Address,
  from: number,
  to: number,
  fallback: { t: number; p: number }[] | undefined,
): Promise<{ t: number; p: number }[] | undefined> {
  const span = to - from;
  const resolution = span < 2 * 3_600_000 ? '15m' : span < 2 * 86_400_000 ? '1h' : '4h';
  const candles = await gmgnKline(token, { chain: 'robinhood', resolution, from, to }).catch((err) => {
    log.warn(`could not read the GMGN candles: ${String(err).slice(0, 120)}`);
    return [] as GmgnCandle[];
  });
  const samples = candles
    .filter((candle) => candle.time >= from && candle.time <= to && candle.close > 0)
    .map((candle) => ({ t: candle.time, p: candle.close }));
  return samples.length > 0 ? samples : fallback;
}

/**
 * Freezes a finished position into the history. The IDR rate is captured here
 * so a later FX move can never rewrite an old record.
 */
export async function recordClose(input: CloseRecordInput): Promise<ClosedRecord> {
  const { tracked, snapshot, valuation, pnl, reason, dryRun, txHash } = input;
  const idrRate = await usdIdrRate().catch(() => Number.NaN);
  const solRateUsd = await usdSolRate().catch(() => Number.NaN);

  // Everything the PnL card shows is captured now, so the card can be
  // regenerated later without changing.
  const traded = tradedToken(snapshot);
  const exitMcapUsd = await marketCapUsd(traded).catch(() => Number.NaN);

  // The gas of the whole round trip: the open, the close and (later) the
  // swap. The open is priced with the ETH price of the moment it was spent.
  const ethPriceNow = await usdPrice(TOKENS.WETH).catch(() => Number.NaN);
  const ethPriceAtOpen = tracked.entry.ethPriceUsd ?? ethPriceNow;
  const openGasUsd = await transactionGasUsd(tracked.entry.txHash, ethPriceAtOpen, dryRun);
  const closeGasUsd = await transactionGasUsd(txHash, ethPriceNow, dryRun);
  // A part that is unknown makes the total unknown: an unknown cost is never
  // counted as zero. A dry run spends nothing, so its total is zero.
  const gasKnown = Number.isFinite(openGasUsd) && Number.isFinite(closeGasUsd);
  const feesAndGasUsd = gasKnown ? openGasUsd + closeGasUsd : Number.NaN;

  const range = tracked.range;
  const rangePriceLower = range
    ? tickToPrice(range.tickLower, snapshot.token0.decimals, snapshot.token1.decimals)
    : undefined;
  const rangePriceUpper = range
    ? tickToPrice(range.tickUpper, snapshot.token0.decimals, snapshot.token1.decimals)
    : undefined;

  const record = await store.addClosed({
    chatId: tracked.chatId,
    version: snapshot.version,
    tokenId: tracked.tokenId,
    pair: positionPair(snapshot),
    fee: snapshot.fee,
    reason,
    entryPrice: tracked.entry.price,
    // The exit price is the traded token's own price, the same unit the
    // entry price is in: the pool price is inverted for a pool that stores
    // the traded token as token1.
    exitPrice: tradedPrice(snapshot, snapshot.price),
    entryValueUsd: tracked.entry.valueUsd,
    exitValueUsd: valuation.principalUsd + valuation.feesUsd,
    pnlUsd: pnl.totalPnlUsd,
    pnlPct: pnl.totalPnlPct,
    feesUsd: pnl.feesEarnedUsd,
    idrRate,
    openedAt: tracked.entry.openedAt,
    closedAt: Date.now(),
    txHash,
    cycle: tracked.cycle,
    dryRun,
    basisUsd: tracked.basisUsd,
    feesAndGasUsd,
    openGasUsd: Number.isFinite(openGasUsd) ? openGasUsd : undefined,
    closeGasUsd: Number.isFinite(closeGasUsd) ? closeGasUsd : undefined,
    entryMcapUsd: tracked.entryMcapUsd,
    exitMcapUsd: Number.isFinite(exitMcapUsd) ? exitMcapUsd : undefined,
    rangeLabel: tracked.rangeLabel,
    strategy: tracked.strategy,
    currency: input.currency ?? 'USD',
    solRateUsd: Number.isFinite(solRateUsd) ? solRateUsd : undefined,
    priceSamples: await capturePricePath(
      traded.address,
      tracked.entry.openedAt,
      Date.now(),
      tracked.priceSamples,
    ),
    rangePriceLower,
    rangePriceUpper,
    contract: traded.address,
    chain: CHAINS.robinhood.id,
  });

  log.info(
    `${tracked.id} closed (${reason}) · pnl $${pnl.totalPnlUsd.toFixed(2)} · ${record.id}`,
  );
  return record;
}

/**
 * The gas of the whole round trip: the open, the close and the swap.
 *
 * NaN when a part is unknown — an imported position has no entry
 * transaction — so the card can say "N/A" instead of a number that is not the
 * whole truth. A dry run spent nothing, so its total is zero.
 */
export function gasTotalUsd(record: ClosedRecord): number {
  // The open and the close always happened. The swap only happened when the
  // record says so, and its gas is then known too.
  const parts = [record.openGasUsd, record.closeGasUsd];
  if (parts.some((part) => part === undefined || !Number.isFinite(part))) return Number.NaN;
  if (record.swapRoute !== undefined) {
    const swap = record.swapGasUsd;
    if (swap === undefined || !Number.isFinite(swap)) return Number.NaN;
    parts.push(swap);
  }
  return parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

/** What a swap did to the proceeds of a closed position. */
export interface SwapAccounting {
  /** The route the swap took. */
  route: '0x' | 'uniswap-v3';
  /** The swap transaction. */
  hash?: string;
  /** The USDG the swap delivered, in USD. */
  receivedUsd: number;
  /** The gas the swap cost, in USD. */
  gasUsd: number;
  /**
   * The fee the provider charged, in USD. It is already netted out of the
   * received amount, so it is never subtracted a second time.
   */
  feeUsd?: number;
  /** The value of the token that was not swapped, in USD. */
  leftoverUsd: number;
}

/**
 * Turns a swap into the numbers a closed record needs.
 *
 * The token that was not swapped is valued at the rate the swap actually
 * got, so the leftover is worth what the swap would have paid for it.
 */
export function swapAccounting(
  outcome: SwapOutcome,
  input: {
    /** The token amount that was withdrawn into the wallet, in base units. */
    withdrawnAmount: bigint;
    /** The token's decimals. */
    decimals: number;
    /** The ETH price, to turn the native gas into USD. */
    ethPriceUsd: number;
    /**
     * The token's price at the close, used when the swap delivered nothing —
     * a swap that failed leaves the whole withdrawal in the wallet.
     */
    exitPrice?: number;
  },
): SwapAccounting {
  // Only a swap that went through sold anything; a failed one left the
  // whole withdrawal in the wallet.
  const sold = outcome.ok ? outcome.soldAmount ?? 0n : 0n;
  const leftover = input.withdrawnAmount > sold ? input.withdrawnAmount - sold : 0n;
  const scale = 10 ** input.decimals;
  const soldHuman = Number(sold) / scale;
  const leftoverHuman = Number(leftover) / scale;
  const receivedUsd = outcome.receivedUsdg !== undefined ? Number(outcome.receivedUsdg) / 1e6 : Number.NaN;
  const rate = soldHuman > 0 && Number.isFinite(receivedUsd) ? receivedUsd / soldHuman : Number.NaN;

  const gasNative = outcome.gasNative ?? 0n;
  const gasUsd = Number.isFinite(input.ethPriceUsd) ? (Number(gasNative) / 1e18) * input.ethPriceUsd : Number.NaN;

  // A swap that delivered nothing left the whole withdrawal in the wallet:
  // it is worth the price it had at the close.
  const exitPrice = input.exitPrice ?? Number.NaN;
  const leftoverUsd = Number.isFinite(rate)
    ? leftoverHuman * rate
    : Number.isFinite(exitPrice)
      ? leftoverHuman * exitPrice
      : Number.NaN;

  return {
    route: outcome.route,
    hash: outcome.hash,
    receivedUsd,
    gasUsd: Number.isFinite(gasUsd) ? gasUsd : Number.NaN,
    feeUsd: outcome.feeUsd,
    leftoverUsd,
  };
}

/**
 * Adds a swap to a closed record: what it cost, what it delivered and the
 * PnL that is left after every cost.
 *
 * The frozen values of the record are not touched — the swap only adds what
 * happened after the close.
 */
export function withSwap(
  record: ClosedRecord,
  swap: SwapAccounting,
): Partial<ClosedRecord> {
  const basis = record.basisUsd ?? record.entryValueUsd;
  const openGas = record.openGasUsd ?? Number.NaN;
  const closeGas = record.closeGasUsd ?? Number.NaN;
  const swapGas = swap.gasUsd;
  const known =
    Number.isFinite(openGas) && Number.isFinite(closeGas) && Number.isFinite(swapGas);

  // What the position is worth now: the USDG the swap delivered plus the
  // token that was not swapped.
  const finalValueUsd = swap.receivedUsd + swap.leftoverUsd;
  // The PnL after every cost. A cost that is unknown leaves the PnL unknown
  // rather than pretending it was free.
  const pnlNetUsd =
    known && Number.isFinite(basis) ? finalValueUsd - openGas - closeGas - swapGas - basis : Number.NaN;
  const pnlNetPct =
    known && Number.isFinite(basis) && basis > 0 ? (pnlNetUsd / basis) * 100 : Number.NaN;

  const gasTotal = known ? openGas + closeGas + swapGas : Number.NaN;

  return {
    swapRoute: swap.route,
    swapHash: swap.hash,
    swapReceivedUsd: Number.isFinite(swap.receivedUsd) ? swap.receivedUsd : undefined,
    swapGasUsd: Number.isFinite(swapGas) ? swapGas : undefined,
    swapFeeUsd: swap.feeUsd !== undefined && Number.isFinite(swap.feeUsd) ? swap.feeUsd : undefined,
    feesAndGasUsd: Number.isFinite(gasTotal) ? gasTotal : undefined,
    pnlNetUsd: Number.isFinite(pnlNetUsd) ? pnlNetUsd : undefined,
    pnlNetPct: Number.isFinite(pnlNetPct) ? pnlNetPct : undefined,
  };
}
