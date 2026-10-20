import { defineChain } from 'viem';

/**
 * Robinhood Chain — Arbitrum Orbit L2, gas token ETH.
 * Addresses below are taken from Uniswap's official deployment feed
 * (https://developers.uniswap.org/deployments.json) and Robinhood's docs,
 * then verified on-chain by `npm run verify:chain`.
 */
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://robinhood.drpc.org'] },
  },
  blockExplorers: {
    default: { name: 'Robinhood Chain Explorer', url: 'https://robinhoodchain.blockscout.com' },
  },
});

export const ETH_SENTINEL = '0x0000000000000000000000000000000000000000' as const;

export const TOKENS = {
  WETH: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
} as const;

/**
 * The chains the bot can report on.
 *
 * The key is stored on every closed position, so the calendar can be scoped
 * to one chain and another one can be added by changing only the filter and
 * the label.
 */
export const CHAINS = {
  robinhood: { id: 'robinhood', label: 'ROBINHOOD CHAIN · LP' },
} as const;

export const CONTRACTS = {
  // Uniswap v3
  v3Factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  v3PositionManager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
  v3QuoterV2: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
  v3SwapRouter02: '0xCaf681a66D020601342297493863E78C959E5cb2',
  tickLens: '0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468',
  // Uniswap v4
  v4PoolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  v4PositionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  v4Quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
  v4StateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
  // Shared
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
} as const;

/**
 * v3 fee tiers in hundredths of a bip (100 = 0.01%). The four Uniswap defaults
 * come first; the rest cover tiers that were enabled on this chain, since the
 * factory maps any fee it was configured with.
 */
export const V3_FEE_TIERS = [100, 500, 3000, 10000, 2500, 5000, 50000] as const;

/**
 * v4 tick spacings probed when scanning. Uniswap's own tiers use 1/10/60/200,
 * but launchpad pools on this chain pick their own (100 is common), so the
 * matrix is deliberately wider. `0x800000` is the dynamic-fee flag.
 */
const V4_TICK_SPACINGS = [1, 10, 60, 200, 100] as const;

const V4_FEES = [100, 500, 3000, 10000, 0x800000] as const;

/**
 * The v4 dynamic-fee flag. A pool key with this fee reports its current fee
 * in the slot, so the key fee and the realised fee are different numbers.
 */
export const V4_DYNAMIC_FEE = 0x800000;

/** True when a raw v4 fee is the dynamic-fee flag. */
export function isDynamicFee(rawFee: number): boolean {
  return rawFee >= V4_DYNAMIC_FEE;
}

/** Every (fee, tickSpacing) pool key the scanner probes. */
export const V4_POOL_CANDIDATES: ReadonlyArray<{ fee: number; tickSpacing: number }> = V4_FEES.flatMap(
  (fee) => V4_TICK_SPACINGS.map((tickSpacing) => ({ fee, tickSpacing })),
);

export const MAX_UINT128 = (1n << 128n) - 1n;
export const Q128 = 1n << 128n;
