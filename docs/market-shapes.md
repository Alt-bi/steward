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

## Что называет предмет в строке /market (замер 2026-09-03)

Прогон `npm run probe` в консоли на /market, аккаунт с 700+ лотами, страница
показывает 10:

| | |
|---|---|
| нарисовано строк | 10 |
| разобрано лотов | 10 |
| с assetid | 10 |
| hover-ссылок из `document.scripts` | 10 |
| строк с `RemoveMarketListing(...)` в разметке | 10 |
| `hovers`-блоб | 193 064 символов, 34 скрипта на странице |
| `g_sessionID` / `g_rgWalletInfo` / `g_rgAssets` | есть / есть / есть |

Оба источника assetid живы одновременно: **кнопка отмены печатает
`RemoveMarketListing( 'mylisting', '<listingid>', <appid>, '<contextid>',
'<assetid>' )` в каждой строке**, и hover-скрипт лежит на странице отдельно, как
и записано выше. Скан не ходит в `/market/mylistings` вообще.

Это опровергло гипотезу, под которую уже был написан код (см. DEVLOG 2.37.1):
«кнопка отмены не совпадает, значит строки слепые». Мерить дешевле.

## The listing book, re-measured 2026-09-03 (live Edge, logged-in account)

Everything below was run in the page's own console on `/market`, one request at
a time, with pauses. It contradicts the section above it in three places, and
the measurement wins.

### `market/actions?q=QueryListingsForItem` does not answer this context at all

`200`, `content-type: text/html`, 1 085 499 bytes of the market homepage —
**with** `x-valve-request-type: queryAction`, **without** it, and with the
classic `X-Requested-With` signature. `res.redirected` is `false`, so it is not
a redirect either. Three tries, three homepages. This is what every scan was
ending in as «Steam дважды прислал веб-страницу».

### `market/listings/{appid}/{market_hash_name}/render/` is alive and is the book

```
?query=&start=0&count=10&currency=5&language=russian&country=RU
→ {success, start, pagesize, total_count, results_html, listinginfo, assets, currency, hovers, app_data}
```

`listinginfo` is keyed by listing id; each row carries `converted_price` +
`converted_fee` (buyer total = their sum) alongside `price`/`fee`, plus
`publisher_fee_percent` and `asset`. Our own lots appear in it and are
recognised by listing id, so the competitor minimum is exact without any
ownership flag. Latency 370–670 ms.

**`count` is a whitelist, not a number.** Same item, one request each:

| count | answer |
|-------|--------|
| 1, 10, 20, 100 | `success: true`, the book |
| 5, 11, 12, 25, 50, 75 | `success: false`, `total_count: 0`, no rows |

`scanWindow` used to return `ourCount + 10` — 11 for any item we hold one lot of
— so essentially every book request asked an unserved depth, got an empty book,
and had it read (correctly!) as Steam refusing about an item we are selling.
Two of those stop a run; four put the governor into a cooldown. Round up to the
next served size instead.

**No group-id wall.** `AK-47 | Redline (Field-Tested)` answers by
`market_hash_name`, `total_count: 1201`, 20 rows for `count=20`. The whole
`strItemName`-is-a-group-id detour existed only for the action endpoint.

**A commodity has no rows.** `Fracture Case` answers `total_count: 1` with an
empty `listinginfo`: cases and keys trade through an order book. That is an
answer, not a refusal — price those from `priceoverview`.

### `search/render` does not know card hashes

`?norender=1&appid=753&query=489260-Rock%20Golem%20(Foil)` → `total_count: 0`.
The search index does not match hash names of trading cards, so a page of cards
spends one request per group to learn nothing. `priceoverview` with the same
full hash answers `81,27 руб.` — that one works.

### Pace

Thirty `/render/` calls at 1.2 s apart (~45/min) over three minutes, none
degraded, no HTML, no 429. The global IP budget of 20/min stays the ceiling we
actually ship, because the Steam client and the user's other tabs share it.

### `mylistings` on a 669-lot account

`?start=0&count=100` answers `{success, pagesize, total_count, assets, start,
num_active_listings, hovers, results_html}` — 100 rows a page, 7 pages, ~12 s
at 1.2 s apart. That is the whole account's listing ids and prices, which is
what tells our own lot from a stranger's when the book cannot.

## Комиссия и дно рынка, измерено 2026-09-03 (кошелёк RUB)

`g_rgWalletInfo` на `/market/`:

```
wallet_fee_percent: "0.05"   wallet_fee_minimum: "87"
wallet_fee_base: "0"         wallet_market_minimum: "87"
wallet_publisher_fee_percent_default: "0.10"
```

`wallet_fee_minimum` — пол под **обеими** комиссиями, не только под своей:

```
buyer = seller + max(seller*0.05, 87) + max(seller*pub, 87)
```

Проверка на ответах самого Steam (`converted_price` + `converted_fee`):

| продавец | комиссия | покупатель | формула |
| --- | --- | --- | --- |
| 87 | 174 | 261 | дно: 87+87+87 |
| 2429 | 363 | 2792 | проценты |
| 7068 | 1059 | 8127 | проценты |
| 53845 | 8076 | 61921 | проценты |

Сто лотов `AK-47 | Redline (Field-Tested)` и десять лотов аккаунта сходятся все.
С полом в 1 копейку под комиссией издателя сходились только те, что выше дна.

`wallet_market_minimum: 87` — минимум, который может получить продавец. Значит
минимальная цена покупателя — 2,61 ₽, и ниже лота не существует.

## Чего у `/market/mylistings/render/` нет, 2026-09-03

`query=<текст>` **игнорируется**: ответ всегда весь аккаунт
(`total_count: 669`), сколько бы ни было совпадений с названием. Фильтра по
предмету нет — узнать свои лоты конкретного предмета можно только полным
обходом.

## Пагинация «Моих лотов», 2026-09-03

Кнопка следующей страницы переписывает строки через AJAX. `document.scripts`
при этом **не меняется**: hover-блок продолжает описывать первую страницу.

| после перелистывания | значение |
| --- | --- |
| строк на экране | 10 (новых) |
| `document.scripts` | 34 → 34 |
| hover-вызовов в них | 20, все про прошлую страницу |
| из них разрешаются в `g_rgAssets` | 20 |
| строк текущей страницы, покрытых блоком | 0 |
| строк с кнопкой `RemoveMarketListing` | 10 из 10 |

Читать блок без привязки к нарисованным строкам нельзя: он не дополняет их, а
добавляет чужие. Строки при этом называют свой assetid сами.

## Снятие лота, измерено 2026-09-04

`removelisting` возвращает предмет в инвентарь **под новым assetid**.

| | |
| --- | --- |
| id, который держал лот | `38179473068` |
| id в инвентаре после снятия | `39042662381` |
| `marketable` / `tradable` | 1 / 1 |

Повторять `sellitem` со старым id бесполезно: ответ «The item is no longer in
your inventory» верен и останется верным. Предмет надо найти заново.

## Кто владелец лота, 2026-09-04

`/render/` про владельца не говорит ничего: в ответе нет ни `steam_id_lister`,
ни `mylisting_` — даже когда наш собственный лот в книге есть. `results_html`
рисует кнопку `BuyMarketListing` и на нашем лоте тоже.

Зато **полная страница предмета** (`/market/listings/{appid}/{hash}`, ~90 КБ)
несёт всё сразу:

| в странице | что это |
| --- | --- |
| `var g_rgListingInfo = {...}` | та же книга, что у `/render/` |
| строки `id="listing_<id>"` | чужие лоты |
| строки `id="mylisting_<id>"` | **наши лоты этого предмета** |
| `RemoveMarketListing('mylisting', '<listingid>', appid, '<ctx>', '<assetid>')` | id и предмет каждого нашего лота |

Это ответ на вопрос «не наш ли лот держит минимум» — по предмету, за один
запрос, без обхода аккаунта.

## Пределы `/market/mylistings`, 2026-09-04

| параметр | что получилось |
| --- | --- |
| `count=100` | 100 лотов, `pagesize: 100` |
| `count=500`, `count=1000` | те же 100, `pagesize: 100` |
| `norender=1` | нет `results_html` **и нет `hovers`** — id не приходят |

Обход аккаунта укоротить нечем: 669 лотов — это семь запросов и ~3,2 МБ.

