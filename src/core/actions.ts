import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from 'viem';
import { keccak256, toHex } from 'viem';
import { v3PositionManagerAbi, v4PositionManagerAbi } from '../constants/abis.js';
import { CONTRACTS, MAX_UINT128 } from '../constants/chain.js';
import { publicClient, requireWallet } from '../chain/client.js';
import { ensureErc20Allowance, ensurePermit2Allowance, erc20Allowance, erc20BalanceOf } from './wallet.js';
import { permit2Abi } from '../constants/abis.js';
import { amountsForLiquidity, liquidityFromAmounts } from './math/positionMath.js';
import { applySlippageDown } from '../utils/format.js';
import { createLogger } from '../logger.js';
import { retryRpc } from '../utils/async.js';
import type { PoolKeyShape, Pool } from './pools.js';
import type { PositionSnapshot } from './positions.js';

const log = createLogger('actions');

/** Uniswap v4 PositionManager action codes (v4-periphery Actions.sol). */
export const V4_ACTION = {
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  CLOSE_CURRENCY: 0x12,
} as const;

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

export interface TxOutcome {
  dryRun: boolean;
  hash?: Hex;
  /** Position id, when the call mints one and we can determine it. */
  tokenId?: bigint;
  /** Set when dry-run simulation reverted; the transaction was not sent. */
  error?: string;
  /** Extra context for the user, e.g. why a dry-run skipped simulation. */
  note?: string;
  /** The USDG a swap delivered, in base units. */
  receivedUsdg?: bigint;
  /** The gas a swap cost, in native units. */
  gasNative?: bigint;
  /** The token amount a swap sold, in base units. */
  soldAmount?: bigint;
}

const nowSeconds = () => Math.floor(Date.now() / 1000) + 1200;

function poolKeyOf(pool: Pool): PoolKeyShape {
  if (pool.version === 'v3') throw new Error('Not a v4 pool');
  return pool.key;
}

/** Packs v4 actions + params into the unlockData blob for modifyLiquidities. */
export function encodeV4UnlockData(actions: number[], params: Hex[]): Hex {
  if (actions.length !== params.length) throw new Error('actions and params length mismatch');
  const actionBytes = `0x${actions.map((a) => a.toString(16).padStart(2, '0')).join('')}` as Hex;
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actionBytes, params]);
}

function encodePoolKey(key: PoolKeyShape): Hex {
  return encodeAbiParameters([{ type: 'tuple', components: POOL_KEY_COMPONENTS }], [key]);
}

function encodeCurrency(address: Address): Hex {
  return encodeAbiParameters([{ type: 'address' }], [address]);
}

function findMintedTokenId(logs: readonly { address: Address; topics: readonly Hex[] }[], owner: Address): bigint | undefined {
  const transferTopic = keccak256(toHex('Transfer(address,address,uint256)'));
  const zeroTopic = `0x${'0'.repeat(64)}`;
  for (const entry of logs) {
    if (entry.address.toLowerCase() !== CONTRACTS.v4PositionManager.toLowerCase() &&
        entry.address.toLowerCase() !== CONTRACTS.v3PositionManager.toLowerCase()) {
      continue;
    }
    if (entry.topics[0] !== transferTopic || entry.topics.length < 4) continue;
    if (entry.topics[1] !== zeroTopic) continue;
    const to = `0x${entry.topics[2]!.slice(-40)}`.toLowerCase();
    if (to !== owner.toLowerCase()) continue;
    return BigInt(entry.topics[3]!);
  }
  return undefined;
}

/**
 * Finds the hash of a transaction the wallet sent with a given nonce.
 *
 * When a send fails ambiguously — the connection dropped after the
 * transaction was broadcast — the hash is unknown. The nonce is not: if it
 * moved on, the transaction is on the chain and can be looked up.
 */
async function findTransactionByNonce(
  owner: Address,
  nonce: number,
): Promise<Hex | undefined> {
  const blocks = await publicClient.getBlockNumber();
  // Only the newest blocks are searched: an ambiguous failure is reported
  // within seconds, so the transaction is still close to the tip.
  for (let i = 0; i < 25; i++) {
    const blockNumber = blocks - BigInt(i);
    if (blockNumber < 0n) break;
    const block = await publicClient.getBlock({ blockNumber, includeTransactions: true });
    for (const transaction of block.transactions) {
      const tx = transaction as { from?: string; nonce?: number; hash?: string };
      if (tx.from?.toLowerCase() !== owner.toLowerCase()) continue;
      if (tx.nonce !== nonce) continue;
      if (tx.hash) return tx.hash as Hex;
    }
  }
  return undefined;
}

/**
 * Sends a transaction and waits for it.
 *
 * The receipt is returned as well, so the caller does not have to fetch it a
 * second time to read the logs.
 *
 * A transaction is **never sent twice**: when the RPC connection breaks
 * after the transaction was broadcast, the pending nonce decides whether it
 * went through. If it did, the transaction is looked up and followed; if it
 * did not, the caller is told that nothing was sent.
 */
async function sendTransaction(
  to: Address,
  data: Hex,
  owner: Address,
): Promise<{ hash: Hex; receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>> }> {
  const { walletClient: client, account } = requireWallet();
  if (account.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error('The wallet changed while the transaction was being prepared — try again.');
  }

  const nonce = await publicClient.getTransactionCount({ address: owner, blockTag: 'pending' });
  let hash: Hex;
  try {
    hash = await client.sendTransaction({ account, to, data, chain: client.chain, nonce });
  } catch (err) {
    // The send failed in a way that leaves it open whether the transaction
    // was broadcast. The nonce says.
    const after = await publicClient
      .getTransactionCount({ address: owner, blockTag: 'pending' })
      .catch(() => nonce);
    if (after <= nonce) throw err;
    const found = await findTransactionByNonce(owner, nonce);
    if (!found) {
      throw new Error(
        `The transaction was sent (nonce ${nonce}) but the RPC lost the receipt. Check the wallet before sending it again.`,
      );
    }
    hash = found;
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
  return { hash, receipt };
}

/** simulates a call in dry-run mode; returns the revert reason instead of throwing. */
async function simulate(to: Address, data: Hex, owner: Address): Promise<string | undefined> {
  try {
    await retryRpc(() => publicClient.call({ account: owner, to, data }));
    return undefined;
  } catch (err) {
    return (err as Error).message.split('\n')[0] ?? 'simulation reverted';
  }
}

/**
 * Checks balances and allowances before a dry-run simulation. Without funds or
 * approvals the mint necessarily reverts with an opaque token error, which is
 * not a useful signal for the user.
 */
async function preflight(
  pool: Pool,
  amount0: bigint,
  amount1: bigint,
  owner: Address,
): Promise<string | undefined> {
  const [balance0, balance1] = await Promise.all([
    erc20BalanceOf(pool.token0.address, owner),
    erc20BalanceOf(pool.token1.address, owner),
  ]);
  if (balance0 < amount0) return `insufficient ${pool.token0.symbol} balance`;
  if (balance1 < amount1) return `insufficient ${pool.token1.symbol} balance`;

  if (pool.version === 'v3') {
    const [a0, a1] = await Promise.all([
      erc20Allowance(pool.token0.address, CONTRACTS.v3PositionManager, owner),
      erc20Allowance(pool.token1.address, CONTRACTS.v3PositionManager, owner),
    ]);
    if (a0 < amount0 || a1 < amount1) return 'token approvals to the v3 position manager are not in place yet';
    return undefined;
  }

  const [erc20ToPermit0, erc20ToPermit1, permitToManager0, permitToManager1] = await Promise.all([
    erc20Allowance(pool.token0.address, CONTRACTS.permit2, owner),
    erc20Allowance(pool.token1.address, CONTRACTS.permit2, owner),
    publicClient.readContract({
      address: CONTRACTS.permit2,
      abi: permit2Abi,
      functionName: 'allowance',
      args: [owner, pool.token0.address, CONTRACTS.v4PositionManager],
    }),
    publicClient.readContract({
      address: CONTRACTS.permit2,
      abi: permit2Abi,
      functionName: 'allowance',
      args: [owner, pool.token1.address, CONTRACTS.v4PositionManager],
    }),
  ]);
  if (
    erc20ToPermit0 < amount0 ||
    erc20ToPermit1 < amount1 ||
    permitToManager0[0] < amount0 ||
    permitToManager1[0] < amount1
  ) {
    return 'Permit2 approvals for the v4 position manager are not in place yet';
  }
  return undefined;
}


/**
 * A dry-run revert caused only by missing funds/approvals is expected; anything
 * else is a real problem with the call and must be surfaced as an error.
 *
 * The preflight has to have found a problem first, and the revert has to name
 * one of the funding failures. A bare "transfer" or "insufficient" is too
 * broad: it would also match a honeypot or a slippage revert, which must not
 * be reported as "this would work".
 */
function expectedFundingRevert(issue: string | undefined, error: string): boolean {
  if (!issue) return false;
  const text = error.toLowerCase();
  const funding = ['stf', 'transfer_from_failed', 'transferfailed', 'insufficient funds', 'insufficient balance', 'allowance', 'permit2'];
  return funding.some((needle) => text.includes(needle));
}

interface OpenPositionParams {
  pool: Pool;
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
  slippagePct: number;
  recipient: Address;
  dryRun: boolean;
}

export interface OpenPositionResult extends TxOutcome {
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
}

/**
 * Mints a new LP position. Uses the largest liquidity both token amounts can
 * support, and asks the pool for slightly less than that so rounding never
 * makes the mint revert.
 */
export async function openPosition(params: OpenPositionParams): Promise<OpenPositionResult> {
  const { pool, tickLower, tickUpper, recipient, dryRun } = params;
  if (tickLower >= tickUpper) throw new Error('Invalid range: lower tick must be below upper');

  const liquidity = liquidityFromAmounts(
    pool.sqrtPriceX96,
    pool.tick,
    tickLower,
    tickUpper,
    params.amount0,
    params.amount1,
  );
  if (liquidity <= 0n) throw new Error('Amount too small for this range — increase the deposit');

  const required = amountsForLiquidity(pool.sqrtPriceX96, tickLower, tickUpper, liquidity);
  const max0 = required.amount0 + required.amount0 / 50n + 1n;
  const max1 = required.amount1 + required.amount1 / 50n + 1n;

  if (pool.version === 'v3') {
    const data = encodeFunctionData({
      abi: v3PositionManagerAbi,
      functionName: 'mint',
      args: [
        {
          token0: pool.token0.address,
          token1: pool.token1.address,
          fee: pool.fee,
          tickLower,
          tickUpper,
          amount0Desired: required.amount0,
          amount1Desired: required.amount1,
          amount0Min: applySlippageDown(required.amount0, params.slippagePct),
          amount1Min: applySlippageDown(required.amount1, params.slippagePct),
          recipient,
          deadline: BigInt(nowSeconds()),
        },
      ],
    });

    if (dryRun) {
      // Simulate regardless of funding so the calldata itself is always checked.
      const [issue, error] = await Promise.all([
        preflight(pool, required.amount0, required.amount1, recipient),
        simulate(CONTRACTS.v3PositionManager, data, recipient),
      ]);
      if (!error) return { dryRun: true, liquidity, amount0: required.amount0, amount1: required.amount1 };
      if (expectedFundingRevert(issue, error)) {
        return {
          dryRun: true,
          note: `Simulated call reached the token transfer and reverted because ${issue}. A live mint approves first, then deposits.`,
          liquidity,
          amount0: required.amount0,
          amount1: required.amount1,
        };
      }
      return { dryRun: true, error, liquidity, amount0: required.amount0, amount1: required.amount1 };
    }

    await ensureErc20Allowance(pool.token0.address, CONTRACTS.v3PositionManager, max0, recipient, dryRun);
    await ensureErc20Allowance(pool.token1.address, CONTRACTS.v3PositionManager, max1, recipient, dryRun);

    const { hash, receipt } = await sendTransaction(CONTRACTS.v3PositionManager, data, recipient);
    const tokenId = findMintedTokenId(receipt.logs, recipient);
    log.info(`minted v3 position ${tokenId ?? '?'} tx=${hash}`);
    return { dryRun: false, hash, tokenId, liquidity, amount0: required.amount0, amount1: required.amount1 };
  }

  const key = poolKeyOf(pool);
  const mintParams = encodeAbiParameters(
    [
      { type: 'tuple', components: POOL_KEY_COMPONENTS },
      { type: 'int24' },
      { type: 'int24' },
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'address' },
      { type: 'bytes' },
    ],
    [
      key,
      tickLower,
      tickUpper,
      liquidity,
      max0 > MAX_UINT128 ? MAX_UINT128 : max0,
      max1 > MAX_UINT128 ? MAX_UINT128 : max1,
      recipient,
      '0x',
    ],
  );

  const unlockData = encodeV4UnlockData(
    [V4_ACTION.MINT_POSITION, V4_ACTION.CLOSE_CURRENCY, V4_ACTION.CLOSE_CURRENCY],
    [mintParams, encodeCurrency(key.currency0), encodeCurrency(key.currency1)],
  );

  const data = encodeFunctionData({
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: [unlockData, BigInt(nowSeconds())],
  });

  if (dryRun) {
    const [issue, error] = await Promise.all([
      preflight(pool, required.amount0, required.amount1, recipient),
      simulate(CONTRACTS.v4PositionManager, data, recipient),
    ]);
    if (!error) return { dryRun: true, liquidity, amount0: required.amount0, amount1: required.amount1 };
    if (expectedFundingRevert(issue, error)) {
      return {
        dryRun: true,
        note: `Simulated call reached the token transfer and reverted because ${issue}. A live mint approves first, then deposits.`,
        liquidity,
        amount0: required.amount0,
        amount1: required.amount1,
      };
    }
    return { dryRun: true, error, liquidity, amount0: required.amount0, amount1: required.amount1 };
  }

  await ensurePermit2Allowance(key.currency0, CONTRACTS.v4PositionManager, max0, recipient, dryRun);
  await ensurePermit2Allowance(key.currency1, CONTRACTS.v4PositionManager, max1, recipient, dryRun);

  const { hash, receipt } = await sendTransaction(CONTRACTS.v4PositionManager, data, recipient);
  const tokenId = findMintedTokenId(receipt.logs, recipient);
  log.info(`minted v4 position ${tokenId ?? '?'} tx=${hash}`);
  return { dryRun: false, hash, tokenId, liquidity, amount0: required.amount0, amount1: required.amount1 };
}

interface ClosePositionParams {
  snapshot: PositionSnapshot;
  slippagePct: number;
  recipient: Address;
  dryRun: boolean;
}

/** Removes all liquidity, collects everything owed and burns the NFT. */
export async function closePosition(params: ClosePositionParams): Promise<TxOutcome> {
  const { snapshot, recipient, dryRun } = params;
  if (snapshot.hasNative) throw new Error('Native-ETH v4 positions are not supported by this bot yet');

  const min0 = applySlippageDown(snapshot.amount0, params.slippagePct);
  const min1 = applySlippageDown(snapshot.amount1, params.slippagePct);

  if (snapshot.version === 'v3') {
    const decrease = encodeFunctionData({
      abi: v3PositionManagerAbi,
      functionName: 'decreaseLiquidity',
      args: [
        {
          tokenId: snapshot.tokenId,
          liquidity: snapshot.liquidity,
          amount0Min: min0,
          amount1Min: min1,
          deadline: BigInt(nowSeconds()),
        },
      ],
    });
    const collect = encodeFunctionData({
      abi: v3PositionManagerAbi,
      functionName: 'collect',
      args: [
        {
          tokenId: snapshot.tokenId,
          recipient,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        },
      ],
    });
    const burn = encodeFunctionData({
      abi: v3PositionManagerAbi,
      functionName: 'burn',
      args: [snapshot.tokenId],
    });
    const data = encodeFunctionData({
      abi: v3PositionManagerAbi,
      functionName: 'multicall',
      args: [[decrease, collect, burn]],
    });

    if (dryRun) {
      const error = await simulate(CONTRACTS.v3PositionManager, data, recipient);
      return { dryRun: true, error };
    }
    const { hash } = await sendTransaction(CONTRACTS.v3PositionManager, data, recipient);
    log.info(`closed v3 position ${snapshot.tokenId} tx=${hash}`);
    return { dryRun: false, hash };
  }

  const key: PoolKeyShape = {
    currency0: snapshot.token0.address,
    currency1: snapshot.token1.address,
    fee: snapshot.fee,
    tickSpacing: snapshot.tickSpacing,
    hooks: snapshot.hooks!,
  };
  const burnParams = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [snapshot.tokenId, min0, min1, '0x'],
  );
  const unlockData = encodeV4UnlockData(
    [V4_ACTION.BURN_POSITION, V4_ACTION.CLOSE_CURRENCY, V4_ACTION.CLOSE_CURRENCY],
    [burnParams, encodeCurrency(key.currency0), encodeCurrency(key.currency1)],
  );
  const data = encodeFunctionData({
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: [unlockData, BigInt(nowSeconds())],
  });

  if (dryRun) {
    const error = await simulate(CONTRACTS.v4PositionManager, data, recipient);
    return { dryRun: true, error };
  }
  const { hash } = await sendTransaction(CONTRACTS.v4PositionManager, data, recipient);
  log.info(`closed v4 position ${snapshot.tokenId} tx=${hash}`);
  return { dryRun: false, hash };
}

/** Collects accrued fees without touching liquidity. */
export async function collectFees(
  snapshot: PositionSnapshot,
  recipient: Address,
  dryRun: boolean,
): Promise<TxOutcome> {
  if (snapshot.hasNative) throw new Error('Native-ETH v4 positions are not supported by this bot yet');

  if (snapshot.version === 'v3') {
    const data = encodeFunctionData({
      abi: v3PositionManagerAbi,
      functionName: 'collect',
      args: [
        {
          tokenId: snapshot.tokenId,
          recipient,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        },
      ],
    });
    if (dryRun) return { dryRun: true, error: await simulate(CONTRACTS.v3PositionManager, data, recipient) };
    const { hash } = await sendTransaction(CONTRACTS.v3PositionManager, data, recipient);
    return { dryRun: false, hash };
  }

  const key: PoolKeyShape = {
    currency0: snapshot.token0.address,
    currency1: snapshot.token1.address,
    fee: snapshot.fee,
    tickSpacing: snapshot.tickSpacing,
    hooks: snapshot.hooks!,
  };
  // Increasing by zero credits the caller with the position's accrued fees.
  const increaseParams = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [snapshot.tokenId, 0n, 0n, 0n, '0x'],
  );
  const unlockData = encodeV4UnlockData(
    [V4_ACTION.INCREASE_LIQUIDITY, V4_ACTION.CLOSE_CURRENCY, V4_ACTION.CLOSE_CURRENCY],
    [increaseParams, encodeCurrency(key.currency0), encodeCurrency(key.currency1)],
  );
  const data = encodeFunctionData({
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: [unlockData, BigInt(nowSeconds())],
  });
  if (dryRun) return { dryRun: true, error: await simulate(CONTRACTS.v4PositionManager, data, recipient) };
  const { hash } = await sendTransaction(CONTRACTS.v4PositionManager, data, recipient);
  return { dryRun: false, hash };
}

interface IncreaseParams {
  snapshot: PositionSnapshot;
  amount0: bigint;
  amount1: bigint;
  slippagePct: number;
  recipient: Address;
  dryRun: boolean;
}

/** Adds liquidity to an existing position from wallet balances. */
export async function increaseLiquidity(params: IncreaseParams): Promise<TxOutcome> {
  const { snapshot, recipient, dryRun } = params;
  if (snapshot.hasNative) throw new Error('Native-ETH v4 positions are not supported by this bot yet');

  const liquidity = liquidityFromAmounts(
    snapshot.sqrtPriceX96,
    snapshot.tick,
    snapshot.tickLower,
    snapshot.tickUpper,
    params.amount0,
    params.amount1,
  );
  if (liquidity <= 0n) throw new Error('Amount too small to add liquidity');

  const required = amountsForLiquidity(snapshot.sqrtPriceX96, snapshot.tickLower, snapshot.tickUpper, liquidity);

  if (snapshot.version === 'v3') {
    const data = encodeFunctionData({
      abi: v3PositionManagerAbi,
      functionName: 'increaseLiquidity',
      args: [
        {
          tokenId: snapshot.tokenId,
          amount0Desired: required.amount0,
          amount1Desired: required.amount1,
          amount0Min: applySlippageDown(required.amount0, params.slippagePct),
          amount1Min: applySlippageDown(required.amount1, params.slippagePct),
          deadline: BigInt(nowSeconds()),
        },
      ],
    });
    if (dryRun) return { dryRun: true, error: await simulate(CONTRACTS.v3PositionManager, data, recipient) };
    await ensureErc20Allowance(snapshot.token0.address, CONTRACTS.v3PositionManager, required.amount0, recipient, dryRun);
    await ensureErc20Allowance(snapshot.token1.address, CONTRACTS.v3PositionManager, required.amount1, recipient, dryRun);
    const { hash } = await sendTransaction(CONTRACTS.v3PositionManager, data, recipient);
    return { dryRun: false, hash };
  }

  const key: PoolKeyShape = {
    currency0: snapshot.token0.address,
    currency1: snapshot.token1.address,
    fee: snapshot.fee,
    tickSpacing: snapshot.tickSpacing,
    hooks: snapshot.hooks!,
  };
  const max0 = required.amount0 + required.amount0 / 50n + 1n;
  const max1 = required.amount1 + required.amount1 / 50n + 1n;
  const increaseParams = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [
      snapshot.tokenId,
      liquidity,
      max0 > MAX_UINT128 ? MAX_UINT128 : max0,
      max1 > MAX_UINT128 ? MAX_UINT128 : max1,
      '0x',
    ],
  );
  const unlockData = encodeV4UnlockData(
    [V4_ACTION.INCREASE_LIQUIDITY, V4_ACTION.CLOSE_CURRENCY, V4_ACTION.CLOSE_CURRENCY],
    [increaseParams, encodeCurrency(key.currency0), encodeCurrency(key.currency1)],
  );
  const data = encodeFunctionData({
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: [unlockData, BigInt(nowSeconds())],
  });
  if (dryRun) return { dryRun: true, error: await simulate(CONTRACTS.v4PositionManager, data, recipient) };
  await ensurePermit2Allowance(key.currency0, CONTRACTS.v4PositionManager, max0, recipient, dryRun);
  await ensurePermit2Allowance(key.currency1, CONTRACTS.v4PositionManager, max1, recipient, dryRun);
  const { hash } = await sendTransaction(CONTRACTS.v4PositionManager, data, recipient);
  return { dryRun: false, hash };
}

