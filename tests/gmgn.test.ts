import { describe, expect, it } from 'vitest';
import { GMGN_INTERVALS, GmgnError, hasGmgnKey } from '../src/core/gmgn.js';

describe('the GMGN client', () => {
  it('offers the windows GMGN can rank by', () => {
    expect(GMGN_INTERVALS).toEqual(['1m', '5m', '1h', '6h', '24h']);
  });

  it('knows whether a key is configured', () => {
    expect(typeof hasGmgnKey()).toBe('boolean');
  });

  it('carries a machine-readable reason', () => {
    const error = new GmgnError('nope', 'rate_limited');
    expect(error.reason).toBe('rate_limited');
    expect(error.message).toBe('nope');
  });
});
