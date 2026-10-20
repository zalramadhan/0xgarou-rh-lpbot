# Decision 0001 — The Bid Ask ladder

**Date:** 2026-10-20
**Status:** accepted
**Affects:** `src/core/bidAsk.ts`, `src/bot/newFlow.ts`, `src/bot/ui.ts`,
`src/store/store.ts`

## Context

The bot could only open one LP position per deposit. The request was a
**Bid Ask** entry strategy: split the investment over 4–10 progressively
weighted entries, with prices/bin distribution independent of the capital
allocation, a full preview, and a configurable entry count that survives
restarts and can be changed from Telegram.

## Decision

1. **Opt-in step, not a mode switch.** After the user picks `USDG only` or
   `token only`, the bot asks **Spot** (the original single position) or
   **Bid Ask**. The two-sided flow is untouched.
2. **N entries = N transactions.** Each entry is its own v3/v4 NFT. There is
   no batching: the position manager mints one NFT per call. The cost is N
   gas-heavy mints; the benefit is that each entry is independently
   trackable, closable and re-balanceable.
3. **Capital and price are independent.** Capital follows
   `allocation[i] = total × (i+1) / (N(N+1)/2)`; price placement follows the
   range, the tick spacing and the live market. Neither one is derived from
   the other.
4. **Direction comes from the funded token, not from the range.** A position
   holds `token0` when the price is at or below its lower bound and `token1`
   when the price is at or above its upper bound. So funding `token0` puts
   the ladder **above** the market and funding `token1` puts it **below**.
   In the pasted token's displayed price that is: quote-only = bids below the
   market, token-only = asks above the market — for both token orderings.
5. **The near edge follows the live price.** The ladder always starts at the
   live tick (aligned away from it), while the far edge stays where the user
   put it. Without this, a price that moved into the selected range between
   picking it and confirming would turn a one-sided mint into a two-sided one
   (or fail with a confusing sizing error). Re-anchoring keeps every mint
   one-sided and keeps "entry 1 is the closest to the market" true.
6. **Contiguous, spacing-aligned bins.** The range is divided into N
   contiguous bins; leftover tick-spacings are given to the **farthest** bins.
   A range that cannot fit N bins at the pool's tick spacing is refused with
   a message that says how to fix it (wider range or fewer entries).
7. **Allocation arithmetic is exact.** Allocations are computed in integer
   micro-USD and the remainder is distributed by largest fractional part, so
   the entries sum to the requested total instead of drifting by a cent each.
8. **The setting needs an explicit Apply.** Settings are per chat and stored
   in `data/store.json`; the Bid Ask count is one of them. Picking a number
   shows what changes (current → new, weights, split) and writes nothing
   until **Apply** is pressed. Existing settings apply immediately, but a
   count that shapes the whole ladder deserves the explicit step.
9. **A stale preview is invalidated, not re-planned.** If the entry count
   changes while a preview is open, the confirm step refuses and asks for a
   fresh `/new`. Silently re-planning would change the allocation the user
   had just reviewed.
10. **Wrong-side ranges are refused.** A one-sided deposit needs a range on
    the funded side; a custom range on the other side is rejected with a
    message that says which side is needed. Full range is two-sided and is
    refused for one-sided deposits.

## Rejected alternatives

- **Re-plan on confirm instead of invalidating** — the user would approve a
  layout they never saw.
- **Batch the mints** — the position manager mints one NFT per call; there
  is no multi-mint.
- **Derive the direction from the range's position relative to the market** —
  breaks as soon as the price crosses a bound, and it is wrong for the
  `token0`/`token1` ordering the range was picked in.
- **Anchor the whole range on the user's absolute prices** — the near edge
  then drifts away from the market, so "entry 1 is the closest to the
  market" stops being true and the ladder can end up on the wrong side.
- **Make the entry count an env var** — not changeable at runtime, not
  per chat, and it would need a restart.

## Consequences

- A 5-entry ladder is 5 mints and 5 tracked positions; the UI always says so
  before the user confirms.
- A ladder whose range is narrower than the market's drift by the time the
  user confirms can be rejected ("the price moved into this entry"). The
  near edge is at most one tick-spacing from the live price, so this needs a
  ~1% move in the wrong direction for a 1%-spacing pool.
- The allocation is a plan, not a guarantee: integer liquidity floors leave a
  few cents of dust, which the preview shows.
