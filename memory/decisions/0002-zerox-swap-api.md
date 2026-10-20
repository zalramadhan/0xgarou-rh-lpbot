# Decision 0002 — 0x Swap API for the auto-swap

**Date:** 2026-10-20
**Status:** accepted
**Affects:** `src/core/zeroXSwap.ts` (new), `src/core/swap.ts`,
`src/monitor/exits.ts`, `src/config.ts`

## Context

The auto-swap of a closed position's token proceeds into USDG was hardcoded to
Uniswap v3: the deepest v3 pool against USDG, quoted with the v3 QuoterV2 and
executed with `SwapRouter02.exactInputSingle`. A token without a v3 USDG pool
could never be swapped back, and a v4-only pool was invisible to the router.

## Decision

1. **0x Swap API v2 is the primary route.** The `AllowanceHolder` endpoints are
   used (`/swap/allowance-holder/price` and `/quote`) with the
   `0x-api-key` and `0x-version: v2` headers and `chainId=4663`.
2. **The key lives in the environment** (`ZEROX_API_KEY`), never in the code, and
   is never logged. Without a key the bot keeps working and falls back.
3. **The allowance target is taken from the response, never hardcoded.** For the
   AllowanceHolder endpoint the target is the AllowanceHolder contract, which
   is both the spender and the entry point, so the spender must equal
   `transaction.to` and must not be the canonical Permit2 address. The 0x
   Settler is never approved.
4. **The v3 route stays as a fallback** for the case where the 0x quote fails
   *before* anything was submitted. It is never used after an uncertain
   submission — a pending or submitted swap is reconciled through its
   transaction hash first.
5. **A swap is stateful per closed position.** `pending → submitted →
   confirmed | failed` is tracked with the transaction hash, so a timeout or an
   RPC error can never cause a second swap.
6. **The threshold is checked twice**: once on the position's own value before
   any API call, and once on the *net* result (the quote minus the 0x fees and
   the estimated gas) before the transaction is signed.

## The 0x v2 schema this relies on

```
GET https://api.0x.org/swap/allowance-holder/quote
  ?chainId=4663&sellToken=..&buyToken=..&sellAmount=..&taker=..&slippageBps=..
headers: 0x-api-key, 0x-version: v2
```

The response carries `buyAmount`, `minBuyAmount`, `sellAmount`,
`allowanceTarget`, `issues.allowance.{spender,actual,error}`,
`issues.balance.{actual,expected,error}`, `liquidityAvailable`, `fees.*`,
`totalNetworkFee`, `route.fills[]`, and `transaction.{to,data,value,gas}`.

## What the live API showed

- Chain 4663 is listed as "Robinhood" in `/swap/chains`.
- The allowance target and the entry point are both the AllowanceHolder
  `0x0000000000001fF3684f28c67538d4D072C22734` — the "spender equals the
  entry point" check is what makes that safe to approve.
- `minBuyAmount` honours the requested `slippageBps`.
- `fees.zeroExFee` is in the **buy token**, but `totalNetworkFee` is in the
  **native token** (wei). Mixing them up would make every swap look worthless.
- A launchpad token routed through Uniswap_V4 + Uniswap_V2 — exactly the
  liquidity the old v3-only router could not see.

## Rejected alternatives

- **The 0x SDK (`@0x/swap-sdk`)** — it wraps the same HTTP endpoints and would
  add a dependency without removing any work.
- **Hardcoding the AllowanceHolder address for 4663** — 0x documents the
  address for other chains but not for Robinhood Chain, and the docs advise
  against hardcoding entry points. The response is the source of truth.
- **Dropping the v3 fallback** — it is the only route that works when 0x has
  no liquidity for a token, and it is already written and validated.
- **Selling the whole wallet balance of the token** — the bot never touches
  balances that do not come from the position it closed.

## Consequences

- A swap needs an API key; without one the bot says so and uses the v3 route.
- The 0x route can include v4 pools and RFQ liquidity, so more tokens can be
  swapped back into USDG.
- The gas is paid in ETH on top of the trade, which is why the net-value check
  exists.
