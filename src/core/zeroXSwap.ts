import { isAddress, type Address, type Hex } from 'viem';
import { config } from '../config.js';
import { publicClient, requireWallet } from '../chain/client.js';
import { erc20Allowance, erc20BalanceOf, ethBalance, ensureErc20Allowance } from './wallet.js';
import { createLogger } from '../logger.js';
import { KeyedMutex } from '../utils/async.js';

const log = createLogger('zerox');

/** Robinhood Chain. */
export const ZEROX_CHAIN_ID = 4663;

/** The canonical Permit2 address. It is a valid allowance target for the
 * permit2 endpoint, but never for the allowance-holder endpoint. */
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 2;

/* --------------------------------- schema --------------------------------- */

/** The part of the 0x v2 quote response this bot relies on. */
export interface ZeroXQuote {
  zid?: string;
  liquidityAvailable?: boolean;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
  /** The minimum acceptable output, set from the requested slippage. */
  minBuyAmount?: string;
  /** The contract the token allowance has to be given to. */
  allowanceTarget?: string;
  issues?: {
    allowance?: { actual?: string; spender?: string; error?: string };
    balance?: { token?: string; actual?: string; expected?: string; error?: string };
    simulationIncomplete?: boolean;
  };
  fees?: {
    zeroExFee?: string | null;
    integratorFee?: string | null;
    gasFee?: string | null;
    integratorFees?: { amount?: string | null; token?: string | null; type?: string }[];
  };
  totalNetworkFee?: string | null;
  route?: {
    fills?: { from?: string; to?: string; source?: string; proportionBps?: number | null }[];
    tokens?: { address?: string; symbol?: string }[];
  };
  transaction?: {
    to?: string;
    data?: string;
    value?: string | null;
    gas?: string | null;
    gasPrice?: string | null;
  };
}

/** A quote that passed every check. */
export interface ValidatedQuote {
  /** The token to sell. */
  sellToken: Address;
  /** The token to buy. */
  buyToken: Address;
  /** The amount sold, in base units. */
  sellAmount: bigint;
  /** The amount bought, in base units. */
  buyAmount: bigint;
  /** The minimum acceptable output, in base units. */
  minBuyAmount: bigint;
  /** The contract that needs the token allowance. */
  allowanceTarget: Address;
  /** The contract the swap transaction is sent to. */
  entryPoint: Address;
  /** The transaction calldata. */
  data: Hex;
  /** The native value the transaction has to carry. */
  value: bigint;
  /** The gas estimate, when 0x provided one. */
  gas?: bigint;
  /** The gas price 0x assumed, in wei. */
  gasPrice?: bigint;
  /** The 0x fee, in the buy token. */
  zeroExFee: bigint;
  /**
   * The network fee 0x estimates, in the **native token** (wei) — not in the
   * buy token.
   */
  totalNetworkFee: bigint;
  /** The liquidity sources the route uses. */
  sources: string[];
}

export class ZeroXError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'no_key'
      | 'no_route'
      | 'insufficient_balance'
      | 'insufficient_allowance'
      | 'invalid_response'
      | 'rate_limited'
      | 'timeout'
      | 'api_error',
  ) {
    super(message);
    this.name = 'ZeroXError';
  }
}

/* -------------------------------- requests -------------------------------- */

function headers(): Record<string, string> {
  const key = config.zeroXApiKey;
  if (!key) throw new ZeroXError('No 0x API key configured', 'no_key');
  return { '0x-api-key': key, '0x-version': 'v2', accept: 'application/json' };
}

async function apiRequest(path: string, params: Record<string, string>): Promise<ZeroXQuote> {
  const url = new URL(`${config.zeroXApiUrl.replace(/\/$/, '')}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 429) {
        lastError = new ZeroXError('The 0x API is rate limited', 'rate_limited');
        break;
      }
      if (res.status >= 500) {
        lastError = new ZeroXError(`The 0x API answered ${res.status}`, 'api_error');
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ZeroXError(
          `The 0x API refused the quote (${res.status})${body ? `: ${body.slice(0, 160)}` : ''}`,
          'api_error',
        );
      }
      const body = (await res.json()) as ZeroXQuote;
      if (!body || typeof body !== 'object') {
        throw new ZeroXError('The 0x API returned an unreadable answer', 'invalid_response');
      }
      return body;
    } catch (err) {
      if (err instanceof ZeroXError) throw err;
      const message = String(err);
      if (/abort|timeout/i.test(message)) {
        lastError = new ZeroXError('The 0x API did not answer in time', 'timeout');
        continue;
      }
      lastError = new ZeroXError(`The 0x API could not be reached: ${message}`, 'api_error');
    }
  }
  throw lastError instanceof ZeroXError
    ? lastError
    : new ZeroXError('The 0x API could not be reached', 'api_error');
}

/* -------------------------------- validation ------------------------------ */

const bigintOr = (value: string | null | undefined): bigint => {
  if (value === undefined || value === null || value === '') return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

/**
 * Checks the quote and turns it into the values the bot needs.
 *
 * Everything the response is used for is verified here: the tokens, the
 * amounts, the route, the allowance target and the transaction payload.
 */
export function validateQuote(quote: ZeroXQuote, request: {
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  slippageBps: number;
}): ValidatedQuote {
  if (quote.liquidityAvailable === false) {
    throw new ZeroXError('0x has no liquidity for this pair', 'no_route');
  }
  if (quote.sellToken && quote.sellToken.toLowerCase() !== request.sellToken.toLowerCase()) {
    throw new ZeroXError('The 0x quote is for a different sell token', 'invalid_response');
  }
  if (quote.buyToken && quote.buyToken.toLowerCase() !== request.buyToken.toLowerCase()) {
    throw new ZeroXError('The 0x quote is for a different buy token', 'invalid_response');
  }
  const quotedSell = bigintOr(quote.sellAmount);
  if (quotedSell !== 0n && quotedSell !== request.sellAmount) {
    throw new ZeroXError('The 0x quote is for a different amount', 'invalid_response');
  }

  const buyAmount = bigintOr(quote.buyAmount);
  if (buyAmount <= 0n) {
    throw new ZeroXError('0x returned no output amount', 'no_route');
  }

  // The minimum output comes from the API; it is only computed locally when
  // the API leaves it out.
  const quotedMin = bigintOr(quote.minBuyAmount);
  const slippageFloor = (buyAmount * BigInt(10_000 - request.slippageBps)) / 10_000n;
  const minBuyAmount = quotedMin > 0n ? quotedMin : slippageFloor;
  if (minBuyAmount > buyAmount) {
    throw new ZeroXError('The 0x minimum output is above its own output', 'invalid_response');
  }

  const transaction = quote.transaction;
  if (!transaction?.to || !isAddress(transaction.to)) {
    throw new ZeroXError('The 0x quote has no transaction target', 'invalid_response');
  }
  if (!transaction.data || !transaction.data.startsWith('0x') || transaction.data.length <= 2) {
    throw new ZeroXError('The 0x quote has no transaction data', 'invalid_response');
  }

  // The allowance target has to be the contract the swap is sent to: for the
  // allowance-holder endpoint that is the AllowanceHolder itself. The Settler
  // and Permit2 are never approved.
  const spender = quote.issues?.allowance?.spender ?? quote.allowanceTarget;
  if (!spender || !isAddress(spender)) {
    throw new ZeroXError('The 0x quote has no allowance target', 'invalid_response');
  }
  if (spender.toLowerCase() === PERMIT2.toLowerCase()) {
    throw new ZeroXError('The 0x quote asks for a Permit2 allowance', 'invalid_response');
  }
  if (spender.toLowerCase() !== transaction.to.toLowerCase()) {
    throw new ZeroXError('The 0x allowance target is not the entry point', 'invalid_response');
  }

  const balanceError = quote.issues?.balance?.error;
  if (balanceError) {
    throw new ZeroXError(`0x reports a balance problem: ${balanceError}`, 'insufficient_balance');
  }
  const allowanceError = quote.issues?.allowance?.error;
  if (allowanceError && !/INSUFFICIENT_ALLOWANCE/i.test(allowanceError)) {
    throw new ZeroXError(`0x reports an allowance problem: ${allowanceError}`, 'insufficient_allowance');
  }

  const gas = transaction.gas ? bigintOr(transaction.gas) : undefined;
  const gasPrice = transaction.gasPrice ? bigintOr(transaction.gasPrice) : undefined;
  return {
    sellToken: request.sellToken,
    buyToken: request.buyToken,
    sellAmount: request.sellAmount,
    buyAmount,
    minBuyAmount,
    allowanceTarget: spender as Address,
    entryPoint: transaction.to,
    data: transaction.data as Hex,
    value: bigintOr(transaction.value),
    gas,
    gasPrice,
    zeroExFee: bigintOr(quote.fees?.zeroExFee),
    totalNetworkFee: bigintOr(quote.totalNetworkFee),
    sources: (quote.route?.fills ?? [])
      .map((fill) => fill.source)
      .filter((source): source is string => Boolean(source))
      .filter((source, index, all) => all.indexOf(source) === index),
  };
}

/* ---------------------------------- quote --------------------------------- */

/** Asks 0x for a firm quote. */
export async function quoteZeroXSwap(request: {
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  taker: Address;
  slippageBps: number;
}): Promise<ValidatedQuote> {
  if (!config.zeroXApiKey) throw new ZeroXError('No 0x API key configured', 'no_key');
  if (request.sellAmount <= 0n) throw new ZeroXError('Nothing to swap', 'no_route');

  const quote = await apiRequest(`/swap/allowance-holder/quote`, {
    chainId: String(ZEROX_CHAIN_ID),
    sellToken: request.sellToken,
    buyToken: request.buyToken,
    sellAmount: request.sellAmount.toString(),
    taker: request.taker,
    slippageBps: String(Math.max(0, Math.round(request.slippageBps))),
  });

  const validated = validateQuote(quote, {
    sellToken: request.sellToken,
    buyToken: request.buyToken,
    sellAmount: request.sellAmount,
    slippageBps: request.slippageBps,
  });
  log.info(
    `0x quote: ${validated.sellAmount} → ${validated.buyAmount} via ${validated.sources.join(', ') || 'unknown'}`,
  );
  return validated;
}

/** The price endpoint: the same route without the transaction. */
export async function priceZeroXSwap(request: {
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  taker: Address;
  slippageBps: number;
}): Promise<ValidatedQuote> {
  if (!config.zeroXApiKey) throw new ZeroXError('No 0x API key configured', 'no_key');
  const quote = await apiRequest(`/swap/allowance-holder/price`, {
    chainId: String(ZEROX_CHAIN_ID),
    sellToken: request.sellToken,
    buyToken: request.buyToken,
    sellAmount: request.sellAmount.toString(),
    taker: request.taker,
    slippageBps: String(Math.max(0, Math.round(request.slippageBps))),
  });
  return validateQuote(quote, {
    sellToken: request.sellToken,
    buyToken: request.buyToken,
    sellAmount: request.sellAmount,
    slippageBps: request.slippageBps,
  });
}

/* ------------------------------ swap states ------------------------------- */

export type SwapState = 'pending' | 'submitted' | 'confirmed' | 'failed';

interface SwapRecord {
  state: SwapState;
  hash?: Hex;
  error?: string;
  updatedAt: number;
}

/** One swap per closed position: the state survives a timeout. */
const states = new Map<string, SwapRecord>();
/** One swap at a time per closed position. */
const locks = new KeyedMutex();

function stateOf(key: string): SwapRecord | undefined {
  return states.get(key);
}

/**
 * True when a transaction for this swap already went out.
 *
 * The Uniswap v3 fallback is only allowed while nothing was submitted: after
 * that the tokens may already be gone.
 */
export function swapWasSubmitted(key: string): boolean {
  const state = stateOf(key);
  return state?.state === 'submitted' || Boolean(state?.hash);
}

/* -------------------------------- execute --------------------------------- */

export interface SwapResult {
  ok: boolean;
  /** The route that was used. */
  route: '0x' | 'uniswap-v3';
  hash?: Hex;
  /** The USDG received, when it is known. */
  receivedUsdg?: bigint;
  /** The estimated gas cost in native units. */
  gasNative?: bigint;
  /** A human-readable summary for the close receipt. */
  note: string;
  error?: string;
}

/**
 * Runs a quoted swap: the approval, the gas check and the transaction.
 *
 * The transaction is only sent once per closed position: a state that is
 * already submitted is reconciled through its receipt instead.
 */
export async function executeZeroXSwap(
  quote: ValidatedQuote,
  options: { owner: Address; dryRun: boolean; key: string },
): Promise<SwapResult> {
  return locks.run(options.key, async () => {
    const existing = stateOf(options.key);
    if (existing?.hash) {
      // Something was already submitted: reconcile before doing anything.
      const receipt = await publicClient
        .getTransactionReceipt({ hash: existing.hash })
        .catch(() => undefined);
      if (receipt) {
        const state: SwapState = receipt.status === 'success' ? 'confirmed' : 'failed';
        states.set(options.key, { state, hash: existing.hash, updatedAt: Date.now() });
        return receipt.status === 'success'
          ? { ok: true, route: '0x', hash: existing.hash, note: 'The swap was already confirmed.' }
          : {
              ok: false,
              route: '0x',
              hash: existing.hash,
              note: 'The earlier swap reverted.',
              error: 'the earlier swap reverted',
            };
      }
    }
    if (existing?.state === 'confirmed') {
      return { ok: true, route: '0x', hash: existing.hash, note: 'The swap was already confirmed.' };
    }

    states.set(options.key, { state: 'pending', updatedAt: Date.now() });

    try {
      // The allowance: only the verified target, and only for what is sold.
      const allowance = await erc20Allowance(quote.sellToken, quote.allowanceTarget, options.owner);
      if (allowance < quote.sellAmount) {
        await ensureErc20Allowance(
          quote.sellToken,
          quote.allowanceTarget,
          quote.sellAmount,
          options.owner,
          options.dryRun,
        );
      }

      if (options.dryRun) {
        try {
          await publicClient.call({
            account: options.owner,
            to: quote.entryPoint,
            data: quote.data,
            value: quote.value,
          });
        } catch (err) {
          // The allowance is not set in a dry run, so a revert here is
          // expected; the quote is what matters.
          log.info(`dry-run swap simulation reverted: ${String(err).slice(0, 120)}`);
        }
        states.set(options.key, { state: 'confirmed', updatedAt: Date.now() });
        return {
          ok: true,
          route: '0x',
          receivedUsdg: quote.buyAmount,
          note:
            `🧪 Would swap ${quote.sellAmount} → ${quote.buyAmount} USDG` +
            ` via ${quote.sources.join(', ') || '0x'}` +
            `${quote.zeroExFee > 0n ? ` (0x fee ${quote.zeroExFee})` : ''}.`,
        };
      }

      // The gas has to be there before the transaction is signed.
      const gasLimit = quote.gas ?? 400_000n;
      const gasPrice = await publicClient
        .estimateFeesPerGas()
        .then((fees) => fees.maxFeePerGas ?? fees.gasPrice ?? 0n)
        .catch(() => 0n);
      const gasCost = gasPrice > 0n ? gasLimit * gasPrice : 0n;
      const balance = await ethBalance(options.owner);
      if (gasCost > 0n && balance < gasCost + quote.value) {
        throw new Error('not enough ETH for the gas');
      }

      const usdgBefore = await erc20BalanceOf(quote.buyToken, options.owner);

      const { walletClient, account } = requireWallet();
      const hash = await walletClient.sendTransaction({
        account,
        chain: walletClient.chain,
        to: quote.entryPoint,
        data: quote.data,
        value: quote.value,
        gas: gasLimit,
      });
      states.set(options.key, { state: 'submitted', hash, updatedAt: Date.now() });

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== 'success') {
        states.set(options.key, { state: 'failed', hash, error: 'reverted', updatedAt: Date.now() });
        return {
          ok: false,
          route: '0x',
          hash,
          // A reverted swap still cost its gas.
          gasNative: receipt.gasUsed * receipt.effectiveGasPrice,
          note: 'The 0x swap reverted — the tokens stayed in your wallet.',
          error: 'the swap reverted',
        };
      }

      // The receipt alone is not proof: the USDG has to be in the wallet.
      const usdgAfter = await erc20BalanceOf(quote.buyToken, options.owner);
      const received = usdgAfter > usdgBefore ? usdgAfter - usdgBefore : 0n;
      if (received <= 0n) {
        states.set(options.key, { state: 'failed', hash, error: 'no USDG received', updatedAt: Date.now() });
        return {
          ok: false,
          route: '0x',
          hash,
          note: '⚠️ The swap went through but no USDG arrived — check the wallet.',
          error: 'no USDG received',
        };
      }
      states.set(options.key, { state: 'confirmed', hash, updatedAt: Date.now() });
      const gasNative = receipt.gasUsed * receipt.effectiveGasPrice;
      const feeNote = quote.zeroExFee > 0n ? ` · 0x fee ${quote.zeroExFee}` : '';
      const gasNote = gasNative > 0n ? ` · gas ${gasNative} wei` : '';
      return {
        ok: true,
        route: '0x',
        hash,
        receivedUsdg: received,
        gasNative,
        note:
          `💱 Swapped ${quote.sources.join(', ') || 'via 0x'} → ${received} USDG` +
          ` (est. ${quote.buyAmount} USDG${feeNote}${gasNote}, tx ${hash.slice(0, 10)}…).`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const previous = stateOf(options.key);
      states.set(options.key, {
        state: previous?.hash ? 'submitted' : 'failed',
        hash: previous?.hash,
        error: message,
        updatedAt: Date.now(),
      });
      return {
        ok: false,
        route: '0x',
        hash: previous?.hash,
        note: `⚠️ The 0x swap failed: ${message}`,
        error: message,
      };
    }
  });
}
