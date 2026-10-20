import { describe, expect, it } from 'vitest';
import { swapAccounting, withSwap } from '../src/core/history.js';
import { costLines } from '../src/monitor/notifyText.js';
import { cardDataFromRecord } from '../src/card/data.js';
import type { ClosedRecord } from '../src/store/store.js';
import type { SwapOutcome } from '../src/core/swap.js';

const NOW = Date.UTC(2026, 9, 20, 12, 0);

function record(overrides: Partial<ClosedRecord> = {}): ClosedRecord {
  return {
    id: 'h1',
    chatId: 1,
    version: 'v4',
    tokenId: '42',
    pair: 'RAETO/USDG',
    fee: 3000,
    reason: 'manual',
    entryPrice: 0.0015,
    exitPrice: 0.0016,
    entryValueUsd: 100,
    exitValueUsd: 100.4,
    pnlUsd: 0.4,
    pnlPct: 0.4,
    feesUsd: 1.25,
    idrRate: 16_000,
    openedAt: NOW - 60_000,
    closedAt: NOW,
    dryRun: false,
    basisUsd: 100,
    feesAndGasUsd: 0.4,
    openGasUsd: 0.2,
    closeGasUsd: 0.2,
    ...overrides,
  };
}

/** A swap that delivered 40 USDG and cost 0.05 of gas. */
function swapOutcome(overrides: Partial<SwapOutcome> = {}): SwapOutcome {
  return {
    ok: true,
    route: '0x',
    hash: '0xswap',
    receivedUsdg: 40_000_000n,
    gasNative: 10n ** 15n,
    feeUsd: 0.03,
    soldAmount: 25n * 10n ** 18n,
    note: '💱 Swapped RAETO → USDG via 0x.',
    ...overrides,
  };
}

describe('the gas of a round trip', () => {
  it('adds the open and the close', () => {
    const closed = record({ openGasUsd: 0.031, closeGasUsd: 0.028, feesAndGasUsd: 0.059 });
    expect(closed.feesAndGasUsd).toBeCloseTo(0.059, 6);
  });

  it('adds the swap when there was one', () => {
    const accounting = swapAccounting(swapOutcome(), {
      withdrawnAmount: 25n * 10n ** 18n,
      decimals: 18,
      ethPriceUsd: 3000,
    });
    // 0.001 ETH at $3000 is $3 of gas.
    expect(accounting.gasUsd).toBeCloseTo(3, 6);

    const updated = withSwap(record({ openGasUsd: 0.031, closeGasUsd: 0.028 }), accounting);
    expect(updated.feesAndGasUsd).toBeCloseTo(3.059, 6);
  });

  it('keeps an unknown cost unknown instead of counting it as zero', () => {
    // An imported position has no entry transaction, so its open gas is
    // unknown. The total is unknown too.
    const updated = withSwap(record({ openGasUsd: undefined, closeGasUsd: 0.028 }), {
      route: '0x',
      receivedUsd: 40,
      gasUsd: 0.05,
      leftoverUsd: 0,
    });
    expect(updated.feesAndGasUsd).toBeUndefined();
    expect(updated.pnlNetUsd).toBeUndefined();
  });

  it('says that a dry run spent nothing', () => {
    const lines = costLines(record({ dryRun: true, openGasUsd: 0, closeGasUsd: 0, feesAndGasUsd: 0 }));
    expect(lines.join('\n')).toContain('not incurred');
  });

  it('says that the gas is incomplete when a part is unknown', () => {
    const lines = costLines(record({ openGasUsd: undefined, closeGasUsd: 0.028, feesAndGasUsd: undefined }));
    expect(lines.join('\n')).toContain('incomplete');
    expect(lines.join('\n')).toContain('open unknown');
  });
});

describe('the PnL after a swap', () => {
  it('is the value that is left after every cost', () => {
    const accounting = swapAccounting(swapOutcome(), {
      withdrawnAmount: 25n * 10n ** 18n,
      decimals: 18,
      ethPriceUsd: 3000,
    });
    // 25 tokens sold for 40 USDG, so the leftover is worth the same rate.
    expect(accounting.receivedUsd).toBeCloseTo(40, 6);
    expect(accounting.leftoverUsd).toBeCloseTo(0, 6);

    const updated = withSwap(
      record({ openGasUsd: 0.2, closeGasUsd: 0.2, basisUsd: 40, pnlUsd: 0.4 }),
      accounting,
    );
    // 40 received, minus 0.2 open, 0.2 close and 3.0 swap gas, minus the
    // 40 basis.
    expect(updated.pnlNetUsd).toBeCloseTo(-3.4, 6);
    expect(updated.pnlNetPct).toBeCloseTo(-8.5, 6);
  });

  it('does not subtract the provider fee twice', () => {
    const accounting = swapAccounting(swapOutcome(), {
      withdrawnAmount: 25n * 10n ** 18n,
      decimals: 18,
      ethPriceUsd: 3000,
    });
    // The fee is kept as information; the received amount is already net.
    expect(accounting.feeUsd).toBeCloseTo(0.03, 6);
    const updated = withSwap(record({ openGasUsd: 0, closeGasUsd: 0, basisUsd: 40 }), accounting);
    // 40 received − 3 of gas − 40 basis. The 0.03 fee is not taken again.
    expect(updated.pnlNetUsd).toBeCloseTo(-3, 6);
  });

  it('counts the gas of a swap that failed', () => {
    // A reverted swap still cost its gas, and the withdrawal stayed in the
    // wallet — so it is worth the price it had at the close.
    const failed = swapOutcome({ ok: false, receivedUsdg: undefined, gasNative: 5n * 10n ** 15n });
    const accounting = swapAccounting(failed, {
      withdrawnAmount: 25n * 10n ** 18n,
      decimals: 18,
      ethPriceUsd: 3000,
      exitPrice: 0.0016,
    });
    expect(accounting.gasUsd).toBeCloseTo(15, 6);
    // The whole withdrawal is still in the wallet.
    expect(accounting.leftoverUsd).toBeCloseTo(25 * 0.0016, 8);
    // The received amount was nothing, so the rate is unknown and the exit
    // price is the fallback.
  });

  it('keeps the PnL before the swap as the gross number', () => {
    const accounting = swapAccounting(swapOutcome(), {
      withdrawnAmount: 25n * 10n ** 18n,
      decimals: 18,
      ethPriceUsd: 3000,
    });
    const closed = record({ openGasUsd: 0, closeGasUsd: 0, basisUsd: 40, pnlUsd: 0.4 });
    const updated = withSwap(closed, accounting);
    expect(updated.pnlUsd).toBeUndefined();
    expect(closed.pnlUsd).toBe(0.4);
  });
});

describe('the receipt lines', () => {
  it('shows the gas of the round trip and the PnL after it', () => {
    const accounting = swapAccounting(swapOutcome(), {
      withdrawnAmount: 25n * 10n ** 18n,
      decimals: 18,
      ethPriceUsd: 3000,
    });
    const closed = withSwap(record({ openGasUsd: 0.2, closeGasUsd: 0.2 }), accounting);
    const lines = costLines({ ...record(), ...closed }).join('\n');
    expect(lines).toContain('⛽ Gas:');
    expect(lines).toContain('open $0.2000');
    expect(lines).toContain('close $0.2000');
    expect(lines).toContain('swap $3.00');
    expect(lines).toContain('⛽ Gas: $3.40');
    expect(lines).toContain('📊 PnL after the costs');
  });

  it('shows only the open and the close when nothing was swapped', () => {
    const lines = costLines(record({ openGasUsd: 0.031, closeGasUsd: 0.028, feesAndGasUsd: 0.059 })).join('\n');
    expect(lines).toContain('open $0.0310');
    expect(lines).toContain('close $0.0280');
    expect(lines).not.toContain('swap $');
  });
});

describe('the card', () => {
  it('shows the gas and the fees it earned as separate rows', () => {
    const data = cardDataFromRecord(
      record({ openGasUsd: 0.031, closeGasUsd: 0.028, feesAndGasUsd: 0.059, feesUsd: 1.25 }),
    );
    expect(data.feesEarnedUsd).toBe(1.25);
    expect(data.gasUsd).toBeCloseTo(0.059, 6);
    expect(data.gasOpenUsd).toBeCloseTo(0.031, 6);
    expect(data.gasCloseUsd).toBeCloseTo(0.028, 6);
  });

  it('marks an unknown gas as missing instead of zero', () => {
    // An imported position has no entry transaction: its open gas is unknown,
    // so the total is unknown too.
    const data = cardDataFromRecord(record({ openGasUsd: undefined, closeGasUsd: 0.028 }));
    expect(data.gasUsd).toBe(Number.NaN);
  });

  it('adds up the gas of a round trip without a swap', () => {
    const data = cardDataFromRecord(record({ openGasUsd: 0.031, closeGasUsd: 0.028 }));
    expect(data.gasUsd).toBeCloseTo(0.059, 6);
  });

  it('knows that a dry run spent nothing', () => {
    const data = cardDataFromRecord(record({ dryRun: true }));
    expect(data.dryRun).toBe(true);
  });
});
