import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The failover is exercised through the fetch the transport uses, with a
 * stubbed `globalThis.fetch` — the real network is never touched.
 */
// The endpoint list is read when the config module is loaded, so it has to
// be set before anything imports it.
process.env.RPC_URLS = 'https://rpc.one/key1,https://rpc.two/key2,https://rpc.three/key3';
process.env.RPC_URL = 'https://rpc.one/key1';

const CONFIG = await import('../src/config.js');

const { rpcFetch, rpcStatus, resetRpcRotation, RpcUnavailableError } = await import(
  '../src/chain/client.js'
);

const realFetch = globalThis.fetch;

/** A response the stub returns. */
function answer(status: number, body = '{}'): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

let called: string[] = [];

beforeEach(() => {
  resetRpcRotation();
  called = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('the RPC failover', () => {
  it('uses the active endpoint and stops there when it answers', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      called.push(String(input));
      return answer(200, '{"jsonrpc":"2.0","id":1,"result":"0x1"}');
    }) as typeof fetch;

    const response = await rpcFetch('https://rpc.one/key1', { method: 'POST', body: '{"method":"eth_blockNumber"}' });

    expect(await response.json()).toMatchObject({ result: '0x1' });
    // One request, one endpoint: nothing else is probed.
    expect(called).toEqual(['https://rpc.one/key1']);
  });

  it('fails over to the next endpoint and stops at the first success', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      called.push(url);
      if (url.startsWith('https://rpc.one')) return answer(429);
      if (url.startsWith('https://rpc.two')) return answer(200, '{"jsonrpc":"2.0","id":1,"result":"0x2"}');
      return answer(200, '{"jsonrpc":"2.0","id":1,"result":"0x3"}');
    }) as typeof fetch;

    const response = await rpcFetch('https://rpc.one/key1', { method: 'POST', body: '{"method":"eth_blockNumber"}' });

    expect(await response.json()).toMatchObject({ result: '0x2' });
    // The third endpoint is never touched: the failover stops at the first
    // endpoint that answers.
    expect(called).toEqual(['https://rpc.one/key1', 'https://rpc.two/key2']);
  });

  it('keeps the full URL of the endpoint it fails over to', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      called.push(url);
      if (url.startsWith('https://rpc.one')) return answer(429);
      return answer(200, '{"jsonrpc":"2.0","id":1,"result":"0x2"}');
    }) as typeof fetch;

    await rpcFetch('https://rpc.one/key1', { method: 'POST', body: '{"method":"eth_blockNumber"}' });

    // The API key and the path of the second endpoint are kept.
    expect(called[1]).toBe('https://rpc.two/key2');
  });

  it('makes the endpoint that answered the active one', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      called.push(url);
      if (url.startsWith('https://rpc.one')) return answer(429);
      return answer(200, '{"jsonrpc":"2.0","id":1,"result":"0x2"}');
    }) as typeof fetch;

    await rpcFetch('https://rpc.one/key1', { method: 'POST', body: '{"method":"eth_blockNumber"}' });
    expect(rpcStatus().active).toBe('https://rpc.two/key2');

    // The next request goes straight to the endpoint that worked.
    await rpcFetch('https://rpc.one/key1', { method: 'POST', body: '{"method":"eth_blockNumber"}' });
    expect(called[2]).toBe('https://rpc.two/key2');
    expect(called).toHaveLength(3);
  });

  it('puts a failing endpoint aside for a minute', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      called.push(url);
      if (url.startsWith('https://rpc.one')) return answer(429);
      return answer(200, '{"jsonrpc":"2.0","id":1,"result":"0x2"}');
    }) as typeof fetch;

    await rpcFetch('https://rpc.one/key1', { method: 'POST', body: '{"method":"eth_blockNumber"}' });
    expect(rpcStatus().cooling).toBe(1);

    // While it is cooling down, the failing endpoint is skipped.
    await rpcFetch('https://rpc.one/key1', { method: 'POST', body: '{"method":"eth_blockNumber"}' });
    expect(called.filter((url) => url.startsWith('https://rpc.one'))).toHaveLength(1);
  });

  it('lets an endpoint back into the rotation when its cooldown expires', async () => {
    vi.useFakeTimers();
    try {
      let recovered = false;
      globalThis.fetch = vi.fn(async (input) => {
        const url = String(input);
        called.push(url);
        if (url.startsWith('https://rpc.one')) {
          return recovered ? answer(200, '{"jsonrpc":"2.0","id":1,"result":"0x1"}') : answer(429);
        }
        if (url.startsWith('https://rpc.two')) return answer(500);
        return recovered ? answer(503) : answer(200, '{"jsonrpc":"2.0","id":1,"result":"0x3"}');
      }) as typeof fetch;

      // The first endpoint fails, the second one takes over — and fails too.
      await rpcFetch('https://rpc.one/key1', { method: 'POST', body: '{"method":"eth_blockNumber"}' });
      expect(rpcStatus().cooling).toBe(2);

      // A minute later both are eligible again.
      vi.advanceTimersByTime(61_000);
      expect(rpcStatus().cooling).toBe(0);

      // The endpoint that answered last is still tried first, but when it
      // fails the recovered one takes over again.
      recovered = true;
      await rpcFetch('https://rpc.one/key1', { method: 'POST', body: '{"method":"eth_blockNumber"}' });
      expect(called.filter((url) => url.startsWith('https://rpc.one')).length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a clear error when every endpoint fails', async () => {
    globalThis.fetch = vi.fn(async () => answer(503)) as typeof fetch;

    await expect(
      rpcFetch('https://rpc.one/key1', { method: 'POST', body: '{"method":"eth_blockNumber"}' }),
    ).rejects.toThrow(/Every RPC endpoint failed/);
  });

  it('fails over on a connection error', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      called.push(url);
      if (url.startsWith('https://rpc.one')) throw new Error('ECONNREFUSED');
      return answer(200, '{"jsonrpc":"2.0","id":1,"result":"0x2"}');
    }) as typeof fetch;

    const response = await rpcFetch('https://rpc.one/key1', { method: 'POST', body: '{"method":"eth_blockNumber"}' });
    expect(await response.json()).toMatchObject({ result: '0x2' });
    expect(called).toHaveLength(2);
  });

  it('never sends a transaction twice when the endpoint is uncertain', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      called.push(url);
      // A timeout after the transaction was broadcast.
      throw new Error('Request timed out');
    }) as typeof fetch;

    const error = await rpcFetch('https://rpc.one/key1', {
      method: 'POST',
      body: '{"method":"eth_sendRawTransaction","params":["0xdead"]}',
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RpcUnavailableError);
    expect((error as InstanceType<typeof RpcUnavailableError>).ambiguous).toBe(true);
    // One endpoint, one attempt: the transaction is not sent again.
    expect(called).toEqual(['https://rpc.one/key1']);
  });

  it('may hand a rejected transaction to the next endpoint', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      called.push(url);
      // 429 means the transaction was never accepted.
      if (url.startsWith('https://rpc.one')) return answer(429);
      return answer(200, '{"jsonrpc":"2.0","id":1,"result":"0xhash"}');
    }) as typeof fetch;

    const response = await rpcFetch('https://rpc.one/key1', {
      method: 'POST',
      body: '{"method":"eth_sendRawTransaction","params":["0xdead"]}',
    });

    expect(await response.json()).toMatchObject({ result: '0xhash' });
    expect(called).toEqual(['https://rpc.one/key1', 'https://rpc.two/key2']);
  });

  it('shares the state between the bot and the monitor', () => {
    // One module, one state: the client the monitor uses is the same one.
    expect(CONFIG.config.rpcUrls).toHaveLength(3);
    expect(rpcStatus().total).toBe(3);
  });
});
