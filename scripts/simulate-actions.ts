/**
 * Validates the transaction encodings against the live contracts with eth_call.
 * Nothing is signed or broadcast.
 *
 *   npm run simulate:actions
 *
 * A mint is expected to revert on funding/allowance checks for a random holder;
 * what matters is that the revert comes from the token transfer step, not from
 * malformed calldata (UnsupportedAction / abi decode errors).
 */
import { zeroAddress } from 'viem';
import { TOKENS } from '../src/constants/chain.js';
import { publicClient } from '../src/chain/client.js';
import { getToken, normalizeAddress } from '../src/core/tokens.js';
import { findPools, sortCurrencies } from '../src/core/pools.js';
import { readPosition } from '../src/core/positions.js';
import { closePosition, collectFees, openPosition } from '../src/core/actions.js';
import { tickRangeFromPercent } from '../src/core/math/tickMath.js';
import { planByUsd } from '../src/core/planner.js';
import type { Address } from 'viem';

// A holder that owns early v3 and v4 positions on this chain; used only as the
// `from` address for read-only simulations.
const SIM_OWNER: Address = '0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52';

function report(label: string, error?: string, note?: string) {
  if (note) {
    console.log(`•  ${label}: ${note}`);
    return;
  }
  if (!error) {
    console.log(`✅ ${label}: simulated successfully`);
    return;
  }
  console.log(`•  ${label}: reverted — ${error}`);
}

async function main() {
  const weth = await getToken(TOKENS.WETH);
  const usdg = await getToken(TOKENS.USDG);
  console.log(`simulating from ${SIM_OWNER} (${weth.symbol}/${usdg.symbol})\n`);

  for (const version of ['v3', 'v4'] as const) {
    for (const tokenId of [1n, 2n]) {
      const snapshot = await readPosition(version, tokenId);
      if (!snapshot) {
        console.log(`-  ${version} #${tokenId}: not found`);
        continue;
      }
      const owner = snapshot.owner === zeroAddress ? SIM_OWNER : snapshot.owner;
      const collect = await collectFees(snapshot, owner, true);
      report(`${version} #${tokenId} collect`, collect.error);

      const close = await closePosition({ snapshot, slippagePct: 1, recipient: owner, dryRun: true });
      report(`${version} #${tokenId} decrease+collect+burn`, close.error);
    }
  }

  console.log('');
  const pools = await findPools(normalizeAddress(TOKENS.WETH), normalizeAddress(TOKENS.USDG));
  for (const pool of pools.filter((p) => p.fee === 500)) {
    const ticks = tickRangeFromPercent(pool.price, 10, 10, pool.token0.decimals, pool.token1.decimals, pool.tickSpacing);
    try {
      const plan = await planByUsd(pool, ticks.tickLower, ticks.tickUpper, 5, SIM_OWNER);
      const result = await openPosition({
        pool,
        tickLower: ticks.tickLower,
        tickUpper: ticks.tickUpper,
        amount0: plan.amount0,
        amount1: plan.amount1,
        slippagePct: 1,
        recipient: SIM_OWNER,
        dryRun: true,
      });
      report(`${pool.version} ${pool.fee / 10_000}% mint (${plan.amount0} / ${plan.amount1})`, result.error, result.note);
    } catch (err) {
      console.log(`•  ${pool.version} mint setup failed: ${(err as Error).message}`);
    }
  }

  const [c0, c1] = sortCurrencies(normalizeAddress(TOKENS.WETH), normalizeAddress(TOKENS.USDG));
  console.log(`\nv4 currency order: ${c0} < ${c1}`);
  const gas = await publicClient.getGasPrice();
  console.log(`gas price ${gas} wei`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
