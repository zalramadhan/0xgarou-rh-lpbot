import { encodePacked, keccak256, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { v3FactoryAbi, v3PoolAbi, v3PositionManagerAbi, v4PositionManagerAbi, v4StateViewAbi } from '../constants/abis.js';
import { CONTRACTS, ETH_SENTINEL } from '../constants/chain.js';
import { publicClient } from '../chain/client.js';
import { accruedFees, feeGrowthInside } from './math/liquidityMath.js';
import { isInRange, positionAmounts } from './math/positionMath.js';
import { sqrtRatioX96ToPrice, tickToPrice } from './math/tickMath.js';
import { computeV4PoolId, type PoolKeyShape } from './pools.js';
import { getToken, type TokenInfo } from './tokens.js';
import { retryRpc } from '../utils/async.js';
import { isRevertError } from '../utils/errors.js';

export type PositionVersion = 'v3' | 'v4';

export interface PositionSnapshot {
  version: PositionVersion;
  tokenId: bigint;
  owner: Address;
  token0: TokenInfo;
  token1: TokenInfo;
  /** v4 pools can be denominated in native ETH; actions are refused for those. */
  hasNative: boolean;
  fee: number;
  /**
   * The pool key's static fee. A v4 dynamic-fee pool reports its current fee
   * in `fee`, which is not the fee the pool id is built from.
   */
  keyFee?: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  /** token1 per token0, human units */
  price: number;
  amount0: bigint;
  amount1: bigint;
  fees0: bigint;
  fees1: bigint;
  inRange: boolean;
  poolAddress?: Address;
  poolId?: Hex;
  hooks?: Address;
}

function decodeInt24(raw: bigint): number {
  const v = raw & 0xffffffn;
  return Number(v & 0x800000n ? v - 0x1000000n : v);
}

/** Decodes the packed v4 PositionInfo (200b poolId | 24b upper | 24b lower | 8b flags). */
export function decodeV4PositionInfo(info: bigint): { tickLower: number; tickUpper: number } {
  return {
    tickLower: decodeInt24((info >> 8n) & 0xffffffn),
    tickUpper: decodeInt24((info >> 32n) & 0xffffffn),
  };
}

/** Uniswap v4 position storage key for a tokenId owned by the PositionManager. */
export function v4PositionId(tokenId: bigint, tickLower: number, tickUpper: number): Hex {
  return keccak256(
    encodePacked(
      ['address', 'int24', 'int24', 'bytes32'],
      [CONTRACTS.v4PositionManager, tickLower, tickUpper, toHex(tokenId, { size: 32 })],
    ),
  );
}

const nativeToken: TokenInfo = {
  address: ETH_SENTINEL,
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
};

async function resolveCurrency(address: Address): Promise<TokenInfo> {
  if (address.toLowerCase() === zeroAddress) return nativeToken;
  return getToken(address);
}

async function ownerOf(version: PositionVersion, tokenId: bigint): Promise<Address | undefined> {
  const contract = version === 'v3' ? CONTRACTS.v3PositionManager : CONTRACTS.v4PositionManager;
  const abi = version === 'v3' ? v3PositionManagerAbi : v4PositionManagerAbi;
  try {
    return await retryRpc(() =>
      publicClient.readContract({
        address: contract,
        abi,
        functionName: 'ownerOf',
        args: [tokenId],
      }),
    );
  } catch (err) {
    // A revert means the NFT is burned/missing; anything else (RPC down, rate
    // limit) must surface instead of silently looking like a closed position.
    if (isRevertError(err)) return undefined;
    throw err;
  }
}

async function readV3Position(tokenId: bigint, owner: Address): Promise<PositionSnapshot | undefined> {
  // viem decodes multi-output reads positionally.
  const [
    ,
    ,
    posToken0,
    posToken1,
    posFee,
    posTickLower,
    posTickUpper,
    posLiquidity,
    posFeeGrowth0Last,
    posFeeGrowth1Last,
    posOwed0,
    posOwed1,
  ] = await retryRpc(() =>
    publicClient.readContract({
      address: CONTRACTS.v3PositionManager,
      abi: v3PositionManagerAbi,
      functionName: 'positions',
      args: [tokenId],
    }),
  );
  if (posToken0.toLowerCase() === zeroAddress || posToken1.toLowerCase() === zeroAddress) return undefined;

  const poolAddress = await publicClient.readContract({
    address: CONTRACTS.v3Factory,
    abi: v3FactoryAbi,
    functionName: 'getPool',
    args: [posToken0, posToken1, posFee],
  });
  if (poolAddress === zeroAddress) throw new Error('Pool for this v3 position no longer exists');

  const [slot0, liquidity, global0, global1, lower, upper, tickSpacing, token0, token1] = await retryRpc(() =>
    Promise.all([
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'slot0' }),
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'liquidity' }),
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'feeGrowthGlobal0X128' }),
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'feeGrowthGlobal1X128' }),
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'ticks', args: [posTickLower] }),
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'ticks', args: [posTickUpper] }),
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'tickSpacing' }),
    getToken(posToken0),
    getToken(posToken1),
    ]),
  );

  const [sqrtPriceX96, rawTick] = slot0;
  const tick = Number(rawTick);
  const tickLower = Number(posTickLower);
  const tickUpper = Number(posTickUpper);
  const inside = feeGrowthInside(
    tick,
    tickLower,
    tickUpper,
    global0,
    global1,
    lower[2],
    lower[3],
    upper[2],
    upper[3],
  );
  const fees0 = accruedFees(posLiquidity, inside.inside0X128, posFeeGrowth0Last, posOwed0);
  const fees1 = accruedFees(posLiquidity, inside.inside1X128, posFeeGrowth1Last, posOwed1);
  const amounts = positionAmounts({
    sqrtPriceX96,
    tick,
    tickLower,
    tickUpper,
    liquidity: posLiquidity,
  });

  return {
    version: 'v3',
    tokenId,
    owner,
    token0,
    token1,
    hasNative: false,
    fee: Number(posFee),
    tickSpacing: Number(tickSpacing),
    tickLower,
    tickUpper,
    liquidity: posLiquidity,
    sqrtPriceX96,
    tick,
    price: sqrtRatioX96ToPrice(sqrtPriceX96, token0.decimals, token1.decimals),
    amount0: amounts.amount0,
    amount1: amounts.amount1,
    fees0,
    fees1,
    inRange: isInRange(tick, tickLower, tickUpper),
    poolAddress,
  };
}

async function readV4Position(tokenId: bigint, owner: Address): Promise<PositionSnapshot | undefined> {
  const [poolKeyRaw, info] = await retryRpc(() =>
    publicClient.readContract({
      address: CONTRACTS.v4PositionManager,
      abi: v4PositionManagerAbi,
      functionName: 'getPoolAndPositionInfo',
      args: [tokenId],
    }),
  );

  const key: PoolKeyShape = {
    currency0: poolKeyRaw.currency0,
    currency1: poolKeyRaw.currency1,
    fee: Number(poolKeyRaw.fee),
    tickSpacing: Number(poolKeyRaw.tickSpacing),
    hooks: poolKeyRaw.hooks,
  };
  const { tickLower, tickUpper } = decodeV4PositionInfo(info);
  const poolId = computeV4PoolId(key);
  const positionId = v4PositionId(tokenId, tickLower, tickUpper);

  const [slot0, liquidity, positionState, insideGrowth, token0, token1] = await retryRpc(() =>
    Promise.all([
    publicClient.readContract({ address: CONTRACTS.v4StateView, abi: v4StateViewAbi, functionName: 'getSlot0', args: [poolId] }),
    publicClient.readContract({
      address: CONTRACTS.v4PositionManager,
      abi: v4PositionManagerAbi,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    }),
    publicClient.readContract({
      address: CONTRACTS.v4StateView,
      abi: v4StateViewAbi,
      functionName: 'getPositionInfo',
      args: [poolId, positionId],
    }),
    publicClient.readContract({
      address: CONTRACTS.v4StateView,
      abi: v4StateViewAbi,
      functionName: 'getFeeGrowthInside',
      args: [poolId, tickLower, tickUpper],
    }),
    resolveCurrency(key.currency0),
    resolveCurrency(key.currency1),
    ]),
  );

  const [sqrtPriceX96Raw, rawTick, , lpFee] = slot0;
  const sqrtPriceX96 = sqrtPriceX96Raw;
  const tick = Number(rawTick);
  if (sqrtPriceX96 === 0n) return undefined;

  const [, fgLast0, fgLast1] = positionState;
  const fees0 = accruedFees(liquidity, insideGrowth[0], fgLast0, 0n);
  const fees1 = accruedFees(liquidity, insideGrowth[1], fgLast1, 0n);
  const amounts = positionAmounts({ sqrtPriceX96, tick, tickLower, tickUpper, liquidity });

  return {
    version: 'v4',
    tokenId,
    owner,
    token0,
    token1,
    hasNative: key.currency0.toLowerCase() === zeroAddress || key.currency1.toLowerCase() === zeroAddress,
    fee: Number(lpFee),
    // The pool id is built from the key's static fee, not the realised one.
    keyFee: key.fee,
    tickSpacing: key.tickSpacing,
    tickLower,
    tickUpper,
    liquidity,
    sqrtPriceX96,
    tick,
    price: sqrtRatioX96ToPrice(sqrtPriceX96, token0.decimals, token1.decimals),
    amount0: amounts.amount0,
    amount1: amounts.amount1,
    fees0,
    fees1,
    inRange: isInRange(tick, tickLower, tickUpper),
    poolId,
    hooks: key.hooks,
  };
}

/** Reads a position by tokenId, or undefined when it is burned / does not exist. */
export async function readPosition(
  version: PositionVersion,
  tokenId: bigint,
): Promise<PositionSnapshot | undefined> {
  if (tokenId <= 0n) throw new Error('tokenId must be positive');
  const owner = await ownerOf(version, tokenId);
  if (!owner) return undefined;
  return version === 'v3' ? readV3Position(tokenId, owner) : readV4Position(tokenId, owner);
}

/** Finds which manager owns a tokenId (v3 checked first). */
export async function detectVersion(tokenId: bigint): Promise<PositionVersion | undefined> {
  if (await ownerOf('v3', tokenId)) return 'v3';
  if (await ownerOf('v4', tokenId)) return 'v4';
  return undefined;
}

export function rangePrices(snapshot: PositionSnapshot): { lower: number; upper: number } {
  return {
    lower: tickToPrice(snapshot.tickLower, snapshot.token0.decimals, snapshot.token1.decimals),
    upper: tickToPrice(snapshot.tickUpper, snapshot.token0.decimals, snapshot.token1.decimals),
  };
}
