import {
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import { publicClient } from '../chain/client.js';
import { CONTRACTS } from '../constants/chain.js';
import { retryRpc } from '../utils/async.js';
import type { Pool } from './pools.js';

/**
 * Uniswap's quoter ABIs are tiny, and viem's generic ABI typing chokes on the
 * tuple parameters here, so the calls are encoded by hand. The selectors are
 * asserted in tests/encoding.test.ts.
 */
export const V3_QUOTE_SELECTOR = toFunctionSelector(
  'quoteExactInputSingle((address,address,uint256,uint24,uint160))',
);
export const V4_QUOTE_SELECTOR = toFunctionSelector(
  'quoteExactInputSingle((address,address,uint24,int24,address),bool,uint128,bytes)',
);

const V3_QUOTE_PARAMS = [
  {
    type: 'tuple',
    components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'fee', type: 'uint24' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
  },
] as const;

const V4_QUOTE_PARAMS = [
  {
    type: 'tuple',
    components: [
      { name: 'currency0', type: 'address' },
      { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickSpacing', type: 'int24' },
      { name: 'hooks', type: 'address' },
    ],
  },
  { name: 'zeroForOne', type: 'bool' },
  { name: 'exactAmount', type: 'uint128' },
  { name: 'hookData', type: 'bytes' },
] as const;

const V3_QUOTE_RESULTS = [
  { type: 'uint256' },
  { type: 'uint160' },
  { type: 'uint32' },
  { type: 'uint256' },
] as const;

const V4_QUOTE_RESULTS = [{ type: 'uint256' }, { type: 'uint256' }] as const;

async function callQuoter(to: Address, data: Hex): Promise<Hex> {
  const result = await retryRpc(() => publicClient.call({ to, data }));
  if (!result.data) throw new Error('quoter returned no data');
  return result.data;
}

/** Exact-in quote on a v3 pool's fee tier. */
export async function quoteV3(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number,
): Promise<bigint> {
  const data = concat([
    V3_QUOTE_SELECTOR,
    encodeAbiParameters(V3_QUOTE_PARAMS, [
      { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n },
    ]),
  ]);
  const raw = await callQuoter(CONTRACTS.v3QuoterV2, data);
  const [amountOut] = decodeAbiParameters(V3_QUOTE_RESULTS, raw);
  return amountOut;
}

/** Exact-in quote through a v4 pool key. */
async function quoteV4(pool: Pool, tokenIn: Address, exactAmount: bigint): Promise<bigint> {
  if (pool.version !== 'v4') throw new Error('quoteV4 needs a v4 pool');
  const zeroForOne = tokenIn.toLowerCase() === pool.token0.address.toLowerCase();
  const data = concat([
    V4_QUOTE_SELECTOR,
    encodeAbiParameters(V4_QUOTE_PARAMS, [
      {
        currency0: pool.key.currency0,
        currency1: pool.key.currency1,
        fee: pool.key.fee,
        tickSpacing: pool.key.tickSpacing,
        hooks: pool.key.hooks,
      },
      zeroForOne,
      exactAmount,
      '0x',
    ]),
  ]);
  const raw = await callQuoter(CONTRACTS.v4Quoter, data);
  const [amountOut] = decodeAbiParameters(V4_QUOTE_RESULTS, raw);
  return amountOut;
}

/** Exact-in quote through whichever pool version is given. */
export async function quoteVia(
  pool: Pool,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<bigint> {
  return pool.version === 'v3'
    ? quoteV3(tokenIn, tokenOut, amountIn, pool.fee)
    : quoteV4(pool, tokenIn, amountIn);
}
