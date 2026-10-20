import { afterEach, describe, expect, it } from 'vitest';
import { isV4Transfer, parseIndexerTransfers } from '../src/core/detect.js';
import { chartTokenAddress, gmgnAddressLink, gmgnTokenLink, lpAgentPortfolioLink } from '../src/bot/links.js';
import { detectedKeyboard, detectedText, splitRows } from '../src/bot/detectFlow.js';
import { positionKeyboard } from '../src/bot/ui.js';
import { store } from '../src/store/store.js';
import { TtlCache } from '../src/utils/cache.js';
import type { PositionSnapshot } from '../src/core/positions.js';
import type { TrackedPosition } from '../src/store/store.js';

const CHAT_ID = 777_002;
const WALLET = '0xa2CA2a1cE4a3e0F5d1A0B2c3D4e5F60718293a4B5';

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ABC = '0x72be1277e198d0c476869253cb4e62807e14533c';

function snapshot(token0: string, token1: string): PositionSnapshot {
  return {
    version: 'v4',
    tokenId: 1n,
    owner: WALLET,
    token0: { address: token0, symbol: 'A', name: 'A', decimals: 18 },
    token1: { address: token1, symbol: 'B', name: 'B', decimals: 18 },
    hasNative: false,
    fee: 3000,
    tickSpacing: 60,
    tickLower: -60,
    tickUpper: 60,
    liquidity: 1n,
    sqrtPriceX96: 2n ** 96n,
    tick: 0,
    price: 1,
    amount0: 1n,
    amount1: 1n,
    fees0: 0n,
    fees1: 0n,
    inRange: true,
    poolAddress: '0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a',
  } as PositionSnapshot;
}

const tracked: TrackedPosition = {
  id: 'p1',
  chatId: CHAT_ID,
  version: 'v4',
  tokenId: '99',
  entry: { amount0: '0', amount1: '0', valueUsd: 10, price: 1, openedAt: Date.now() },
  basisUsd: 10,
  feesWithdrawnUsd: 0,
  compoundedFeesUsd: 0,
  alerts: true,
  autoCompound: false,
  compoundIntervalMs: 3_600_000,
  compoundMinFeeUsd: 1,
  createdAt: Date.now(),
};

/** A tracked position with the given manager and id. */
function trackRecord(version: 'v3' | 'v4', tokenId: string) {
  return {
    chatId: CHAT_ID,
    version,
    tokenId,
    entry: { amount0: '0', amount1: '0', valueUsd: 10, price: 1, openedAt: Date.now() },
    basisUsd: 10,
    feesWithdrawnUsd: 0,
    compoundedFeesUsd: 0,
    alerts: true,
    autoCompound: false,
    compoundIntervalMs: 3_600_000,
    compoundMinFeeUsd: 1,
  };
}

afterEach(async () => {
  for (const position of store.positionsFor(CHAT_ID)) await store.remove(position.id);
});

describe('position links', () => {
  it('points at the LP Agent portfolio for the wallet', () => {
    const link = lpAgentPortfolioLink(WALLET);
    expect(link).toContain('https://app.lpagent.io/portfolio');
    expect(link).toContain(`address=${WALLET}`);
    expect(link).toContain('chain=ROBINHOOD');
  });

  it('points at the GMGN token and address pages', () => {
    expect(gmgnTokenLink(ABC)).toBe(`https://gmgn.ai/robinhood/token/${ABC}`);
    expect(gmgnAddressLink(WALLET)).toBe(`https://gmgn.ai/robinhood/address/${WALLET}`);
  });

  it('charts the traded side of the pool, not the quote asset', () => {
    expect(chartTokenAddress(snapshot(USDG, ABC))).toBe(ABC);
    expect(chartTokenAddress(snapshot(WETH, ABC))).toBe(ABC);
    // Two quote assets: there is no traded side, so token0 is used.
    expect(chartTokenAddress(snapshot(WETH, USDG))).toBe(WETH);
  });

  it('adds both link buttons to the position keyboard', () => {
    const kb = positionKeyboard('p1', tracked, true, { snapshot: snapshot(USDG, ABC), wallet: WALLET });
    const buttons = kb.inline_keyboard.flat() as { text: string; url?: string }[];
    const lp = buttons.find((b) => b.text === '🤖 Check LP Agent');
    const gmgn = buttons.find((b) => b.text === '📈 View Chart on GMGN');
    expect(lp?.url).toBe(lpAgentPortfolioLink(WALLET));
    expect(gmgn?.url).toBe(gmgnTokenLink(ABC));
  });
});

describe('detected position rows', () => {
  it('marks the positions the store already tracks', async () => {
    await store.add(trackRecord('v4', '99'));

    const rows = splitRows([
      { version: 'v4', tokenId: 99n },
      { version: 'v4', tokenId: 100n },
      { version: 'v3', tokenId: 7n },
    ]);

    expect(rows.map((r) => r.tracked)).toEqual([true, false, false]);
    expect(rows[1]!.version).toBe('v4');
    expect(rows[2]!.version).toBe('v3');
  });

  it('treats the same id in the two managers as two different NFTs', async () => {
    await store.add(trackRecord('v3', '7'));

    const rows = splitRows([
      { version: 'v3', tokenId: 7n },
      { version: 'v4', tokenId: 7n },
    ]);

    expect(rows.map((r) => r.tracked)).toEqual([true, false]);
  });
});

describe('the detected screen', () => {
  it('counts the found, the untracked and the already tracked', () => {
    const text = detectedText(
      WALLET,
      [
        { version: 'v4', tokenId: 1n, tracked: false },
        { version: 'v4', tokenId: 2n, tracked: true },
        { version: 'v3', tokenId: 3n, tracked: false },
      ],
      'indexed via RPC',
    );

    expect(text).toContain('🧩 Found <b>3</b> LP NFTs · v3 1 · v4 2');
    expect(text).toContain('📥 Untracked <b>2</b> · indexed via RPC');
    expect(text).toContain('✅ 1 already tracked.');
    expect(text).toContain('👇 Tap to start tracking one:');
  });

  it('says so when the wallet holds nothing', () => {
    const text = detectedText(WALLET, [], 'indexed via RPC');
    expect(text).toContain('No LP position NFTs in this wallet.');
  });

  it('says so when every found position is already tracked', () => {
    const text = detectedText(
      WALLET,
      [{ version: 'v4', tokenId: 1n, tracked: true }],
      'indexed via RPC',
    );
    expect(text).toContain('✅ Every found position is already tracked.');
  });

  it('offers a track button per untracked position and a rescan', () => {
    const kb = detectedKeyboard([
      { version: 'v4', tokenId: 11n, tracked: false },
      { version: 'v4', tokenId: 12n, tracked: false },
      { version: 'v4', tokenId: 13n, tracked: true },
    ]);
    const data = kb.inline_keyboard
      .flat()
      .map((b) => (b as { callback_data?: string }).callback_data);

    expect(data).toContain('detect:track:v4:11');
    expect(data).toContain('detect:track:v4:12');
    // A tracked position gets no button, and the list can be re-read.
    expect(data).not.toContain('detect:track:v4:13');
    expect(data).toContain('detect:rescan');
    expect(data).toContain('menu:home');
  });
});

describe('the position store', () => {
  it('finds a position by manager and id', async () => {
    const created = await store.add(trackRecord('v4', '4242'));

    expect(store.findByToken('v4', '4242')?.id).toBe(created.id);
    // The v3 manager hands out its own ids: #4242 there is a different NFT.
    expect(store.findByToken('v3', '4242')).toBeUndefined();
  });
});

describe('the ttl cache', () => {
  it('serves a value until it expires', () => {
    const cache = new TtlCache<string>(1_000);
    cache.set('a', 'value', 0);

    expect(cache.get('a', 500)).toBe('value');
    expect(cache.get('a', 999)).toBe('value');
    expect(cache.get('a', 1_000)).toBeUndefined();
  });

  it('drops one entry or all of them', () => {
    const cache = new TtlCache<string>(1_000);
    cache.set('a', 'one');
    cache.set('b', 'two');

    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('two');

    cache.clear();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe('indexer pages', () => {
  it('reads the token ids out of an asset transfer page', () => {
    const ids = parseIndexerTransfers({
      transfers: [
        { tokenId: '0x0000000000000000000000000000000000000000000000000000000000000f2' },
        { tokenId: '261' },
        { tokenId: 'not-a-number' },
        {},
      ],
    });
    expect(ids).toEqual([242n, 261n]);
  });

  it('returns nothing for an empty page', () => {
    expect(parseIndexerTransfers({})).toEqual([]);
  });

  it('keeps only transfers of the v4 position manager', () => {
    const v4 = '0x58daec3116aae6D93017bAAea7749052E8a04fA7';
    expect(isV4Transfer({ rawContract: { address: v4 } })).toBe(true);
    expect(isV4Transfer({ rawContract: { address: v4.toLowerCase() } })).toBe(true);
    expect(isV4Transfer({ rawContract: { address: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3' } })).toBe(false);
    expect(isV4Transfer({})).toBe(false);
  });
});
