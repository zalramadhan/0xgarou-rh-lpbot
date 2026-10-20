/**
 * Verifies the hardcoded Robinhood Chain addresses and the v4 pool-id math
 * against live chain state. Run with: npm run verify:chain
 */
import { zeroAddress } from 'viem';
import { CONTRACTS, TOKENS, robinhoodChain } from '../src/constants/chain.js';
import { v3PositionManagerAbi, v4PositionManagerAbi } from '../src/constants/abis.js';
import { publicClient } from '../src/chain/client.js';
import { findPools, computeV4PoolId, sortCurrencies } from '../src/core/pools.js';
import { getToken, normalizeAddress } from '../src/core/tokens.js';
import { usdPrice } from '../src/core/prices.js';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const chainId = await publicClient.getChainId();
  check('RPC chainId is 4663', chainId === robinhoodChain.id, String(chainId));

  for (const [name, address] of Object.entries(CONTRACTS)) {
    const code = await publicClient.getCode({ address });
    check(`contract deployed: ${name}`, Boolean(code && code !== '0x'), address);
  }

  const npmFactory = await publicClient.readContract({
    address: CONTRACTS.v3PositionManager,
    abi: v3PositionManagerAbi,
    functionName: 'factory',
  });
  check('v3 PositionManager.factory matches', npmFactory.toLowerCase() === CONTRACTS.v3Factory.toLowerCase(), npmFactory);

  const weth9 = await publicClient.readContract({
    address: CONTRACTS.v3PositionManager,
    abi: v3PositionManagerAbi,
    functionName: 'WETH9',
  });
  check('v3 PositionManager.WETH9 is WETH', weth9.toLowerCase() === TOKENS.WETH.toLowerCase(), weth9);

  const v4PoolManager = await publicClient.readContract({
    address: CONTRACTS.v4PositionManager,
    abi: v4PositionManagerAbi,
    functionName: 'poolManager',
  });
  check(
    'v4 PositionManager.poolManager matches',
    v4PoolManager.toLowerCase() === CONTRACTS.v4PoolManager.toLowerCase(),
    v4PoolManager,
  );

  const weth = await getToken(TOKENS.WETH);
  const usdg = await getToken(TOKENS.USDG);
  check('WETH metadata', weth.symbol === 'WETH' && weth.decimals === 18, `${weth.symbol}/${weth.decimals}`);
  check('USDG metadata', usdg.symbol === 'USDG' && usdg.decimals === 6, `${usdg.symbol}/${usdg.decimals}`);

  const wethPrice = await usdPrice(TOKENS.WETH);
  check('WETH has a USDG price route', Number.isFinite(wethPrice) && wethPrice > 0, `$${wethPrice.toFixed(2)}`);

  const [currency0, currency1] = sortCurrencies(normalizeAddress(TOKENS.WETH), normalizeAddress(TOKENS.USDG));
  const standardKey = { currency0, currency1, fee: 500, tickSpacing: 10, hooks: zeroAddress };
  const standardPoolId = computeV4PoolId(standardKey);
  const dynamicKey = { currency0, currency1, fee: 0x800000, tickSpacing: 60, hooks: zeroAddress };
  const dynamicPoolId = computeV4PoolId(dynamicKey);
  console.log(`   v4 poolId (WETH/USDG 0.05%): ${standardPoolId}`);
  console.log(`   v4 poolId (WETH/USDG dynamic): ${dynamicPoolId}`);

  const pools = await findPools(normalizeAddress(TOKENS.WETH), normalizeAddress(TOKENS.USDG));
  check('found v3/v4 WETH-USDG pools', pools.length > 0, pools.map((p) => p.label).join(', '));
  for (const pool of pools) {
    console.log(
      `   ${pool.label.padEnd(14)} ${pool.version === 'v3' ? pool.address : pool.poolId} price=${pool.price.toFixed(2)} liq=${pool.liquidity}`,
    );
  }

  const gasPrice = await publicClient.getGasPrice();
  console.log(`   gas price: ${gasPrice} wei`);

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verification failed:', err);
  process.exit(1);
});
