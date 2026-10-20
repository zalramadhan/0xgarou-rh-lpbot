# Robinhood Chain LP Bot

Telegram bot that opens, closes and monitors Uniswap **v3 + v4** liquidity
positions on **Robinhood Chain** (Arbitrum Orbit L2, chainId `4663`, gas in ETH).

You paste a token contract address; the bot scans every standard v3 and v4 pool
for it against **USDG** and **WETH**, shows the fee tiers and active depth, then
walks you through range → size → confirm. After that it keeps watching the
position: out-of-range alerts, fee/PnL tracking, auto-compounding and a
one-tap rebalance.

```
/new  →  paste CA  →  pick pool  →  pick side  →  Spot or Bid Ask  →  range  →  size  →  confirm
```

## Features

| Area | What it does |
| --- | --- |
| Open | Pool discovery across v3 fee tiers and v4 pool keys (a scan takes ~2.5 s cold and is instant while the caches are warm), a range ladder of 15–85% (15, 20, 25, 30, 35, 45, 50, 55, 60, 65, 70, 75, 80, 85) or a custom price range, USD size or wallet-share sizing, an exact mint preview in market cap, slippage-protected min amounts |
| Bid Ask | One-sided ladder with 4–10 entries: the selected range is split into contiguous bins, capital is allocated 1:2:…:N (nearest entry smallest, farthest largest), and each entry is minted and tracked as its own NFT. Spot remains the one-position option |
| Close | A confirmation with the value, the fees, the PnL and the slippage a swap would use → the position is closed → you choose 🔄 Swap Token to USDG or 💎 Keep Both → and, for a swap, the route: 0x API or V3 Pool. A failed swap is reported as a failure, never as a success |
| Monitor | Value, pending fees, exact PnL against cost basis, fee APR, distance to each range bound |
| Speed | Every button answers its callback query **before** it does any work, a screen that takes a moment shows a `⏳` note, and the market cap is cached and refreshed in the background — one tap is always enough |
| Alerts | 🟢 back-in-range / 🔴 out-of-range DMs with action buttons (🔄 Refresh, 🤖 Check LP Agent, 📈 View Chart on GMGN). A master switch for both lives in the **main menu** (🔕 Range alerts off) and in **⚙️ Settings** |
| Automate | Auto-compound fees on an interval, TP/SL, ⚡ auto-TP with re-entry cycles, 📈 OOR take profit — each toggleable per position. **The rebalance is manual**: 🔁 Rebalance now closes the position and re-mints it with the same width and the same side, on the live price |
| Proceeds | 💱 optional auto-swap of closed token proceeds into USDG, routed by the **0x Swap API** (v3 + v4 + RFQ liquidity), only above a minimum amount you set (default $0.30) |
| History | 📜 every close is frozen as a record: reason, cycle, PnL in **USD and IDR** (rate captured at close) |
| Profit calendar | 📅 realized profit per month, week and day as a 1080x1350 calendar image: tinted day cells, weekly totals, a diverging week chart and the positions of a day |
| PnL card | 🖼 a 1080x1350 receipt image for every closed position: net realized PnL, ROI, market caps, the range and the price chart, rendered from the frozen close record so it never changes |
| Address book | 📒 every pasted CA is saved by symbol, searchable, one tap to scan again |
| Detect | 🔍 lists every LP NFT the wallet holds (v3 + v4) and tracks the ones that are missing, with 🤖 Check LP Agent and 📈 View Chart on GMGN links on each position |
| Wallet | 🔐 import a private key in chat → scrypt + AES-256-GCM keystore on disk, rename, unlock |
| Safety | Dry-run default, per-chat allowlist, per-chat transaction lock, slippage caps, native-ETH positions refused |

## Quick start

```bash
npm install
cp .env.example .env      # fill TELEGRAM_BOT_TOKEN and PRIVATE_KEY
npm run verify:chain      # checks every contract address against the live chain
npm run dev               # long-polling bot + monitor loop
```

Create the bot with [@BotFather](https://t.me/BotFather), then put the token in
`.env`. `DRY_RUN=true` (the default) simulates every transaction with `eth_call`
and never broadcasts. Flip it in `/settings` (or `.env`) when you are ready.

### One click

```bash
./install-shortcut.sh          # icon in the project folder, on the Desktop and in the app menu
```

The shortcut runs `start.sh`: it installs the packages if they are missing,
checks that `.env` exists, and starts the bot in a terminal window. Only one
copy runs at a time — a second click says so instead of letting two bots
fight over the same Telegram updates.

**Just paste a contract address** into the chat and the bot scans every Uniswap
pool for it and lists them — `/new` is only needed to pick a side and a size.

If `ALLOWED_CHAT_IDS` is empty, the **first chat that sends `/start` claims the
bot** and every other chat is rejected. Add ids to `ALLOWED_CHAT_IDS` to share
it with a team.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | BotFather token (required) |
| `PRIVATE_KEY` | — | Wallet that owns the positions. Empty = read-only monitoring |
| `RPC_URL` | `https://robinhood.drpc.org` | Use a dedicated provider in production |
| `RPC_URLS` | empty | Every RPC endpoint, comma or newline separated. The request goes to the **active** endpoint and stops the moment it answers — no other endpoint is probed. An endpoint that answers **429**, a 5xx, a timeout or drops the connection is put aside for a minute and the next eligible one takes over; the one that answered last stays in use. `RPC_URL` is the first one, and a list in either variable is split |
| `ALLOWED_CHAT_IDS` | empty | Comma separated Telegram chat ids |
| `DRY_RUN` | `true` | Simulate instead of sending |
| `DB_PATH` | `data/store.json` | Tracked positions + settings + history + address book |
| `KEYSTORE_PATH` | `data/keystore.json` | Encrypted wallet keystore written by `/importwallet` |
| `RPC_MAX_CONCURRENCY` | `4` | Max parallel RPC requests (public nodes choke on bursts) |
| `POLL_INTERVAL_MS` | `15000` | Monitor loop interval. Lower = faster TP/SL, more RPC calls |
| `DEFAULT_SLIPPAGE_PCT` | `1` | Min-amount tolerance on mint/close |
| `EXPLORER_URL` | `https://robinhoodchain.blockscout.com` | Tx links |
| `DETECT_USE_INDEXER` | `true` | Use the RPC's NFT index for `/detect` (Alchemy). `false` forces the on-chain scan |
| `DETECT_SCAN_LIMIT` | `4000000` | How many v4 token ids the on-chain `/detect` fallback walks |
| `ZEROX_API_KEY` | empty | 0x Swap API key; it routes the auto-swap. Without it the Uniswap v3 route is used |
| `GMGN_API_KEY` | empty | GMGN API key (queries: trending, candles). Never logged |
| `GMGN_PRIVATE_KEY` | empty | GMGN Ed25519 private key — only if GMGN should ever execute a swap |
| `GMGN_API_URL` | `https://openapi.gmgn.ai` | The GMGN OpenAPI base URL |

The PnL card is rendered with [`@resvg/resvg-js`](https://github.com/yisibl/resvg-js),
a prebuilt native module — `npm install` pulls the right binary, no system
packages are needed.

## Commands

Every screen has buttons; `🏠 Menu` on each one returns to the main menu, which is
what `/start` and `/menu` open:

```
🏠 ROBINHOOD LP BOT
Uniswap v3 + v4 · Robinhood Chain (4663)
────────────
🧪 Mode: DRY-RUN — nothing is sent
👛 Wallet: 0xa2CA…c8EB
📊 Open positions: 0
🎯 Armed exit rules: 0
📜 Closed: 0
────────────
👇 Pick an action:
```

`[🚀 Open position]` · `[📊 Positions] [💼 Portfolio]` · `[🔍 Detect] [📜 History]` ·
`[👛 Wallet] [⚙️ Settings]` · `[📒 Address book] [📡 Status] [ℹ️ Help]` — every sub-screen
edits the same message instead of posting a new one, so the chat stays one message deep.

| Command | Purpose |
| --- | --- |
| `/menu` · `/start` | Main menu with buttons |
| `/new` | Open a position: paste a token CA, pick the pool, range and size |
| `/positions` | List tracked positions with value, fees, range status and pending total |
| `/portfolio` | Totals for the whole book: value, fees, PnL, allocation per position |
| `/history` | Closed positions with reason, cycle, PnL in USD **and IDR**, paged, with a detail card |
| `/card <id>` | Renders the PnL card (receipt image) of a closed position and sends it as a photo |
| `/calendar` | Opens the 📅 profit calendar: month → week → day, in USD or IDR |
| `/trending` | 🔥 top trending tokens of the chain (5m / 1h / 6h / 24h) — tap one to scan its pools |
| `/claim` | Claim fees from every position in one action (per-position receipts) |
| `/pos <id>` | Detail panel: range bar, TP/SL, collect, close, rebalance, automation toggles |
| `/import <tokenId>` | Track an existing v3/v4 position by NFT id |
| `/detect` | Find every LP NFT the wallet holds and start tracking the untracked ones |
| `/scan <CA>` | Paged pool list: TVL, fee APR, 24h volume, price, health, sorting and filters |
| `/safety <CA>` | Buy/sell simulation, mint/blacklist bytecode checks before you commit |
| `/wallet` | Bot wallet address, ETH/USDG/WETH balances, import / rename / unlock |
| `/book` | Address book of saved token CAs: tap to scan, add, search, remove |
| `/settings` | Dry-run toggle, slippage, alerts, auto-swap, auto-TP target, default cycles, Bid Ask entry count, display currency, calendar timezone |
| `/importwallet` · `/unlock` · `/rename` | Encrypted keystore: import a key, unlock it for trading, rename the wallet |
| `/status` | RPC host, block, gas price, tracked count |
| `/cancel` | Abort the current flow |

### Top trending

`/trending` (or **🔥 Top Trending** in the menu) lists the **top 10** trending
tokens of Robinhood Chain with a **5m / 1h / 6h / 24h** toggle:

```
🔥 Top Trending · Robinhood Chain
⏱ Window 1h · ranked by volume
────────────────
1️⃣ <b>NVDA</b>  ▲ +0.4%
   🏦 MC $18.7M · 🧲 Liq $1.7M · 💵 Vol $925.6K
2️⃣ <b>UHI</b>  ▲ +6.6%
   🏦 MC $18.4M · 🧲 Liq $414.7K · 💵 Vol $595.4K
```

The list shows the **market cap**, the liquidity and the volume of every
token — the price is left out, it is noise at this level. The rank is a
numbered emoji and the change carries an arrow (▲ / ▼ / ▬) so the direction
survives without colour. The ranking is by the **volume that traded** in the
chosen window, not by the number of swaps.

Tapping a token **scans its pools** right away (the same path as pasting the
address), and the 🧭 button opens the token on GMGN. The list comes from
**GMGN** (`/v1/market/rank`, chain `robinhood`, `order_by=volume`), with the
GeckoTerminal API the bot already uses as the fallback. It is cached for a
minute and survives a rate limit with the previous list.

### The pool list

`/new` and `/scan` show every Uniswap pool the token trades in, deepest first,
five per page with `◀ Prev` / `Next ▶`:

```
Pools · 37 found (by TVL) · page 1/2
📊 Global TVL/MCAP: 0.04 🔴
1. RAETO/USDG · ⚡ Uni v4 · 5.0% fee
   💰 TVL $59.6K  ·  📈 APR 5,816%  ·  📊 24h $189.8K
   💵 Price: $0.001492
```

| Badge | Meaning |
| --- | --- |
| ⚡ | Healthy: TVL ≥ $1,000 and price within 5% of the deepest pool |
| ⚠️ | Thin (TVL < $1,000) or price 5–20% off the market |
| 🛑 | TVL < $150 — your own deposit would move the price |
| ❌ | Price > 20% away from the market: selecting it is refused |

`Global TVL/MCAP` is the token's Uniswap TVL over its FDV, dot-coloured at
10% and 30%. APR is the fee estimate `24h volume × fee / TVL × 365`. Pools are
capped at the 15 deepest that can be addressed; native-ETH v4 pools are skipped.

**Sorting and filters** live under the list: `⇅ Sort` cycles TVL → APR → 24h
volume, and `Hide ❌` drops broken-price pools. The header always names the
active sort, and pool buttons are numbered in the sorted order.

### The safety screen

Every open runs a screen before the confirmation is shown, and `/safety <CA>`
runs it on demand:

```
🛡 Token safety · RAETO
v4 USDG/RAETO
⚠️ Buy/sell simulation — round trip loses 5.2% beyond fees (via the v3 1% pool)
✅ Supply — no mint entry point found
⚠️ Controls — blacklist/burn entry points found
⚠️ Warnings only — review them, then continue if you accept the risk.
```

- **Buy/sell simulation** quotes a ~$10 buy and an immediate sell back through
the pool's quoter and compares the result with the theoretical output. More than
3% extra loss is a warning, more than 15% (or a revert on the sell leg) blocks
the open. This is how transfer taxes and honeypots are caught.
- **Contract checks** scan the token bytecode for `mint`, blacklist and
`burnFrom` entry points; a found mint or control function is a warning, missing
code is a hard fail.
- **v4 quoter fallback** — this deployment's v4 quoter does not expose
`quoteExactInputSingle`, so a v4 pool's round trip is measured on the token's
deepest v3 pool instead. A transfer tax belongs to the token, not the pool, so
the measurement still holds; the message says which pool was used.
- Nothing here is a guarantee: an unknown result is shown as `⚪`, never as a
pass.

### Finding positions you opened elsewhere

`/detect` (or the 🔍 Detect button) lists every Uniswap LP NFT the bot wallet
holds and marks the ones that are not tracked yet — one tap adds them to the
book with the same automation as a position opened through the bot.

```
🔍 Detected positions
────────────
👛 0xa2CA…c8EB
🧩 Found 684 LP NFTs · v3 31 · v4 653
📥 Untracked 12 · indexed via RPC
────────────
🟢 v4 #261 WETH/RAETO · $48.20 · 📥 not tracked
   0.0042 WETH + 12.3 RAETO
────────────
👇 Tap to start tracking one:
```

How the wallet's positions are found depends on the RPC:

- **v3** — the position manager is ERC721Enumerable, so the ids come straight
  from `tokenOfOwnerByIndex`: one call per position, on any RPC.
- **v4** — the position manager is a plain ERC721 with no enumeration, and the
  public RPCs refuse `eth_getLogs` windows wider than 10–100 blocks, so event
  scanning over a 93M block chain is not an option. The bot uses the RPC's NFT
  index (`alchemy_getAssetTransfers`, seconds) when the provider has one, and
  otherwise walks every minted id with multicall3 — exact, but minutes, because
  the chain has minted ~3.9M v4 positions. `DETECT_USE_INDEXER=false` forces
  the walk; `DETECT_SCAN_LIMIT` caps it.

A scan is cached for five minutes so a second tap does not re-walk the chain.
**🔄 Rescan** bypasses the cache and reads the chain again, rendering into the
same message. The v3 and v4 managers hand out ids independently, so `#7` of
one is not `#7` of the other — the same id in the same manager is the same NFT
and is tracked only once.

Every position screen also links out to **📈 LP Agent** (the wallet's portfolio:
value, PnL, open and closed positions) and **🧭 GMGN** (price chart for the
pool's traded token).

## Bid Ask ladders

After choosing a one-sided deposit (`USDG only` or `token only`), the bot offers
two entry strategies:

- **🎯 Spot** — the original single position across the selected range.
- **📊 Bid Ask** — split the selected range into contiguous bins and open one
  position per bin.

If the price moves while you are deciding, the range moves with it instead of
failing: a one-sided range keeps its width and follows the market (so the mint
stays one-sided), a two-sided range is re-centred on the new price, and the
receipt says so.

Bid Ask is configured in **⚙️ Settings → 📊 Bid Ask → Number of entries**. The
default is **5** and the allowed range is **4–10**; tapping a number asks for
confirmation before the value is persisted, so it survives restarts. Changing it
never touches active positions and only affects the next ladder.

The total investment is split with weights `1, 2, 3, …, N`:

```
allocation[i] = total × (i + 1) / (N × (N + 1) / 2)
```

The entry nearest the market receives the smallest allocation and the farthest
entry receives the largest. Allocations are rounded in integer micro-USD with a
largest-remainder pass, so they sum to the requested total within token
precision.

Price placement is calculated separately from capital:

- **USDG only** — bids below the market. Entry 1 is the bin closest to the live
  price, entry N is the deepest.
- **Token only** — asks above the market. Entry 1 is the bin closest to the live
  price, entry N is the highest.
- The near edge of the ladder always starts at the live price, so every entry
  stays one-sided even when the market moved after the range was picked. The
  far edge stays where you put it.
- The selected range must fit `N` bins at the pool's tick spacing and has to sit
  on the funded side of the market. A range on the wrong side is refused.
- Each entry is a separate v3/v4 NFT, so a 5-entry ladder sends 5 mints and is
  tracked as 5 positions.

The confirmation screen shows every entry's number, allocation, percentage,
target/mid price, bin range, the requested and planned totals, wallet shortfall,
safety flags and the number of transactions. If the entry count changes while a
preview is open, the preview is invalidated instead of silently re-planning.

## GMGN

The credentials live in `.env` and are never logged:

```
GMGN_API_KEY=…        # from gmgn.ai/ai — the market queries
GMGN_PRIVATE_KEY=…     # the Ed25519 private key, only if GMGN should trade
```

`npm run smoke:gmgn` prints what is configured and tests the API with a live
trending call.

GMGN's API key is bound to an Ed25519 key pair. The pair lives in
`~/.config/gmgn/keypair.pem` (mode 0600) and the credentials in
`~/.config/gmgn/.env`; the bot keeps a copy of the private key in its own
`.env` (escaped newlines) for the signed routes. To create a new pair:

```bash
npx gmgn-cli config     # generates the pair and prints a link with the public key
```

Open that link, create the API key, then
`npx gmgn-cli config --apply <api-key>` writes and verifies the credentials.
The **query** routes the bot uses (trending, candles) only need the API key.

The bot uses GMGN's OpenAPI (`https://openapi.gmgn.ai`), the same service
GMGN's own `gmgn-cli` talks to:

- `GET /v1/market/rank?chain=robinhood&interval=1h` — the **trending screen**
  now ranks with GMGN (5m / 1h / 6h / 24h). GeckoTerminal is the fallback
  when no key is set or the API is unreachable.
- `GET /v1/market/token_kline` — the **PnL card's chart** now uses real
  candles. They are captured when the position closes and frozen in the close
  record, so the card never changes afterwards.

The requests carry `X-APIKEY` plus a `timestamp` and a `client_id`; only the
trading routes would need the private key signature.

## The auto-swap route

After a **live** close, the token side of the position is swapped into USDG:

- The routing is the **0x Swap API v2** (`/swap/allowance-holder/quote`,
  chain `4663`), so the swap can use Uniswap v3, Uniswap v4 and RFQ liquidity
  instead of a single v3 pool.
- The token allowance is given to the **AllowanceHolder** contract the API
  reports (`issues.allowance.spender`, which for this endpoint is also the
  entry point). The Settler and Permit2 are never approved.
- The quote's `minBuyAmount` is used as the floor, and the request carries the
  chat's slippage (1 % by default).
- The swap only happens when the leftover is worth more than the configured
  minimum (**$0.30** by default) **after** the 0x fees and the estimated gas.
- It never runs for a position that is about to be re-entered by ⚡ Auto-TP —
  the re-entry needs those tokens — and never in dry-run.
- A failed quote falls back to the old Uniswap v3 route, but only when nothing
  was submitted. Once a transaction is sent it is reconciled through its hash
  instead of being sent again.
- Without `ZEROX_API_KEY` the bot says so and uses the v3 route.

### Closing a position by hand

A manual close is a flow, and the user decides what happens to the money:

1. 🔒 **Close** opens a confirmation: the pair, the value, the fees, the PnL,
   the market-cap range and the slippage a swap would use. Nothing is sent
   until **✅ Yes, close it**.
2. The position is closed and the user chooses what happens to the withdrawn
   tokens: 🔄 **Swap Token to USDG** or 💎 **Keep Both — No Swap**. A manual
   close never swaps on its own — the automatic swap only runs for the
   automated exits.
3. A swap asks for the route: **0x API** or **V3 Pool**. The route the user
   picked is the route that is used; a failure is not retried through the
   other one.
4. A failed swap is reported as a failure, names the token and says the
   tokens are still in the wallet only when the wallet confirms it. The close
   and the swap are two separate results.

The closed position keeps its actions: 📊 **Generate PnL Card**, ↩️ **Back to
Position** and 🏠 **Back to Home**.

```
ZEROX_API_KEY=... npm run smoke:0x -- 0xTokenAddress
npm run smoke:0x -- 0xTokenAddress --amount 1000000000000000
```

quotes a swap without sending anything: the route, the fees, the gas and the
allowance target. `--amount` (in base units) checks a route for a token the
wallet does not hold.

## Automation rules

- **TP/SL** (per position, in `%` of the cost basis): `🎯 TP/SL` on a position
  takes `30 -20`, `tp 30`, `sl -20` or `clear`. The monitor checks every tick
  and closes the position the moment a threshold is crossed — **before** any
  rebalance or compound, so a position at its target is never re-centred. The
  receipt names the rule and the realized PnL. A failed close is retried after
  5 minutes, not every tick.
- **Alerts** fire only on a range transition, so you are not spammed every poll.
- **The rebalance is manual**: 🔁 Rebalance now on the position closes it and
  re-mints it with the **same width and the same side**, on the live price. The
  close is confirmed before the re-mint is sent, and only the withdrawn tokens
  (plus a 1% buffer) are reused, so unrelated wallet balances are never
  touched. A one-sided position stays one-sided — re-centring it would need
  both tokens again, and the capital that came back from the close is
  one-sided.
- **Auto-compound** collects fees and re-adds them to the same position, at most
  once every 10 minutes and only when pending fees exceed the configured floor
  (default $1) and the position is in range.
- **⚡ Auto-TP with cycles** (per position): when the auto-TP target is hit
  (default +1% over the cost basis, changeable in `/settings`) the bot closes,
  records the exit, then **re-enters the same pool with the same width and
  size**, re-centred on the current price. Each re-entry is the next cycle; the
  cycle limit (default 3, per-position via `🎯 Cycle n/m`) stops the loop, and
  the last cycle closes without re-entering. Dry-run stops after the simulated
  close.
- **📈 OOR take profit** (per position toggle): price leaving the range on the
  *upper* side means the position converted to the quote token at a profit —
  the bot takes profit immediately instead of waiting for an idle position.
  Stop loss always wins over every take profit.
- **The range is read in the traded token's own terms.** The pool price is
  `token1 per token0`, so for a pool that stores the traded token as token1 the
  price is inverted. Every "left / right / in range" decision uses the traded
  token's price and its market cap: **OOR LEFT** is below the lower bound,
  **OOR RIGHT** is above the upper bound, **IN RANGE** is between them. The
  review screen, the position card, the list and the alerts all use the same
  numbers, so the bar always matches the market-cap line.
- **💱 Auto-swap to USDG**: after a **live** close the remaining token proceeds
  are quoted through a v3 USDG pool and swapped with the configured slippage as
  the minimum. No route for that token → the tokens stay in your wallet and the
  receipt says so.
- Every automated action is serialized per chat with the manual buttons, so two
  taps can never broadcast two transactions.

## History, IDR and the address book

- Every close — manual or automated — freezes a **history record**: pair, reason
  (manual / TP / SL / OOR TP / auto TP), cycle number, entry vs exit price, value,
  fees and realized PnL. `/history` pages through them; each record opens a detail
  card with the transaction link.
- **PnL is shown in USD and IDR.** The USD → IDR rate comes from a live FX API
  (cached for an hour) and is **frozen into the record at close time**, so a later
  FX move can never rewrite old history. No rate → shows `Rp —`, never a guess.
- **Address book**: every CA pasted into `/new`, `/scan`, `/safety` or `/book` is
  saved with its symbol (up to 50 per chat). `📒 Address book` lists them newest
  first; one tap runs the pool scan again, or `🔎 Search` filters by symbol, name
  or address fragment.

## The PnL card

`/card <id>` renders a **1080 × 1350 receipt image** for a closed position and
sends it as a photo. It is drawn from the frozen close record, so regenerating
it later always produces the same numbers.

```
🟢 0XGAROU
   — POSITION CLOSED —
   RAETO/USDG
   Auto TP · Robinhood
   +$12.50
   +8.25% ROI · +Rp 205.000
   ───────────────────────────
   Entry MCAP        $150K
   Exit MCAP         $162.5K
   Initial           $150.00
   Received          $162.50
   Fees Earned       $1.25
   Gas               $0.42
   open $0.20 · close $0.22
   ───────────────────────────
   Duration          12m 35s
   Range             -20% to -10%
   Strategy          Spot
   0x1234...abcd · 16 Oct 2026 · 14:32
   [price chart]
```

- **Net realized PnL** comes from the bot's own PnL accounting (the same number
  `/pos` shows); there is no second calculation path. The hero is the only
  place the PnL and the ROI appear. After a swap the hero is the PnL that is
  **left after every cost**, with the number from before the gas next to the
  ROI.
- **The gas is what the transactions cost**: the open, the close and the swap,
  each read from its own receipt, with a breakdown under the total. A dry run
  spent nothing and says so; a cost that could not be measured (an imported
  position has no entry transaction) says "incomplete" — an unknown cost is
  never counted as zero.
- **"Fees Earned" is a gain, not a cost**: the fees the position actually
  earned. The fee a pool charges traders is the LP's income, so it is never
  counted as a cost.
- **Currency**: the main amounts follow the chat's display currency
  (`⚙️ Settings → 💱`). In IDR mode the hero is in rupiah and the USD
  equivalent sits next to the ROI, so the same number is never printed twice.
  The IDR amount uses the **rate captured at close time**; without a rate the
  card says `N/A` instead of estimating.
- **Market caps** are the traded token's FDV at entry and at exit, scaled from
  the pool price over the range. Missing → `N/A`, never a price.
- **The chart** uses the price samples the monitor recorded while the position
  was open (one every 5 minutes, 240 at most). With no samples the chart is
  left out entirely — no line is ever invented.
- Rendering is `SVG → PNG` with [resvg](https://github.com/linebender/resvg)
  and a bundled **JetBrains Mono** (SIL Open Font License, `assets/fonts/`),
  so the output is identical on every machine.

## The profit calendar

`/calendar` (or **📅 Profit Calendar** in the menu) opens the realized profit of
every **closed** position, per month, per week and per day. Every view is a
1080 x 1350 image in the same Receipt style as the PnL card.

```
 0XGAROU                         PROFIT CALENDAR
 ROBINHOOD CHAIN · LP
 OKTOBER 2026
 +$154.50
 Hari trading 15 · Win 9/15 · Best +41.3 · Worst -14.2

 Sen   Sel   Rab   Kam   Jum   Sab   Min   Mgg
  1     2     3     4     5     6     7    W1
+12.5  -8.4   ·   +25.1  +6.3 -14.2  +31.8  +29
 ...
```

- **Three views.** `Bulan` is the month calendar with a tinted cell per day
  and a weekly total column (`Mgg`); `Minggu` is a diverging bar chart of the
  seven days; `Hari` lists the positions closed that day with their pair, close
  reason, range, duration, net PnL and stored ROI.
- **The same numbers as everywhere else.** The buckets sum the finalized net
  realized PnL of the closed records; there is no second PnL calculation.
- **Days are bucketed in the user's timezone** (`⚙️ Settings → 🕒`, default
  WIB / Asia/Jakarta). A close at 05:00 UTC is the same day in Jakarta.
- **IDR uses each position's own stored rate** (the one captured when it
  closed), so an old day never changes when the FX rate moves. A position
  without a rate shows `N/A` and is left out of the win/best/worst stats.
- **Only USD and IDR** are offered in the calendar. The toggle also updates the
  chat's saved display currency, which the PnL card uses.
- **Navigation** is limited: you cannot go past the current month, week or day,
  nor before the month of the first closed position. Every button edits the
  same message, and the images are cached (past periods forever, the current
  one until a position closes).
- The day view's position buttons open the **PnL card** of that close.

## Wallet keystore

`/importwallet` accepts a private key **in chat**, asks for a passphrase (≥ 8
characters) and stores only an encrypted keystore (`scrypt N=2^15` + `AES-256-GCM`,
file mode `0600`) — the raw key is never written to disk. `/unlock` decrypts it into
the running process, `/rename` changes its display name.

⚠️ Telegram keeps whatever you send: the bot deletes its own prompts but **cannot
delete your messages** — delete the key and passphrase messages yourself.

## How the numbers are computed

- **Pool price** comes from `slot0.sqrtPriceX96` (v3) / `StateView.getSlot0(poolId)` (v4), adjusted for token decimals.
- **Position amounts** use the exact Uniswap `LiquidityAmounts` formulas on `BigInt`.
- **Uncollected fees** use `feeGrowthInside` (v3 pool ticks, v4 `StateView.getFeeGrowthInside`) minus the position's last checkpoint, plus `tokensOwed` on v3.
- **USD value** prices each token in USDG. USDG is the chain's anchor stablecoin, so it is the USD unit. Direct token/USDG pools are preferred; otherwise the bot routes through WETH. No price feed → shows `—`, never a guess.
- **PnL** is exact against a cost basis: `principal + pending fees + fees withdrawn - capital deposited`. Compounded fees increase both the basis and the position, so PnL stays continuous and nothing is double counted. **APR** annualizes fee income (pending + withdrawn + compounded) on that basis.
- Tick ↔ price conversion uses double precision (relative error ~1e-15). Minting always uses integer ticks aligned to the pool's tick spacing, so prices are only used for sizing and display.

## Verified deployments (checked on-chain, chainId 4663)

| Contract | Address |
| --- | --- |
| Uniswap v3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| v3 NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| v3 SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| v4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| v4 StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| WETH | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` |
| USDG (6 decimals) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

`npm run verify:chain` re-checks all of these, including that
`v3PositionManager.factory()` and `v4PositionManager.poolManager()` point at the
addresses above, and that the computed v4 pool ids resolve to real pools.

## Scripts

| Script | Purpose |
| --- | --- |
| `./start.sh` | Runs the bot in this terminal — the one the desktop shortcut uses |
| `./install-shortcut.sh` | Creates the desktop/menu icon (`--remove` takes it away) |
| `npm run dev` | Bot + monitor with reload |
| `npm start` | Bot + monitor |
| `npm test` | Unit tests (math, encoding, valuation, formatting, rendering) — every worker gets a temp store, so the suite can never touch `data/store.json` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify:chain` | Live address/metadata/pool-id verification |
| `npm run simulate:actions` | Simulates collect/close against real positions and a mint, printing revert reasons |
| `npm run inspect -- <tokenId>` | Read any position through the bot's code path |
| `npm run card -- <id>` | Renders the PnL card of a closed position to `data/cards/<id>.png` |
| `npm run preview:card` | Renders the card layouts (profit, loss, IDR) with fixture data |
| `npm run preview:calendar` | Renders the calendar views from real closed records |
| `npm run smoke:0x -- <token>` | Quotes a 0x swap for a token — reads only, never sends |
| `npm run smoke:gmgn` | Reports which GMGN credentials are configured and whether the API accepts them |
| `npm run preview:text` | Renders every position screen with fixture data |
| `npm run smoke` | Store + reader + valuation + one monitor pass, no Telegram |

The simulation run is the fastest way to confirm nothing is broken after a code
change, without spending gas:

```
✅ v3 #1 decrease+collect+burn: simulated successfully
✅ v4 #1 decrease+collect+burn: simulated successfully
•  v3 0.05% mint: reverted — STF (expected: sim address has no allowance)
```

## Security

- A hot wallet key on a server is a real risk. Use a **dedicated wallet** holding
  only the capital you want the bot to manage, and never the wallet with your
  main holdings.
- `DRY_RUN=true` by default. Test the whole flow before switching to live.
- Approvals are set to unlimited for the Uniswap contracts and Permit2; the bot
  never grants allowances to anything else.
- The bot never moves funds anywhere except the configured wallet address.
- The keystore file holds the key **only** encrypted under your passphrase. There
  is no recovery: a forgotten passphrase means importing the key again.
- `.env` is git-ignored. Do not commit it; do not paste your key into Telegram.

## Limitations

- Uniswap **v3 and v4 only** (the dominant DEX on this chain). v2, UniswapX and
  other AMMs are not managed.
- **Bid Ask ladders are sequential mints**: N entries means N transactions and N
  tracked positions. A failure part-way through stops the ladder and reports the
  entries that were already opened.
- **v4 native-ETH pools** (currency = `0x0`) are read-only: the bot refuses to
  trade them because it would need to wrap/unwrap ETH.
- v4 pool scanning probes standard fee/tick-spacing keys plus the dynamic-fee
  flag with **zero hooks**. Hooked pools with custom spacing need to be added to
  `V4_POOL_CANDIDATES`.
- Positions opened outside the bot are found by `/detect`, not by the monitor:
  v4 has no on-chain enumeration, so without an indexer-capable RPC the scan
  walks millions of token ids and takes minutes. `/import <tokenId>` is the
  instant way to track one known NFT.
- Sizing a position requires both tokens in the wallet; the bot does not swap to
  rebalance ratios. Shortfalls are shown before you confirm.
- Prices come from on-chain pool state, not an oracle. Thin pools can be noisy.
- The free public RPC (`robinhood.drpc.org`) rate-limits `eth_getLogs` and
  occasionally returns "temporarily unavailable"; the bot retries transient
  errors, but a dedicated provider is recommended for 24/7 operation.

## Layout

```
src/
  chain/client.ts        viem clients, chain config
  constants/             addresses, ABIs
  core/
    math/                tick, liquidity and fee math (BigInt)
    tokens.ts            ERC-20 metadata cache
    pools.ts             v3 + v4 discovery, pool ids, prices from slot0
    prices.ts            USDG-denominated pricing
    positions.ts         position readers (v3 NFT, v4 packed PositionInfo)
    detect.ts            LP-NFT discovery for a wallet (v3 enumerable, v4 index or scan)
    valuation.ts         USD value, range distance, IL/APR
    planner.ts           USD- and wallet-sized deposits
    bidAsk.ts            Bid Ask weights, bin placement and ladder planning
    actions.ts           mint / close / collect / increase, dry-run aware
    strategy.ts          auto-compound and the rebalance
    wallet.ts            balances and approvals (ERC-20 + Permit2)
  logger.ts              compact tagged terminal logs
  store/store.ts         JSON persistence for positions and settings
  card/                  the PnL card and the profit calendar: layout, values, PNG render
  bot/                   grammY handlers, flows, formatting
    detectFlow.ts        the /detect screen: find and track untracked LP NFTs
    cardFlow.ts          /card: render and send a closed position's card
    calendarFlow.ts      /calendar: the month, week and day views with navigation
    links.ts             LP Agent portfolio and GMGN chart deep links
  monitor/monitor.ts     alerts and automation loop
  monitor/notifyText.ts  the out-of-range, back-in-range and exit messages
assets/fonts/            JetBrains Mono + Inter (SIL OFL) used by the images
scripts/                 verification, simulation, inspection, smoke test
tests/                   unit tests
```
