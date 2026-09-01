# What Steam actually serves on /market and /inventory

Measured 2026-09-01 against a live logged-in account, by evaluating this repo's
own parsers in the page (bundled with esbuild, injected, run) rather than by
re-implementing them in a probe. Anything below is what the shipping code saw.

Re-run the same way when something "stops working": the difference between a
broken parser and a moved page is one afternoon, and guessing costs more.

## /market (the front page) is still the classic page

`g_rgWalletInfo`, `g_sessionID`, `g_strLanguage` and `g_rgAssets` are all
defined. Rows are `.market_listing_row[id^="mylisting_"]`, ten per page, inside
`#tabContentsMyActiveMarketListingsRows`.

- **`.market_listing_price_with_fee` no longer exists.** The price cell is
  `.market_listing_my_price` holding two lines — `81,27 руб.` over
  `(70,68 руб.)`, buyer then you-receive. `pricesFromListingRow` already falls
  through to it, and `pricesFromListingText` reads both numbers.
- **The hover blob is not inside the rows container.** Every
  `CreateItemHoverFromContainer( g_rgAssets, 'mylisting_<id>_image', <appid>,
  '<contextid>', '<assetid>', 0 )` call sits in one page-level `<script>` under
  `#responsive_page_template_content`. Parsing hovers from the rows host found
  none, and every listing came back with no assetid and no contextid — the two
  things a re-list needs. `hoverBlobOnPage()` reads the scripts instead. This
  was silent: the reprice run called every row "blind" and paged
  `/market/mylistings` to recover data the page already had.
- `GET /market/mylistings?start=0&count=10` answers `{success, pagesize,
  total_count, assets, start, num_active_listings, hovers, results_html}` —
  unchanged, and still the fallback when the DOM carries no refs.

## /inventory is still the classic page too

`g_ActiveInventory`, `g_rgAppContextData`, `g_sessionID`, `g_steamID` all
defined. Tiles are `.item[id]` with ids `{appid}_{contextid}_{assetid}`, and
each tile carries `rgItem` with `description` nested inside it — which is where
`market_hash_name`, `marketable` and `tradable` live, not on the tile object.

One change worth knowing: **Steam keeps only the current page's tiles in the
DOM** (25 of them for a 6 005-item Dota 2 inventory). It no longer renders every
page and hides the rest, so `isHiddenInventoryPage` never fires today. It stays
because it costs nothing and older layouts did exactly that, and because
`watchForRepaint` — which is what keeps the price badges alive when the user
pages — depends on nothing else being assumed about the layout.

`GET /inventory/{steamid}/{appid}/{contextid}?l=english&count=N` answers
`{assets, descriptions, more_items, last_assetid, total_inventory_count,
success}`. Unchanged.

## /market/listings/{appid}/{name} is the rewritten React page

No `g_rgListingInfo`, no `g_rgWalletInfo`, no `g_sessionID`, no
`.market_listing_row`. Everything is in `window.SSR`, and `projectSsr` reads it
correctly today — verified on two very different items:

| | thin item (a foil card) | busy commodity (Fracture Case) |
|---|---|---|
| `buckets[0].min_price` | **null** | 6021 |
| order book | maxBuy 604 · minSell 8127 · 12 buy / 2 sell | maxBuy 5965 · minSell 6021 · 3 787 454 buy / 184 607 sell |
| listing rows shipped | 1 (ours, `bMine: true`) | 0 — a commodity ships an order book, not rows |
| `itemName` | the hash itself | `G18DA243004`, the group id |
| history points | 3 | 1112 |

Two things follow. **A null bucket minimum is normal**, not an error, and the
same document states the answer in `amtMinSellOrder` — so `bucketMinimum` falls
through to the order book rather than spending a request or giving no verdict.
And **a commodity page carries no listing rows at all**, which is why the panel
must never read "no rows" as "no market".

`window.SSR.loaderData[0]` contains `strWebAPIToken`. Nothing here reads it and
nothing should: projecting it would put a live credential on the page's message
bus.

## How `QueryListingsForItem` refuses (2026-09-01)

`GET /market/actions?q=QueryListingsForItem&qp=[{appid,strItemName,filters,
accessoryFilters,propertyFilters,start}]` is what replaced `/render/`. Measured
from a logged-in page, it answers JSON **with or without**
`x-valve-request-type: queryAction`, and with the classic `X-Requested-With`
signature too — so the header is not the gate an earlier session took it for.

What it actually does under pressure is degrade in two stages:

1. **An empty book.** `200`, `{data: {total_count: 0, listings: [], more:
   false}}` — for an item whose full book it returned a minute earlier. Fifteen
   calls over about two minutes was enough; a one-minute pause restored the
   truth.
2. **The market homepage as markup**, title «Сообщество Steam :: Торговая
   площадка сообщества Steam».

Neither is an error status, and that is the trap. Stage 1 reads exactly like
«nobody is selling this», and the scanner recorded it as proof that
`strItemName` was wrong, wrote the whole app off as unnamed, and checked 0 of 10
items. Stage 2 reads as a dead endpoint.

The tell is free and certain: **we are ourselves selling the item we are asking
about**, so our own lot is in that book by definition and `total_count: 0`
cannot be true. `scanCompetitors` passes `emptyIsRefusal` whenever that holds,
and the one case where an empty book is honestly a naming problem — a hash name
on a group-id app like 730, asked before a group id has been learned — is now
stated by the caller as `nameMayBeWrong` instead of being inferred from the
reply.

Markup where JSON belongs is likewise reported to the governor as
`rate_limited` rather than as a plain error. It always was a refusal; filing it
as an error is why the pace never dropped on the way to stage 2.

## What a refusing book must never cost

Two rules follow from the above, and both were broken:

- **The verdict expires.** «The book is not answering» is a throttle, not a
  fact about the endpoint, so `BookLiveness` holds it for two minutes and then
  lets the next run ask again. As a flag only a fresh «Сканировать страницу»
  could clear, every «Догрузить цены» after one bad minute returned instantly
  and printed a refusal that had happened minutes earlier — «Запросов 0» under
  a sentence describing two replies nobody had just received.
- **The market minimum is a different endpoint.** In exact mode the price pass
  is deliberately cache-only, because the book answers better and cheaper. When
  the book is the thing refusing, that reasoning inverts: `priceoverview` and
  `search` are untouched, and they are what every SIH-shaped tool prices from.
  The run now falls back to them instead of doing nothing, which is the whole
  difference between «ничего не работает» and «посчитано по рыночному
  минимуму».
