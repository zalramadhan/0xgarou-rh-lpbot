import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, toFunctionSelector, zeroAddress, type Hex } from 'viem';
import { computeV4PoolId, sortCurrencies } from '../src/core/pools.js';
import { decodeV4PositionInfo, v4PositionId } from '../src/core/positions.js';
import { encodeV4UnlockData, V4_ACTION } from '../src/core/actions.js';
import { CONTRACTS, TOKENS } from '../src/constants/chain.js';
import { recoverV4Key } from '../src/core/discovery.js';
import { parseFeePct } from '../src/core/indexer.js';
import { V3_QUOTE_SELECTOR, V4_QUOTE_SELECTOR } from '../src/core/quoter.js';

const WETH = TOKENS.WETH as `0x${string}`;
const USDG = TOKENS.USDG as `0x${string}`;

describe('v4 pool ids', () => {
  it('matches the live WETH/USDG 0.05% pool id on Robinhood Chain', () => {
    const [currency0, currency1] = sortCurrencies(WETH, USDG);
    const id = computeV4PoolId({ currency0, currency1, fee: 500, tickSpacing: 10, hooks: zeroAddress });
    // Read from StateView on chain 4663 during development; if this changes the
    // address list or the hashing scheme is wrong, the bot would mint into a
    // non-existent pool.
    expect(id).toBe('0xfcfae8fa0bd6da961bcf5d990f27690932deac4f093e99bf3e871691c6586593');
  });

  it('sorts currencies case-insensitively by address', () => {
    expect(sortCurrencies(USDG, WETH)).toEqual([WETH, USDG]);
    expect(sortCurrencies(WETH, USDG)).toEqual([WETH, USDG]);
  });
});

describe('v4 pool key recovery', () => {
  const RAETO = '0x72be1277e198d0c476869253cb4e62807e14533c' as `0x${string}`;

  it('rebuilds a launchpad pool key with a 5% static fee and 100 spacing', () => {
    // Live RAETO/USDG pool on Robinhood Chain (the deepest pool for that
    // token). The token listing does not report the fee, so recovery must try
    // exotic static tiers or the bot reports "no pool" while $59k sits in it.
    const key = recoverV4Key(RAETO, USDG, '0x5480a1684776826bc7c98123635ed38accedaa6adeb49f73bc5e87975c1ef995');
    expect(key).toEqual({ currency0: USDG, currency1: RAETO, fee: 50_000, tickSpacing: 100, hooks: zeroAddress });
  });

  it('prefers the fee reported by the listing', () => {
    const key = recoverV4Key(RAETO, USDG, '0x5480a1684776826bc7c98123635ed38accedaa6adeb49f73bc5e87975c1ef995', 5);
    expect(key?.fee).toBe(50_000);
  });

  it('returns undefined for an id that cannot be rebuilt', () => {
    expect(recoverV4Key(RAETO, USDG, `0x${'11'.repeat(32)}`)).toBeUndefined();
  });
});

describe('quoter selectors', () => {
  it('matches the Uniswap quoter signatures', () => {
    // A wrong selector makes every quote fail, and the safety screen would
    // then report "unknown" instead of catching a honeypot.
    expect(V3_QUOTE_SELECTOR).toBe(
      toFunctionSelector('quoteExactInputSingle((address,address,uint256,uint24,uint160))'),
    );
    expect(V4_QUOTE_SELECTOR).toBe(
      toFunctionSelector('quoteExactInputSingle((address,address,uint24,int24,address),bool,uint128,bytes)'),
    );
  });
});

describe('indexer fee parsing', () => {  it('reads the percentage from the pool name when the listing omits it', () => {
    expect(parseFeePct(null, 'RAETO / USDG 5%')).toBe(5);
    expect(parseFeePct(undefined, 'WETH / USDG 0.05%')).toBe(0.05);
  });

  it('prefers the explicit field and ignores unparseable names', () => {
    expect(parseFeePct('0.3', 'WETH / USDG 5%')).toBe(0.3);
    expect(parseFeePct(null, 'RAETO / USDG')).toBeUndefined();
  });
});

describe('v4 position info decoding', () => {
  const pack = (poolId: bigint, tickUpper: number, tickLower: number) =>
    (poolId << 56n) | ((BigInt(tickUpper) & 0xffffffn) << 32n) | ((BigInt(tickLower) & 0xffffffn) << 8n);

  it('decodes positive ticks', () => {
    const info = pack(1n, 1200, -600);
    expect(decodeV4PositionInfo(info)).toEqual({ tickLower: -600, tickUpper: 1200 });
  });

  it('sign-extends negative ticks', () => {
    const info = pack(1n, -60, -120);
    expect(decodeV4PositionInfo(info)).toEqual({ tickLower: -120, tickUpper: -60 });
  });

  it('keeps extreme ticks intact', () => {
    const info = pack(1n, 887220, -887220);
    expect(decodeV4PositionInfo(info)).toEqual({ tickLower: -887220, tickUpper: 887220 });
  });
});

describe('v4 position storage key', () => {
  it('uses the position manager, ticks and tokenId', () => {
    const a = v4PositionId(1n, -600, 600);
    const b = v4PositionId(2n, -600, 600);
    expect(a).not.toBe(b);
    // keccak256 of 58 packed bytes
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(v4PositionId(1n, -600, 600)).toBe(a);
  });
});

describe('v4 unlock data', () => {
  it('packs actions as bytes and params as an array', () => {
    const paramA = '0xdeadbeef' as Hex;
    const paramB = '0xcafe' as Hex;
    const data = encodeV4UnlockData([V4_ACTION.MINT_POSITION, V4_ACTION.CLOSE_CURRENCY], [paramA, paramB]);

    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], data);
    expect(actions).toBe('0x0212');
    expect(params).toEqual([paramA, paramB]);
  });

  it('rejects mismatched action/param counts', () => {
    expect(() => encodeV4UnlockData([V4_ACTION.MINT_POSITION], [])).toThrow(/mismatch/);
  });

  it('orders close actions for both currencies', () => {
    const data = encodeV4UnlockData(
      [V4_ACTION.BURN_POSITION, V4_ACTION.CLOSE_CURRENCY, V4_ACTION.CLOSE_CURRENCY],
      ['0x01', '0x02', '0x03'] as Hex[],
    );
    const [actions] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], data);
    expect(actions).toBe('0x031212');
  });
});

describe('contract constants', () => {
  it('uses the verified Uniswap deployments', () => {
    expect(CONTRACTS.v3PositionManager).toBe('0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3');
    expect(CONTRACTS.v4PositionManager).toBe('0x58daec3116aae6D93017bAAea7749052E8a04fA7');
    expect(CONTRACTS.permit2).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3');
  });
});
