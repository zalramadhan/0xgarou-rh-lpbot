import type { Address, Hex } from 'viem';
import { encodeFunctionData } from 'viem';
import { publicClient, requireWallet } from '../chain/client.js';
import { CONTRACTS, TOKENS } from '../constants/chain.js';
import { v3SwapRouter02Abi } from '../constants/abis.js';
import { createLogger } from '../logger.js';
import { applySlippageDown } from '../utils/format.js';
import { isRevertError } from '../utils/errors.js';
import { findPools } from './pools.js';
import { usdPrice } from './prices.js';
import { quoteV3 } from './quoter.js';
import type { TokenInfo } from './tokens.js';
import { ensureErc20Allowance, erc20BalanceOf } from './wallet.js';
import type { TxOutcome } from './actions.js';
import {
  executeZeroXSwap,
  quoteZeroXSwap,
  swapWasSubmitted,
  ZeroXError,
  type ValidatedQuote,
} from './zeroXSwap.js';

const log = createLogger('swap');

/**
 * How far below the market a route may be priced before the swap is
 * refused. A healthy route on a thin token is one to one and a half percent
 * off; three percent is already a bad route.
 */
const MAX_ROUTE_DISCOUNT_PCT = 3;

/**
 * How far below the market a route is priced, in percent.
 *
 * A negative number means the route is *better* than the market. NaN when
 * either price is unknown — then the route is not judged.
 */
export function routeDiscountPct(impliedUsd: number, marketUsd: number): number {
  if (!Number.isFinite(impliedUsd) || impliedUsd <= 0) return Number.NaN;
  if (!Number.isFinite(marketUsd) || marketUsd <= 0) return Number.NaN;
  return ((marketUsd - impliedUsd) / marketUsd) * 100;
}

interface SwapPlan {
  poolFee: number;
  amountIn: bigint;
  quotedOut: bigint;
  minOut: bigint;
}

/**
 * Picks the deepest v3 pool the token has against USDG and quotes the swap.
 * Only v3 is routed: the v4 router on this chain is not the standard Quoter,
 * so a v4-only token is reported as "no route" instead of guessed at.
 *
 * This is the **fallback** route: 0x is the primary one, and this is only
 * used when 0x has no quote for the pair.
 */
export async function planUsdgSwap(
  token: TokenInfo,
  amountIn: bigint,
  slippagePct: number,
): Promise<SwapPlan | undefined> {
  if (amountIn <= 0n) return undefined;
  const pools = (await findPools(token.address, TOKENS.USDG)).filter((p) => p.version === 'v3');
  if (pools.length === 0) return undefined;

  const best = pools.sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1))[0]!;
  if (best.version !== 'v3') return undefined;

  try {
    const quotedOut = await quoteV3(token.address, TOKENS.USDG, amountIn, best.fee);
    if (quotedOut === 0n) return undefined;
    return {
      poolFee: best.fee,
      amountIn,
      quotedOut,
      minOut: applySlippageDown(quotedOut, slippagePct),
    };
  } catch (err) {
    log.warn(`quote failed for ${token.symbol} → USDG: ${String(err)}`);
    return undefined;
  }
}

/**
 * The routes a swap can take.
 *
 * - `0x` — the 0x Swap API (AllowanceHolder), which aggregates the liquidity
 *   of the chain.
 * - `uniswap-v3` — a Uniswap v3 pool against USDG.
 */
export type SwapRoute = '0x' | 'uniswap-v3';

export const SWAP_ROUTE_LABEL: Record<SwapRoute, string> = {
  '0x': '0x API',
  'uniswap-v3': 'V3 Pool',
};

/**
 * Swaps the position's own token proceeds into USDG.
 *
 * With `route: 'auto'` (the default) 0x is tried first and the Uniswap v3
 * route is the fallback for the pairs 0x cannot quote — but only when the 0x
 * quote failed *before* anything was submitted.
 *
 * With an explicit route **only that route is used**: a failure is reported
 * as a failure and never retried through the other route.
 */
export async function swapProceedsToUsdg(options: {
  token: TokenInfo;
  amount: bigint;
  owner: Address;
  slippagePct: number;
  dryRun: boolean;
  /** The closed position, used to make the swap idempotent. */
  key: string;
  /** The USD value of what would be sold, used for the threshold check. */
  valueUsd: number;
  /** The smallest swap worth making, in USD. */
  minUsd: number;
  /** The price of the buy token in USD, for the fee and gas accounting. */
  buyTokenUsd: number;
  /**
   * The market price of the token that is sold, in USD.
   *
   * A route that is priced far below the market is not a route — it is a loss
   * that looks like a swap. The tokens stay in the wallet instead.
   */
  sellTokenUsd?: number;
  /** The route to use. `auto` tries 0x first and falls back to v3. */
  route?: SwapRoute | 'auto';
}): Promise<SwapOutcome> {
  const { token, amount, owner, slippagePct, dryRun, key } = options;
  const route = options.route ?? 'auto';

  // Nothing worth swapping: skip before spending an API call.
  if (options.valueUsd < options.minUsd) {
    return {
      ok: false,
      route: route === 'auto' ? '0x' : route,
      skipped: true,
      note: `🏏 ${token.symbol} proceeds are below $${options.minUsd.toFixed(2)} — the tokens stayed in your wallet.`,
    };
  }

  // The wallet may hold less than the position did.
  const balance = await erc20BalanceOf(token.address, owner).catch(() => 0n);
  if (balance <= 0n) {
    return { ok: false, route: route === 'auto' ? '0x' : route, skipped: true, note: '🏏 Nothing to swap.' };
  }
  const sellAmount = balance < amount ? balance : amount;

  if (route === 'uniswap-v3') {
    return swapViaV3(token, sellAmount, owner, dryRun, slippagePct);
  }

  const viaZeroX = await swapViaZeroX(options, sellAmount);
  if (route === '0x') {
    // The user picked the 0x route: a failure stays a failure.
    return viaZeroX;
  }

  // `auto`: the v3 route is the fallback, but only when the 0x quote failed
  // before anything was submitted.
  if (viaZeroX.ok || viaZeroX.submitted) return viaZeroX;
  const fallback = await swapViaV3(token, sellAmount, owner, dryRun, slippagePct);
  if (fallback.ok) {
    return {
      ...fallback,
      note: `${fallback.note} (0x had no route: ${viaZeroX.error ?? 'unknown'})`,
    };
  }
  return { ...viaZeroX, note: `${viaZeroX.note} ${fallback.note}` };
}

/** The 0x route: quote, check the economics, then send. */
async function swapViaZeroX(
  options: {
    token: TokenInfo;
    owner: Address;
    dryRun: boolean;
    key: string;
    slippagePct: number;
    minUsd: number;
    buyTokenUsd: number;
    /** The market price of the sold token, in USD. */
    sellTokenUsd?: number;
  },
  sellAmount: bigint,
): Promise<SwapOutcome & { submitted?: boolean }> {
  const { token, owner, dryRun, key } = options;
  const slippagePct = options.slippagePct;

  try {
    const quote = await quoteZeroXSwap({
      sellToken: token.address,
      buyToken: TOKENS.USDG,
      sellAmount,
      taker: owner,
      slippageBps: Math.round(slippagePct * 100),
    });

    // The swap has to be worth its gas: the output minus the 0x fee and the
    // estimated gas. The 0x fee is in the buy token, the network fee and the
    // gas in the native token.
    const usdgScale = 1e6;
    const feeValue = Number(quote.zeroExFee) / usdgScale;
    const nativeGas =
      (quote.gas && quote.gasPrice ? Number(quote.gas) * Number(quote.gasPrice) : 0) +
      Number(quote.totalNetworkFee);
    let gasValue = 0;
    if (nativeGas > 0) {
      const ethUsd = await usdPrice(TOKENS.WETH).catch(() => Number.NaN);
      if (Number.isFinite(ethUsd)) gasValue = (nativeGas / 1e18) * ethUsd;
    }
    const outputValue = (Number(quote.buyAmount) / usdgScale) * options.buyTokenUsd;
    const netUsd = outputValue - feeValue - gasValue;
    if (!Number.isFinite(netUsd) || netUsd < options.minUsd) {
      return {
        ok: false,
        route: '0x',
        skipped: true,
        quote,
        note: `🏏 After the 0x fees and the gas the swap is worth less than $${options.minUsd.toFixed(2)} — the tokens stayed in your wallet.`,
      };
    }

    // The route has to be near the market: the quote's own rate against the
    // live price of the pool. A thin route can quote 5-10% below, and taking
    // it would quietly cost a tenth of the position.
    const market = options.sellTokenUsd;
    if (market !== undefined && Number.isFinite(market) && market > 0) {
      const soldHuman = Number(quote.sellAmount) / 10 ** token.decimals;
      const boughtUsd = (Number(quote.buyAmount) / 1e6) * options.buyTokenUsd;
      const impliedUsd = soldHuman > 0 ? boughtUsd / soldHuman : Number.NaN;
      const below = routeDiscountPct(impliedUsd, market);
      if (Number.isFinite(below)) {
        if (below > MAX_ROUTE_DISCOUNT_PCT) {
          return {
            ok: false,
            route: '0x',
            skipped: true,
            quote,
            note:
              `🏏 The 0x route is ${below.toFixed(1)}% below the market ($${impliedUsd.toFixed(6)} against $${market.toFixed(6)})` +
              ' — the tokens stayed in your wallet.',
            error: 'the route is too far below the market',
          };
        }
      }
    }

    const result = await executeZeroXSwap(quote, { owner, dryRun, key });
    // A hash means a transaction went out: the v3 fallback is only allowed
    // while nothing has been submitted.
    return { ...result, quote, submitted: Boolean(result.hash) };
  } catch (err) {
    const reason = err instanceof ZeroXError ? err.reason : 'api_error';
    if (reason === 'no_key') {
      log.info('no 0x API key: using the Uniswap v3 route');
    } else {
      log.warn(`0x quote failed (${reason}): ${String(err).slice(0, 160)}`);
    }
    return {
      ok: false,
      route: '0x',
      // A transaction that went out before the failure means the tokens may
      // already be gone: the v3 fallback must not run.
      submitted: swapWasSubmitted(key),
      note: `⚠️ The 0x API could not swap ${token.symbol} → USDG (${reason}).`,
      error: reason,
    };
  }
}

/** The Uniswap v3 route: the deepest USDG pool, quoted and sent. */
async function swapViaV3(
  token: TokenInfo,
  sellAmount: bigint,
  owner: Address,
  dryRun: boolean,
  slippagePct: number,
): Promise<SwapOutcome> {
  const plan = await planUsdgSwap(token, sellAmount, slippagePct);
  if (!plan) {
    return {
      ok: false,
      route: 'uniswap-v3',
      note: `⚠️ No V3 pool to swap ${token.symbol} into USDG.`,
      error: 'no route',
    };
  }
  const result = await swapToUsdg(token, plan, owner, dryRun);
  return {
    ok: !result.error,
    route: 'uniswap-v3',
    hash: result.hash,
    receivedUsdg: result.receivedUsdg,
    gasNative: result.gasNative,
    soldAmount: result.soldAmount,
    note: result.error
      ? `⚠️ The V3 swap of ${token.symbol} failed: ${result.error}`
      : `💱 Swapped ${token.symbol} → USDG via the V3 pool.`,
    error: result.error,
  };
}

export interface SwapOutcome {
  ok: boolean;
  /** The route that was used. */
  route: '0x' | 'uniswap-v3';
  /** True when the swap was skipped on purpose. */
  skipped?: boolean;
  hash?: Hex;
  /** The quote, when 0x provided one. */
  quote?: ValidatedQuote;
  /** The USDG the swap delivered, in base units. */
  receivedUsdg?: bigint;
  /** The gas the swap cost, in native units. */
  gasNative?: bigint;
  /**
   * The fee the provider charged, in USD. It is already netted out of the
   * received amount, so it is never subtracted a second time.
   */
  feeUsd?: number;
  /** The token amount that was sold, in base units. */
  soldAmount?: bigint;
  /** A human-readable summary for the close receipt. */
  note: string;
  error?: string;
}

/**
 * Swaps the position's own token proceeds into USDG through SwapRouter02.
 * In dry-run the call is simulated and never sent; a shortfall or a revert is
 * reported, and the tokens simply stay in the wallet.
 */
export async function swapToUsdg(
  token: TokenInfo,
  plan: SwapPlan,
  owner: Address,
  dryRun: boolean,
): Promise<TxOutcome> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const data = encodeFunctionData({
    abi: v3SwapRouter02Abi,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: token.address,
        tokenOut: TOKENS.USDG,
        fee: plan.poolFee,
        recipient: owner,
        amountIn: plan.amountIn,
        amountOutMinimum: plan.minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  try {
    await ensureErc20Allowance(token.address, CONTRACTS.v3SwapRouter02, plan.amountIn, owner, dryRun);
  } catch (err) {
    return { dryRun, error: `approval failed: ${String(err)}` };
  }

  if (dryRun) {
    try {
      await publicClient.call({ account: owner, to: CONTRACTS.v3SwapRouter02, data });
      return { dryRun: true };
    } catch (err) {
      return { dryRun: true, error: isRevertError(err) ? 'simulated swap reverted' : String(err) };
    }
  }

  const { walletClient, account } = requireWallet();
  // What arrived and what it cost are read from the chain, not estimated.
  const usdgBefore = await erc20BalanceOf(TOKENS.USDG, owner).catch(() => 0n);
  try {
    const hash: Hex = await walletClient.sendTransaction({
      account,
      chain: walletClient.chain,
      to: CONTRACTS.v3SwapRouter02,
      data,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') return { dryRun: false, hash, error: 'swap transaction reverted' };
    log.info(`swapped ${token.symbol} → USDG for ${owner}`);
    const usdgAfter = await erc20BalanceOf(TOKENS.USDG, owner).catch(() => usdgBefore);
    const received = usdgAfter > usdgBefore ? usdgAfter - usdgBefore : 0n;
    const gasNative = receipt.gasUsed * receipt.effectiveGasPrice;
    return { dryRun: false, hash, receivedUsdg: received, gasNative, soldAmount: plan.amountIn };
  } catch (err) {
    return { dryRun: false, error: String(err) };
  }
}
