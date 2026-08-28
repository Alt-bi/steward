# Steward

Open-source helper for [Steam Community Market](https://steamcommunity.com/market/), inventory, and trade offers.

Not SIH: no ads, no subscriptions, no telemetry. Every request goes to `steamcommunity.com`. Sources are here, unobfuscated.

[Privacy](PRIVACY.md) · [License (MIT)](LICENSE)

---

## What it does

- **Reprice** — scans your active listings, finds the competitor minimum, and relists one tick below. Listings that already hold the floor are left alone.
- **Inventory** — values what you own against the Steam market, totals it, paints prices on Steam's own tiles, and lists the selection: at the floor, under it, or with a markup. The game picker comes from the page (`g_rgAppContextData`); you do not wait for `#730_2` in the URL.
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
2. `GET /market/mylistings` in pages of 100. Data is glued from three response fields (`listinginfo` + `results_html` + `hovers`), because each one is empty some of the time.
3. Market floors are a cheap `priceoverview`, one request per unique item, cached for 2 minutes in the lookup path (the user-facing TTL is 15 minutes).
4. **Who actually holds the floor.** `priceoverview.lowest_price` counts our own listings, so:
   - a floor **below** our cheapest listing is someone else's, free of extra work;
   - a floor **equal** to ours means we are in the floor, and only then does Steward open `market/listings/{appid}/{hash}/render`, where `listinginfo` keys are listing ids. We already know our ids from `mylistings`, so the first foreign id is the real competitor minimum.
5. Target = competitor minimum − N cents, inverted through the fee function (5% Steam + 10% publisher) by binary search.
6. On the button: `removelisting` → pause → `sellitem`. Sales still need Steam Guard.

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

Steam marks **count in a window**, not the gap between calls. The scheduler is a token bucket, not a fixed sleep: the first ~18 requests leave immediately, and a pause appears only when the budget is actually spent.

| Endpoint | /min | Burst | Why |
|---|---|---|---|
| `search/render` | 40 | 10 | The market UI uses it too |
| `priceoverview` | 18 | 18 | Metered API, hard cap |
| `listings/render` | 30 | 8 | True competitor floor |
| `mylistings` / `inventory` | 12 | 4 | Heavy pages |
| `sellitem` / `removelisting` | 20 | 2 | Plus its own pause between sales |

- A 429 **halves** the allowed rate and zeroes the burst; eight successes in a row give +2/min. Classic AIMD: it converges on the limit instead of oscillating around it.
- The 429 counter decays on successes, so backoff does not stick at 15 s.
- **Six failures in a row with no success** trip the breaker — but that is no longer a scan *error*: whatever was priced is returned, the rest becomes a “Load remaining prices” button. A partial result is useful; an aborted scan is not.
- Steam's `Retry-After` always wins, and an active pause is never shortened.
- A price lives in the cache 15 minutes (configurable) and is shared across tabs, so a second scan is almost free.

The panel status shows the phase and progress. A pause is appended on the right and **distinguishes** `request budget Ns` (we are holding ourselves, this is fine) from `Steam limit Ns` (Steam refused). The popup has a log of the last 40 responses and remaining budget per endpoint.

### Where prices come from

Two sources, one result, chosen automatically.

1. **`search/render?norender=1`** — up to 100 items per request. Skins arrive as a family: `AK-47 | Redline` covers every wear and StatTrak at once.
2. **`priceoverview`** — one item, hard limit.

Search matches **display names**, not `market_hash_name`. Steam Community items hash as `296830-:CoffeeBreak:` — that query finds nothing, so the request is built from the display name. Accuracy still comes from matching `hash_name`, not the query.

Search turns itself off in two cases:

- **nothing to batch** — N items would take N queries (emoticons, backgrounds, cards), so search is an extra round trip. Straight to `priceoverview`;
- **it cannot find them** — if a sample of 6 groups matches under 30%, search is dropped and the rest is fetched one by one. That used to cost 700 useless requests.

Order matters: with hundreds of listings the **most expensive** are priced first. If Steam cuts the scan in half, the half that landed is the half with the money.

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
| Price source | market search | Batched, soft limit |
| Price freshness | 15 min | Up to 24 h. For large portfolios raise it: emoticon prices barely move |
| Parallel price requests | 4 | The scheduler still spaces them |
| One listing per item per pass | on | Otherwise several of our lots land on one price |
| Exact competitor floor | on | Extra request where we ourselves hold the floor |
| Quick-buy cap | 500.00 | Ceiling for “Buy cheapest”. Zero disables buying |

The inventory sell strategy is set on the panel — it changes from pass to pass, not once.

The popup also has Steam rate counters, remaining budget, a response log, and a cache reset.

## Tests

```bash
npm test          # 247 tests
npm run check     # typecheck + tests + build
```

Tests run the real modules against a stub environment (`test/support/env.ts`: fetch, chrome, storage, scheduler), so they cover behaviour under limits, not just arithmetic: a scan returns a partial result instead of throwing, the cache saves a request, one skin family costs one query, the scheduler does not throttle itself.

Regressions that already happened are locked in:

- parsing `1 234,56 pуб.` — a dot in the suffix was treated as the decimal mark and inflated the price 100×;
- a pause stuck at 8–15 s after every request;
- `296830-:CoffeeBreak:` as a search query — 57 requests for 4 prices;
- `DataCloneError` posting raw Steam globals from the page world. Checked by asserting `structuredClone` of the projection does not throw: Node has no DOM, but a function and a cyclic reference are equally uncloneable.

## Roadmap (from SIH, Steam-only)

- [x] Prices as badges on inventory tiles
- [x] Trade-offer analysis: side totals, highlight, lookalike swap
- [x] Quick buy on the listing page
- [x] Price-history chart (`market/pricehistory`)
- [ ] Inventory: sort, filters, bulk select on tiles, quick sell, hide listed items
- [ ] Own listings: search/filter, mass cancel, buy orders
- [ ] Trade offer inbox as a whole, not one offer at a time
- [ ] CS2: stickers, charms, Steam tags (not float)
- [ ] Badge crafting, market-history export, local inventory-value snapshots
- [ ] Auto-buy sniper — **not planned**: a purchase spends money, and each one stays a human call

## Leftovers from version 1

`legacy/` is the previous bundle with no build step (globals in `steam.js` / `panel.js`). Kept to compare behaviour. It is not shipped.

---

## По-русски

Steward — своё расширение для маркета, инвентаря и обменов Steam. Не SIH: без рекламы, подписок и телеметрии. Все запросы идут только на `steamcommunity.com`.

**Умеет сейчас:** репрайс своих лотов, оценка инвентаря и массовая продажа, антискам на странице обмена, история цены и покупка самого дешёвого лота под лимитом.

**Не будет:** цен с Buff/CSFloat/Skinport, float и paint seed (Steam их в вебе не отдаёт), SDA, автозакупки-снайпера.

Сборка: `npm install && npm run build`, затем загрузить папку `dist` на `edge://extensions`. Подробности — в английской части выше.
