import type { Address } from 'viem';
import { amountsForLiquidity, liquidityFromAmounts } from './math/positionMath.js';
import { usdPrice } from './prices.js';
import type { Pool } from './pools.js';
import { erc20BalanceOf } from './wallet.js';

const UNIT_LIQUIDITY = 10n ** 18n;

export interface DepositPlan {
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
  valueUsd: number;
  price0Usd: number;
  price1Usd: number;
  balance0?: bigint;
  balance1?: bigint;
  shortfall0: bigint;
  shortfall1: bigint;
}

function valueOfAmounts(
  pool: Pool,
  amount0: bigint,
  amount1: bigint,
  price0Usd: number,
  price1Usd: number,
): number {
  const a0 = Number(amount0) / 10 ** pool.token0.decimals;
  const a1 = Number(amount1) / 10 ** pool.token1.decimals;
  const safe = (n: number) => (Number.isFinite(n) ? n : 0);
  return safe(a0 * price0Usd) + safe(a1 * price1Usd);
}

async function finalize(
  pool: Pool,
  liquidity: bigint,
  amount0: bigint,
  amount1: bigint,
  price0Usd: number,
  price1Usd: number,
  owner?: Address,
): Promise<DepositPlan> {
  const [balance0, balance1] = owner
    ? await Promise.all([erc20BalanceOf(pool.token0.address, owner), erc20BalanceOf(pool.token1.address, owner)])
    : [undefined, undefined];
  return {
    liquidity,
    amount0,
    amount1,
    valueUsd: valueOfAmounts(pool, amount0, amount1, price0Usd, price1Usd),
    price0Usd,
    price1Usd,
    balance0,
    balance1,
    shortfall0: balance0 !== undefined && balance0 < amount0 ? amount0 - balance0 : 0n,
    shortfall1: balance1 !== undefined && balance1 < amount1 ? amount1 - balance1 : 0n,
  };
}

/**
 * Computes the deposit required for a target USD size at the pool's current
 * price. Amounts are linear in liquidity, so we price one unit of liquidity
 * and scale.
 */
export async function planByUsd(
  pool: Pool,
  tickLower: number,
  tickUpper: number,
  targetUsd: number,
  owner?: Address,
): Promise<DepositPlan> {
  if (!(targetUsd > 0)) throw new Error('Deposit size must be greater than zero');
  const [price0Usd, price1Usd] = await Promise.all([usdPrice(pool.token0.address), usdPrice(pool.token1.address)]);

  const base = amountsForLiquidity(pool.sqrtPriceX96, tickLower, tickUpper, UNIT_LIQUIDITY);
  const unitValue = valueOfAmounts(pool, base.amount0, base.amount1, price0Usd, price1Usd);
  if (!(unitValue > 0)) throw new Error('No USD price feed for this pair — cannot size a USD deposit');

  const scaled = Math.floor((targetUsd / unitValue) * Number(UNIT_LIQUIDITY));
  if (scaled <= 0) throw new Error('Deposit too small for this range');
  const liquidity = BigInt(scaled);
  const amounts = amountsForLiquidity(pool.sqrtPriceX96, tickLower, tickUpper, liquidity);
  return finalize(pool, liquidity, amounts.amount0, amounts.amount1, price0Usd, price1Usd, owner);
}

/**
 * Sizes a one-sided deposit from `pct`% of one token's balance. The other
 * side is left at zero, so the mint draws everything from that token.
 */
export async function planBySideShare(
  pool: Pool,
  tickLower: number,
  tickUpper: number,
  side: 'quote' | 'token',
  pct: number,
  owner: Address,
  token: { address: string },
): Promise<DepositPlan> {
  const [price0Usd, price1Usd, balance0, balance1] = await Promise.all([
    usdPrice(pool.token0.address),
    usdPrice(pool.token1.address),
    erc20BalanceOf(pool.token0.address, owner),
    erc20BalanceOf(pool.token1.address, owner),
  ]);
  const share = BigInt(Math.max(1, Math.min(100, Math.round(pct))));
  const tokenIsToken0 = pool.token0.address.toLowerCase() === token.address.toLowerCase();
  const spendToken0 = side === 'token' ? tokenIsToken0 : !tokenIsToken0;
  const balance = spendToken0 ? balance0 : balance1;
  const amount0 = spendToken0 ? (balance * share) / 100n : 0n;
  const amount1 = spendToken0 ? 0n : (balance * share) / 100n;
  if (amount0 === 0n && amount1 === 0n) {
    throw new Error(`Wallet holds none of the ${spendToken0 ? pool.token0.symbol : pool.token1.symbol} needed`);
  }

  const liquidity = liquidityFromAmounts(pool.sqrtPriceX96, pool.tick, tickLower, tickUpper, amount0, amount1);
  if (liquidity <= 0n) throw new Error('Amount too small for this range');
  const required = amountsForLiquidity(pool.sqrtPriceX96, tickLower, tickUpper, liquidity);
  const plan = await finalize(pool, liquidity, required.amount0, required.amount1, price0Usd, price1Usd, owner);
  return { ...plan, balance0, balance1 };
}

/** Uses `pct` percent of both wallet balances. */
export async function planByWalletShare(
  pool: Pool,
  tickLower: number,
  tickUpper: number,
  pct: number,
  owner: Address,
): Promise<DepositPlan> {
  const [price0Usd, price1Usd, balance0, balance1] = await Promise.all([
    usdPrice(pool.token0.address),
    usdPrice(pool.token1.address),
    erc20BalanceOf(pool.token0.address, owner),
    erc20BalanceOf(pool.token1.address, owner),
  ]);
  const share = BigInt(Math.max(1, Math.min(100, Math.round(pct))));
  const amount0 = (balance0 * share) / 100n;
  const amount1 = (balance1 * share) / 100n;
  if (amount0 === 0n && amount1 === 0n) throw new Error('Wallet holds none of these tokens');

  const liquidity = liquidityFromAmounts(pool.sqrtPriceX96, pool.tick, tickLower, tickUpper, amount0, amount1);
  if (liquidity <= 0n) throw new Error('Amount too small for this range');
  const required = amountsForLiquidity(pool.sqrtPriceX96, tickLower, tickUpper, liquidity);
  const plan = await finalize(pool, liquidity, required.amount0, required.amount1, price0Usd, price1Usd, owner);
  return { ...plan, balance0, balance1 };
}
