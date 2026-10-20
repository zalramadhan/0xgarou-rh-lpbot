import { erc20Abi } from '../constants/abis.js';
import { publicClient } from '../chain/client.js';
import { getAddress, isAddress, type Address } from 'viem';
import { createLogger } from '../logger.js';
import { retryRpc } from '../utils/async.js';
import { isRevertError } from '../utils/errors.js';

const log = createLogger('tokens');

export interface TokenInfo {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
}

const cache = new Map<string, TokenInfo>();
const inflight = new Map<string, Promise<TokenInfo>>();
/** When a token's metadata could not be read, and when to try again. */
const failed = new Map<string, number>();
/** The last warning per token, so one broken token does not flood the log. */
const warnedAt = new Map<string, number>();
const FAIL_RETRY_MS = 30_000;
const WARN_INTERVAL_MS = 60_000;

function key(address: string) {
  return address.toLowerCase();
}

/** Warns about a token once, not once per attempt. */
function warnOnce(address: Address, message: string): void {
  const now = Date.now();
  if (now - (warnedAt.get(key(address)) ?? 0) < WARN_INTERVAL_MS) return;
  warnedAt.set(key(address), now);
  log.warn(message);
}

/** Normalizes and validates a user supplied contract address. */
export function normalizeAddress(input: string): Address {
  const trimmed = input.trim();
  if (!isAddress(trimmed, { strict: false })) {
    throw new Error(`"${trimmed}" is not a valid contract address`);
  }
  return getAddress(trimmed);
}

async function readSymbol(address: Address): Promise<string> {
  try {
    return await publicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: 'symbol',
    });
  } catch (err) {
    // A transport error (a rate limit, a dropped connection) fails the same
    // way twice, so only a contract that reverts is worth a second try.
    if (!isRevertError(err)) throw err;
    try {
      // Some tokens expose bytes32 symbols.
      const raw = await publicClient.readContract({
        address,
        abi: [
          {
            type: 'function',
            name: 'symbol',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ type: 'bytes32' }],
          },
        ] as const,
        functionName: 'symbol',
      });
      return raw.replace(/\0+$/, '');
    } catch {
      warnOnce(address, `symbol() failed for ${address}`);
      return 'UNKNOWN';
    }
  }
}

async function fetchToken(address: Address): Promise<TokenInfo> {
  const [symbol, name, decimals] = await retryRpc(() =>
    Promise.all([
      readSymbol(address),
      publicClient.readContract({ address, abi: erc20Abi, functionName: 'name' }).catch(() => 'Unknown token'),
      publicClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    ]),
  );
  if (decimals > 36) throw new Error(`Token ${address} reports ${decimals} decimals — refusing to trade it`);
  const info: TokenInfo = { address, symbol: symbol.slice(0, 24), name: name.slice(0, 64), decimals };
  cache.set(key(address), info);
  return info;
}

/** Fetches token metadata, cached for the process lifetime. */
export async function getToken(address: Address | string): Promise<TokenInfo> {
  const addr = normalizeAddress(address);
  const cached = cache.get(key(addr));
  if (cached) return cached;

  // A token that could not be read is remembered for a moment: without it
  // every scan would pay the same failed calls again.
  const failedAt = failed.get(key(addr));
  if (failedAt !== undefined) {
    if (Date.now() - failedAt < FAIL_RETRY_MS) {
      throw new Error(`Could not read the metadata of ${addr}`);
    }
    failed.delete(key(addr));
  }

  const pending = inflight.get(key(addr));
  if (pending) return pending;
  const promise = fetchToken(addr)
    .catch((err) => {
      failed.set(key(addr), Date.now());
      throw err;
    })
    .finally(() => inflight.delete(key(addr)));
  inflight.set(key(addr), promise);
  return promise;
}
