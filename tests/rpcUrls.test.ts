import { describe, expect, it } from 'vitest';
import { parseRpcUrls } from '../src/config.js';

describe('the RPC list', () => {
  it('keeps the single RPC_URL working', () => {
    expect(parseRpcUrls(undefined, 'https://rpc.one')).toEqual(['https://rpc.one']);
  });

  it('falls back to the public endpoint when nothing is configured', () => {
    expect(parseRpcUrls(undefined, undefined)).toEqual(['https://robinhood.drpc.org']);
  });

  it('reads a comma separated list', () => {
    expect(parseRpcUrls('https://a.one,https://b.one,https://c.one', undefined)).toEqual([
      'https://a.one',
      'https://b.one',
      'https://c.one',
    ]);
  });

  it('reads a newline separated list', () => {
    expect(parseRpcUrls('https://a.one\nhttps://b.one', undefined)).toEqual([
      'https://a.one',
      'https://b.one',
    ]);
  });

  it('puts RPC_URL after the list and never repeats one', () => {
    const urls = parseRpcUrls('https://a.one, https://b.one', 'https://b.one');
    expect(urls).toEqual(['https://a.one', 'https://b.one']);
  });

  it('reads a list in RPC_URL as well', () => {
    // An .env that already holds several endpoints in RPC_URL has to work:
    // the first one is the transport, the rest are the backups.
    const urls = parseRpcUrls(undefined, 'https://a.one, https://b.one');
    expect(urls).toEqual(['https://a.one', 'https://b.one']);
  });

  it('keeps the list of RPC_URLS and RPC_URL in one pool', () => {
    const urls = parseRpcUrls('https://a.one', 'https://b.one,https://a.one');
    expect(urls).toEqual(['https://a.one', 'https://b.one']);
  });

  it('drops the trailing slash so the paths can be replaced', () => {
    expect(parseRpcUrls('https://a.one/', undefined)).toEqual(['https://a.one']);
  });

  it('rejects an endpoint that is not a URL', () => {
    expect(() => parseRpcUrls('rpc.one', undefined)).toThrow(/http/);
  });
});
