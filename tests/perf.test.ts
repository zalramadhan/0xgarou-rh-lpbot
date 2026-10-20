import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, zeroAddress, type Address } from 'viem';
import { computeV4PoolId, sortCurrencies } from '../src/core/pools.js';
import { recoverV4Key, recoverV4Keys } from '../src/core/discovery.js';
import { mapLimit } from '../src/utils/async.js';
import { reanchorRange } from '../src/core/math/tickMath.js';
import { oneSidedDirection } from '../src/core/pairs.js';
import { looksLikeAddress } from '../src/bot/newFlow.js';

const C0 = '0x72be1277e198d0c476869253cb4e62807e14533c' as Address;
const C1 = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;

describe('pool id encoding', () => {
  it('matches the generic ABI encoder', () => {
    const key = { currency0: C0, currency1: C1, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
    const reference = keccak256(
      encodeAbiParameters(
        [
          { type: 'address', name: 'currency0' },
          { type: 'address', name: 'currency1' },
          { type: 'uint24', name: 'fee' },
          { type: 'int24', name: 'tickSpacing' },
          { type: 'address', name: 'hooks' },
        ],
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      ),
    );
    expect(computeV4PoolId(key)).toBe(reference);
  });

  it('recovers a key from its pool id', () => {
    const [currency0, currency1] = sortCurrencies(C0, C1);
    const key = { currency0, currency1, fee: 500, tickSpacing: 10, hooks: zeroAddress };
    const recovered = recoverV4Key(C0, C1, computeV4PoolId(key));
    expect(recovered).toMatchObject({ fee: 500, tickSpacing: 10 });
  });

  it('recovers an exotic tick spacing too', () => {
    const [currency0, currency1] = sortCurrencies(C0, C1);
    const key = { currency0, currency1, fee: 10000, tickSpacing: 1234, hooks: zeroAddress };
    const recovered = recoverV4Key(C0, C1, computeV4PoolId(key));
    expect(recovered).toMatchObject({ fee: 10000, tickSpacing: 1234 });
  });

  it('recovers a whole list of pool ids in one sweep', () => {
    // The scan recovers the ids of a token in one go: the guess (fee, tick
    // spacing) is the same for every pool of the pair, so paying for it per
    // pool is what made a scan slow.
    const [currency0, currency1] = sortCurrencies(C0, C1);
    const wanted = [
      { fee: 500, tickSpacing: 60 },
      { fee: 10000, tickSpacing: 1234 },
      { fee: 3000, tickSpacing: 200 },
    ];
    const ids = wanted.map((entry) =>
      computeV4PoolId({ currency0, currency1, fee: entry.fee, tickSpacing: entry.tickSpacing, hooks: zeroAddress }),
    );

    const recovered = recoverV4Keys(
      C0,
      C1,
      ids.map((poolId, index) => ({ poolId, feePct: wanted[index]!.fee / 10_000 })),
    );

    expect(recovered.size).toBe(3);
    for (const entry of wanted) {
      const id = computeV4PoolId({
        currency0,
        currency1,
        fee: entry.fee,
        tickSpacing: entry.tickSpacing,
        hooks: zeroAddress,
      });
      expect(recovered.get(id.toLowerCase())).toMatchObject(entry);
    }
  });
});

describe('bounded concurrency', () => {
  it('keeps the result order and the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (value) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return value * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, async (value) => value)).toEqual([]);
  });
});

describe('pasted addresses', () => {
  it('recognises a contract address', () => {
    expect(looksLikeAddress('0x72be1277e198d0c476869253cb4e62807e14533c')).toBe(true);
    expect(looksLikeAddress(' 0x72BE1277E198D0C476869253CB4E62807E14533C ')).toBe(true);
    expect(looksLikeAddress('0x1234')).toBe(false);
    expect(looksLikeAddress('hello')).toBe(false);
    expect(looksLikeAddress('0x72be1277e198d0c476869253cb4e62807e14533cz')).toBe(false);
  });
});

describe('re-anchoring a range to the live price', () => {
  it('keeps the width and follows the market', () => {
    // A one-sided range that was picked below a -341350 market.
    const range = { tickLower: -342_780, tickUpper: -341_400 };
    const moved = reanchorRange(range, -341_500, 'down', 60);
    expect(moved.changed).toBe(true);
    expect(moved.tickUpper - moved.tickLower).toBe(range.tickUpper - range.tickLower);
    // The near edge follows the market, so the range stays below it.
    expect(moved.tickUpper).toBeLessThanOrEqual(-341_500);
  });

  it('leaves a range that is still valid alone', () => {
    const range = { tickLower: -342_780, tickUpper: -341_400 };
    const same = reanchorRange(range, -341_350, 'down', 60);
    expect(same.changed).toBe(false);
    expect(same.tickLower).toBe(range.tickLower);
    expect(same.tickUpper).toBe(range.tickUpper);
  });

  it('re-centres a two-sided range on the price', () => {
    const moved = reanchorRange({ tickLower: -342_780, tickUpper: -339_960 }, -341_300, 'both', 60);
    expect(moved.tickLower).toBeLessThanOrEqual(-341_300);
    expect(moved.tickUpper).toBeGreaterThan(-341_300);
  });
});

describe('the direction of a one-sided range', () => {
  const USDG = {
    address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const,
    symbol: 'USDG',
    name: 'USDG',
    decimals: 6,
  };
  const TOKEN = {
    address: '0x72be1277e198d0c476869253cb4e62807e14533c' as const,
    symbol: 'RAETO',
    name: 'RAETO',
    decimals: 18,
  };

  it('puts the range on the side that holds the funded token', () => {
    const usdgFirst = { token0: USDG, token1: TOKEN };
    const tokenFirst = { token0: TOKEN, token1: USDG };
    // Funding USDG needs a range above the market (a position above the price
    // holds token0), and funding RAETO needs one below.
    expect(oneSidedDirection(usdgFirst, 'quote')).toBe('up');
    expect(oneSidedDirection(usdgFirst, 'token')).toBe('down');
    expect(oneSidedDirection(tokenFirst, 'quote')).toBe('down');
    expect(oneSidedDirection(tokenFirst, 'token')).toBe('up');
  });
});
