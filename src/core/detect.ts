import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { v3PositionManagerAbi, v4PositionManagerAbi } from '../constants/abis.js';
import { CONTRACTS } from '../constants/chain.js';
import { publicClient } from '../chain/client.js';
import { config } from '../config.js';
import { retryRpc } from '../utils/async.js';
import { TtlCache } from '../utils/cache.js';
import { isRevertError } from '../utils/errors.js';
import { createLogger } from '../logger.js';
import type { PositionVersion } from './positions.js';

const log = createLogger('detect');

/** Multicall3, deployed at the same address on every EVM chain. */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

const aggregate3Abi = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

/** ownerOf(uint256) */
const OWNER_OF_SELECTOR = '0x6352211e';

/** `ownerOf` calls packed into one multicall3 round trip. */
const OWNER_BATCH = 2000;

/**
 * Consecutive empty batches that mark the end of the minted id range. The v4
 * manager hands out sequential ids and roughly half of them are burned, so a
 * long run without a single hit means the space is exhausted.
 */
const SCAN_EMPTY_RUN = 6;

/** Hard stop for the fallback scan. The chain minted ~3.9M v4 positions. */
const SCAN_LIMIT = config.detectScanLimit;

/** Indexer pages fetched before giving up on the fast path. */
const INDEXER_MAX_PAGES = 60;

function ownerOfCallData(tokenId: bigint): Hex {
  return `${OWNER_OF_SELECTOR}${tokenId.toString(16).padStart(64, '0')}` as Hex;
}

interface Aggregate3Result {
  success: boolean;
  returnData: Hex;
}

/** Runs one multicall3 batch and returns the owner of every id it resolved. */
async function batchOwners(manager: Address, ids: bigint[]): Promise<Map<bigint, Address>> {
  const calls = ids.map((id) => ({
    target: manager,
    allowFailure: true,
    callData: ownerOfCallData(id),
  }));

  const raw = await retryRpc(() =>
    publicClient.call({
      to: MULTICALL3,
      data: encodeFunctionData({
        abi: aggregate3Abi,
        functionName: 'aggregate3',
        args: [calls],
      }) as Hex,
    }),
  );
  const data = raw.data;
  if (!data) throw new Error('multicall3 returned no data');
  const decoded = decodeFunctionResult({
    abi: aggregate3Abi,
    functionName: 'aggregate3',
    data,
  }) as readonly Aggregate3Result[];

  const owners = new Map<bigint, Address>();
  decoded.forEach((entry, i) => {
    const id = ids[i]!;
    if (!entry.success || entry.returnData.length < 66) return; // burned or never minted
    const owner = decodeFunctionResult({
      abi: v4PositionManagerAbi,
      functionName: 'ownerOf',
      data: entry.returnData,
    }) as Address;
    if (owner) owners.set(id, owner);
  });
  return owners;
}

/** Token ids of `owner` in the v3 manager, via ERC721Enumerable. */
async function v3TokenIds(owner: Address): Promise<bigint[]> {
  const balance = await retryRpc(() =>
    publicClient.readContract({
      address: CONTRACTS.v3PositionManager,
      abi: v3PositionManagerAbi,
      functionName: 'balanceOf',
      args: [owner],
    }),
  );
  const ids: bigint[] = [];
  for (let i = 0n; i < balance; i++) {
    const id = await retryRpc(() =>
      publicClient.readContract({
        address: CONTRACTS.v3PositionManager,
        abi: v3PositionManagerAbi,
        functionName: 'tokenOfOwnerByIndex',
        args: [owner, i],
      }),
    );
    ids.push(id);
  }
  return ids;
}

/* -------------------------------------------------------------------------- */
/*                              Indexer fast path                             */
/* -------------------------------------------------------------------------- */

interface AssetTransfer {
  tokenId?: string;
  rawContract?: { address?: string };
}

interface AssetTransfersResult {
  transfers?: AssetTransfer[];
  pageKey?: string;
}

/** Token ids of an indexer page, ignoring anything that is not an integer id. */
export function parseIndexerTransfers(result: AssetTransfersResult): bigint[] {
  const ids: bigint[] = [];
  for (const transfer of result.transfers ?? []) {
    if (!transfer.tokenId) continue;
    try {
      ids.push(BigInt(transfer.tokenId));
    } catch {
      // Not a plain integer id — skip it.
    }
  }
  return ids;
}

/** True when a transfer belongs to the v4 position manager. */
export function isV4Transfer(transfer: AssetTransfer): boolean {
  return (transfer.rawContract?.address ?? '').toLowerCase() === CONTRACTS.v4PositionManager.toLowerCase();
}

/** Raw JSON-RPC call against the configured endpoint. */
async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  let body: { result?: unknown; error?: { message?: string } };
  try {
    body = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
  } catch {
    throw new Error(`RPC ${method} returned a non-JSON response`);
  }
  if (body.error) throw new Error(body.error.message ?? `RPC ${method} failed`);
  return body.result;
}

/**
 * Lists the NFT ids the wallet received from the v4 position manager, using
 * the indexer behind an Alchemy-style endpoint.
 *
 * Returns `null` when the endpoint cannot serve the request, which tells the
 * caller to fall back to the on-chain scan.
 */
async function indexerV4TokenIds(owner: Address): Promise<bigint[] | null> {
  const ids = new Set<bigint>();
  let pageKey: string | undefined;

  for (let page = 0; page < INDEXER_MAX_PAGES; page++) {
    let result: AssetTransfersResult;
    let filtered = true;
    try {
      result = await indexerPage(owner, pageKey, true);
    } catch (err) {
      const message = (err as Error).message.toLowerCase();
      const unsupported =
        message.includes('method not found') ||
        message.includes('not supported') ||
        message.includes('does not exist') ||
        message.includes('unknown method');
      if (unsupported) {
        log.info('RPC has no NFT index — falling back to an on-chain scan');
        return null;
      }
      // Some providers serve the method but not every filter: try unfiltered.
      try {
        result = await indexerPage(owner, pageKey, false);
        filtered = false;
      } catch {
        log.warn('indexer lookup failed', err);
        return null;
      }
    }

    for (const transfer of result.transfers ?? []) {
      if (transfer.rawContract?.address) {
        if (!isV4Transfer(transfer)) continue;
      } else if (!filtered) {
        // Unfiltered page without contract info — cannot tell what it is.
        continue;
      }
      for (const id of parseIndexerTransfers({ transfers: [transfer] })) ids.add(id);
    }
    pageKey = result.pageKey;
    if (!pageKey) break;
  }

  return [...ids];
}

/** One page of NFT transfers for a wallet. */
async function indexerPage(
  owner: Address,
  pageKey: string | undefined,
  contractFilter: boolean,
): Promise<AssetTransfersResult> {
  const params: Record<string, unknown> = {
    category: ['erc721'],
    maxCount: '0x3e8',
    toAddress: owner,
    ...(pageKey ? { pageKey } : {}),
  };
  if (contractFilter) params.contractAddresses = [CONTRACTS.v4PositionManager];
  return (await rpcCall('alchemy_getAssetTransfers', [params])) as AssetTransfersResult;
}

/* -------------------------------------------------------------------------- */
/*                             On-chain scan path                             */
/* -------------------------------------------------------------------------- */

/**
 * Walks every minted v4 id and asks who owns it. Exact but slow: the chain has
 * minted millions of positions, so a full walk takes minutes.
 */
async function scanV4TokenIds(
  owner: Address,
  onProgress?: (scanned: number, total: number) => void,
): Promise<{ ids: bigint[]; scanned: number }> {
  const wanted = owner.toLowerCase();
  const ids: bigint[] = [];
  let scanned = 0;
  let maxSeen = 0;
  let emptyRun = 0;

  while (scanned < SCAN_LIMIT) {
    const start = BigInt(scanned) + 1n;
    const batch: bigint[] = [];
    for (let i = 0n; i < BigInt(OWNER_BATCH); i++) batch.push(start + i);

    let owners: Map<bigint, Address>;
    try {
      owners = await batchOwners(CONTRACTS.v4PositionManager, batch);
    } catch (err) {
      // A failed batch must not silently drop positions; retry it one by one.
      log.warn(`v4 scan batch ${start} failed, retrying one by one`, err);
      for (const id of batch) {
        try {
          const addr = await retryRpc(() =>
            publicClient.readContract({
              address: CONTRACTS.v4PositionManager,
              abi: v4PositionManagerAbi,
              functionName: 'ownerOf',
              args: [id],
            }),
          );
          if (addr.toLowerCase() === wanted) ids.push(id);
        } catch (inner) {
          if (!isRevertError(inner)) log.warn(`ownerOf(${id}) failed`, inner);
        }
      }
      scanned += batch.length;
      continue;
    }

    let hits = 0;
    for (const [id, addr] of owners) {
      hits++;
      if (Number(id) > maxSeen) maxSeen = Number(id);
      if (addr.toLowerCase() === wanted) ids.push(id);
    }
    emptyRun = hits === 0 ? emptyRun + 1 : 0;
    scanned += batch.length;
    onProgress?.(scanned, Math.max(scanned, maxSeen + OWNER_BATCH));

    if (emptyRun >= SCAN_EMPTY_RUN) break;
  }

  return { ids, scanned };
}

/* -------------------------------------------------------------------------- */

export interface DetectedToken {
  version: PositionVersion;
  tokenId: bigint;
}

/** Where the v4 ids came from. */
type V4Source = 'indexer' | 'scan' | 'none';

interface DetectProgress {
  /** `v4-scan` means the on-chain id walk, `v4` the indexer. */
  phase: 'v3' | 'v4' | 'v4-scan';
  scanned: number;
  total: number;
}

interface DetectResult {
  /** Every LP NFT the wallet holds, v3 first. */
  tokens: DetectedToken[];
  /** How the v4 ids were found. */
  v4Source: V4Source;
  /** Highest v4 id the scan had to walk through. */
  scannedTo: number;
}

/**
 * Every LP NFT the wallet owns, across both managers. Callers diff this against
 * the store to surface untracked positions.
 *
 * The result is cached per wallet for a few minutes: the fallback scan walks
 * millions of ids, so a second request in the same process should not pay for
 * it again. A manual rescan asks for a fresh read.
 */
const cache = new TtlCache<DetectResult>(5 * 60_000);

function cacheKey(owner: Address): string {
  return owner.toLowerCase();
}

interface DetectOptions {
  onProgress?: (progress: DetectProgress) => void;
  /** Ignore the cached result and read the chain again. */
  refresh?: boolean;
}

export async function detectPositions(
  owner: Address,
  options: DetectOptions = {},
): Promise<DetectResult> {
  const { onProgress, refresh = false } = options;
  const key = cacheKey(owner);
  const cached = cache.get(key);
  if (cached && !refresh) return cached;

  const v3Ids = await v3TokenIds(owner).catch((err) => {
    log.warn('v3 enumeration failed', err);
    return [] as bigint[];
  });
  onProgress?.({ phase: 'v3', scanned: v3Ids.length, total: v3Ids.length });

  let v4Ids: bigint[] = [];
  let v4Source: V4Source = 'none';
  let scannedTo = 0;

  const indexed = config.detectUseIndexer ? await indexerV4TokenIds(owner) : null;
  if (indexed) {
    v4Source = 'indexer';
    // The indexer lists transfers; a position can have been handed on again,
    // so ownership is confirmed on-chain before it counts as held.
    const confirmed: bigint[] = [];
    for (let i = 0; i < indexed.length; i += OWNER_BATCH) {
      const slice = indexed.slice(i, i + OWNER_BATCH);
      const owners = await batchOwners(CONTRACTS.v4PositionManager, slice).catch((err) => {
        log.warn('v4 ownership check failed', err);
        return new Map<bigint, Address>();
      });
      for (const id of slice) {
        const holder = owners.get(id);
        if (holder && holder.toLowerCase() === owner.toLowerCase()) confirmed.push(id);
      }
      onProgress?.({
        phase: 'v4',
        scanned: Math.min(i + OWNER_BATCH, indexed.length),
        total: indexed.length,
      });
    }
    v4Ids = confirmed;
    scannedTo = indexed.length;
  } else {
    v4Source = 'scan';
    const scan = await scanV4TokenIds(owner, (scanned, total) =>
      onProgress?.({ phase: 'v4-scan', scanned, total }),
    );
    v4Ids = scan.ids;
    scannedTo = scan.scanned;
  }

  const tokens: DetectedToken[] = [
    ...v3Ids.map((tokenId) => ({ version: 'v3' as const, tokenId })),
    ...v4Ids.map((tokenId) => ({ version: 'v4' as const, tokenId })),
  ];
  tokens.sort((a, b) =>
    a.version === b.version
      ? Number(a.tokenId - b.tokenId)
      : a.version === 'v3'
        ? -1
        : 1,
  );

  const result: DetectResult = { tokens, v4Source, scannedTo };
  cache.set(key, result);
  return result;
}
