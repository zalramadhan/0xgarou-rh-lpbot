import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zeroAddress, type Address, type Hex } from 'viem';

const OWNER = '0x1111111111111111111111111111111111111111' as Address;
const SELL = '0x72be1277e198d0c476869253cb4e62807e14533c' as Address;
const BUY = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;
const ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734' as Address;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address;
const HASH = ('0x' + 'ab'.repeat(32)) as Hex;

process.env.ZEROX_API_KEY = 'test-key';

const chain = {
  balance: 1_000_000_000_000_000_000n,
  usdg: 0n,
  allowance: 0n,
  eth: 10n ** 18n,
  sent: [] as Hex[],
  approvals: [] as { spender: Address; amount: bigint }[],
  receiptStatus: 'success' as 'success' | 'reverted',
  receiptMissing: false,
  estimate: 300_000n,
};

vi.mock('../src/chain/client.js', () => ({
  publicClient: {
    call: vi.fn(async () => '0x'),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 1_000_000_000n })),
    getTransactionReceipt: vi.fn(async () => {
      if (chain.receiptMissing) throw new Error('receipt not found');
      return { status: chain.receiptStatus, gasUsed: 100_000n, effectiveGasPrice: 1_000_000_000n };
    }),
    waitForTransactionReceipt: vi.fn(async () => {
      if (chain.receiptMissing) throw new Error('receipt not found');
      return { status: chain.receiptStatus, gasUsed: 100_000n, effectiveGasPrice: 1_000_000_000n };
    }),
  },
  requireWallet: () => ({
    account: { address: OWNER },
    walletClient: {
      chain: {},
      sendTransaction: vi.fn(async (request: { to: Address; data: Hex }) => {
        chain.sent.push(request.data);
        // The swap delivers USDG to the wallet.
        chain.usdg += 2_000_000n;
        return HASH;
      }),
      writeContract: vi.fn(async (request: { args: [Address, bigint] }) => {
        chain.approvals.push({ spender: request.args[0]!, amount: request.args[1]! });
        return HASH;
      }),
    },
  }),
  botAddress: OWNER,
}));

vi.mock('../src/core/prices.js', () => ({
  usdPrice: vi.fn(async () => 3000),
  clearPriceCache: vi.fn(),
  tokenUsdValue: vi.fn(async () => 0),
}));

vi.mock('../src/core/wallet.js', () => ({
  ethBalance: vi.fn(async () => chain.eth),
  erc20BalanceOf: vi.fn(async (token: Address) => (token.toLowerCase() === BUY.toLowerCase() ? chain.usdg : chain.balance)),
  erc20Allowance: vi.fn(async () => chain.allowance),
  ensureErc20Allowance: vi.fn(async (_token: Address, spender: Address, amount: bigint) => {
    chain.approvals.push({ spender, amount });
    return undefined;
  }),
  ensurePermit2Allowance: vi.fn(async () => []),
}));

const { quoteZeroXSwap, validateQuote, ZeroXError, executeZeroXSwap } = await import(
  '../src/core/zeroXSwap.js'
);
const { swapProceedsToUsdg } = await import('../src/core/swap.js');
const { shouldAutoSwap } = await import('../src/monitor/exits.js');

/** A valid 0x v2 quote response. */
function quoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    zid: '0x1',
    liquidityAvailable: true,
    sellToken: SELL,
    buyToken: BUY,
    sellAmount: '1000000000000000000',
    buyAmount: '2000000',
    minBuyAmount: '1980000',
    allowanceTarget: ALLOWANCE_HOLDER,
    issues: {
      allowance: { actual: '0', spender: ALLOWANCE_HOLDER },
      balance: { token: SELL, actual: '1000000000000000000', expected: '1000000000000000000' },
      simulationIncomplete: false,
    },
    fees: { zeroExFee: '0', integratorFee: null, gasFee: null },
    totalNetworkFee: '0',
    route: {
      fills: [{ from: SELL, to: BUY, source: 'Uniswap_V3', proportionBps: 10000 }],
      tokens: [{ address: SELL, symbol: 'RAETO' }, { address: BUY, symbol: 'USDG' }],
    },
    transaction: {
      to: ALLOWANCE_HOLDER,
      data: '0xdeadbeef',
      value: '0',
      gas: '300000',
    },
    ...overrides,
  };
}

function mockFetch(handler: (url: URL) => { status?: number; body?: unknown; text?: string }) {
  const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    const { status = 200, body = quoteResponse(), text } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => text ?? JSON.stringify(body),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  chain.balance = 1_000_000_000_000_000_000n;
  chain.usdg = 0n;
  chain.allowance = 0n;
  chain.eth = 10n ** 18n;
  chain.sent = [];
  chain.approvals = [];
  chain.receiptStatus = 'success';
  chain.receiptMissing = false;
  chain.estimate = 300_000n;
  vi.unstubAllGlobals();
});

describe('the 0x quote', () => {
  it('keeps the 0x fee in the buy token and the network fee in the native token', async () => {
    mockFetch(() => ({
      body: quoteResponse({
        fees: { zeroExFee: '3000', gasFee: '7272855378000000' },
        totalNetworkFee: '7272855378000000',
      }),
    }));
    const quote = await quoteZeroXSwap({
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: 1_000_000_000_000_000_000n,
      taker: OWNER,
      slippageBps: 100,
    });
    expect(quote.zeroExFee).toBe(3_000n);
    expect(quote.totalNetworkFee).toBe(7_272_855_378_000_000n);
  });

  it('reads a valid quote and checks every field', async () => {
    mockFetch(() => ({ body: quoteResponse() }));
    const quote = await quoteZeroXSwap({
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: 1_000_000_000_000_000_000n,
      taker: OWNER,
      slippageBps: 100,
    });

    expect(quote.buyAmount).toBe(2_000_000n);
    expect(quote.minBuyAmount).toBe(1_980_000n);
    expect(quote.allowanceTarget).toBe(ALLOWANCE_HOLDER);
    expect(quote.entryPoint).toBe(ALLOWANCE_HOLDER);
    expect(quote.sources).toEqual(['Uniswap_V3']);
  });

  it('sends the chain, the tokens, the amount and the slippage', async () => {
    const fetchMock = mockFetch(() => ({ body: quoteResponse() }));
    await quoteZeroXSwap({
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: 1_000_000_000_000_000_000n,
      taker: OWNER,
      slippageBps: 100,
    });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/swap/allowance-holder/quote');
    expect(url.searchParams.get('chainId')).toBe('4663');
    expect(url.searchParams.get('sellToken')).toBe(SELL);
    expect(url.searchParams.get('buyToken')).toBe(BUY);
    expect(url.searchParams.get('sellAmount')).toBe('1000000000000000000');
    expect(url.searchParams.get('taker')).toBe(OWNER);
    expect(url.searchParams.get('slippageBps')).toBe('100');
  });

  it('sends the api key without logging it', async () => {
    const fetchMock = mockFetch(() => ({ body: quoteResponse() }));
    await quoteZeroXSwap({
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: 1_000_000_000_000_000_000n,
      taker: OWNER,
      slippageBps: 100,
    });
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    const headers = init.headers;
    expect(headers['0x-api-key']).toBe('test-key');
    expect(headers['0x-version']).toBe('v2');
  });

  it('refuses a quote for a different token or amount', () => {
    expect(() =>
      validateQuote(quoteResponse({ sellToken: BUY }) as never, {
        sellToken: SELL,
        buyToken: BUY,
        sellAmount: 1_000_000_000_000_000_000n,
        slippageBps: 100,
      }),
    ).toThrow(/different sell token/);
    expect(() =>
      validateQuote(quoteResponse({ sellAmount: '5' }) as never, {
        sellToken: SELL,
        buyToken: BUY,
        sellAmount: 1_000_000_000_000_000_000n,
        slippageBps: 100,
      }),
    ).toThrow(/different amount/);
  });

  it('never approves the Permit2 address', () => {
    expect(() =>
      validateQuote(quoteResponse({ issues: { allowance: { spender: PERMIT2 } } }) as never, {
        sellToken: SELL,
        buyToken: BUY,
        sellAmount: 1_000_000_000_000_000_000n,
        slippageBps: 100,
      }),
    ).toThrow(/Permit2/);
  });

  it('refuses an allowance target that is not the entry point', () => {
    expect(() =>
      validateQuote(quoteResponse({ issues: { allowance: { spender: zeroAddress } } }) as never, {
        sellToken: SELL,
        buyToken: BUY,
        sellAmount: 1_000_000_000_000_000_000n,
        slippageBps: 100,
      }),
    ).toThrow(/not the entry point/);
  });

  it('refuses a quote without a transaction', () => {
    expect(() =>
      validateQuote(quoteResponse({ transaction: { to: ALLOWANCE_HOLDER, data: '0x' } }) as never, {
        sellToken: SELL,
        buyToken: BUY,
        sellAmount: 1_000_000_000_000_000_000n,
        slippageBps: 100,
      }),
    ).toThrow(/no transaction data/);
  });

  it('reports a balance problem', () => {
    expect(() =>
      validateQuote(
        quoteResponse({
          issues: { balance: { error: 'INSUFFICIENT_BALANCE' } },
        }) as never,
        { sellToken: SELL, buyToken: BUY, sellAmount: 1_000_000_000_000_000_000n, slippageBps: 100 },
      ),
    ).toThrow(/balance problem/);
  });

  it('reports a missing liquidity', () => {
    expect(() =>
      validateQuote(quoteResponse({ liquidityAvailable: false }) as never, {
        sellToken: SELL,
        buyToken: BUY,
        sellAmount: 1_000_000_000_000_000_000n,
        slippageBps: 100,
      }),
    ).toThrow(/no liquidity/);
  });
});

describe('the 0x api failures', () => {
  it('reports a rate limit', async () => {
    mockFetch(() => ({ status: 429, body: { message: 'rate limited' } }));
    await expect(
      quoteZeroXSwap({ sellToken: SELL, buyToken: BUY, sellAmount: 1n, taker: OWNER, slippageBps: 100 }),
    ).rejects.toThrow(/rate limited/);
  });

  it('reports a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('The operation was aborted due to timeout');
      }),
    );
    await expect(
      quoteZeroXSwap({ sellToken: SELL, buyToken: BUY, sellAmount: 1n, taker: OWNER, slippageBps: 100 }),
    ).rejects.toThrow(/did not answer in time/);
  });

  it('reports a malformed answer', async () => {
    mockFetch(() => ({ body: { nonsense: true } }));
    await expect(
      quoteZeroXSwap({ sellToken: SELL, buyToken: BUY, sellAmount: 1n, taker: OWNER, slippageBps: 100 }),
    ).rejects.toThrow(/no output amount/);
  });

  it('reports a server error', async () => {
    mockFetch(() => ({ status: 500, body: { message: 'boom' } }));
    await expect(
      quoteZeroXSwap({ sellToken: SELL, buyToken: BUY, sellAmount: 1n, taker: OWNER, slippageBps: 100 }),
    ).rejects.toThrow(/500/);
  });
});

describe('the 0x swap execution', () => {
  it('approves the allowance target and sends the transaction', async () => {
    mockFetch(() => ({ body: quoteResponse() }));
    const quote = await quoteZeroXSwap({
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: 1_000_000_000_000_000_000n,
      taker: OWNER,
      slippageBps: 100,
    });
    const result = await executeZeroXSwap(quote, { owner: OWNER, dryRun: false, key: 'p1' });

    expect(chain.approvals[0]?.spender).toBe(ALLOWANCE_HOLDER);
    expect(chain.sent).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it('reuses an existing allowance instead of approving again', async () => {
    chain.allowance = 10n ** 30n;
    mockFetch(() => ({ body: quoteResponse() }));
    const quote = await quoteZeroXSwap({
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: 1_000_000_000_000_000_000n,
      taker: OWNER,
      slippageBps: 100,
    });
    await executeZeroXSwap(quote, { owner: OWNER, dryRun: false, key: 'p-allowance' });
    expect(chain.approvals).toHaveLength(0);
  });

  it('never sends a transaction in a dry run', async () => {
    mockFetch(() => ({ body: quoteResponse() }));
    const quote = await quoteZeroXSwap({
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: 1_000_000_000_000_000_000n,
      taker: OWNER,
      slippageBps: 100,
    });
    const result = await executeZeroXSwap(quote, { owner: OWNER, dryRun: true, key: 'p-dry' });
    expect(chain.sent).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('refuses to swap without the gas', async () => {
    chain.eth = 0n;
    mockFetch(() => ({ body: quoteResponse() }));
    const quote = await quoteZeroXSwap({
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: 1_000_000_000_000_000_000n,
      taker: OWNER,
      slippageBps: 100,
    });
    const result = await executeZeroXSwap(quote, { owner: OWNER, dryRun: false, key: 'p-gas' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not enough ETH/);
    expect(chain.sent).toHaveLength(0);
  });

  it('does not send a second swap for the same close', async () => {
    mockFetch(() => ({ body: quoteResponse() }));
    const quote = await quoteZeroXSwap({
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: 1_000_000_000_000_000_000n,
      taker: OWNER,
      slippageBps: 100,
    });
    await executeZeroXSwap(quote, { owner: OWNER, dryRun: false, key: 'p-once' });
    expect(chain.sent).toHaveLength(1);
    const again = await executeZeroXSwap(quote, { owner: OWNER, dryRun: false, key: 'p-once' });
    expect(chain.sent).toHaveLength(1);
    expect(again.ok).toBe(true);
  });

  it('reports a reverted swap', async () => {
    chain.receiptStatus = 'reverted';
    mockFetch(() => ({ body: quoteResponse() }));
    const quote = await quoteZeroXSwap({
      sellToken: SELL,
      buyToken: BUY,
      sellAmount: 1_000_000_000_000_000_000n,
      taker: OWNER,
      slippageBps: 100,
    });
    const result = await executeZeroXSwap(quote, { owner: OWNER, dryRun: false, key: 'p-revert' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reverted/);
  });
});

describe('the auto-swap rules', () => {
  it('skips a swap below the threshold', async () => {
    mockFetch(() => ({ body: quoteResponse() }));
    const outcome = await swapProceedsToUsdg({
      token: { address: SELL, symbol: 'RAETO', name: 'RAETO', decimals: 18 },
      amount: 1_000_000_000_000_000_000n,
      owner: OWNER,
      slippagePct: 1,
      dryRun: false,
      key: 'p-small',
      valueUsd: 0.2,
      minUsd: 0.3,
      buyTokenUsd: 1,
    });
    expect(outcome.skipped).toBe(true);
    expect(chain.sent).toHaveLength(0);
    expect(outcome.note).toMatch(/below \$0.30/);
  });

  it('swaps above the threshold', async () => {
    mockFetch(() => ({ body: quoteResponse() }));
    const outcome = await swapProceedsToUsdg({
      token: { address: SELL, symbol: 'RAETO', name: 'RAETO', decimals: 18 },
      amount: 1_000_000_000_000_000_000n,
      owner: OWNER,
      slippagePct: 1,
      dryRun: false,
      key: 'p-big',
      valueUsd: 50,
      minUsd: 0.3,
      buyTokenUsd: 1,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.route).toBe('0x');
    expect(chain.sent).toHaveLength(1);
  });

  it('never swaps for a position that is about to re-enter', () => {
    expect(shouldAutoSwap({ enabled: true, dryRun: false, canReenter: false })).toBe(true);
    expect(shouldAutoSwap({ enabled: true, dryRun: false, canReenter: true })).toBe(false);
    expect(shouldAutoSwap({ enabled: true, dryRun: true, canReenter: false })).toBe(false);
    expect(shouldAutoSwap({ enabled: false, dryRun: false, canReenter: false })).toBe(false);
  });
});

describe('the 0x error type', () => {
  it('carries a machine-readable reason', () => {
    const error = new ZeroXError('nope', 'no_route');
    expect(error.reason).toBe('no_route');
    expect(error.message).toBe('nope');
  });
});
