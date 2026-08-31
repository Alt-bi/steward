# Steward

Open-source helper for [Steam Community Market](https://steamcommunity.com/market/), inventory, and trade offers.

Not SIH: no ads, no subscriptions, no telemetry. Every request goes to `steamcommunity.com`. Sources are here, unobfuscated.

[Privacy](PRIVACY.md) · [Development log](DEVLOG.md) · [License (MIT)](LICENSE)

---

## What it does

- **Reprice** — scans the listings Steam has already painted on this page, finds the competitor minimum, and relists one tick below. Listings that already hold the floor are left alone. Search, sorting and per-row ticking work on the scanned page for free, and the ticked rows can be taken off the market in bulk instead of repriced. Page the Steam table and scan again for the next batch.
- **Inventory** — values the items currently visible in Steam's grid, totals them, paints prices on those tiles, and lists the selection: at the floor, under it, or with a markup. It does not walk the whole backpack. Search, filters, sorting and bulk ticking work on what is already priced, so narrowing a page of two hundred stacks costs no requests; Ctrl+click on a tile picks or drops that single copy, and a single stack can be listed on its own. The game picker comes from the page (`g_rgAppContextData`).
- **Buy orders** — on the market home page: every standing order, how much of the wallet each is holding, and — on request — how far each one sits from the current market minimum. Orders can be cancelled in bulk.
- **Price levels** — anywhere a price is set, the target can be the cheapest competitor *or* what the item has actually been selling for: the volume-weighted average of the last week, month, or year. Pricing against the market walks it down a kopeck at a time; pricing against last month's average is how a listing moves **up** and waits. Available in the repricer, in the inventory's sell strategy, and shown as a ladder on the item page.
- **Offers** — on the trade-offer list: every offer at once, what leaves and what arrives, which are held in escrow, which take items and give nothing back. On request it names the items and prices both sides, so the one offer worth opening can be found without opening thirty. It never accepts or declines anything.
- **Trade** — on an offer page, prices both sides, shows the gap, and flags what is wrong: a lookalike swap, invisible characters, mixed alphabets in a name, unmarketable items, a lopsided value.
- **Item** — on a listing: current lots, a sales-history chart, 30-day average and floor, a cheaper/dearer verdict, liquidity, and a one-click buy of the cheapest lot under a hard cap.

## What it will not do

Steward is a SIH *alternative*, not a SIH clone. These stay out on purpose:

| SIH feature | Why Steward will not |
|---|---|
| Prices from 28 marketplaces | Needs a backend and affiliates. Steward is Steam-only. |
| Float / paint seed / float rank | Steam does not put them in the web inventory. Getting them means a third-party inspect API or the Game Coordinator. |
| Steam Desktop Authenticator | Storing a shared secret is a ToS and account-risk problem. |
| Auto-buy sniper | Spending money is a human decision. One-click buy with a cap, yes. A loop that buys, no. |
| Ads, subscriptions, telemetry | The point of the project. |

CS2 still gets wear from the hash name, rarity/collection from Steam `tags`, stickers and charms from item `descriptions`, and Inspect in game. Just not a float number.

---

## Install (unpacked)

```bash
npm install
npm run build
```

Then `edge://extensions` → **Developer mode** → **Load unpacked** → the **`dist`** folder (not the repo root).

Or: `powershell -ExecutionPolicy Bypass -File install-edge.ps1`

During development `npm run watch` rebuilds `dist/` on every change — then hit Refresh on `edge://extensions` and reload the Steam tab.

```bash
npm run typecheck
npm test
npm run check    # typecheck + tests + build
```

## How it works

1. `page-bridge.js` (MAIN world) hands the extension `g_sessionID`, `g_rgWalletInfo`, `g_rgAssets`, `g_rgAppContextData` — without that, `sellitem` cannot be built.
   It sends a **projection**, not the raw objects: `postMessage` structured-clones its argument, and Steam's inventory objects hold DOM references, so a raw `g_rgAppContextData` dies with `DataCloneError`. Only named fields are copied (`src/page/project.ts`), which also shrinks a large inventory by orders of magnitude. `postMessage` itself is wrapped: a clone failure must not escape into the page.
2. Active listings come from the DOM Steam already rendered (`#tabContentsMyListings` / the current My listings page) — the endpoint is never paged. The one thing the markup does not always carry is **which asset a listing holds**: the classic market writes it into `CreateItemHoverFromContainer(...)` on every row, other layouts do not. Without it a listing can be cancelled but not re-listed, so one `GET /market/mylistings` (this page only, no pagination) fills them in. That single request does a second job: it returns the **complete set of our own listing ids**, and `total_count` says whether it really was complete. Without that, a lot priced exactly like ours cannot be told from our own lot on the next page. A listing whose asset is still unknown is never planned — `removelisting` would succeed and `sellitem` could not. Inventory prices come from the visible grid (`rgItem` / `g_rgAssets`), not from fetching every unique hash in the backpack. That is how SIH stays inside Steam's IP budget.
3. **Our own prices are never requested.** They are in the row markup Steam already painted (`market_listing_price_with_fee` / the Beta cell), so the only thing worth a request is what somebody *else* is asking.
4. **Who actually holds the floor.** `priceoverview.lowest_price` counts our own listings, so a floor equal to ours settles nothing — and Steam caches that number for hours, so «equal to ours» is often yesterday's market. `market/listings/{appid}/{hash}/render` answers exactly, for the same one request: `listinginfo` is keyed by listing id, and we know our own ids. So with the exact floor on, the order is **cache → the listing book**, and nothing else runs. The book always answers: one request, one item settled. `search` only *sometimes* answers — it settles an item when a competitor happens to sit below us, and returns nothing when it cannot match the name — so spending a scarce IP budget on it first is backwards. The unsettled items are read dearest-first, because a run Steam cuts short should have settled the listings worth money.
   - a floor **below** our cheapest listing is someone else's — the cheap pass settles it and no listing page is opened;
   - anything else — a floor equal to ours, or no price at all — goes to the book. The window scales with how many lots of that item are ours, because a fixed ten was full of our own cases before a competitor could appear.
   - the answer is recorded as **checked** (`sole` — nobody is down there with us) or **unchecked** (`ours`, `no-price`). Only the first is good news, and the panel counts them separately.
5. Target = competitor minimum − N cents, inverted through the fee function (5% Steam + 10% publisher) by binary search.
6. On the button: `removelisting` → pause → `sellitem`. Sales still need Steam Guard.
7. Mass cancel is the same `removelisting` without the second half, and buy orders go through `cancelbuyorder`. Both stop at the **first** refusal from Steam rather than waiting out a pause and continuing, and both say how many they had done by then. Steam takes a cancelled listing or order off the page immediately, so nothing is re-read afterwards — the row says what happened to it.

8. The offer list draws items as pictures: a tile carries only `classinfo/{appid}/{classid}/{instanceid}`, and the name arrives when you hover. Valuing an inbox therefore needs one `economy/itemclasshover` per **distinct class** — the only place in the extension that asks Steam about something the page did not already say. A class is immutable, so answers are kept in `chrome.storage.local` forever and a second inbox is nearly free. Before a large run the panel says how many unknown items there are and roughly how long that will take, because a user who is told «this is 300 requests» can decide and a user watching a progress bar cannot.

9. **Levels.** `market/pricehistory` returns every recorded sale, and the three averages come off it. It is the strictest endpoint Steam has — about six a minute — so it is never automatic: a button, a count, an estimate in minutes, and a confirmation above a dozen items. Answers are kept for six hours, because a thirty-day average does not move in an afternoon. A window longer than the history is refused rather than answered: the «yearly average» of a three-week-old case is its three-week average, and calling it a year is a lie the user would price against. So is an average built on fewer than three sales.

## Architecture

```
src/
  core/         types, money, fees, settings, message protocol
  background/   service worker: request scheduler + price cache (IndexedDB)
  steam/        transport and Steam endpoints (run in the content script)
  content/      on-page panel and feature registry
    features/   one folder = one feature
  page/         MAIN-world bridge to window.g_*
  popup/        settings and rate-limit counters
```

The important decision: **one frequency scheduler for the whole browser**. Every request asks the service worker first (`net/acquire`); the worker says “go” or “wait N ms”; every result is reported back (`net/report`). 429 and `success:false` raise the pause, successes lower it. Two market tabs no longer rate-limit each other. The requests themselves stay in the content script: only there do they have the page cookies and Referer the market endpoints expect.

Scheduler state survives worker eviction (`chrome.storage.session`). The price cache survives a tab reload (IndexedDB, shared across tabs).

### Rate limits

Steam publishes no quotas. What it actually meters is **count from one IPv4 in a window**, shared with the Steam client, other tabs, and other extensions. A 429 is often an HTML 200 page saying “too many requests”; `priceoverview` often answers `{success:false}` instead. Hitting the limiter during a ban extends it (hours, not seconds).

The scheduler is two token buckets: a **global IP budget** wrapping every call, plus a per-endpoint ceiling so a sell loop cannot starve price lookups.

| Kind | /min | Burst | Why |
|---|---|---|---|
| **IP (all of them)** | 20 | 6 | The real limiter |
| `search/render` | 20 | 4 | Batch families; default source |
| `priceoverview` | 15 | 4 | Metered API; SIH held 20 |
| `listings/render` | 10 | 2 | Competitor floor, only when ours is the minimum |
| `pricehistory` | 6 | 1 | Heavy, button only |
| `mylistings` | 6 | 2 | One call per scan: asset ids, and which listings are ours |
| `inventory` | 10 | 2 | Fallback only, in pages of 2000 (ASF's cap) |
| `pricehistory` | 6 | 1 | The strictest of them. Never automatic; cached six hours |
| `itemclasshover` | 20 | 5 | What an offer's items are; each class paid for once, ever |
| `sellitem` / `removelisting` | 8 | 1 | 50–100 in a row is how people get 2–24 h bans |

- A 429 **does not retry**, and the **first** one opens the breaker. Cooldown starts at 30 s (SIH's number) and `Retry-After` wins. Waiting out a pause and then sending the rest of a scan is how a 30-second microban becomes hours, so nothing restarts by itself: every button asks `allowSteamTraffic()` first and says how long is left.
- `{success:false}` on a price is **not** “this item has no market”. Those keys stay unresolved so “Load remaining prices” can pick them up.
- Eight successes in a row give +2/min (AIMD). An active pause is never shortened.
- A price lives in the cache 15 minutes (configurable) and is shared across tabs, so a second scan is almost free.
- Sales pause 2.5 s between items by default. The scan concurrency default is 2.

The panel status shows the phase and progress. A pause is appended on the right and **distinguishes** `request budget Ns` (we are holding ourselves, this is fine) from `Steam limit Ns` (Steam refused). The popup has a log of the last 40 responses and remaining budget per endpoint.

### Where prices come from

Two sources, one result, chosen automatically.

1. **`search/render?norender=1`** — up to 100 items per request. Skins arrive as a family: `AK-47 | Redline` covers every wear and StatTrak at once.
2. **`priceoverview`** — one item, hard limit.

Search matches **display names**, not `market_hash_name`. Steam Community items hash as `296830-:CoffeeBreak:` — that query finds nothing, so the request is built from the display name. Accuracy still comes from matching `hash_name`, not the query.

Search turns itself off in two cases:

- **nothing to batch** — N items would take N queries (emoticons, backgrounds, cards), so search is an extra round trip. Straight to `priceoverview`;
- **it cannot find them** — if a sample of 6 groups matches under 30%, search is dropped and the rest is fetched one by one. That used to cost 700 useless requests.

With the exact competitor floor on (the default), the repricer uses neither of these: it reads the cache, then goes straight to the listing book, because that is the only request that answers every time it is spent. Both sources stay in use for the inventory, the offers tab and buy orders, where the market minimum *is* the answer.

A scan covers **this Steam page only** — typically ~10 listings or ~25 inventory tiles, not hundreds of unique hashes. Page Steam's own pager and scan again. Cached prices make a second page cheap.

The two mass actions are aimed differently, on purpose. **Reprice** moves every ticked overpriced listing, shown or not — otherwise the number on the button would change with the search box. **Cancel** takes only the ticked rows *on screen*: it is the action a user aims with a filter («everything that says Copenhagen 2024, off the market»), so the visible set is the set.

What happens *after* the prices land costs nothing: the inventory search, the filters (`marketable`, `priced`), the four sort orders and the bulk ticking all run over the prices already in hand. Selection is stored as «everything priced except what you unticked» — of whole stacks in the panel, and of single copies on the tiles — so «Load remaining prices» adds the newly priced stacks without quietly re-ticking what you dropped. Picking happens on **Ctrl+click** because a plain click is Steam's own: it opens the item. Only dropped copies are marked on the grid; a full selection leaves Steam's inventory looking untouched. There is no «hide listed items» because Steam takes a listed item out of the inventory grid itself — there is nothing left to hide.

### Trade checks

On `/tradeoffer/*` a separate MAIN-world bridge (`trade-bridge.js`) runs: slot contents live in `g_rgCurrentTradeStatus`, but that is only ids — names, hashes and flags live on `UserYou` / `UserThem`. The join is only possible in the page world, so it lives there. The bridge watches the offer version and resends a snapshot when items are dragged.

Checks, all on pure functions:

| Signal | Level | How |
|---|---|---|
| Invisible characters in the name | danger | zero-width, soft hyphen, bidi switches |
| Letters from another alphabet | danger | Latin mixed with Cyrillic or Greek |
| Lookalike swap | danger | the name collapses to the same string (homoglyphs, case, punctuation, Levenshtein) and the price is half or less |
| Not marketable | warn | it will not become money |
| Value imbalance | danger / info | gap over 20% of the larger side |
| Unknown prices | warn | totals are incomplete, and that is said outright |

If a lookalike's price could not be checked, the level drops to warn. Accusing without a number is not allowed.

### Price levels

Four targets, one implementation (`src/core/levels.ts`), used by three features so the number a user reads on the item page is the number the repricer will aim at:

| Level | What it is |
| --- | --- |
| market | The cheapest listing that is not ours |
| avg7 / avg30 / avg365 | Volume-weighted average of recorded sales over that window |

Two rules keep an average from becoming a bad price:

- **an average is never taken below the market.** If the month's average is under what somebody is asking right now, listing at the average is a discount nobody asked for. The target is clamped up to just under the cheapest competitor, and the row says that is what happened;
- **a window longer than the history is not an average.** Steam happily serves three weeks of sales for a three-week-old case; averaging them and calling it a year is how a user prices something at a number that never existed. Same for fewer than three recorded sales.

A level target also means repricing can move a listing **up**, which the old planner could not express — «are we already the cheapest» is not a question when the target is an absolute price. `planMove` sorts by distance in either direction; `planDrop` still only counts cuts.

### The offer inbox

The list page says everything except the one thing that decides the verdict: **which side is yours**. Steam marks the two blocks `primary` and `secondary`, which is layout, not meaning — and reading them backwards would turn a robbery into a bargain on screen. So the side is worked out in three layers, and how it was worked out is kept:

1. **the avatars** — each block links to a person, and one of them is the partner from the offer header. This is the only signal that means anything;
2. **the header text** — «You will receive» / «Вы получите», one translation away from breaking;
3. **`primary` / `secondary`** — a guess, and marked as one. An offer decided this way carries a visible «could not tell which side is yours» on its row.

What gets flagged: an offer that takes items and returns none; a value gap where you get under half of what you give; escrow; items arriving that cannot be sold on the market; sums that are incomplete because a price is missing. Every flag is a pure function over the two item lists.

There is **no mass accept and no mass decline**. An offer moves items out of an account for good, the side detection is a heuristic, and a button that acts on a heuristic in bulk is how a mistake becomes irreversible. Each row is a link to the offer; the decision stays with the user.

### Item page

`market/pricehistory` returns every recorded sale. Two wrinkles are fixed on the way in and never leak: dates arrive as `"Jul 25 2016 01: +0"`, and prices are floats in wallet units instead of the integer cents the rest of the code uses.

- Averages are **volume-weighted**: a day with one sale does not weigh the same as a day with a hundred.
- The verdict uses the **30-day** average, not all time: an item that crashed six months ago is not “cheap” today. Under 85% of the average — cheaper than usual; over 110% — dearer. Fewer than three sales in a month — “not enough to judge”, no invented percentages.
- The chart is our own SVG, no libraries. A long series is folded by **bucket averaging**, not sampling, so a spike does not vanish depending on where a bucket edge fell. Volume is summed, not averaged — no sale is dropped.

### One-click buy

The only call in the project that spends money, so it defaults to refusal. Before anything is sent:

- the amount does not exceed the **quick-buy cap** in settings;
- the cap is set and greater than zero;
- `subtotal + fee` equals `total` exactly — a parse bug must not become a purchase;
- the price is sane and a listing id exists.

Then a `confirm` with the real numbers and a reminder that the money leaves now. Exactly one listing per click: nothing retries, loops, or buys the next lot by itself.

There will be no sniper. Each purchase stays a human decision.

### Adding a feature

1. `src/content/features/<name>/index.ts` — implement `Feature` and call `register(...)`.
2. Import the folder from `src/content/index.ts`.
3. If it does not live on `/market/*`, add the URL to the feature's `matches` and to `content_scripts` in `src/manifest.json`.

Panel, statuses, tabs, scheduler and cache come for free.

## Settings (extension icon)

| Setting | Default | Why |
|---|---|---|
| Pause between relists | 1600 ms | Steam bans on frequency, not volume |
| Below competitor | 1 ¢ | How far to undercut |
| Price source | market search | Batched, soft limit. Not used by the repricer while the exact floor is on |
| Price freshness | 15 min | Up to 24 h. For large portfolios raise it: emoticon prices barely move |
| Parallel price requests | 4 | The scheduler still spaces them |
| One listing per item per pass | on | Otherwise several of our lots land on one price |
| Sell strategy (panel) | by market minimum | Also: below, above, or by the week/month/year average |
| Exact competitor floor | on | Reads the listing book instead of guessing from `priceoverview` — and *replaces* it, rather than adding to it |
| Quick-buy cap | 500.00 | Ceiling for “Buy cheapest”. Zero disables buying |

The inventory sell strategy is set on the panel — it changes from pass to pass, not once.

The popup also has Steam rate counters, remaining budget, a response log, and a cache reset.

## Tests

```bash
npm test          # 611 tests
npm run check     # typecheck + tests + build
```

Tests run the real modules against a stub environment (`test/support/env.ts`: fetch, chrome, storage, scheduler), so they cover behaviour under limits, not just arithmetic: a scan returns a partial result instead of throwing, the cache saves a request, one skin family costs one query, the scheduler does not throttle itself.

Regressions that already happened are locked in:

- parsing `1 234,56 pуб.` — a dot in the suffix was treated as the decimal mark and inflated the price 100×;
- a pause stuck at 8–15 s after every request;
- `296830-:CoffeeBreak:` as a search query — 57 requests for 4 prices;
- `DataCloneError` posting raw Steam globals from the page world. Checked by asserting `structuredClone` of the projection does not throw: Node has no DOM, but a function and a cyclic reference are equally uncloneable;
- `3 hours ago` in a listing row read as the price 3,00 ₽, and the Market Beta cell `0,05€ (0,03€)` glued into €50.03;
- repricing a listing with no assetid: `removelisting` succeeds, `sellitem` cannot, and the lot is gone from the market. Such listings are refused at planning time now;
- `cancelbuyorder` answering `{"success":8}` read as a success — the order was still there while the panel said the money was back. Only `1` counts now;
- four copies of the same «what Steam said» switch, already drifted apart, so one refusal read differently in each tab (`src/content/ui/errors.ts`);
- an item description cut short by a regex looking for the closing brace — `Sticker | {LOL}` ends the object early. The hover payload is walked with a brace counter that respects strings;
- an unreadable hover answer cached as «no such item», which would have made the mistake permanent. Only real answers are kept;
- a **tie read as a win**: our lot and a stranger's at the same price scored as «we already hold the minimum», and the lot sat there — at equal prices Steam sells the older listing first. A shared floor is now something to undercut, but only once Steam has confirmed the full set of our own listings, or it would be bidding against ourselves;
- a fixed window of ten listings answering «no competitor» for anyone holding ten lots of the same case;
- «no overpriced lots on this page» printed over items that were never checked, because a stopped scan left them looking like ordinary skips;
- a «yearly average» computed from a three-week-old item's whole history, and an average built on two sales. Both are refused by name now;
- **four search misses read as a ban.** `search/render` answers `success:false` when it simply cannot match a name — routine, and the whole reason the hit-rate guard exists — but the circuit breaker counted those toward the same streak as a `priceoverview` throttle and blocked the scan. Search misses no longer feed the breaker;
- the optional pass running before the mandatory one: five search requests spent, zero items settled, and Steam cut the scan off before the listing book was ever opened.

## Roadmap (from SIH, Steam-only)

- [x] Prices as badges on inventory tiles
- [x] Trade-offer analysis: side totals, highlight, lookalike swap
- [x] Quick buy on the listing page
- [x] Price-history chart (`market/pricehistory`)
- [x] Inventory: search, filters, sorting, bulk select, quick sell of one stack
- [x] Inventory: pick single copies on Steam's own tiles (Ctrl+click)
- [x] Own listings: search, sorting, per-row select, mass cancel
- [x] Buy orders: what they hold, distance to the market, mass cancel
- [x] Trade offer inbox as a whole, not one offer at a time
- [ ] CS2: stickers, charms, Steam tags (not float)
- [ ] Badge crafting, market-history export, local inventory-value snapshots
- [ ] Auto-buy sniper — **not planned**: a purchase spends money, and each one stays a human call

## Leftovers from version 1

`legacy/` is the previous bundle with no build step (globals in `steam.js` / `panel.js`). Kept to compare behaviour. It is not shipped.

---

## По-русски

Steward — своё расширение для маркета, инвентаря и обменов Steam. Не SIH: без рекламы, подписок и телеметрии. Все запросы идут только на `steamcommunity.com`.

**Свои цены не запрашиваются** — они уже нарисованы на странице; запрос уходит только за чужими. Пропуск с пометкой «не проверено» отличается от пропуска «проверил, мы одни на минимуме», и «оверпрайса нет» больше не печатается поверх непроверенных лотов.

**Уровни цен:** цель можно поставить не только «подрезать конкурента», но и «средняя за неделю / месяц / год» — по этим ценам предмет реально продавался. Лот тогда может уехать **вверх** и подождать. Средняя никогда не опускается ниже текущего рынка, а «средняя за год» у предмета трёхнедельной давности не считается вовсе. История продаж — самый медленный запрос Steam, поэтому она качается только по кнопке, с честно названной ценой в запросах и минутах, и живёт в кэше часами.

**Умеет сейчас:** репрайс своих лотов с поиском и массовым снятием, заявки на покупку (сколько заморожено и насколько далеко от рынка), разбор всего списка обменов сразу, оценка инвентаря и массовая продажа, антискам на странице обмена, история цены и покупка самого дешёвого лота под лимитом.

**Не будет:** цен с Buff/CSFloat/Skinport, float и paint seed (Steam их в вебе не отдаёт), SDA, автозакупки-снайпера.

Сборка: `npm install && npm run build`, затем загрузить папку `dist` на `edge://extensions`. Подробности — в английской части выше.
