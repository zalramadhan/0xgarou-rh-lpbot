# Changelog

Append-only, newest first. Each entry records what changed, why, which files
were touched and how it was verified. See `README.md` for the format.

---

## 2026-10-21 — A chosen range width is the width you chose

**Area:** core (tick maths), tests

**What changed**
- **"▼ -50%" gave a 33% range.** The one-sided range was built by adding the
  width to the *aligned* near bound. The width itself was computed as a ratio
  (`log(1 + pct)`), which is right for "50% higher" but wrong for "50% lower":
  a -50% range has to reach down to *half* the price, and the old maths only
  reached a third of the way down. On top of that, the near bound sits on a
  tick boundary, so with a wide tick spacing (IGNITION's pool: 1000 ticks =
  10.5% a step) the error grew to 17 points.
- **The far end is now the requested distance from the live price**, and the
  near end stays as close to the price as the tick spacing allows. The
  requested width is what the user gets: -50% is 50% below the live price (the
  label may show a little more, because the far bound has to sit on a tick
  boundary too).
- The two-sided range (`±pct%`) was already right and is unchanged.

**Files**
- `src/core/math/tickMath.ts` — `oneSidedTicks`.
- `tests/entry.test.ts` — the far end is measured from the live price.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 380/380 pass (33 files)
- Live: the position that was opened with "▼ -50%" and ended up labelled
  "-33% to -1%" now measures "-53% to -5%".

---

## 2026-10-20 — The home screen shows the open positions

**Area:** core, bot (menu, ui, positions flow), monitor, tests

**What changed**
- **The main menu lists the open positions**, in the same format as the
  position list: the token with the colour of its state, the visual range,
  the market cap and the PnL with the fees.
  ```
  🟢 <b>#6 · IGNITION/USDG</b> · Robinhood
  [■■■■■■■■■|□] 92% Left
  MC $713,02K → $1,06M · now $1,04M
  $53.32 · PnL +0.61% · Fees $0.3723
  ```
  Every open position also gets a button at the top of the menu
  (`#6 🟢 IGNITION/USDG · $53`), so it can be opened from the home screen.
- **The menu never waits for the chain.** The last view of every position is
  cached (`core/positionViews.ts`): the monitor produces a view on every tick
  and keeps it, and the menu draws the cache. A view that has gone stale is
  refreshed in the background; only a cold cache is waited for, because
  otherwise the menu would have nothing to show. One read per position at a
  time, so two taps never send two rounds of requests.
- The view loader moved from the bot to `core/positionViews.ts`, so the
  monitor and the bot share one way of reading a position.

**Files**
- `src/core/positionViews.ts` — **new** — the view, the cache and the refresh.
- `src/bot/menu.ts` — the position block and the position buttons.
- `src/bot/ui.ts` — `menuPositionRow`.
- `src/bot/positionsFlow.ts` — the loader moved out.
- `src/monitor/monitor.ts` — keeps the cache warm.
- `tests/menuPositions.test.ts` — **new**.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 378/378 pass (33 files)

---

## 2026-10-20 — A position in an exotic pool shows its PnL and fees again

**Area:** core (valuation, discovery), tests

**What changed**
- **Position #6 (IGNITION/USDG) showed no PnL and no fees.** Two things
  together made the bot blind to that token:
  - The price feed looks for a token's pools by probing the standard fee tiers
    and tick spacings. IGNITION's pool is **4.99% with a spacing of 1000** —
    neither is standard — so the probe found nothing.
  - The indexer, which does list that pool, was skipped for every pair that
    contains a quote token. The skip was meant for the *quote* token's own
    (enormous) listing, not for a token that trades against a quote, so it
    hid exactly the pools the probe cannot guess.
  - The result was a price of NaN, and with it the whole valuation: the
    position read `— · PnL — · Fees —`.
- **The indexer is consulted again for a token that trades against a quote.**
  The skip now applies to the token being *listed* only when that token is
  itself a quote (USDG, WETH), where the listing really is enormous. The
  price feed now finds the exotic pools (IGNITION: 6 pools, including the
  4.99% one the position is in).
- **A position is valued from its own pool when the feed is missing.** The
  pool a position is in knows the rate between its two tokens, so the missing
  side of the price is taken from there — the market the position is actually
  exposed to, not a guess, and for free (no extra request). This is the
  safety net: a position stays readable even when the indexer is down.
- The market cap line comes back with it (`MC $712,81K → $1,06M · now
  $1,03M`), because it needs the same prices.

**Files**
- `src/core/discovery.ts` — the indexer skip now only applies to a quote
  token.
- `src/core/valuation.ts` — `priceFromPoolRate`.
- `tests/priceFallback.test.ts` — **new** — the fallback, the "unknown stays
  unknown" rule and the preference for the price feed.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 374/374 pass (32 files)
- Live: position #6 reads `💰 $53.27 · Fees $0.3383` and `📊 +$0.2701 (+0.51%)`.

---

## 2026-10-20 — The project goes to GitHub

**Area:** repo, docs

**What changed**
- The project is now a git repository and lives at
  `github.com/zalramadhan/0xgarou-rh-lpbot` (**private**). The first commit
  carries the whole bot: the source, the tests, the `memory/` folder, the
  launcher and the desktop icon.
- **Nothing secret is in it.** `.env`, `data/` and `*.log` are gitignored, and
  the real values (Telegram token, wallet key, 0x and GMGN keys, the RPC list)
  were checked against every committed file before the push.
- `.bot.lock` (the launcher's lock file) is gitignored too.
- `AGENTS.md` and `memory/STATE.md` no longer say "this is not a git
  repository".

**Files**
- `AGENTS.md`, `memory/STATE.md`, `memory/CHANGELOG.md`, `.gitignore`.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 370/370 pass (31 files)

---

## 2026-10-20 — One click to run the bot, and the market cap gets two decimals

**Area:** utils, bot ui, card, launcher, docs, tests

**What changed**
- **A one-click launcher.** `./install-shortcut.sh` puts a "0xgarou LP Bot"
  icon in the project folder, on the Desktop and in the application menu. It
  runs `start.sh`, which installs the packages if they are missing, checks that
  `.env` exists, and starts the bot in a terminal window (KDE opens the user's
  own terminal). **Only one copy runs at a time**: a second click says so
  instead of letting two bots fight over the same Telegram updates. The icon
  is the bot's own range bar.
- **The market cap is written with two decimals and a comma** — `$1,05M`,
  `$684,45K` — in the position screen, the range alerts, the review screen and
  the PnL card. A market cap is a large, precise number, so it gets the same
  treatment as the rupiah amounts.

**Files**
- `start.sh`, `install-shortcut.sh` — **new** — the launcher and the installer.
- `assets/icon.svg` — **new** — the desktop icon.
- `src/utils/format.ts` — `fmtMcapUsd`.
- `src/bot/ui.ts`, `src/card/format.ts` — the market cap uses it.
- `tests/notifyText.test.ts`, `tests/pnlCard.test.ts`, `tests/rangeOrientation.test.ts`,
  `tests/ui.test.ts` — the new format.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 370/370 pass (31 files)
- The shortcut was launched for real (KDE → alacritty → `start.sh` → the bot
  came up and the Telegram polling started).

---

## 2026-10-20 — The alert's Details button gets a better emoji

**Area:** monitor, tests

**What changed**
- The out-of-range alert's **Details** button is now **🧾 Details** instead of
  📄 Details: a receipt reads as "the position sheet with the numbers", while
  a plain page read as nothing in particular.

**Files**
- `src/monitor/monitor.ts` — the button label.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 370/370 pass (31 files)

---

## 2026-10-20 — The rebalance keeps the side, and it is manual now

**Area:** core, monitor, bot flow, ui, store, tests, docs

**What changed**
- **The re-mint failed for one-sided positions.** The rebalance re-centred the
  range on the live price, whatever the position was. A position that held only
  one token then needed **both** tokens again — and the capital that came back
  from the close is one-sided — so the mint had nothing to work with and the
  bot ended up with *"closed, but the re-mint failed"*. The range now keeps the
  **same side** of the market (`reanchorRange` with the side the position
  holds) and the same width, so a one-sided position stays one-sided and the
  mint works. The auto-TP re-entry got the same fix.
- **The close is confirmed before the re-mint is sent** — the capital the
  re-mint uses is what the close returns.
- **The rebalance is manual.** The automatic rebalance is gone: the monitor no
  longer rebalances on its own, the per-position `🔁 Rebalance ON/OFF` toggle
  is gone with it, and the alert says *"Rebalance is manual — tap Rebalance
  now"*. 🔁 **Rebalance now** stays.
- **A failed re-mint now says why.** The message carries the reason instead of
  a dead end.
- The rebalance keeps the same width, the same side and the live price, and
  reuses only the withdrawn tokens (plus a 1% buffer).

**Why**
The rebalance was the one action that could lose a position without the user
asking for it, and the one that failed most often — a one-sided position could
never be re-minted from its own capital.

**Files**
- `src/core/strategy.ts` — `sideOf` and `reentryRange` (the side-aware range).
- `src/monitor/monitor.ts` — the automatic rebalance is gone.
- `src/bot/ui.ts`, `src/bot/positionsFlow.ts` — the toggle is gone, the
  failure message carries the reason.
- `src/store/store.ts` — the `autoRebalance` flag is gone.
- `tests/rebalanceRange.test.ts` — **new** — the side rule, and the proof that
  re-centring is what broke it.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 370/370 pass (31 files)

---

## 2026-10-20 — The position buttons name the token and colour the state

**Area:** ui, bot flow, tests

**What changed**
- A position in the list is now a button that says what it is:
  ```
  #5 🟢 IGNITION/USDG · $53
  ```
  The number, a colour for the state, the pair and the value — instead of a
  bare `#5 · $53.00`.
- The colours: **green** for a profit, **red** for a loss and **orange** when
  the position left its range. Orange wins over the PnL, because a position out
  of its range needs attention whatever it earned.
- The list row uses the same colours, so the button and the row never
  disagree.

**Why**
The button only carried a number and a value, so the list had to be read
line by line to find out which position was which and how it was doing.

**Files**
- `src/bot/ui.ts` — `statusEmoji`, shared by the row and the button.
- `src/bot/positionsFlow.ts` — `positionButton`.
- `tests/ui.test.ts` — the colours.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 366/366 pass (30 files)

---

## 2026-10-20 — The range frame hugs the range

**Area:** ui, monitor

**What changed**
- The rules that frame the range block no longer have blank lines around
  them: the block sits tight on the position screen and in the alerts.
  ```
  🔴 #1 · V4/USDG · Robinhood
  OUT OF RANGE · RIGHT
  ─────────────────────────────
  [■■■■■■■■■■|]→ <b>OOR RIGHT</b>
  MC $1.7M → $2.6M · now $3.5M
  ─────────────────────────────
  💰 $13.24 · Fees $0.0000
  ```

**Why**
The blank lines broke the frame into three separate pieces; the range bar
and the market cap are one block and read better as one.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 365/365 pass (30 files)

---

## 2026-10-20 — The range alerts can be switched from the menu

**Area:** bot flow, ui, tests

**What changed**
- The **main menu** has a button that switches the range alerts (out of range
  and back in range) on and off, and the menu text says which state they are
  in: `🔔 Range alerts: on — out of range and back in range`.
- The settings button and the chat line now say the same thing
  (`🔔 Range alerts` instead of the vague "Alerts"), so it is clear which
  alerts the switch covers.

**Why**
The switch existed in the settings, but it was one row down in a long list and
its label did not say what it turned off. The menu is where the state of the
bot is read.

**Files**
- `src/bot/menu.ts` — the button, the state line and the `menu:alerts` callback.
- `src/bot/ui.ts` — the settings label and line.
- `src/bot/index.ts` — the answer text of the settings toggle.
- `tests/menu.test.ts` — the button and the toggle.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 365/365 pass (30 files)

---

## 2026-10-20 — The range bar shows which way the price left

**Area:** ui, monitor, tests

**What changed**
- Once the price is outside the range, the bar shows **which way it left**:
  - **OOR RIGHT** (the token is above the range) → `[■■■■■■■■■■|]→`
  - **OOR LEFT** (the token is below the range) → `←[|□□□□□□□□□□]`

  The marker moves past the end the price went through and an arrow points
  that way. While the price is inside the range the marker stays in it
  (`[■■■■■■■|□□□] · 67% Left`).
- The bar is built in one place (`rangeBar`), so the position card, the
  position list, the alerts and the review screen cannot drift apart.

**Why**
A bar that simply filled up on one side did not say which side the price had
left through — the arrow makes the direction readable at a glance.

**Files**
- `src/bot/ui.ts` — the shared `rangeBar`.
- `tests/ui.test.ts`, `tests/notifyText.test.ts`, `tests/rangeOrientation.test.ts` —
  the new bar shapes.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 364/364 pass (30 files)

---

## 2026-10-20 — The range block is framed on the position screen and the alerts

**Area:** ui, monitor, tests

**What changed**
- The **range bar and the market-cap line** are now framed by a rule above
  and below, on the detailed position screen and on the out-of-range and
  back-in-range alerts:
  ```
  ─────────────────────────────
  [■■■■■■■■■|□] OOR RIGHT
  MC $2.3M → $3.5M · now $3.5M
  ─────────────────────────────
  ```
- The PnL follows the block right away, so the cost information still sits
  directly under the range.

**Why**
The bar and the market cap are the two numbers a position is judged by; framing
them makes them read as one block instead of two loose lines.

**Files**
- `src/bot/ui.ts` — the frame in the position card, and the shared
  `RANGE_FRAME`.
- `src/monitor/notifyText.ts` — the frame in both alerts.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 364/364 pass (30 files)

---

## 2026-10-20 — The gas of the whole round trip, and the PnL after the swap

**Area:** core, card, store, monitor, bot flow, tests, docs

**What changed**
- **The "Fees & Gas" row counted half the gas.** The open's gas was never
  read, even though the mint transaction's hash is stored
  (`tracked.entry.txHash`). The total is now **open + close + swap**, each
  measured from its own receipt.
- **The pool's trading fee is gone from the costs.** It was an estimate
  (`deposit × fee`) and, worse, it is not a cost at all for an LP: the fee a
  pool charges traders is the LP's *income*. The card now shows the **fees the
  position actually earned** (`Fees Earned`) and the **gas** as two separate
  rows, plus a small breakdown line (`open $0.03 · close $0.03 · swap $0.01`).
- **The PnL after a swap.** The record is written at the close, but the swap
  happens after it, so the card used to show the PnL from before the swap and
  the swap's own cost was invisible. A swap now adds to the record: what it
  delivered, what it cost and the **PnL that is left after every cost**
  (`pnlNetUsd` / `pnlNetPct`). The card's hero shows that number, with the
  number from before the gas as the secondary line.
- **The 0x fee is tracked but not subtracted twice.** `receivedUsdg` is the
  *balance difference* after the swap, so it is already net of the provider's
  fee. It is kept as `swapFeeUsd` for information only. The 0x
  `totalNetworkFee` (a native estimate) is **not** part of the costs: the
  actual gas comes from the receipt.
- **Unknown is never zero.** An imported position has no entry transaction, so
  its open gas is unknown: the total reads "incomplete" and the breakdown says
  "open unknown". A dry run spent nothing, so it reads "not incurred" — a
  cost that was not incurred is not the same as a cost that is unknown.
- **A swap that failed still counts.** A reverted swap cost its gas, and the
  withdrawal stayed in the wallet, so the record is updated for it as well and
  the leftover is valued at the close price.
- The v3 swap route now reports what it received and what it cost (it
  fetched its receipt anyway), and the automatic swap of an auto-TP close
  updates its record the same way as a manual one.
- The ETH price at the open is stored with the position, so the open's gas is
  priced at the time it was spent.
- Records closed before this change keep their old numbers; the card and the
  receipt ignore the old mixed "fees & gas" value and read the three gas
  fields, so an old record shows "N/A" instead of a number that is not the
  whole truth.

**Why**
The card claimed a cost that was never paid and left the swap's cost out of
the result. The numbers now come from the transactions that actually
happened, and the PnL is what is really left in the wallet.

**Files**
- `src/core/history.ts` — the gas of the open and the close, `swapAccounting`
  and `withSwap`.
- `src/core/swap.ts` — the outcome carries the received amount, the gas and
  the provider's fee; the v3 route reports them.
- `src/store/store.ts` — the new record fields and `updateClosed`.
- `src/card/data.ts`, `src/card/pnlCard.ts` — the hero, the two rows and the
  breakdown line.
- `src/monitor/notifyText.ts` — `costLines`, the receipt's gas and PnL.
- `src/monitor/exits.ts`, `src/bot/positionsFlow.ts` — the swap updates the
  record; the receipt shows the costs.
- `tests/closeCosts.test.ts` — **new** — the gas totals, the post-swap PnL,
  the 0x fee, the dry run, the imported position and the Keep Both path.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 362/362 pass (30 files)
- the card was rendered with a swap: the hero is the PnL after the gas, the
  rows show "Fees Earned" and "Gas", and the breakdown lists the three
  transactions

---

## 2026-10-20 — Sequential RPC failover, and a transaction is never sent twice

**Area:** core, tests

**What changed**
- **The failover is sequential and stops at the first success.** The active
  endpoint takes the request; when it answers, the request is done — no other
  endpoint is probed, scanned or asked. The endpoint that answered becomes
  the active one for the next request.
- **A failure moves on to the next eligible endpoint**: HTTP 429, HTTP 5xx, a
  timeout or a connection error puts that endpoint aside for the existing
  60 seconds and the next one that is eligible takes over. An endpoint
  becomes eligible again when its cooldown expires, and the one that
  answered last keeps the traffic until it fails.
- **When every endpoint fails**, the error says so (`Every RPC endpoint
  failed: …`). It is named `AbortError`, so neither the transport nor the
  client retries it and the failover cannot loop.
- **A transaction is never sent twice.** The transport's own retry count is
  now 0 — the failover is the only thing that repeats a request, and it
  never repeats a *write*: a transaction that failed ambiguously (a timeout
  after it was broadcast) throws an `ambiguous` error instead of being sent
  to the next endpoint. A transaction that was rejected with **429** was
  definitely not accepted, so the next endpoint may take it.
- **The nonce settles an ambiguous send.** `sendTransaction` reads the
  pending nonce before it sends; when the send fails ambiguously it reads it
  again. If it did not move, nothing was sent; if it moved, the transaction
  is looked up in the recent blocks and followed, so the bot never sends it
  a second time.
- `retryRpc` no longer retries an aborted request: the failover has already
  been through every endpoint.

**Why**
The earlier version let the transport retry on its own, which could send a
transaction twice, and it retried the same endpoint before moving on. The
failover now lives in one place and knows the difference between a read and
a write.

**Files**
- `src/chain/client.ts` — the sequential failover, the write rule, the
  `RpcUnavailableError` and `rpcStatus`.
- `src/core/actions.ts` — the nonce check and the hash lookup for an
  ambiguous send.
- `src/utils/async.ts` — `retryRpc` skips an aborted request.
- `tests/rpcFailover.test.ts` — **new** — the failover, the cooldown and the
  write rules.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 349/349 pass (29 files)
- live with the ten configured endpoints: a call in 211 ms, the next one in
  0 ms, no other endpoint touched

---

## 2026-10-20 — A list of RPCs works in either variable, and a broken token stops shouting

**Area:** config, core, tests

**What changed**
- **A list of endpoints in `RPC_URL` now works.** The variable used to be
  taken as one address, so a `.env` with several comma separated endpoints
  sent every request to `https://key1, https://key2, …` — Alchemy answered
  *"Must be authenticated"* and **every read failed**. Both `RPC_URL` and
  `RPC_URLS` are now split into a list, `RPC_URLS` first, and the first
  endpoint is what the transport talks to.
- **A token that cannot be read stops flooding the log.** `symbol() failed`
  is logged once per token per minute instead of once per attempt, the
  `bytes32` symbol is only tried when the contract actually *reverts* (a
  rate limit fails the same way twice), and a token whose metadata could not
  be read is remembered for 30 s, so a scan does not pay the same failed
  calls again.

**Why**
The repeated `symbol() failed` warnings were not a broken token: they were
the RPC URL being wrong, so every metadata read failed, was retried five
times, and was tried twice per attempt.

**Files**
- `src/config.ts` — `parseRpcUrls` splits both variables; `config.rpcUrl` is
  the first endpoint of the list.
- `src/core/tokens.ts` — the throttled warning, the revert-only `bytes32`
  fallback and the short-lived failure cache.
- `tests/rpcUrls.test.ts` — a list in `RPC_URL` and one pool of both.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 338/338 pass (28 files)
- the ten configured endpoints are parsed and a call against them works

---

## 2026-10-20 — Nine RPCs, and the bot rotates through them

**Area:** core, config, bot flow, tests, docs

**What changed**
- **`RPC_URLS`** holds every RPC endpoint (comma or newline separated).
  `RPC_URL` keeps its meaning — it is the first endpoint — so an existing
  `.env` works untouched.
- **The bot rotates.** An endpoint that answers **429** (too many requests) or
  a 5xx, or drops the connection, is put aside for a minute and the next one
  takes over. The endpoint that answered last stays in use, so a healthy
  provider is never left behind. The whole base URL is swapped, not just the
  host: an API key lives in the path.
- **`/status` shows the RPC in use** — `🛰 RPC robinhood-mainnet.g.alchemy.com
  (2/9 · 1 cooling)` — so a rate-limited endpoint is visible instead of
  silently slowing the bot down.

**Why**
A public or shared provider rate-limits, and every call that waited for it
was a call the user felt. Nine endpoints in the pool mean the bot keeps
working when one of them says no.

**Files**
- `src/config.ts` — `parseRpcUrls` and `config.rpcUrls`.
- `src/chain/client.ts` — the rotation, the cooldown and `rpcStatus`.
- `src/bot/screens.ts` — the status line.
- `tests/rpcUrls.test.ts` — **new** — the parsing of the list.
- `.env` — the `RPC_URLS` placeholder, README — the variable.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 330/330 pass (28 files)
- measured with a local server that answers 429: the call failed over in
  624 ms, the limited endpoint was marked as cooling down and the next call
  took **0 ms**

---

## 2026-10-20 — The pool scan is five times faster

**Area:** core, tests

**What changed**
- **A scan took 12.6 s.** The v4 pool ids of a token were recovered one by
  one, and each recovery brute-forces the (fee, tick spacing) combination:
  ~15 fees × 2 000 spacings = 30 000 hashes **per pool id**. Fifteen ids
  meant 450 000 hashes — five seconds of pure CPU.
- **The ids of a pair are now recovered in one sweep**
  (`recoverV4Keys`): the guess is the same for every pool of a pair, so the
  sweep is paid once per pair instead of once per pool. The exotic spacing
  sweep only runs for the fee the listing actually names (and the dynamic-fee
  flag) — the standard tiers use a common spacing, which the first pass
  already covers. **535 ms instead of 2 127 ms**, same four pools found.
- **The indexer pages are fetched in parallel** (the first page on its own,
  so a rate limit still leaves its result) instead of one after another.
- **The pool prices and the depth measurements run in parallel** (`mapLimit`),
  not one pool at a time.
- **The depth no longer probes the chain a second time**: the traded token's
  price is already known from the pool, so only the quote is looked up — and
  USDG is one dollar.
- **The indexer is not asked about the quote pairs** (USDG/WETH): their pools
  are known locally and their listing is enormous.
- **Caches were given a longer life**: the indexer listing 60 s → 120 s, the
  prices 45 s → 120 s, and a failed listing is remembered for 60 s, so a
  rate-limited API is not hammered.

**Why**
The scan is the first thing a user sees when they paste a CA, and twelve
seconds of waiting is what made it feel broken.

**Files**
- `src/core/discovery.ts` — `recoverV4Keys`, the batched recovery, and the
  quote-pair shortcut.
- `src/core/scanner.ts` — the batched recovery in the scan, the parallel
  prices and depths, and the depth that reuses the known price.
- `src/core/indexer.ts` — the pages in parallel and the longer cache.
- `src/core/prices.ts` — the longer price cache.
- `tests/perf.test.ts` — the list recovery in one sweep.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 329/329 pass (27 files)
- measured on the V4 token: **12 638 ms → 2 512 ms** for a cold scan, and
  **0 ms** while the caches are warm. The same four pools are found.

---

## 2026-10-20 — Buttons answer at once and never need a second tap

**Area:** bot flow, core, ui, tests

**What changed**
- **The root cause of "the button needs two clicks"**: the screens that read
  the chain, the price feeds and the indexer took half a second to two and a
  half seconds, and the answer only came *after* that work in some handlers.
  The first tap stopped the spinner late or not at all, so the user tapped
  again. The market cap alone was **2.35 s** (three indexer pages).
- **The market cap is fast now**: the FDV is a property of the token, so one
  indexer page is enough (the deepest pool can sit on page three) — and the
  value is cached for a minute and refreshed in the background. Cold: ~0.9 s,
  warm: **0 ms**.
- **Every callback is acknowledged before the work.** The amount step answers
  before the pool is refreshed and the deposit is planned.
- **Slow screens show a loading note** (`⏳ Loading the position…`,
  `⏳ Scanning the pools…`, `⏳ Loading the trending list…`) in the message
  the button came from, so the user sees that the tap arrived.
- **An edit that Telegram refuses is no longer an error.** "Message is not
  modified" means the screen is already there, so no second copy is sent.
- **A double tap cannot execute anything twice**: a second Confirm Open
  finds no flow and says the position was already opened, a second Close
  says the position was already closed, a second Rebalance says the position
  was already rebalanced. The chat lock still serialises the work.
- **A crash on an empty pool list is fixed**: the range buttons used
  `scan.pools[0]!.pool`, which threw when the scan came back empty — the
  button did nothing at all.

**Why**
A button that answers late feels broken, and a button that answers late *and*
then throws is worse. The fix is not a longer timeout: the work is faster,
the answer comes first, and the user sees progress while it runs.

**Files**
- `src/core/scanner.ts` — the market-cap cache and the background refresh.
- `src/core/indexer.ts` — `fetchIndexerPools` can fetch a single page.
- `src/bot/screens.ts` — `present` handles "not modified", and the new
  `showLoading`.
- `src/bot/positionsFlow.ts`, `src/bot/newFlow.ts`, `src/bot/trendingFlow.ts` —
  the loading notes, the early answers and the double-tap guards.
- `tests/callbacks.test.ts` — **new** — the answer comes first, the loading
  note appears, a failure is reported.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 328/328 pass (27 files)
- measured: the market cap is 0.9 s cold and 0 ms warm (it was 2.35 s every
  time)

---

## 2026-10-20 — The close flow asks before it closes, and after

**Area:** bot flow, core, monitor, ui, tests, docs

**What changed**
- **Closing is a flow, not a button.** 🔒 Close now opens a confirmation with
  the pair, the value, the fees, the PnL, the market-cap range and the
  slippage a later swap would use (`🔁 A swap to USDG would use at most 1%
  slippage`). Only **✅ Yes, close it** closes the position; ✖ Cancel returns
  to the position.
- **After the close the user chooses what happens to the withdrawn tokens:**
  🔄 **Swap Token to USDG** or 💎 **Keep Both — No Swap**. The automatic swap
  never runs for a manual close any more (`performExit` takes
  `skipAutoSwap`), so nothing is swapped behind the user's back.
- **The swap route is the user's choice:** **0x API** or **V3 Pool**. An
  explicit route is used *only* — `swapProceedsToUsdg` takes a `route` and the
  v3 fallback is now reserved for the automatic swap, and only while nothing
  was submitted (a submitted transaction is detected through the swap state).
- **A failed swap is never reported as a success.** The message says the swap
  failed, names the token, and only claims the tokens are in the wallet when
  the wallet confirms the balance. The close and the swap are reported as two
  separate outcomes.
- **After the close the message carries the actions that still work:**
  📊 **Generate PnL Card** (the frozen record), ↩️ **Back to Position** (the
  closed-position summary) and 🏠 **Back to Home**.
- The buttons were renamed and completed: 🤖 **Check LP Agent** and 📈 **View
  Chart on GMGN** (the traded token's chart, the wallet's LP Agent portfolio),
  and the alert keyboard now has a 🔄 Refresh.
- **The range picker has the full ladder**: 15, 20, 25, 30, 35, 45, 50, 55,
  60, 65, 70, 75, 80 and 85 percent, three per row, on all three sides
  (symmetric, ▼ below the market, ▲ above it). A tapped value goes through
  the same calculation as a typed one, and only opens the amount step — it
  never mints.

**Why**
A close used to happen on the first tap, and the automatic swap could sell the
withdrawn tokens without asking. The user now sees what will happen, decides
what happens to the proceeds, picks the route, and gets the truth about a
failure — and the closed position still offers its card and its summary.

**Files**
- `src/bot/positionsFlow.ts` — the confirmation, the choice, the route picker,
  the swap and the receipt with its actions.
- `src/bot/session.ts` — the `closeChoice` / `closeRoute` steps.
- `src/core/swap.ts` — the explicit route, the split into `swapViaZeroX` and
  `swapViaV3`, and the `auto` fallback that only runs before a submission.
- `src/core/zeroXSwap.ts` — `swapWasSubmitted`, so a submitted transaction
  stops the fallback.
- `src/monitor/exits.ts` — `skipAutoSwap`.
- `src/bot/ui.ts` — the expanded range presets and the renamed buttons.
- `src/monitor/monitor.ts` — the alert keyboard.
- `tests/closeFlow.test.ts` — **new** — the whole flow.
- `tests/entry.test.ts`, `tests/detect.test.ts`, `tests/notifyText.test.ts` —
  the new keyboards.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 320/320 pass (26 files)

---

## 2026-10-20 — The range is read in the traded token's terms

**Area:** core, bot flow, monitor, ui, tests, docs

**What changed**
- **The OOR side was wrong for pools that store the traded token as token1.**
  The pool price is `token1 per token0`, so the token's own price is the
  *inverse* of it in that case. The bot compared the raw tick with the range
  and reported **OOR LEFT while the token was above the range**. Now the whole
  range — the bounds, the current price, the distances and the side — is
  computed in the traded token's terms (`tradedRange` / `rangeForToken` in
  `core/pairs.ts`):
  - **OOR LEFT** — the price (or market cap) is **below** the lower bound.
  - **OOR RIGHT** — the price (or market cap) is **above** the upper bound.
  - **IN RANGE** — the price is between the bounds.
  The same fix applies to the **OOR take profit** (the monitor's `aboveRange`),
  to the valuation's distances and to the closed record's exit price, which was
  the pool price while the entry price was the token's price.
- **The review screen shows the range in market cap**, not in price:
  `📐 Range MC $1.12M → $1.40M · now $1.30M`, plus the range bar drawn from the
  same numbers, so the review and the position that gets opened agree. The Bid
  Ask review and its bins use the same unit.
- **A freshly opened position is shown as a position.** After **Confirm Open**
  the chat is updated with the real position card — the status, the range bar,
  the market-cap line, the value, the fees, the PnL and the deposited amounts —
  and the action buttons (Refresh, LP Agent, the chart, close, TP/SL, …). It is
  the same screen the position panel shows, not a "position opened" line.
- **The range bar is no longer inside a code block** and is rendered as a
  normal message. The screens were then given a fixed layout:
  - **Review**: title, pool line, a rule, the bar, the market-cap range, the
    deposit and the total — the bar sits **above** the range line.
  - **Out of range**: the pair, the bar, the market cap, the PnL and the
    distance to the bound — no blank lines, no bold on the pair or the label.

**Why**
A pool that stores the traded token as token1 (the common case on this chain:
`USDG/TOKEN`) reported the wrong side, so the alert, the bar and the OOR take
profit all pointed the wrong way. The review screen spoke in prices while the
position spoke in market caps, and opening a position ended with a dead-end
message instead of the position the user could act on.

**Files**
- `src/core/pairs.ts` — `tradedRange`, `rangeForToken`, `tradedPrice`,
  `tokenPrice`: the range in the traded token's terms.
- `src/core/valuation.ts` — the distances are measured in those terms.
- `src/core/history.ts` — the exit price is the traded token's price.
- `src/bot/ui.ts` — `rangeVisual` reads the side from the price, `plannedRangeVisual`
  and `plannedMarketCapLine` for the review screen, the card and the list follow
  the visual.
- `src/monitor/monitor.ts` — `aboveRange` in the traded terms; the alert gets
  the PnL and the IDR rate.
- `src/monitor/notifyText.ts` — the new alert layout.
- `src/bot/newFlow.ts` — the review screens in market cap, the position card
  after the open.
- `src/bot/positionsFlow.ts` — `positionScreen`, shared by the panel and the
  open flow.
- `tests/rangeOrientation.test.ts` — **new** — the orientation rules.
- `tests/ui.test.ts`, `tests/notifyText.test.ts` — the new formats and the
  regression for the inverted pool.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 312/312 pass (25 files)
- live: the OOR alert and the position card were rendered with the real
  V4/USDG pool (the inverted case) and report **OOR RIGHT** — the token is
  above the range.

---

## 2026-10-20 — The test suite can no longer touch the production store

**Area:** store, tests, infra

**What changed**
- **A test wrote to the real `data/store.json`.** Nineteen of the 24 test
  files never set `DB_PATH`, so they used the production path — and the two
  `/detect` tests call `store.add()` / `store.remove()`. Running the suite
  overwrote the live store with the default data: the closed positions, the
  address book and the per-chat settings were **gone**.
- Fixed in three layers:
  1. `vitest.config.ts` + `tests/setup.ts` — every worker gets a temp
     `DB_PATH` / `KEYSTORE_PATH` (per worker, so two workers never share a
     file).
  2. `store.persist()` refuses to write to `data/store.json` when the process
     runs under vitest. A test that sets `DB_PATH` too late fails loudly
     instead of wiping the data.
  3. The five test files that manage their own store still do (they set the
     path in their module body, after the setup).
- The closed record and the address-book entry of the affected position were
  **rebuilt from the chain**: the token id, both transactions (the mint and
  the close), the pool key (fee 29990, ticks 332100/336600) and the two block
  timestamps. The rebuilt record renders a **byte-identical** PnL card to the
  one made from the original record.
- The per-chat settings of that chat were not rebuilt: they are gone and the
  bot now falls back to the `.env` (`DRY_RUN=true`, dry-run). The user has to
  set the dry-run / live switch again in **⚙️ Settings** if that was the last
  state.

**Why**
The bug was invisible: the tests passed, the bot kept working, and the data
was quietly replaced. A test must never be able to reach the production
store, and the loss had to be repaired.

**Files**
- `vitest.config.ts` — **new** — the setup file.
- `tests/setup.ts` — **new** — a temp store and keystore per worker.
- `src/store/store.ts` — the guard that refuses to write to the production
  path under vitest.
- `tests/detect.test.ts`, `tests/detectFlow.test.ts` — unchanged, but they now
  write to the temp store.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 302/302 pass (24 files)
- the production store is byte-identical before and after a full test run

---

## 2026-10-20 — A missing field can no longer crash a screen

**Area:** ui, tests

**What changed**
- `esc()` accepts `undefined` / `null` and returns an empty string instead of
  throwing. `shortDate()` returns `—` for an invalid date. The history
  detail screen falls back to `?` for a missing version.
- The PnL card button is only reachable **through** the history detail
  screen, so a crash there (`Cannot read properties of undefined (reading
  'replace')`) took the card with it and the tap looked broken.

**Why**
A closed record that lost a field used to kill the whole screen. The card
itself was fine — the crash was in the text around it.

**Files**
- `src/utils/format.ts` — the safe `esc()`.
- `src/bot/historyFlow.ts` — the safe `shortDate()` and the version fallback.
- `tests/cardFlow.test.ts` — a record with missing fields still opens.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 302/302 pass (24 files)

---

## 2026-10-20 — A failed callback answer no longer kills the button

**Area:** bot flow, tests

**What changed**
- Every `ctx.answerCallbackQuery(...)` in the bot now goes through the new
  helper `answer(ctx, options)` (`src/bot/answers.ts`), which swallows the
  failure. Telegram rejects an answer when the update reached the bot late:
  *"query is too old and response timeout expired or query ID is invalid"*.
- Before the fix that rejection **aborted the whole action**: the PnL card
  button answered the query first, so a rejected answer meant the card was
  never sent — and the outer error handler tried to answer the same dead
  query, so the chat showed **nothing at all**: no card, no error, only the
  loading spinner on the button.
- The router now also writes the reason into the chat when a callback fails
  (`⚠️ …`), so a broken button is never silent again.

**Why**
The PnL card button looked broken — the tap did nothing, with no error
anywhere. The code was right all along (the card rendered, Telegram accepted
the PNG), the *answer* was the only thing that could fail silently, and it
failed hard enough to take the card with it.

**Files**
- `src/bot/answers.ts` — **new** — the best-effort `answer()` helper.
- `src/bot/*.ts` — all 103 answer calls now use the helper.
- `src/bot/index.ts` — the chat fallback for a failed callback.
- `tests/cardFlow.test.ts` — a test that the card is still sent when
  Telegram refuses the answer.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 301/301 pass (24 files)
- the new test fails when the helper rethrows, so it really covers the bug

---

## 2026-10-20 — Top trending screen: market cap, emoji, hierarchy

**Area:** ui, bot flow, tests, docs

**What changed**
- The **Top Trending** list was reformatted: a title line, a subtitle line
  (window + how GMGN ranks), a rule, then **two lines per token** — the symbol
  with its change on the first, the numbers on the second — and a footer.
- The **price is gone**; the row now shows the **market cap** (`🏦 MC`), the
  liquidity (`🧲 Liq`) and the volume (`💵 Vol`). A token price such as
  `6.8486e-5` was unreadable in a list; the market cap is the size that
  actually matters when picking a token to scan.
- The rank is a **numbered emoji** (`1️⃣` … `🔟`) and the change carries an
  **arrow** (`▲` / `▼` / `▬`) next to the signed percentage, so the direction
  survives without colour. The symbol stays bold.
- Missing numbers are left out of the stats line instead of printing `NaN`.
- The list is capped at the **top 10** tokens. The cap is applied at the
  source (`TRENDING_LIMIT`), so the API is asked for ten rows instead of
  twenty — less rate-limit weight, a shorter message and a shorter keyboard.
- The ranking is now **by traded volume**, not by the number of swaps. GMGN is
  asked for `order_by=volume&direction=desc` and the rows are sorted by volume
  locally as well, so the order holds whichever source answered. The subtitle
  says "ranked by volume".

**Why**
The first version was one dense line per token with a raw float price and no
visual hierarchy — hard to scan and hard to read on a phone. The market cap
replaces the price, and the two-line block per token makes the list scannable.

**Files**
- `src/bot/trendingFlow.ts` — new `trendingText` layout, the `RANK_EMOJI`
  table, the price dropped from the row.
- `tests/trending.test.ts` — expectations for the new layout; a test that the
  price is no longer shown.
- `README.md` — the sample output of the screen.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 290/290 pass (23 files)
- live: `/trending` renders the new layout with GMGN's live list

---

## 2026-10-20 — Profit calendar (month, week, day)

**Area:** card, core, store, bot, tests, docs

**What changed**
- New **📅 Profit Calendar** for Robinhood Chain LP positions, reached with
  `/calendar` or the **📅 Profit Calendar** button in the main menu. Three
  views, one drill-down path: **Bulan** (the month calendar with a tinted cell
  per day and a weekly `Mgg` column), **Minggu** (a diverging bar chart of the
  seven days) and **Hari** (the positions closed that day, with their pair,
  close reason, range, duration, net PnL and stored ROI).
- Every view is a 1080 x 1350 PNG in the same Receipt style as the PnL card and
  reuses its renderer, fonts and colour tokens: the shared parts moved into
  `src/card/theme.ts`, and **Inter** was added next to JetBrains Mono.
- The numbers are the finalized net realized PnL of the closed records — the
  same accounting the PnL card and `/pos` use. There is no second PnL path.
- **Days are bucketed in the user's timezone.** New setting
  `⚙️ Settings -> 🕒` (default WIB / Asia/Jakarta, plus WITA, WIT and UTC).
- **IDR uses each position's own stored close-time rate**, so an old day never
  changes when the rate moves. A position without a rate renders `N/A` and is
  left out of the win/best/worst stats. Only USD and IDR are offered; the
  toggle updates the chat's saved display currency.
- The renderer takes one JSON payload
  (`{ chain, view, period, currency, timezone, days[], weeks[], positions[], stats }`)
  and returns a PNG — all aggregation happens before rendering.
- A **daily index** (chat + timezone -> close date -> records) is kept in
  memory and rebuilt only when the chat's history changes, so a month view does
  not scan every record on every click.
- Closed records now carry the **chain** they were closed on, so another chain
  can be added later by changing only the filter and the label.
- Navigation: tabs, arrows, week/day drill-down and the currency switch all
  edit the same message. Arrows that would leave the allowed range are not
  drawn. The callback data (`cal:m:2026-10:usd`, `cal:w:2026-10-12:idr`,
  `cal:d:2026-10-17:usd`) stays well under 64 bytes and encodes the whole
  state. Rendered images are cached (past periods forever, the current one
  until a position closes) and repeat clicks are ignored while a render runs.
- The day view's position buttons open the **PnL card** of that close.

**Why**
There was no way to see *when* the profit was made, only how much. The
calendar buckets the same closed records by day, in the user's own timezone,
and renders it in the language the PnL card already established.

**Files**
- `src/card/theme.ts` — **new** — the shared canvas, tokens and SVG helpers.
- `src/card/calendarCard.ts` — **new** — the month, week and day layouts.
- `src/card/pnlCard.ts` — now uses the shared theme.
- `src/core/calendar.ts` — **new** — the daily index, the buckets, the stats
  and the navigation limits.
- `src/bot/calendarFlow.ts` — **new** — the command, the callbacks, the
  keyboard and the image cache.
- `src/constants/timezone.ts`, `src/constants/chain.ts` — **new/extended** — the
  time zones and the chain registry.
- `src/store/store.ts` — the `chain` field, the `timezone` setting, a history
  version for the cache.
- `src/core/history.ts` — captures the chain on every close.
- `src/bot/ui.ts`, `src/bot/index.ts`, `src/bot/menu.ts` — the setting, the
  command, the callback routing and the menu button.
- `assets/fonts/` — Inter added (Regular, Medium, SemiBold) with its licence.
- `scripts/preview-calendar.ts` — **new** — renders the views from real
  records.
- `tests/calendar.test.ts`, `tests/calendarFlow.test.ts` — **new** — 22 cases.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 237/237 pass (18 files)

---

## 2026-10-20 — GMGN API: trending and card candles

**Area:** core, config, bot, tests, docs

**What changed**
- The GMGN key is now used for real. New `src/core/gmgn.ts` talks to GMGN's
  OpenAPI (`https://openapi.gmgn.ai`, the service GMGN's own `gmgn-cli` uses):
  `GET /v1/market/rank` for the trending list and `GET
  /v1/market/token_kline` for the candles. The requests carry `X-APIKEY` plus
  a `timestamp` and a `client_id`.
- **The trending screen now ranks with GMGN** (`chain=robinhood`, the
  5m/1h/6h/24h toggle), with GeckoTerminal as the fallback. Verified live:
  GMGN returns a different ranking than GeckoTerminal, so the source is really
  GMGN.
- **The PnL card's chart now uses real GMGN candles.** They are captured when
  the position closes and frozen in the close record, so the card stays
  immutable; the bot's own samples are the fallback.
- The credentials are first-class config: `GMGN_API_KEY`, `GMGN_PRIVATE_KEY`
  (trading only) and `GMGN_API_URL`. They are never logged.
- New `npm run smoke:gmgn` reports what is configured and tests the API with a
  live trending call.

**Why**
The trending screen was running on GeckoTerminal because GMGN's public routes
looked unusable. They are not: the market routes are documented in GMGN's own
CLI, they support the Robinhood Chain, and the key the user had works.

**Files**
- `src/core/gmgn.ts` — **new** — the client, the trending list and the candles.
- `src/core/trending.ts` — GMGN first, GeckoTerminal as the fallback.
- `src/core/history.ts` — captures the candles at close time.
- `src/config.ts`, `.env`, `.env.example` — the GMGN settings.
- `scripts/smoke-gmgn.ts` — **new**.
- `tests/gmgn.test.ts` — **new**.

The Ed25519 key pair was generated with `npx gmgn-cli config` and lives in
`~/.config/gmgn/keypair.pem` (0600); the credentials are in
`~/.config/gmgn/.env` and a copy of the private key is in the bot's `.env`
(escaped newlines). Nothing secret was printed or committed.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 288/288 pass (23 files)
- live: `npm run smoke:gmgn` lists GMGN's Robinhood trending tokens

---

## 2026-10-20 — 0x Swap API routes the auto-swap

**Area:** core, monitor, config, tests, docs

**What changed**
- The auto-swap of a closed position's token proceeds into USDG is now routed
  by the **0x Swap API v2** (`/swap/allowance-holder/price` and `/quote`,
  `chainId=4663`), so it can use Uniswap v3, Uniswap v4 and RFQ liquidity
  instead of one hardcoded v3 pool.
- The token allowance goes to the **AllowanceHolder** contract the API reports
  (`issues.allowance.spender`, which for this endpoint is also the entry
  point). The Settler and Permit2 are never approved, and the spender has to
  match `transaction.to` before anything is approved.
- The quote is validated field by field: the tokens, the sell amount, the buy
  amount, `minBuyAmount` (used as the floor), the route, the transaction
  target, the calldata and the native value. The request carries the chat's
  slippage.
- **A swap is idempotent per closed position.** The state
  (`pending → submitted → confirmed | failed`) and the transaction hash are
  kept, and a swap that was already submitted is reconciled through its
  receipt instead of being sent again.
- The threshold is checked twice: on the position's value before any API
  call, and on the net result (the quote minus the 0x fees and the estimated
  gas) before the transaction is signed.
- The **Uniswap v3 route stays as a fallback** and is only used when the 0x
  quote failed *before* anything was submitted.
- `ZEROX_API_KEY` is read from the environment, never logged and never
  hardcoded. Without a key the bot says so and uses the v3 route.

**Why**
A token without a v3 USDG pool could not be swapped back at all, and the
hardcoded v3 router could not see v4 or RFQ liquidity.

**Files**
- `src/core/zeroXSwap.ts` — **new** — the requests, the validation, the state
  machine and the execution.
- `src/core/swap.ts` — `swapProceedsToUsdg` picks the route; the v3 code
  becomes the fallback.
- `src/monitor/exits.ts` — the close flow uses the new routing; the
  re-entry guard became `shouldAutoSwap`.
- `src/config.ts`, `.env`, `.env.example` — `ZEROX_API_KEY`.
- `scripts/smoke-0x-swap.ts` — **new** — quotes a swap without sending it.
- `tests/zeroXSwap.test.ts` — **new** — 23 cases.

**Verified against the live API** (chain 4663 is in 0x's supported chain
list): WETH -> USDG quotes through Uniswap_V3 and a launchpad token -> USDG
through **Uniswap_V4 + Uniswap_V2** — a v4 pool the old v3-only router could
never use. The allowance target and the entry point both come back as the
AllowanceHolder `0x0000000000001fF3684f28c67538d4D072C22734`, and the API
honours the requested 1 % slippage in `minBuyAmount`.

The live quote also showed that `totalNetworkFee` is in the **native token**
(wei), not in the buy token — the net-value check was corrected, and a
regression test pins both units.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 285/285 pass (22 files)

---

## 2026-10-20 — Top trending screen

**Area:** core, bot, tests, docs

**What changed**
- New **/trending** screen (and a **Top Trending** menu button) with the trending
  tokens of Robinhood Chain and a **5m / 1h / 6h / 24h** toggle.
- Tapping a token runs the **pool scan** for it — the same path as pasting the
  contract address — and every row has a **GMGN link** to that token.
- The list comes from the GeckoTerminal API the bot already uses for pool
  discovery (`networks/robinhood/trending_pools?duration=…`), so it needs no
  key and answers for the chain. The list is cached for a minute and a failed
  or rate-limited request keeps the previous list on screen.
- The GMGN JSON API is behind Cloudflare and its trending route is not
  documented, so it is not used as the source; the GMGN links are.

**Why**
Finding a token to LP into should not need a contract address.

**Files**
- `src/core/trending.ts` — **new** — the windows, the source and the cache.
- `src/bot/trendingFlow.ts` — **new** — the screen, the keyboard and the
  callbacks.
- `src/bot/index.ts`, `src/bot/menu.ts` — the command, the routing and the menu
  button.
- `tests/trending.test.ts` — **new**.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 261/261 pass (21 files)

---

## 2026-10-20 — Auto-swap minimum threshold

**Area:** store, monitor, bot, tests, docs

**What changed**
- The auto-swap of a closed position's token proceeds into USDG now only runs
  when the leftover is worth at least **$0.30**. A smaller remainder stays in
  the wallet, because the gas of the swap costs more than the swap is worth.
- The threshold is a per-chat setting (**Settings -> Swap >= $0.30**) with the
  choices $0.30, $1, $5, $10, $25 and $100. It is captured in the close
  record, so a card always shows the threshold that applied.

**Why**
Swapping a few cents of leftovers burned more gas than it was worth, and the
user had no way to change that behaviour.

**Files**
- `src/constants/autoSwap.ts` — **new** — the default, the choices and the
  normalisation.
- `src/store/store.ts` — the `autoSwapMinUsd` setting.
- `src/monitor/exits.ts` — the swap is skipped below the threshold.
- `src/bot/ui.ts`, `src/bot/index.ts` — the settings row, the picker and the
  callback.
- `tests/autoSwap.test.ts` — **new**.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 256/256 pass (20 files)

---

## 2026-10-20 — Audit fixes: correctness, safety and cleanup

**Area:** core, monitor, store, bot, tests, docs

**What changed**
- **The one-sided Spot path works again.** The range guard in the open flow
  assumed the range brackets the live price, but a one-sided range is *by
  construction* outside it, so every `quote only` / `token only` deposit was
  rejected with "Price moved outside the chosen range…". The range is now
  re-anchored instead: a range that is still valid is left alone, a one-sided
  range the price moved into follows the market (same width), and a two-sided
  range the price left is re-centred. The amounts are planned again and the
  receipt says the range moved.
- **An unknown price no longer looks like a total loss.** `valuate` turned a
  missing price feed into 0, so the PnL read as -100 % and the monitor fired
  the stop loss — closing a real position. Unknown values stay `NaN` now, and
  `decideExit` ignores them as it always intended to.
- **Setting a take-profit no longer deletes the stop loss.** The exit-rule
  patch only carries the rules the user actually mentioned; `clear` is now an
  explicit flag.
- **A failed disk write no longer disables the store.** The persist chain
  survives a rejected write instead of staying rejected forever.
- **A corrupt store file is no longer overwritten** with an empty store.
- **The auto-rebalance resolves the pool and the new range before it closes**,
  and a failed re-mint after the close is reported as "closed, capital in the
  wallet" instead of leaving a stale record that the next tick deletes.
- **The auto-swap no longer starves the auto-TP re-entry** (it skips the
  swap when the position is about to be re-entered).
- **A re-entered position keeps its card data** (entry market cap, range
  label, strategy, contract, price samples).
- **v4 dynamic-fee pools get the right pool id back**: the snapshot carries the
  pool key's static fee, so the rebalance and the re-entry work on them.
- **A dry-run revert is only excused when it really is a funding problem**;
  the old check matched the bare words "transfer" and "insufficient", so a
  honeypot or a slippage revert was reported as "this would work".
- **The history labels a pair the same way as every other screen**
  (`TOKEN/USDG`), the card and the keyboard use the chat's cycle limit instead
  of a hard-coded 3, the auto-rebalance keeps the position's age, and
  `/portfolio` adds up the PnL the bot already computed instead of
  re-deriving it.
- The compound timer is not reset when nothing was compounded, the distance to
  the nearest bound uses one denominator, a simulated exit is not repeated
  every 5 minutes, and the transaction receipt is no longer fetched twice per
  mint.
- **Cleanup:** 33 dead exports removed, 91 exports that were only used inside
  their own module made private, the dead "unsupported pools" counter removed,
  and eleven rules that existed in two places now exist once (the PnL formula,
  the pair label, the traded side of a pair, the range re-centring, the
  mint-withdrawn helper, the IDR format, the HTML escape, the Monday of a
  date, the compact USD amount, the one-sided direction and the dynamic-fee
  flag).

**Why**
The audit found two bugs that cost real money — a whole entry path that could
never mint, and a stop loss that fired on a missing price feed — plus a set of
"silently wrong" behaviours and a lot of duplicated rules that could drift
apart.

**Files**
- `src/core/pairs.ts` — **new** — the traded side, the pair label and the
  one-sided direction, used by the bot and the core.
- `src/core/math/tickMath.ts` — `reanchorRange`.
- `src/core/valuation.ts` — unknown values stay unknown; one distance
  denominator.
- `src/core/strategy.ts` — the shared re-centred range and the shared
  mint-withdrawn helper; the rebalance checks before it closes.
- `src/core/positions.ts` — the snapshot carries the pool key's static fee.
- `src/core/actions.ts` — the funding-revert check; the receipt comes out of
  the send; the wallet is checked before sending.
- `src/core/history.ts` — the normalized pair label.
- `src/monitor/exits.ts` — the auto-swap waits for the re-entry; the re-entry
  keeps the card data.
- `src/monitor/monitor.ts` — the closed-without-remint path, the compound
  timer, the dry-run exit cooldown.
- `src/bot/newFlow.ts` — the re-anchored range; the one-sided direction.
- `src/bot/positionsFlow.ts` — the exit-rule patch; the cycle limit; the
  portfolio PnL.
- `src/store/store.ts` — the persist chain; a corrupt file is not wiped.
- `src/utils/format.ts`, `src/card/format.ts`, `src/card/theme.ts`,
  `src/constants/chain.ts` — the shared formatters and the dynamic-fee flag.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 251/251 pass (19 files)

---

## 2026-10-20 — Faster monitor, faster scans, auto-detect on a pasted CA

**Area:** core, monitor, bot, config, tests, docs

**What changed**
- **Pasting a contract address now scans its pools right away** — no `/new`,
  no menu click. The message handler recognises an ERC-20 address, remembers
  it and shows the pool list, so the flow continues as before. `/scan` uses the
  same path.
- **The monitor checks positions in parallel** (bounded by the RPC gate) and
  **skips the positions that cannot do anything**: no armed rule, no
  auto-rebalance, no compound due and no alerts means no chain read at all.
  A passive position now costs zero RPC calls per tick.
- **The pool scan reads its candidate pools in parallel** and the result is
  **cached for a minute** per token, so a second paste or a `/scan` is instant.
- **The v4 pool-key recovery is ~500x faster.** The common tick spacings
  (1, 10, 60, 100, 200) are probed first — 75 hashes instead of 30 000 — and a
  recovered key is remembered per pool id. Measured: a common pool went from
  ~516 ms of blocking CPU to ~1 ms; the full sweep is now only paid for pools
  that really use an exotic spacing.
- **`/positions` reads every position once** instead of twice (the pending
  fees are summed from the views that were already loaded).
- **The three module-level caches** (prices, pools, indexer) now drop their
  expired entries instead of keeping them forever.
- The pool id encoder writes the fixed 5 x 32 byte head by hand instead of
  going through the generic ABI encoder (identical output, asserted by a test).
- `POLL_INTERVAL_MS` defaults to **15 s** (was 30 s), so Auto TP, TP/SL,
  rebalancing and the auto-swap react twice as fast. The user's `.env` and
  `.env.example` were updated to match.

**Why**
Every screen that needed the chain paid for a full scan, the monitor read
positions one after another, and the v4 key recovery burned half a second of
CPU per pool — all of it on the critical path of a user waiting for a reply
or for a take-profit to fire.

**Files**
- `src/bot/newFlow.ts` — `looksLikeAddress`, `scanPastedAddress`,
  `handleLooseText`.
- `src/bot/index.ts` — the loose-text branch, `/scan` reusing the scan path.
- `src/monitor/monitor.ts` — the parallel tick and the "needs attention" filter.
- `src/core/scanner.ts` — the parallel candidate reads and the scan cache.
- `src/core/discovery.ts` — the common-spacing fast path and the key memo.
- `src/core/pools.ts` — the hand-written pool id encoding, the cache eviction.
- `src/core/prices.ts`, `src/core/indexer.ts` — the cache eviction.
- `src/bot/positionsFlow.ts` — `/positions` reads once.
- `src/utils/async.ts` — `mapLimit`.
- `src/config.ts`, `.env`, `.env.example` — the poll interval.
- `tests/perf.test.ts` — **new** — the encoder, the key recovery, `mapLimit`
  and the address detection.
- `tests/flows.test.ts` — the pasted-address flow.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 245/245 pass (19 files)

---

## 2026-10-20 — PnL card (receipt image for a closed position)

**Area:** card, store, core, monitor, bot, tests, docs

**What changed**
- New `src/card/` module that renders a **1080 x 1350 PNG receipt** for a
  closed LP position: brand, pair, close reason, the net realized PnL as the
  hero, the ROI with the IDR (or USD) value on one line, then the trade rows
  (Entry MCAP, Exit MCAP, Initial, Received, Fees & Gas), the setup rows
  (Duration, Range, Strategy) and the footer with the short contract and the
  close date/time. A price chart is the last element.
- Rendering is SVG to PNG with `@resvg/resvg-js` and a bundled **JetBrains
  Mono** (`assets/fonts/`, SIL OFL), so the output is identical everywhere and
  needs no system fonts.
- The card is reachable: `/card <id>` and a **PnL card** button on every
  closed-position record in `/history`.
- Everything the card shows is captured **at close time** and frozen in the
  close record: the entry and exit market cap, the configured range, the
  strategy, the display currency, the USD-IDR and USD-SOL rates, the price
  samples and the range bounds in price terms.
- The monitor now records a price sample every 5 minutes (240 at most) on each
  tracked position, which is what the chart draws. Positions closed without
  samples simply have no chart — no line is ever invented.
- New chat setting **Display currency** (USD / IDR / SOL) in the settings. It
  decides the main amounts on the card; next to the ROI the other currency is
  shown, so the same number is never printed twice.
- The FX module now fetches the USD-SOL rate from the same request as the
  IDR rate.

**Why**
The bot had the numbers but no artifact to show them in. The card is a receipt
style image built from the frozen close record, so a later market move, a
setting change or a new position can never change a card that was already
generated.

**Files**
- `src/card/pnlCard.ts` — **new** — the layout, the chart and the PNG render.
- `src/card/format.ts` — **new** — currency, market cap, duration and date
  formatting for the card.
- `src/card/data.ts` — **new** — the record to card data mapping, the pair and
  reason labels, the range label.
- `src/constants/currency.ts` — **new** — the display currencies.
- `src/store/store.ts` — the new close-record and tracked-position fields, the
  `currency` setting.
- `src/core/history.ts` — captures the card data at close time.
- `src/monitor/monitor.ts` — the price sampling.
- `src/bot/newFlow.ts` — captures the entry market cap, range label, strategy
  and contract when a position opens.
- `src/bot/cardFlow.ts` — **new** — the `/card` command.
- `src/core/fx.ts` — the SOL rate.
- `src/bot/ui.ts`, `src/bot/index.ts` — the currency setting.
- `assets/fonts/` — **new** — JetBrains Mono (Regular + Bold) and its licence.
- `scripts/render-pnl-card.ts`, `scripts/preview-pnl-card.ts` — **new**.
- `tests/pnlCard.test.ts` — **new** — 21 cases.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 215/215 pass (16 files)

---

## 2026-10-20 — Compact USDG position screens

**Area:** ui, monitor, core, tests, docs

**What changed**
- The position card (`/pos <id>`) is now compact and follows one fixed shape:
  `🟢 #1 · TOKEN/USDG · Robinhood`, a status line, the range bar, the market-cap
  line, value/fees, PnL and a four-line automation summary.
- The position list (`/positions`) uses a three-line row per position:
  header, range bar, value/PnL/fees.
- New range visual `[■■■■■■■|□□□] 67% Left`: the filled cells are the part of
  the range the price traversed, the marker is the price, the empty cells are
  what is left. The percentage is the real distance to the lower bound, not a
  count of empty blocks. Out-of-range positions show `OOR LEFT` / `OOR RIGHT`
  and the distance to the nearest bound.
- Positions are numbered `#1`, `#2`, … (from the tracked id `p1`, `p2`, …) and
  the pair is always labelled `TOKEN/USDG` — the traded token first, the USDG
  quote last, whatever the pool's token order is.
- The header says `Robinhood` instead of the protocol and fee tier. Token
  prices, the price per pair, the token amounts and the cost basis are gone
  from the card.
- New market-cap line `MC $1.12M → $1.40M · now $1.30M`: the FDV at the range
  bounds and right now, scaled from the pool price. The line is omitted
  entirely when no market cap is available — a price is never substituted.
- Out-of-range and back-in-range alerts were rewritten to the same visual
  language, and the auto-rebalance state is reported as `ON` with the cooldown
  state.
- Exit notifications (auto and manual) now read
  `🎯 Take Profit · #1` / `RAETO/USDG · +40.00%` / `💰 Closed $52.40 · Fees $1.25`,
  with the re-entry line (`🔄 Re-entered as #7 · Cycle 3/3` +
  `Same range width and allocation`) only when a re-entry actually happened and
  an accurate `⚠️ Re-entry failed: …` line when it did not.
- Exit labels were re-cased: `🔒 Manual Close`, `🎯 Take Profit`, `🛑 Stop
  Loss`, `📈 OOR Take Profit`, `⚡ Auto-TP`.

**Why**
The old card was long, mixed protocol versions with prices and repeated the
cost basis, and the range was drawn as an ASCII line. The new screens are
scannable on a phone, always name the same things in the same place, and never
show a price where a market cap was meant.

**Files**
- `src/bot/ui.ts` — `positionNumber`, `positionPair`, `tradedToken`,
  `holdsOnlyUsdg`, `rangeVisual`, `marketCapLine`, rewritten `positionCard` and
  `positionRow`; the old `rangeBar`/`statusBadge` helpers are gone.
- `src/monitor/notifyText.ts` — **new** — `outOfRangeNotification`,
  `backInRangeNotification`, `exitNotification`/`exitNotificationLines`.
- `src/monitor/monitor.ts` — the alerts and the exit receipt use the new
  builders; the market cap is fetched only when an alert is sent.
- `src/monitor/exits.ts` — exit labels re-cased.
- `src/bot/positionsFlow.ts` — the list row, the detail card (with the market
  cap) and the manual-close receipt.
- `src/core/scanner.ts` — `marketCapUsd(token)` exported, reusing the existing
  FDV calculation.
- `src/utils/format.ts` — `fmtCompactUsd`, `fmtCompactDuration`, `fmtSignedUsd`.
- `scripts/preview-position-text.ts` — **new** — renders every new screen with
  fixture data (`npm run preview:text`).
- `tests/ui.test.ts`, `tests/notifyText.test.ts` — **new/updated** — formatting,
  numbering, OOR sides, exit reasons, missing market cap, escaping.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 190/190 pass (15 files)

---

## 2026-10-20 — Bid Ask LP entry strategy

**Area:** core, bot flow, store, ui, tests, docs

**What changed**
- New one-sided entry strategy **📊 Bid Ask** next to the existing
  **🎯 Spot** option (the old "single range" wording was renamed to *Spot*).
  It is offered after the user picks `USDG only` / `token only`; the
  two-sided flow is unchanged.
- New setting **⚙️ Settings → 📊 Bid Ask → Number of entries**: 4–10 entries,
  default 5, per chat, persisted in `data/store.json`. Picking a number shows
  a confirmation screen; the value is only written after **Apply**. The
  current value, the weights and the resulting percentage split are shown.
  Changing it never modifies open positions.
- Capital allocation: `allocation[i] = total × (i+1) / (N(N+1)/2)`, computed
  in integer micro-USD with a largest-remainder pass, so the allocations sum
  exactly to the requested total. Entry 1 (nearest the market) gets the
  smallest share, entry N the largest.
- Price placement: the selected range is split into N contiguous,
  tick-spacing-aligned bins. The near edge follows the live price so every
  mint stays one-sided; the far edge stays where the user put it. Leftover
  tick-spacings go to the farthest bins. Ranges that are too narrow or on the
  wrong side of the market are refused with an explanatory error.
- New preview screen listing every entry: number, allocation, percentage,
  target/mid price, bin range — plus requested vs planned total, rounding
  dust, wallet shortfall, safety flags and the number of transactions.
- Execution: N **separate** mints, one transaction each, sequential under one
  `txLock`. Each entry is re-planned against the live pool and re-validated
  before minting; the ladder stops at the first failure and reports the
  entries that were already opened. Every mint is tracked as its own
  position (`Bid Ask <TOKEN> i/N` label).
- If the entry count changes while a preview is open, the preview is
  invalidated instead of silently re-planning.
- Full range is now refused for one-sided entries (it used to produce a
  two-sided mint on a one-sided deposit).
- The Bid Ask preview shows the outer range in the pasted token's own price
  units, and the spot preview no longer prints the range bounds inverted when
  the pasted token is `token1`.

**Why**
The bot could only open one position per deposit. A ladder lets a user scale
into a pool over several entries with a progressive capital split, and the
entry count has to be a per-chat setting rather than an env var so it can be
changed from Telegram without touching the source.

**Files**
- `src/constants/bidAsk.ts` — **new** — limits, choice list, normalisation.
- `src/core/bidAsk.ts` — **new** — weights, allocations, bin placement,
  direction rules, plan builder (with an injectable planner for tests).
- `src/store/store.ts` — `bidAskEntries` setting, default/backfill/clamp.
- `src/bot/ui.ts` — settings line and button, Bid Ask submenu + apply
  confirmation, strategy keyboard, `confirmKeyboard(count)`.
- `src/bot/index.ts` — `set:bidask`, `set:bidaskSelect:N`, `set:bidAskApply:N`
  callbacks.
- `src/bot/session.ts` — `EntryStrategy`, `strategy` on the draft/range
  steps, the `strategy` step, `bidAsk` on the confirm step.
- `src/bot/newFlow.ts` — strategy step, Bid Ask preview, sequential execution
  with partial-result reporting.
- `src/bot/screens.ts` — help text mentions Spot/Bid Ask and the setting.
- `README.md` — new "Bid Ask ladders" section, flow and limitations updated.

**Verification**
- `npm run typecheck` — pass
- `npm test` — 174/174 pass (14 files; 22 new tests in `tests/bidAsk.test.ts`,
  4 new flow tests in `tests/flows.test.ts`, settings default/persistence
  tests in `tests/automation.test.ts`).

---

## 2026-10-20 — Store writes use a unique temp file

**Area:** store, infra

**What changed**
- `Store.persist()` writes to `<db>.<pid>.<seq>.tmp` and renames that, instead
  of a fixed `<db>.tmp`.

**Why**
`detect.test.ts` and `detectFlow.test.ts` both write the default
`data/store.json` from separate vitest workers. They raced on the same temp
file name and one of them failed with
`ENOENT: no such file or directory, rename 'data/store.json.tmp'`.

**Files**
- `src/store/store.ts` — `saveSeq` counter, unique temp name.

**Verification**
- `npm test` — 174/174 pass, repeatedly.

---

## 2026-10-20 — Session memory folder

**Area:** docs, infra

**What changed**
- New `memory/` folder: `README.md` (the protocol), `STATE.md` (current
  architecture and invariants), `CHANGELOG.md` (this file) and `decisions/`
  (one file per notable design decision).
- New `AGENTS.md` at the repo root pointing at the memory folder, so any
  coding agent picks up the protocol automatically.

**Why**
The project is not a git repository, so there is no commit history to read.
The memory folder gives every future session the same starting point.

**Files**
- `memory/README.md`, `memory/STATE.md`, `memory/CHANGELOG.md` — **new**
- `memory/decisions/0001-bid-ask-ladder.md` — **new**
- `AGENTS.md` — **new**

**Verification**
- Documentation only; `npm run typecheck` and `npm test` unchanged and green.
