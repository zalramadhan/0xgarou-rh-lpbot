import { createPublicClient, createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { config } from '../config.js';
import { robinhoodChain } from '../constants/chain.js';

/**
 * Public Robinhood Chain RPCs start returning "method eth_call is temporarily
 * unavailable" when a burst of calls lands at once, so every HTTP request goes
 * through a small FIFO gate. Retries live in `retryRpc`.
 */
let activeRequests = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (activeRequests < config.rpcMaxConcurrency) {
    activeRequests++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeRequests++;
}

function release(): void {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = waiters.shift();
  if (next) next();
}

/* ----------------------------- RPC rotation ------------------------------ */

/**
 * The RPCs the bot talks to, in the order they should be used.
 *
 * A provider that answers "429", a 5xx, or drops the connection is put aside
 * for a minute and the next one takes over, so a rate-limited endpoint does
 * not slow every call down. The endpoint that answered last stays in use.
 */
const RPC_COOLDOWN_MS = 60_000;
let activeRpc = 0;
const coolingUntil = new Map<number, number>();

/** The methods that change the chain: their requests must never be sent twice. */
const WRITE_METHODS = new Set(['eth_sendRawTransaction', 'eth_sendTransaction']);

/** The JSON-RPC method of a request, when the body can be read. */
function methodOf(init: RequestInit | undefined): string | undefined {
  const body = init?.body;
  if (typeof body !== 'string') return undefined;
  try {
    const parsed = JSON.parse(body) as { method?: string };
    return typeof parsed.method === 'string' ? parsed.method : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every endpoint failed.
 *
 * The error is named `AbortError` so that neither the transport nor the
 * client retries it: the failover already tried every endpoint, and a retry
 * would only walk through them again.
 */
export class RpcUnavailableError extends Error {
  /** True when the request may have reached the chain anyway. */
  readonly ambiguous: boolean;

  constructor(message: string, ambiguous = false) {
    super(message);
    this.name = 'AbortError';
    this.ambiguous = ambiguous;
  }
}

/** The endpoint that answered last stays in use. */
function markHealthy(index: number): void {
  activeRpc = index;
}

/** Puts an endpoint aside for a minute and moves on to the next one. */
function markUnhealthy(index: number): void {
  coolingUntil.set(index, Date.now() + RPC_COOLDOWN_MS);
  if (config.rpcUrls.length > 1) activeRpc = (index + 1) % config.rpcUrls.length;
}

/**
 * The next endpoint that may answer: not cooling down and not tried yet.
 *
 * Returns -1 when every endpoint is cooling down; the caller then gives the
 * active one a chance anyway, because a request that is not sent at all is
 * worse than one that fails.
 */
function pickRpc(tried: Set<number>): number {
  const now = Date.now();
  for (let i = 0; i < config.rpcUrls.length; i++) {
    const index = (activeRpc + i) % config.rpcUrls.length;
    if (tried.has(index)) continue;
    if ((coolingUntil.get(index) ?? 0) <= now) {
      activeRpc = index;
      return index;
    }
  }
  return -1;
}

/**
 * Sends the request to the endpoint that is allowed to answer.
 *
 * The active endpoint goes first and the request stops the moment it is
 * answered — no endpoint is probed for the sake of it. A failure moves on to
 * the next eligible endpoint, which then becomes the active one.
 *
 * The URL is rewritten, not just the host: an endpoint's API key lives in
 * its path, so the whole base has to be replaced.
 */
export const rpcFetch: typeof fetch = async (input, init) => {
  await acquire();
  try {
    const request =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const from = config.rpcUrl.replace(/\/$/, '');
    const write = WRITE_METHODS.has(methodOf(init) ?? '');
    const tried = new Set<number>();
    let lastError: unknown = new Error('no RPC endpoint answered');

    for (;;) {
      let index = pickRpc(tried);
      if (index < 0) {
        // Every endpoint is cooling down: the active one still gets a chance.
        index = activeRpc;
        if (tried.has(index)) break;
      }
      tried.add(index);
      const base = config.rpcUrls[index]!;
      const rewritten = request.startsWith(from) ? base + request.slice(from.length) : request;
      const host = (() => {
        try {
          return new URL(base).host;
        } catch {
          return base;
        }
      })();

      try {
        const response = await fetch(rewritten, init);
        // 429 means "too many requests", 5xx means the provider is unwell.
        if (response.status === 429 || response.status >= 500) {
          markUnhealthy(index);
          lastError = new Error(`RPC ${host} answered ${response.status}`);
          // A transaction that was rejected with 429 was never sent, so the
          // next endpoint may take it. Every other failure is ambiguous: the
          // chain may have it already, so it must not be sent a second time.
          if (write && response.status !== 429) {
            throw new RpcUnavailableError(
              `The transaction could not be confirmed by ${host} (${response.status}) — it may or may not have been sent.`,
              true,
            );
          }
          continue;
        }
        markHealthy(index);
        return response;
      } catch (err) {
        markUnhealthy(index);
        if (err instanceof RpcUnavailableError) throw err;
        lastError = err;
        // An ambiguous failure on a write: the transaction may already be on
        // the chain. Sending it again would spend the nonce twice.
        if (write) {
          throw new RpcUnavailableError(
            `The transaction could not be confirmed by ${host} — it may or may not have been sent.`,
            true,
          );
        }
      }
    }

    throw new RpcUnavailableError(
      `Every RPC endpoint failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  } finally {
    release();
  }
};

/**
 * Which RPC is in use right now, and how many are cooling down.
 *
 * The status screen shows it, so a rate-limited endpoint is visible instead
 * of silently slowing the bot down.
 */
export function rpcStatus(): { active: string; index: number; total: number; cooling: number } {
  const now = Date.now();
  let cooling = 0;
  for (const until of coolingUntil.values()) if (until > now) cooling++;
  return {
    active: config.rpcUrls[activeRpc] ?? '',
    index: activeRpc,
    total: config.rpcUrls.length,
    cooling,
  };
}

/** Puts every endpoint back into rotation (used by the tests). */
export function resetRpcRotation(): void {
  activeRpc = 0;
  coolingUntil.clear();
}

const transport = http(config.rpcUrl, {
  timeout: 25_000,
  // The failover lives in the fetch: the transport must not send a request
  // again on its own, or a transaction could be submitted twice.
  retryCount: 0,
  retryDelay: 400,
  fetchFn: rpcFetch,
});

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport,
});

/**
 * The signing wallet is mutable: a key from `.env` is used at boot, and an
 * imported/unlocked keystore can replace it at runtime. These are live ESM
 * bindings, so every importer sees the switch immediately.
 */
let activeAccount: PrivateKeyAccount | undefined = config.privateKey
  ? privateKeyToAccount(config.privateKey)
  : undefined;

export let account: PrivateKeyAccount | undefined = activeAccount;

export let walletClient = activeAccount
  ? createWalletClient({ account: activeAccount, chain: robinhoodChain, transport })
  : undefined;

/** Address the bot acts for, if a key is configured or unlocked. */
export let botAddress: Address | undefined = activeAccount?.address;

/** Switches the signing wallet (or clears it with `undefined`). */
export function setWalletAccount(next: PrivateKeyAccount | undefined): Address | undefined {
  activeAccount = next;
  account = next;
  botAddress = next?.address;
  walletClient = next
    ? createWalletClient({ account: next, chain: robinhoodChain, transport })
    : undefined;
  return botAddress;
}

export function requireWallet() {
  if (!account || !walletClient) {
    throw new Error('No PRIVATE_KEY configured — this bot can only watch positions, not trade.');
  }
  return { account, walletClient };
}
