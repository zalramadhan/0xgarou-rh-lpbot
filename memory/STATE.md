# Current state

> Snapshot of the project as it stands. Updated whenever the architecture, an
> invariant, a user-facing flow or a setting changes. See `CHANGELOG.md` for
> the history and `decisions/` for the reasoning behind the bigger choices.

## What this is

A Telegram bot that opens, monitors and closes Uniswap **v3 and v4** LP
positions on **Robinhood Chain (4663)**. It discovers pools for a pasted token
contract, sizes a deposit, mints the NFT, then watches it for TP/SL, fees,
rebalances and auto-compounding.

- Stack: Node ≥ 20, TypeScript (`strict` + `noUncheckedIndexedAccess`),
  [grammy](https://grammy.dev) for Telegram, [viem](https://viem.sh) for the
  chain, [vitest](https://vitest.dev) for tests.
- **This directory is a git repository**: the code lives at
  `github.com/zalramadhan/0xgarou-rh-lpbot` (private). Commits are the coarse
  history; the readable history is still `memory/CHANGELOG.md`.
- The bot is **read-only without a wallet**: `PRIVATE_KEY` unset ⇒
  `config.isReadOnly`, and only the wallet-free commands work.
- **Dry-run is the default** (`DRY_RUN` defaults to `true`). Every write path
  checks `settings.dryRun` before sending a transaction.

## Commands

```bash
npm run dev        # tsx watch src/index.ts
npm run start      # tsx src/index.ts
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run smoke      # scripts/smoke.ts — live sanity check against the chain
npm run verify:chain
```

`data/` (store + keystore) and `.env` are gitignored. The store path comes
from `DB_PATH`, the keystore from `KEYSTORE_PATH`; both default to `data/`.

## Layout

| Path | What lives there |
| --- | --- |
| `src/index.ts` | Process entry: config check, store init, monitor start. |
| `src/bot/index.ts` | Grammy wiring, command routing, `handleSettingsCallback`. |
| `src/bot/answers.ts` | The best-effort `answer()` helper: a rejected callback answer never stops the action. |
| `src/bot/newFlow.ts` | The `/new` flow: token → pools → side → strategy → range → size → preview → mint. |
| `src/bot/session.ts` | Per-chat conversation state (`Draft`, `Session` union). |
| `src/bot/ui.ts` | All keyboards and screen text (settings, menus, previews). |
| `src/core/positionViews.ts` | The view of a position (snapshot, valuation, PnL, market cap), its cache and the refresh behind the home screen. |
| `src/bot/positionsFlow.ts` | Per-position actions: close, TP/SL, compound, rebalance, history. |
| `src/bot/detectFlow.ts` | `/detect` — finds wallet LP NFTs and adopts them. |
| `src/core/planner.ts` | `planByUsd`, `planBySideShare`, `planByWalletShare`. |
| `src/core/bidAsk.ts` | Bid Ask ladder: weights, allocations, bin placement, plan builder. |
| `src/core/pairs.ts` | The traded side of a pair, the `TOKEN/USDG` label, the one-sided direction, and the range in the traded token's terms. |
| `src/core/trending.ts` | The trending-token list (5m/1h/6h/24h), the top ten ranked by traded volume. |
| `src/bot/trendingFlow.ts` | The Top Trending screen: the window toggle, the token rows (market cap, liquidity, volume) and the tap-to-scan callback. |
| `src/core/zeroXSwap.ts` | The 0x Swap API: quotes, validation, the allowance target and the swap state machine. |
| `src/core/gmgn.ts` | The GMGN OpenAPI client: the trending list and the candles. |
| `src/core/scanner.ts` | Pool scan; also `marketCapUsd(token)` (the FDV of one token). |
| `src/card/` | The images: `theme.ts` (shared tokens), `pnlCard.ts`, `calendarCard.ts`, `format.ts`, `data.ts`. |
| `src/core/calendar.ts` | The profit calendar: daily index, day/week buckets, stats, navigation limits. |
| `src/monitor/notifyText.ts` | Text of the OOR, back-in-range and exit notifications. |
| `src/core/actions.ts` | Chain writes: mint, close, collect, increase (dry-run aware). |
| `src/core/math/tickMath.ts` | Tick ⇄ price maths and tick alignment. |
| `src/core/math/positionMath.ts`, `liquidityMath.ts` | Uniswap liquidity maths. |
| `src/core/safety.ts` | Token safety screen run before anything is signed. |
| `src/core/positions.ts` | Reads an LP NFT back from the chain. |
| `src/monitor/` | Polling loop (`monitor.ts`) and exit decisions (`exits.ts`). |
| `src/store/store.ts` | JSON store: settings, tracked positions, history, address book. |
| `src/constants/` | Chain addresses, ABIs, Bid Ask limits. |
| `tests/` | Vitest suites; `memory/` — this folder. |
| `start.sh` | The launcher the desktop shortcut runs: installs the packages, checks `.env`, starts the bot, holds a lock so only one copy runs. |
| `install-shortcut.sh` | Creates (or removes) the desktop/menu icon. |
| `assets/icon.svg` | The desktop icon: the bot's range bar. |

## Core invariants

These are the rules that are easy to break by accident.

1. **One-sided deposits must stay one-sided.** A position holds `token0` when
   the price is at or below its lower bound and `token1` when the price is at or
   above its upper bound (`getAmountsForLiquidity` in
   `src/core/math/liquidityMath.ts`). Therefore:
   - funding `token0` ⇒ the range sits **above** the market (`direction: 'up'`),
   - funding `token1` ⇒ the range sits **below** the market (`direction: 'down'`).
   In the *displayed* price of the pasted token this means: quote-only = bids
   below the market, token-only = asks above the market — true for both token
   orderings.
2. **Price conventions.** `tickToPrice`/`priceToTick` are *token1 per token0*
   with decimals applied; `tick` is the raw Uniswap tick. `pool.tick` is the
   pool's current raw tick.
3. **Ticks are spacing-aligned.** Every `tickLower`/`tickUpper` used for a mint
   is a multiple of the pool's `tickSpacing`; `alignTickDown`/`alignTickUp` do
   that. `MIN_TICK`/`MAX_TICK` are not spacing-aligned, so never use them
   directly as a range bound.
4. **Settings are per chat**, stored in `data/store.json`.
   `store.settingsFor()` backfills missing fields with defaults, so a new
   setting only needs a default there, a field on `ChatSettings` and a
   normalisation on write. `store.updateSettings()` is the only writer.
5. **Transactions are serialised per chat** by `txLock` (`src/bot/locks.ts`), so
   a double tap cannot fire two mints.
6. **Store writes are atomic**: write to a unique `.tmp` file, then rename.
   The temp name includes the pid and a counter — parallel test workers share
   `data/store.json` and used to clobber each other's temp file.
7. **A test never writes to the production store.** `vitest.config.ts` loads
   `tests/setup.ts`, which points every worker at a temp `DB_PATH` /
   `KEYSTORE_PATH`, and `store.persist()` refuses to write to
   `data/store.json` while under vitest. A test that sets the path too late
   fails loudly instead of wiping the real data.
8. **Nothing modifies an open position behind the user's back.** Settings
   changes only affect future setups.
9. **A callback answer never decides the outcome.** Answer a callback query
   with `answer(ctx, options)` from `src/bot/answers.ts`, never with
   `ctx.answerCallbackQuery` directly: Telegram rejects an answer that
   arrives too late (*"query is too old"*), and a rejected answer must not
   take the action with it. A broken button also writes the reason into the
   chat, so it is never silent.
10. **A missing field never crashes a screen.** `esc()` takes `undefined` and
    returns `''`, the formatters print `—`. A record that lost a field must
    still open, because the history screen is the only way to the card button.
11. **Closed records are frozen.** Every number a card or the calendar shows is
    captured at close time (PnL, IDR/SOL rates, market caps, range, strategy,
    chain, price samples), so an old record never changes.
12. **An unknown value stays unknown.** A missing price feed makes the PnL
    `NaN` — never 0 — so it can never look like a total loss and fire a stop
    loss.
13. **A range follows the market.** `reanchorRange` (in `tickMath.ts`) moves a
    range the price has invalidated: a one-sided range follows the market with
    the same width, a two-sided range is re-centred. A range that is still
    valid is left alone.
14. **The range is read in the traded token's terms.** The pool price is
    `token1 per token0`; for a pool that stores the traded token as token1 the
    token's price is the inverse. `tradedRange` / `rangeForToken`
    (`src/core/pairs.ts`) map the bounds, the current price and the side into
    those terms: **OOR LEFT** is below the lower bound, **OOR RIGHT** is above
    the upper bound. Every screen, the valuation, the monitor's `aboveRange`
    and the closed record use them, so a bar can never contradict the label
    or the market-cap line.
15. **A manual close never swaps on its own.** `performExit` takes
    `skipAutoSwap`, and the close flow asks the user what to do with the
    withdrawn tokens and which route to use. An explicit route is used only —
    the v3 fallback belongs to the automatic swap and only runs while nothing
    was submitted (`swapWasSubmitted`).
16. **A failed swap is never reported as a success.** The close and the swap
    are two separate results, and the tokens are only said to be in the wallet
    when the wallet confirms the balance.
17. **A callback is acknowledged before the work.** Every handler answers the
    callback query first and then does the slow part, and a screen that takes
    more than a moment puts a `⏳` note in the message (`showLoading`). The
    market cap is cached and refreshed in the background, so a second tap is
    never needed.
18. **A double tap executes nothing twice.** The chat lock serialises the
    work and every flow checks that it is still live inside the lock: a second
    Confirm Open, Close or Rebalance reports that the action already
    happened.
19. **A scan recovers its v4 pool ids in one sweep.** The (fee, tick spacing)
    guess is the same for every pool of a pair, so it is paid once per pair
    (`recoverV4Keys`) and never per pool. The single-id recovery
    (`recoverV4Key`) stays complete but slow. The indexer pages, the pool
    prices and the depth measurements all run in parallel, and the depth
    reuses the price the scan already knows.
20. **The RPCs rotate.** `config.rpcUrls` holds every endpoint
    (`RPC_URLS`, with `RPC_URL` first; a list in either is split). An endpoint
    that answers 429 or drops the connection is put aside for a minute and
    the next one takes over; the last one that answered stays in use. The
    whole base URL is swapped, because an API key lives in the path.
21. **The failover never repeats a write.** A transaction that failed
    ambiguously is never sent again: the pending nonce decides whether it
    went through, and the hash is looked up in the recent blocks. Only a
    definite 429 (the transaction was never accepted) may be handed to the
    next endpoint.
22. **The costs of a closed position come from the transactions.** The gas is
    the open + the close + the swap, each read from its own receipt; the
    provider's fee is tracked but never subtracted twice (the received amount
    is already net of it). An unknown cost is never counted as zero: an
    imported position has no entry transaction, so its total reads
    "incomplete", while a dry run reads "not incurred". The PnL that is shown
    is the one that is left after every cost.
23. **A re-entry keeps the side of the market.** A one-sided position is
    re-minted one-sided (`reanchorRange` with the side the position holds);
    re-centring it would need both tokens again, and the capital that came
    back from the close is one-sided. The close is confirmed before the
    re-mint is sent. The rebalance is manual: the monitor never does it on
    its own.
24. **A market cap is written with two decimals and a comma** — `$1,05M`,
    `$684,45K` — everywhere it is shown (`fmtMcapUsd`). It is a large, precise
    number, so it gets the same treatment as the rupiah amounts. The other
    dollar amounts keep the plain dot format.
25. **A position is always valued from its own pool.** The price feed is the
    first source, but when one side of the pair has no feed, the rate of the
    pool the position is in gives it — the market the position is exposed to,
    for free. Without that, a position in a pool with an exotic fee tier or
    tick spacing (IGNITION: 4.99%, spacing 1000) reads as "—" for its PnL
    and its fees. A price that is unknown on **both** sides stays unknown: it
    must never look like a zero, because a zero looks like a total loss and
    would fire the stop loss.
26. **The indexer is skipped only for a quote token's own listing.** A token
    that trades *against* a quote has a small listing, and it is the only way
    to find a pool the standard probes cannot guess.
27. **The home screen is instant.** The menu draws the last view of every
    position, which the monitor produces on every tick. A stale view is
    refreshed in the background, a cold one is waited for; either way the menu
    never holds the user up for the chain.
28. **The bot runs from `start.sh`, and only one copy runs.** The launcher
    holds a lock file; a second start says the bot is already running instead
    of letting two copies fight over the same Telegram updates.

## The `/new` flow

```
/new → paste CA → pool scan → side ─┬─ both sides ─────────────────────┐
                                    ├─ quote only → strategy ─┬─ Spot  ─┤→ range → size → preview → confirm
                                    │                          └─ Bid Ask┘
                                    └─ token only → strategy ─┘
```

- **Side** (`both` / `quote` / `token`): which side of the pair the deposit
  funds. `both` is the classic two-token mint around the live price.
- **A pasted contract address outside a flow starts the scan** — the pool
  list appears without `/new` (`handleLooseText` in `newFlow.ts`).
- **Strategy** (`spot` / `bidAsk`): only offered for one-sided sides.
  `spot` = the original single position across the range. `bidAsk` = a ladder
  of N positions.
- **Range**: presets (±15/35/55/85% for both sides, `▼ -x%` for quote-only,
  `▲ +x%` for token-only), full range (both sides only) or custom prices.
- **Size**: a USD amount typed in, or a percentage of the relevant wallet
  balance (`amountKeyboard`).
- **Preview → confirm**: the preview is rebuilt from a refreshed pool every
  time, and the safety screen runs before anything is signed.

## Bid Ask ladders

- Entry count: **4–10**, default **5**, per chat, set in
  `⚙️ Settings → 📊 Bid Ask → Number of entries`. Changing it requires an
  explicit **Apply**; it is persisted and never touches open positions.
- Capital split: `allocation[i] = total × (i+1) / (N(N+1)/2)`, computed in
  integer micro-USD with a largest-remainder pass so the entries sum exactly
  to the requested total. Entry 1 (nearest the market) gets the smallest
  share, entry N the largest.
- Price placement: the selected range is split into N contiguous,
  spacing-aligned bins. The **near edge follows the live price** (so every
  mint stays one-sided even if the market moved after the range was picked);
  the far edge stays where the user put it. Leftover tick-spacings go to the
  farthest bins. A range that is too narrow or on the wrong side is refused.
- Execution: N **separate** mints, one transaction each, sequential under one
  `txLock`. Each entry is re-planned against the live pool and re-validated
  before it is minted; the ladder stops at the first failure and reports what
  was already opened. Each mint is tracked as its own position.
- If the entry count changes while a preview is open, the preview is
  invalidated instead of silently re-planned.

## Position screens

One fixed shape for every position, on every screen:

```
🟢 #1 · TOKEN/USDG · Robinhood
IN RANGE

[■■■■■■■|□□□] 67% Left
MC $1.12M → $1.40M · now $1.30M

💰 $48.20 · Fees $1.25
📊 +$2.40 (+5.10%) · Rp 38.400

🎯 TP +30% · SL -20%
⚡ Auto-TP +1.5% · Cycle 2/3
🔄 Rebalance ON · OOR TP ON
🧩 Compound 6h · APR 12.4%
⏱ Age 2h · Last rebalance 1h
```

- **Numbering**: `#1` comes from the tracked id `p1` (`positionNumber`).
- **Pair label**: always `TOKEN/USDG` — the traded token first, the USDG quote
  last, whatever the pool's token order is (`positionPair`, `tradedToken`).
- **Range bar**: `rangeVisual` in `src/bot/ui.ts` renders
  `[■■■■■■■|□□□] 67% Left`; the filled cells are the traversed part of the
  range, the marker is the price, and the percentage is the real distance to
  the lower bound. Out of range it shows `OOR LEFT` / `OOR RIGHT`.
- **Market cap**: `MC …` is the FDV at the range bounds and now, scaled from
  the pool price. It is omitted when the indexer has no FDV — never replaced
  by a price.
- **No prices**: the card shows no token price, no price per pair, no token
  amounts and no cost basis.
- Optional fields are omitted when they are unknown, never faked.

`npm run preview:text` renders every one of these screens with fixture data.

## The PnL card

`/card <id>` renders a 1080 x 1350 PNG receipt for a closed position
(`src/card/`). SVG is laid out by hand and rasterised with `@resvg/resvg-js`
using the bundled JetBrains Mono in `assets/fonts/` — no system fonts, so the
output is the same everywhere.

- **The card is a pure function of the frozen close record.** Everything it
  shows (entry/exit market cap, range label, strategy, currency, the IDR and
  SOL rates, the price samples) is captured at close time in
  `src/core/history.ts` and stored on the `ClosedRecord`. A card generated
  today and one generated next month show the same numbers.
- **Net PnL and ROI come from the bot's own PnL accounting** (`pnlUsd`,
  `pnlPct` on the record) — there is no second calculation path.
- **The chart** draws the price samples the monitor records (one every 5
  minutes, 240 at most). Without samples the chart is left out entirely.
- **Missing values show `N/A`**, never a zero and never an estimate.
- The chat's **display currency** (`Settings -> currency`) decides the main
  amounts; the other currency is shown next to the ROI so the same number is
  never printed twice.
- `npm run preview:card` renders the profit, loss and IDR layouts with
  fixture data; `npm run card -- <id>` renders a real record to
  `data/cards/<id>.png`.

## The profit calendar

`/calendar` (or the menu button) shows the realized profit of every closed
position per month, week and day, as a 1080 x 1350 image in the same Receipt
style (`src/card/calendarCard.ts`).

- **The numbers come from the closed records** — the same finalized net
  realized PnL the PnL card uses. There is no second PnL calculation.
- **Days are bucketed in the chat's timezone** (`Settings -> timezone`, default
  WIB / Asia/Jakarta). The bucket key is the local close date.
- **IDR sums each position's stored close-time rate**; a position without a
  rate renders `N/A` and is excluded from the win/best/worst stats. Only USD
  and IDR are offered.
- `src/core/calendar.ts` keeps a **daily index** (chat + timezone -> close
  date -> records) that is rebuilt only when the history version changes, so a
  month view does not scan every record.
- The renderer takes one payload and returns a PNG; the aggregation happens
  first. The callback data is `cal:{m|w|d}:{period}:{usd|idr}`.
- `npm run preview:calendar` renders the three views from real records.

## Performance notes

- **The monitor tick is parallel** and **skips positions that cannot act**
  (`needsAttention`): no armed rule, no auto-rebalance, no compound due and no
  alerts means no chain read at all. The RPC gate in `chain/client.ts` bounds
  the burst.
- **The poll interval is 15 s** (`POLL_INTERVAL_MS`). Lower means faster
  triggers and more RPC calls.
- **A pool scan is cached for a minute** and its candidates are read in
  parallel. A scan costs dozens of RPC calls, so it is worth caching.
- **The v4 pool-key recovery** probes the common tick spacings first and
  remembers the result per pool id: ~1 ms instead of ~516 ms of blocking CPU.
- `mapLimit` (`src/utils/async.ts`) is the bounded-concurrency helper.

## Settings (per chat)

| Setting | Field | Default | Where |
| --- | --- | --- | --- |
| Dry-run | `dryRun` | `true` (env) | Settings toggle |
| Slippage | `slippagePct` | `1%` (env) | Settings slider |
| Alerts | `alertsEnabled` | `true` | Settings toggle |
| Auto-swap to USDG | `autoSwapToUsdg` | `false` | Settings toggle |
| Auto-TP target | `autoTpTargetPct` | `1%` | Settings prompt |
| Auto-TP cycles | `tpCycleLimit` | `3` | Settings prompt |
| Bid Ask entries | `bidAskEntries` | `5` | Settings → Bid Ask |
| Display currency | `currency` | `USD` | Settings → 💱 |
| Auto-swap minimum | `autoSwapMinUsd` | `$0.30` | Settings → Swap ≥ |

**The auto-swap route** is the 0x Swap API v2 on chain 4663
(`/swap/allowance-holder/quote`). The allowance goes to the AllowanceHolder the
API reports, never to the Settler or Permit2. A swap is keyed by the closed
position, so it can never be sent twice; a submitted swap is reconciled through
its hash. Without `ZEROX_API_KEY` the Uniswap v3 route is used instead.
| Calendar timezone | `timezone` | `Asia/Jakarta` | Settings → 🕒 |

Per-position overrides (alerts, auto-compound, auto-rebalance, auto-TP, cycle
limit) live on the tracked position itself, not in the chat settings.

## Testing conventions

- Vitest, suites in `tests/`, named after the area (`flows.test.ts`,
  `bidAsk.test.ts`, `menu.test.ts`, …).
- Telegram flows are tested with a hand-rolled `fakeCtx()` that captures
  `replies`, `edits` and `answerCallbackQuery` calls — there is no bot mock
  library in use.
- Chain access is mocked (`vi.mock`) where a test needs it; pure maths and
  formatting are tested directly.
- Tests that write to the store point `DB_PATH`/`KEYSTORE_PATH` at a temp
  directory *before* importing the config module (see `automation.test.ts`).
- `bidAsk.test.ts` injects a fake `planUsd` planner into `buildBidAskPlan`
  instead of hitting the network — keep that seam open.
- `ui.test.ts` and `notifyText.test.ts` cover the position screens: numbering,
  pair label, range bar, market cap, exit reasons and HTML escaping.
- Always finish with `npm run typecheck` and `npm test`; both must be green.
