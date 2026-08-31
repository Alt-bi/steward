## 2.21.1 — reprice learns the group id itself

## 2.22.1 — one history ritual, two tabs; trade stops colonising the inbox

`loadHistory()` was copy-pasted
between Inventory and Reprice — the same gate, the same cost warning, the same
progress text, fifty lines each, already drifting apart in wording. New
`steam/history-load.ts` owns the ritual: unknown-count, confirm above twelve,
traffic gate, resolve, outcome. Tabs keep their own status lines (the reprice
wording is sharper about bans and stayed); they just stop maintaining the
machinery. Cached-everything is its own case — no prompt, no gate, free.

Bug found while comparing the copies: Trade matched `/tradeoffer` as a prefix,
which also matched the inbox `/tradeoffers/` — two tabs mounted side by side
on the same page, both claiming offers. Trade is now `/tradeoffer` only.
## 2.22.0 — wear on the tiles (SIH parity, one request instead of a queue)

The one CS feature SIH had and we did not: the float value on an owned
copy. SIH fetches it per item through its own server, a queue and a
click — and it reads the numbers off Steam's own dialog rather than
asking Steam.

Probing the live site found the endpoint the inventory page itself uses:
`/inventory/{steamid}/{appid}/{contextid}/itemdynproperties/{assetid}`
replies with Wear Rating, Pattern Template and Paint Seed for every copy
in the context, no matter which assetid sits in the path (verified 2026-08:
5 copies answered from one call; comma-lists and the bare path either 404
or hit the duplicate-action guard). One request decorates a whole screen.

New `steam/floats.ts` owns the endpoint; the scan loads wear after the
prices, on the owner's own page only, and caches it for the page's life —
a float belongs to an asset forever, so re-scans are free. Chips paint on
the tile's top edge (`float 0.381`, `float 0.15–0.381` when the stack
differs) where the price badge never sits. It rides the `inventory`
budget kind; a refusal decorates less, it never fails the scan.

Five tests pin the shape of the answer — including «no wear is an answer,
not a failure», because a crate has no float and must not look broken.


The bucket fact was proven but unreachable: `priceAndPlan` runs the exact pass
with `cacheOnly`, so search never fires before the book, and a CS skin with no
previously learned id hits `unnamed` and gets skipped — for every user who has
never run a price search with the panel open. The fix is a recovery step inside
the exact worker: when the store holds no group id for a 730 item, `learnGroupForItem
` fires one `search/render` by the stripped name and takes the `market_bucket_group_id`
off the row whose hash matches exactly — a sibling wear teaches nothing, because
the row we did not ask for is a guess with one thing wrong in it.

A learned id persists in the naming store, so the search costs one request per
item across the whole life of the install, not per scan. Throttled or markup
search replies are not a failure to wear: the worker keeps its unknown, which is
what it had before the request existed. Three over-the-wire tests cover the wire:
the exact-row match, the near miss, and the blocked acquire.

Stays at one search per item per pass: batching would collapse a CS portfolio to
one request, but the answer needs the exact hash anyway, and a family query that
404s would black out five wears at once.


## 2.21.0 follow-up — the bucket question, closed by live evidence

The React Query cache inside the rewritten item page gave the game away: the
frontend queries `QueryListingsForItem` with `strItemName` set to the GROUP id
(`"G1807209A023004"`), not the wear name. Replayed live against our signed
endpoint the group id answers with the full book — `total_count` 1652, first
lot 230000 cents — where every name-based form answers zero. Not a ban, not
anonymity: grouped CS items simply do not answer to `market_hash_name`.

That is exactly the chain 2.21.0 already carries — `search/render` (live,
200, real counts) hands out `market_bucket_group_id` per row, `learnGroups`
stores it keyed by hash, `scanCompetitors` asks the book by the learned id
and filters `market_name_inside_group` down to our wear. Both legs of the
chain now verified against the user's signed-in tab. No code change needed;
the version stays 2.21.0.

Still open: legacy `market/myhome` with session still returns the page (it
is no longer a JSON endpoint); the mylistings flow must keep using the DOM/
SSR sources.
# Development log

What changed, why, and how it was found. Newest first.

The rule for an entry: a bug gets written down with the *mechanism*, not the
symptom, and with what proved it — a live capture, a failing test, a
measurement. An entry that says "fixed a bug in pricing" is worth nothing to
whoever reads it in a year. This log starts at 2.15.0; earlier history is in
`git log`.

Prose here is English, to match the rest of the repo. The UI is Russian.

---

## 2.21.0 — the endpoint signs its own traffic, and so must we

The evidence-based verdict from 2.20.3 arrived with the smoking gun: the page
served in place of JSON was titled «Сообщество Steam :: Торговая площадка
сообщества Steam» — the market **homepage**, not an apology, not a proxy
interstitial, not a robot check. A redirect to the market home is what the
rewritten frontend serves to a request it does not recognize as its own.

That also explains why every cookie-less probe from this machine answered
200 with 200 KB of JSON while the logged-in tab kept getting markup: the
legacy handler still answers unsigned requests, the new one does not. Three
versions of "the endpoint is fine, actually" were all true and none of them
was the user's session.

The frontend's own bundles carry the answer. Its action helper signs every
GET to `/market/actions` with `x-valve-request-type: queryAction` (POSTs send
`mutationAction`), sends `qp` with the filter objects the page keeps in
state — `filters: {}, accessoryFilters: {}, propertyFilters: {}` — and no
`country`/`currency` params. No `X-Requested-With`: the classic AJAX mark is
not the frontend's signature, and sending it marks the request as foreign.

`fetchListingBook` now copies that shape verbatim, header included. `net.ts`
gained an `ajax: false` opt-out for callers chasing endpoints the new
frontend owns, tested to prove the legacy mark stays off the wire. The live
probe with the copied shape answered 200 JSON on the first try.

One honesty note: this was diagnosed from outside the session — the fix is
verified against the endpoint's behavior (probe + tests), not yet against
the user's logged-in tab. The next live scan is the real gate.

The gate passed on 2026-08-31. A signed-in profile driven over CDP replayed
the copied shape verbatim: `QueryListingsForItem` answered 200 with clean
JSON in ~350 ms, full structure (`more` / `start` / `total_count` /
`listings` / `facets`) — no homepage markup anywhere. The soft-ban-versus-
markup question this line of versions chased is closed: with the frontend's
own signature the rewritten handler answers properly, signed-in or not.

What the live session opened instead is the bucket question. Even signed-in,
a name-keyed `QueryListingsForItem` answers `total_count: 0` for grouped CS
wears (AK-47 | Redline (Field-Tested), bare and wear-suffixed alike), while
ungrouped items answer sensibly (Mann Co. Supply Key → 1). And the item page
never calls `/market/actions` itself — it renders its rows from the SSR
embed, so there is no live frontend request to copy from the page. Finding
how the real frontend asks for a grouped item's book is the next task; the
place to look is a market *search* run, where `market_item_search` does hit
the endpoint live.

628 tests green; typecheck and build green.

---

## 2.20.3 — the page that replaces JSON gets to name itself

2.20.2's honest wording produced an honest report back: two markup pages, the
new message verbatim, three requests spent. That report confirmed the build was
live and the diagnosis loop was working — but it also proved the message was
still not specific enough to act on.

Probes again before code, five more shapes through the browser's own path:
the book answers JSON for a real group id, for a bogus group id, for a hash
name Steam does not know, with stale cookies, and with four different Referer
values. Nothing sent from a cookie-less session draws markup. Whatever the
tab is being served depends on the logged-in session — a check on the browser
itself, a market-account gate, or a ban that follows the real profile rather
than the curl one.

Guessing a fourth theory was the wrong move, so the error now carries its own
evidence: `not_json` captures the page's own title (or visible text, one line,
script/style stripped, clipped at 80 chars — `markupNote`), the liveness
breaker keeps the last one, and the «дважды веб-страница» verdict prints it
verbatim. The next report states which page was served.

Tests: `markupNote` x3 (title, text fallback with script/style removed, clip),
BookLiveness keeps the note, restart clears it.

---

## 2.20.2 — the sorry-page spoke Russian and the classifier did not

The same «Steam больше не отдаёт книгу лотов» verdict returned on the first
live run of 2.20.1, with the same 0-of-10, 2-requests shape. Before touching
code, the endpoint was probed from this machine on the browser's exact path —
through the Happ proxy (exit IP 147.90.89.72), three requests back-to-back,
correct `X-Requested-With` headers, stale cookies included: `HTTP 200,
application/json, 216 KB, total_count 1657` every time. The book was not dead
on either exit IP.

The remaining way to reproduce the old wording was an apology page the
classifier misses — and it was sitting in plain sight. `RATE_LIMIT_BODY`
matched Russian only as `сделали слишком много запросов`. The market's actual
sorry copy says «Слишком много запросов с вашего IP-адреса», without
«сделали». English matched, Russian did not, the soft ban fell through to
`not_json`, two of them tripped the liveness breaker — and the panel blamed
the endpoint. The fix matches stems that survive any phrasing of the apology
(`слишком много запросов`, `превышен(а|о) лимит/частота`), tested against the
verbatim RU copy. When the ban is recognized it routes to the rate-limit path:
cooldown, honest «Steam отказал», resume button — instead of a death story.

Also: the panel title now carries the manifest version (`Steward 2.20.2`).
Two bug reports this session were plausibly one stale build and one real bug,
and nothing on screen told them apart. A version in the corner makes that
check the user's, in one second, instead of an archaeology dig.

623 tests green; typecheck and build green.

---

## 2.20.1 — one markup page was not a death sentence for the endpoint

The first live run of 2.20.0 ended early and reported:

```
Steam больше не отдаёт книгу лотов по этому адресу — точную проверку
конкурентов сделать не могу. Посчитано по рыночному минимуму: 0 из 10.
Запросов 2.
```

Ten items to check, two requests spent, and a sentence that blamed Steam for
something Steam was not doing.

### The endpoint was alive; we proved it an hour later

Probing `QueryListingsForItem` with the same qp shape the scan uses, from this
machine, on the same day:

```
GET /market/actions?q=QueryListingsForItem&qp=[{"appid":730,
    "strItemName":"AK-47 | Redline (Field-Tested)",...}]
HTTP 200 | application/json | 215469 bytes
{"data":{"more":true,"total_count":1652,"listings":[{"listingid":"55465934…
```

A full book, 1652 rows. The claim «no longer serves the book» was a local fact
about a local flag.

### The flag nobody could clear

`resolveExactLows` caught `not_json` — an HTTP 200 whose body was markup — and
set `exactEndpointGone = true` at module scope. Everything after the first such
answer stopped asking, and nothing in the module ever set the flag back to
false: not the next scan, not the answered book, not the page reload if the tab
survived. The other eight items were never requested and were reported in the
past tense anyway.

Two HTML answers had come back in the live run — plausible sources: the user's
HTTP proxy (Happ) interstiting one request, or Steam returning its sorry-page
in a shape `isSteamRateLimitBody` does not recognize (that matcher knows two
phrasings, not all of them). Both are weather. The code treated weather as an
execution.

The distinction the code now keeps, in `BookLiveness` (plan.ts, pure, unit-
tested): one markup page is noise; two in a row with nothing good between them
is a pattern worth stopping on; one answered book wipes the streak; and every
new scan clears the verdict — pressing «Сканировать» is the user asking whether
it is back, and the old answer is exactly what they want re-checked.

One honest trade: a *genuinely* gone endpoint now costs two probes per scan
instead of zero. That is the price of never lying about an alive one, and the
probes carry the budget's own pace.

### Proof

- 622 tests (was 618), `npm run check` green.
- The live probe above is the counterexample the old behavior failed: same
  hour, same endpoint, healthy answer.
- New `BookLiveness` suite: one markup does not stop the run; two do; an
  answer between them resets; `restart()` clears a dead verdict.

---

## 2.20.0 — the group id, learned for free

The 2.19.0 session left one honest gap: on appid 730 the exact-competitor scan
was dead forever. `QueryListingsForItem` answers `total_count: 0` to a
`market_hash_name` — every skin lives under an internal group id — so the scan
reported `unnamed`, the app joined a session blocklist, and those lots fell back
to market minimums until the tab was reloaded. The name Steam answers to existed
(«G1807209A023004» was verified against the live account in 2.15.0) but nothing
fetched it, and nothing remembered it.

### Where the name comes from

Two sources, both already paid for:

- **Search answers.** The `market/search/render` rows the repricer already reads
  for prices carry `asset_description.market_bucket_group_id`. Steam hands the
  id out whether we want it or not; now `groupIdsFromResults` picks it up and
  `fetchMarketLows` posts it to the worker's naming store after every batch.
- **Grouped item pages.** A rewritten page names its own focus
  (`ItemMarketQueryString.strItemName` = the group id) and ships the bucket list
  of every wear under that group. The listing tab now records
  `bucket hash → group id` for the whole list when it opens such a page.

Both are stored via new `naming/get|set|drop` RPC into a second IndexedDB store
(`srp-naming`, no TTL) — facts about Steam's naming, not market state, so they
outlive the price cache.

### What the scan does with it

`resolveExactLows` asks the naming store before each exact scan:

- a learned id is passed to `scanCompetitors` as the name to ask the book with,
  with the real hash kept as the client-side row filter — the scan that used to
  be permanently `unnamed` becomes exact again;
- an app already on the `unnamedApps` blocklist is no longer skipped wholesale:
  items that carry a learned id still get scanned;
- `unnamed` *with* a learned id means the id went stale — it is dropped from the
  store and the app is marked unnamed again, so a dead fact cannot masquerade as
  a live one.

A group book without our wear in the window (`total_count` far from zero, zero
rows of ours) reads as «unknown», not «nobody is under us» — the same honesty
rule the window has always had.

### Proof

- 618 tests (was 611), `npm run check` green: new suites cover
  `groupIdsFromResults` (rows with and without the id, an id equal to the hash,
  a missing answer), the search→store learning round trip, and
  `scanCompetitors` asking the book under the internal name with the wear filter.
- What no test can prove yet: that a live CS2 scan picks the id up and comes
  back exact. The 2.15.0 capture of the qp shape (`strItemName` group id +
  filters) and the `asset_description` row shape say it will; the first live run
  against the account settles it. The summary line now says so: open the item's
  page once and the exactness returns.

### Still open

- Wear filters (`buckets[].filters`) could narrow the group book server-side so
  the twenty-row window stops mixing wears; deliberately not built — client-side
  filtering is correct, filters only buy window quality, and they add a stale-
  filter failure mode that would look exactly like a stale group id.
- Unverified live shapes remain: `rgBuyOrders` on the item page, `/market/`
  buy-order rows, `/tradeoffers/` per-offer selectors — the account holds no buy
  orders and no pending offers to capture.

---

## 2.19.0 — the repricer could not have worked, and nobody had asked it to

Opened the account's own market page instead of reasoning about it, and the first
measurement stopped the session: `mylistings` no longer answers in any shape this
code knows.

### `mylistings` returns none of the four fields we read

Captured 2026-08-29, `GET /market/mylistings?start=0&count=10` on an account
holding 761 listings:

```
success  pagesize  total_count  assets  start  num_active_listings  hovers  results_html
```

No `listinginfo`. No `listings`. No `listings_on_hold`, no `listings_to_confirm`.
Steam went back to sending a page of markup, the assets that markup draws, and
the block of `CreateItemHoverFromContainer(…)` calls that ties the two together.

Two consequences, and the second is worse than the first.

**The assets vanished.** The hover block is now the only statement of which asset
a listing holds — and the market page itself no longer carries one either: on the
live page not one row has an `onmouseover`, and `g_rgListingInfo` is an empty
object. So every listing came out of `assembleListings` with `assetid: ""`, and
every reprice plan died at `нет assetid — нельзя выставить снова`. The whole
feature. 2.16.0's write staging is the only reason that was a refusal to start
rather than 761 lots taken off the market and left there.

**And it counted as Steam stonewalling.** `isEmpty` looked for the JSON shapes,
found none, and marked a perfectly good 200 as a soft throttle — so the answer
was thrown away, four of them in a row opened the circuit breaker, and the panel
reported Steam refusing when Steam had answered in full.

That is the **fourth** time this codebase has made the same mistake, and the
third distinct endpoint: `listings` in 2.15.0, `pricehistory` in 2.17.0,
`mylistings` twice — once when `listinginfo` became `listings`, and now. The rule
was written down each time and each time as a rule about *that* payload. So it is
now stated the other way round, which is the way that generalises: **an answer
that states a count is an answer, whatever the count says.** An account with
nothing listed is entitled to say so, and only a reply that names nothing at all
— no count, no rows, no hovers — is Steam declining to speak.

`hovers` is parsed by `parseHovers`, which has been in this file since the
beginning and was already the classic market's source for the same fact. Nothing
new had to be invented; the payload just had to be read.

### A write sent with a dead session was read as a success

`fetchRaw` has always checked for `g_steamID = false` — Steam's own marker on a
logged-out page. `postForm`, which carries every call that changes something,
never did. Steam does not fail a POST from an expired session; it answers 200
with the login page.

`removelisting` then read it through this:

```ts
try { json = JSON.parse(body); }
catch { /* a non-JSON 200 is a normal success for this endpoint */ return; }
```

An empty 200 really is this endpoint's success, and that case is handled a line
earlier. What fell into the catch was everything else — a login page, an
interstitial — and it was reported as a lot successfully taken off the market.
`cancelbuyorder` had the same catch, where the false success reads as *your money
is back*.

Both now raise it. Which of "it went through" and "it did not" is true cannot be
known from here, so it is raised as not knowing: `describeRelistFailure` already
had that category for a dropped connection, and `not_json` and `bad_json` join
`network` in it. A delist whose outcome is unknown ends the run, because the next
step would begin by taking another lot off the market.

### Two bulk loops had their own halt rule, and both were missing a case

The reprice loop stops on a refusal that is about the account rather than the
item — rate limit, breaker, no session. The buy-order cancel loop and the
inventory sell loop each had their own copy, and both listed only the rate
limits. So a session that expired part-way through kept firing writes at an
endpoint that could not accept a single one of them, once per remaining item, to
the end of the list.

`haltsRun` and `outcomeUnknown` are now one rule in one place, used by all three.
Both loops also stopped calling an unknown outcome an error: a `sellitem` whose
reply never arrived may well have listed the item, and «ошибка» sends the user
looking in the inventory for something that is on the market.

### Measured and found fine

- `economy/itemclasshover` still answers, still wraps its description in
  `BuildHover(…)`, still carries `market_hash_name`. It also carries
  `market_listing_bucket_group_id` — a second source for the group id the 2.15.0
  entry wanted, alongside the one in search results.
- `QueryListingsForItem` answers a plain hash name for appid 753: `total_count: 1`,
  `more: false`, one row, `bMine: true`. The exact competitor check works as
  written for community items; it is Counter-Strike that needs the group id.
- Community items are not grouped. Their assets carry `market_bucket_id`
  (`B318680-2`) but no `market_bucket_group_id`, and their market URL is the hash
  name itself.
- `/market/` still defines `g_rgWalletInfo`, `g_sessionID` and `g_rgAssets`, fee
  fields included. The rewrite has not reached it.

### Not done

Group-id resolution for appid 730 (see 2.15.0), now with two known sources for
the id. `myOrders.rgBuyOrders` on the item page, the `/market/` buy-order rows
and the `/tradeoffers/` per-offer selectors all remain unverified — the account
holds no buy order and no pending offer. Fee percentages on the rewritten item
page.

611 tests, typecheck clean.

---

## 2.18.0 — the panel had every number and told the reader to press the button

Two of these came out of one afternoon on the live market. The rule that keeps
paying: open the page and look at what Steam actually shipped, rather than
reasoning about what it probably ships.

### On a grouped page the focused wear is usually not in the book at all

Measured on `/market/listings/730/G1807209A023004`, 2026-08-29. Steam ships
twenty listing rows for the group and focuses the page on one wear:

```
focus                       AK-47 | Redline (Minimal Wear)
20 shipped rows             13 Battle-Scarred, 7 Well-Worn
rows for the focused wear   0
```

Minimal Wear costs six times what Battle-Scarred does, so it is nowhere near the
group's twenty cheapest lots. This is the ordinary state of a grouped page, not
an edge case — the panel's own filter to the focused wear comes back empty on
most CS items — and it is a state 2.15.0 deliberately created, by filtering the
mixed book down to the wear on screen.

What it ran into was a guard that predates all of it:

```ts
if (!state.listings.length) {
  rows.appendChild(el("div", "stw-empty", "Нажми «Посмотреть цену»."));
  return;
}
```

So a user pressed the button, the panel read the page, computed the price from
the bucket, the thirty-day average, the verdict, the ladder and the chart —
drew all of them — and then, underneath, told them to press the button. The
liquidity line, which lives below that guard, was never drawn on a grouped page
at all.

The empty-rows sentence now depends on which of three situations it is: nothing
has been read yet, the page priced this item but sent no individual lots for it,
or the market really is empty. Those are three different facts and only the last
one means "you cannot sell this". `describeNoListings` is pure, so which sentence
belongs to which situation is asserted rather than eyeballed.

### The demand side was sitting in the page, unread

The same capture turned up a query the projection walked straight past:

```
["market","orderbook",730,"AK-47 | Redline (Minimal Wear)"]
  amtMaxBuyOrder 1510670   amtMinSellOrder 1510688
  cBuyOrders       2 641   cSellOrders           74
```

and on a case, `["market","orderbook",730,"Fracture Case"]` — 6205 against 6250,
with 3 815 419 buy orders behind 176 590 lots.

Everything this extension shows is the sell side: what the cheapest lot asks,
what the item has been going for. None of it answers the question a holder
actually has, which is what they would get if they wanted out today. The highest
standing buy order answers it exactly — it pays the moment a lot is listed at it
— and Steam hands it over for free, on the page, for the item in focus.

`PlainItemPage.orders` now carries it and the panel prints one line: both sides,
the spread in money and as a share, and how many orders stand on each. Both
halves of the spread are needed because neither means anything alone — 0,18 ₽
between the sides is a rounding error on a 15 000 ₽ rifle and a fifth of the
price on a cheap sticker. An absent side is null, never a price of zero.

Steam only asks about the focused item, so `orderBook(hash)` answers null for
every other item of the group. That is the honest answer and not a zero.

### A quiet week was reported as "this item has no sales history"

`levelValue` returned `missing: "no-history"` whenever a window's average came
back null. But the average is null exactly when no sale falls inside *that
window*, which an item with twelve years of history and a slow week satisfies —
and the sentence the user then read was «нет истории продаж», which says Steam
has never heard of the thing. The opposite of the truth, at the moment they are
deciding what to ask for it. Split into `no-sales`, with its own words.

### Measured and found fine

`historyFrom` in the projection keeps 400 days and caps at 1200 points, and the
cap looked like it would bite on a busy item, whose recent history is hourly.
It does not: Steam thins its own series to daily beyond roughly two weeks, so
the four wears of the Redline hold 5256, 4890, 4801 and 4578 points across
twelve years and only 1083, 717, 628 and 415 of them inside 400 days. Nothing is
truncated, and `spanDays` stays honest for every window the ladder offers.

### Not done

`myOrders.rgBuyOrders` on the item page is projected nowhere — the shape is
unverified because the account holds no buy order to look at, and the same is
still true of the `/market/` buy-order rows and the `/tradeoffers/` per-offer
selectors. Group-id resolution for appid 730 (see 2.15.0). Fee percentages on
the rewritten item page.

588 tests, typecheck clean.

---

## 2.17.0 — the rewritten page defines none of the globals we were reading

Session spent measuring the live market rather than reasoning about it, which
turned out to be the right call: two of the four findings below are things that
*look* like they work.

### `pricehistory` answers for a group id, with a chart about no item that exists

Measured, 2026-08-29, on the live endpoint:

```
market_hash_name=G1807209A023004  ->  200, success:true, 894 points
```

`G1807209A023004` is the AK-47 Redline *group*. The series it returns mixes ten
items — four wears, two Souvenir, four StatTrak — and its median sits at ~4085 ₽,
between the Battle-Scarred floor (2657 ₽) and the Minimal Wear one (16175 ₽).
Plausible in every way and about nothing.

2.15.0 taught the listing panel to resolve a group id to the wear the page has in
focus. What it did not do was decide what to do when that resolution *fails* —
buckets empty, a fallback naming an item the page did not price — and the answer
it fell into was to ask `pricehistory` with the group id. Before this measurement
that looked safe, because the assumption was that it would fail.

`isItemOnPage()` now gates the request: buckets and histories are what the page
keys by hash name, and if it keys anything at all and none of it matches, the
name is not an item here. The panel says so in those words and computes nothing,
instead of drawing a confident chart for a group. A page that keys nothing by
hash — the classic market page — is unaffected and still asked directly.

### The rewritten item page has no `g_rgWalletInfo`, and we were guessing roubles

Also measured, on the live page. All of these are `undefined` there:

```
g_rgWalletInfo   g_strCountryCode   g_sessionID   g_rgAssets   g_rgListingInfo
```

and the `steamCountry` cookie is not readable from script. So on **every**
rewritten item page, `currencyId()` fell through to its hardcoded `5` and
`country()` to its hardcoded `"RU"`, for every user on earth.

For a rouble wallet that is invisible. For anyone else it is not, and the failure
is a quiet one: `search` ignores the `currency` parameter and answers in the
user's real wallet (already documented in `live-shapes.test.ts`), while
`priceoverview` and `pricehistory` honour the one we send. A dollar wallet
therefore got dollar minimums from search and rouble medians from history, both
written into one cache under one key — and a verdict comparing the two.

The page does carry its wallet, in its own query cache under
`["CurrentUserWalletDetails", <accountid>]`: `currency_code`,
`wallet_country_code`, `user_country_code`. `projectSsr` now projects currency and
country from there, and `page-context` consults the page when no global said
otherwise. A real `g_rgWalletInfo` still wins — the classic pages have it and it
is the better source — and a wallet once learned is never unlearned, because it
is a fact about the user rather than about the item.

Fees are still `DEFAULT_FEES` on such a page: `CurrentUserWalletDetails` carries
no `wallet_fee_percent`. That is a real gap, but the item panel does not price
anything for sale, and repricing happens on `/market/`, which still defines the
global.

### Two more consequences of the same root

- **The bridge's settle-poll could never fire on the rewritten page.** It waited
  for `window.g_sessionID` alongside the payload, and there is no `g_sessionID`
  there — so a page that finished hydrating after `document_idle` was simply
  never re-read. `window.SSR` is now sufficient on its own.
- **`waitForPage` always waited out its full four seconds there**, because the
  promise it races resolves on the first session id from the bridge, which never
  arrived. It now also resolves on an item page. Buying was never broken: the
  session id comes from the cookie, which is present.

### An item that has never sold was asked about forever

Same endpoint, the other shape. Measured: a name Steam does not know answers
**HTTP 500** with `{"success":false,"price_suffix":"руб.","prices":false}`, and a
name it knows answers 200 with an array. So `success:false` is unambiguous, and
an empty array is Steam saying "no recorded sales" — an answer.

`isEmpty` counted the empty array as a refusal, which threw, and a thrown answer
is never cached. So an item with no sales was re-asked on *every* scan, on the
endpoint the governor rations hardest at six calls a minute — and four of them in
a row opened the breaker and stopped the whole run. Now the empty series is
summarised, cached for six hours like any other, and reported as "no sales
history" rather than as Steam refusing.

This is the third instance of the same mistake in this codebase (`listings` in
2.15.0, and `mylistings` before that): **a well-formed zero counted as a
stonewall.** The rule that holds in every case: only a reply that is not the
shape Steam promised is a refusal.

### Not done

Group-id resolution for appid 730 (see 2.15.0). Fee percentages on the rewritten
item page. `buy_orders` rows and `/tradeoffers/` selectors remain unverified for
want of data on the account.

576 tests, typecheck clean.

---

## 2.16.0 — writes that stop half-way, and a worker that woke up blind

Four fixes. Two of them are about the extension changing something on the
account and then telling the user the wrong thing about it.

### A lot could come off the market and never go back on, reported as "ошибка"

Repricing is two writes: `removelisting`, then `sellitem` at the new price. If
the first succeeded and the second failed, the item sat in the inventory, off
sale — and the row said `ошибка: …`, the same words used for a lot that had not
been touched at all. The run then carried on to the next item and did it again.

The dangerous half is the second one. Whatever stopped the relist — Steam
refusing, a dead session, a reply we could not parse — is almost certainly about
the next lot too, and each further step *starts* by taking a lot off the market.
A hundred ticked rows is the panel clearing the account's market page one call at
a time, while the summary counts "ошибок: 100".

`describeRelistFailure` in `src/content/ui/errors.ts` now classifies by which
part of the write was in flight:

- `before` — our own guards (no assetid). Nothing was sent; the run continues.
- `removing` — Steam answered and refused, so the listing is exactly where it
  was. The run continues, unless the refusal is one that is certainly about the
  next item too (rate limit, breaker, no session).
- `relisting` — the lot is off the market. Says so in those words, names the
  item, and ends the run.

A listing that sells mid-run makes `removelisting` fail with Steam's own answer,
and that must not end a reprice of two hundred — which is why "Steam said no" and
"we do not know" are kept apart rather than folded into "the write failed".

### A write that never came back was reported as if Steam had answered

`postForm` did not wrap `fetch`. A dropped connection threw a bare `TypeError`
past the governor — no outcome reported, no kind to reason about — and the loop
called it an ordinary error. For a read that is fine; the request cost nothing.
For a delist it is the one case where **what Steam did with it is unknown**, and
calling that "ошибка" is a guess about the user's own inventory.

`ErrorKind` gained `network`; `fetchRaw` and `postForm` both raise it; and a
`network` failure during the delist reads "неизвестно, снят ли лот" and stops the
run. Reads are unaffected — `fetchJsonRetry` still treats it as retryable.

### The service worker could wake up and fire straight into a live ban

`hydrate()` set `hydrated = true` **before** awaiting `chrome.storage.session`.
A content script wakes the worker with a burst of `acquire` calls in one tick;
the first started the load, and every other one sailed past the flag and spent a
fresh, empty budget while the cooldown the previous worker had recorded was still
being read off the disk. That is six requests into a live Steam pause — precisely
what the whole governor exists to prevent, and Steam refreshes the IP block on
every hit during one.

The load is now memoised as the promise rather than as a flag, so callers queue
behind the real read.

Two supporting changes were needed to see it at all:

- `scheduler.forget()` — drops the in-memory copy, which is what a killed worker
  does. Every other entry point marks the state loaded, so the code that runs on
  *every* worker wake-up had never once been reached by a test.
- The test stub's `chrome.storage.session.get` now resolves on a later turn of
  the loop instead of instantly. A real storage read crosses a process boundary;
  a stub that answers in the same microtask hides this entire class of bug, and
  did — the first version of the regression test passed against the broken code.

### `decodeJson` tore the bracket off a top-level array

It skipped to the first `{`, so `[{"a":1}]` became `{"a":1}]` and a perfectly
good answer was reported as `bad_json`. Nothing we call today answers with an
array; the point is that the junk-stripper must not be the reason the first one
that does looks like a refusal.

### Not done

Group-id resolution for appid 730 (see 2.15.0) is still unbuilt. The `buy_orders`
row shape and the `/tradeoffers/` per-offer selectors are still unverified — the
account has neither a standing buy order nor a pending offer to check against.

562 tests, typecheck clean.

---

## 2.15.0 — the market rewrite, and three things it quietly broke

Valve replaced the item page with a React app that ships its own state in
`window.SSR`, and `/render/` — the endpoint that used to hand over the listing
book — now answers with the page itself. `QueryListingsForItem` is the
replacement, reached through `GET /market/actions?q=<Op>&qp=<JSON array>`.

### `count` is decoration, and "nobody is under us" was a fiction

Measured, not assumed: asking for 1, 10 and 100 all answered with **twenty** rows
and `more: true`. The `crowded` flag — "the book was cut off, a competitor may
not have fit" — compared rows received against rows requested. A seller holding
twenty-plus lots of one item asked for thirty, got twenty, all of them theirs,
and the panel reported "checked, nobody is under us" with an entire book sitting
below.

Steam states `more` outright, and it now decides. The window heuristic is kept
only for the classic page, which hands over whatever it drew and says nothing
about the rest. This also fixes the inverse: a complete book of twenty rows
against a request for ten is no longer re-asked forever.

### The panel was blind on every grouped market page

`/market/listings/730/AK-47 | Redline (Field-Tested)` **redirects** to
`/market/listings/730/G1807209A023004`. What is left in the URL is the group id,
which is no item's hash name — and buckets, book rows and histories are all keyed
by hash name. So the panel found nothing, then paid for a listings request the
page already held, then paid for a `pricehistory` request (the most rationed
endpoint we touch), and presented the group's cheapest lot — a Battle-Scarred one
— as this page's price, with a working buy button, against an empty history.

The page names both facts itself: `listingQuery.strItemName` is the string Steam
queries the book with, and `initialSelectedBucketID ?? initialFallbackBucketID`
is the item on screen. `focusedItem()` resolves them, the fetched book is
filtered to that wear, and the status line says which wear it took — numbers
about an item the user did not name are only honest next to its name.

### `total_count: 0` proves the *name* wrong, not the market empty

All of appid 730 now lives under group ids, including a plain `Fracture Case`
(`G18DA243004`), so a hash-name book always comes back empty. We only ever scan
items we are ourselves selling, and our own lot is in that book by definition —
so zero lots cannot mean "nobody is selling".

Worse, the empty reply was counted as a soft throttle: `isEmpty` threw, the
governor saw four `empty` in a row, and the whole scan backed off. Every CS item
did this. Now only a reply with no `data` block at all is Steam declining to
speak, `CompetitorScan.unnamed` carries the fact, and a module-level set makes it
cost one request per app instead of one per item per scan.

The first version of that check was dead code — the exception fired before the
caller ever saw `total_count`. There is a regression test for it now.

### Found, recorded, not built

The book can be narrowed to one wear:

```
qp: [{appid, strItemName:"G1807209A023004", start,
      filters:{"Quality":["normal"],"Exterior":["WearCategory2"]}}]
```

Values must be **arrays** — a bare string returns zero lots. The pairs are in
`buckets[].filters` on the item page, and the group id arrives free in the search
results already fetched for prices
(`results[].asset_description.market_bucket_group_id`).

That is enough to restore exact competitor checks for CS. It needs a persistent
store for group ids and filters — the IndexedDB price cache holds numbers only —
and plumbing through search → prices → reprice, which is a feature, not a fix.
## End-to-end replay on a live account (2026-08-31)

The whole SIH pipeline was replayed in-page through CDP on the signed-in
bot tab — same fetches, same selectors, the extension itself never
launched — and the two independent sources of one number were cross-checked.

- `mylistings` still answers the JSON envelope of 2026-08-29: 729 active,
  100 rows in `results_html`, prices in the nested-span shape under
  `market_listing_my_price` (no `price_with_fee` classes present at all).
  The fallback chain in `pricesFromListingRow` priced 100 of 100 rows;
  the chain is load-bearing now, not a backup.
- Non-grouped TF2 foils: the book answers by the href name as-is, id-prefix
  included (`489260-Rock Golem (Foil)`) — total 1, `bMine` true, and the
  books unPrice+unFee (8127) equals the DOM sell price (81.27 RUB) to the
  cent. Two sources, one number. The grouped path stays proven by the
  AK gid above.
- Observation, not a defect: two foil listings active in `mylistings` were
  absent from their book (`bMine` false) — consistent with the twenty-four-
  hour hold on fresh listings. Ownership comes from `mylistings` ids, not
  `bMine`, so the scan still cannot undercut a hidden self.
- Probe caution: ru-RU locale money is `81,27 руб.` — a naive digit-glue
  probe reads 8127 as 81277068 and invents a parser bug. The real parser
  tokenizes by MONEY_TOKEN; do not trust quick probes on money text.


## 2.22.2 — the panel bends to the screen

The panel was 440px of fixed pride — a CS table with wear ranges
wanted more. `resize: horizontal` plus a remembered width (localStorage,
same ritual as position): drag the bottom-right corner once, every page
after opens that wide. Clamp guards the restore (>=320, <=viewport).

Wear reached the rows list too: a stack reads
`81,27 за штуку · float 0.15-0.38`, so the float that decorates the tile
explains itself in the row without a second glance at the grid.

## SIH parity cycle — what stayed, and why

Studied the SIH 1.17.6 source end to end before copying anything. The parts
worth copying were wear on tiles and the inventory ritual (both shipped in
2.22.x); the parts that looked like gaps were checked against this codebase
and mostly are not:

- `avg7` is not noise. It is a selling strategy with its own volume guard
  (`levelVolume` in core/levels), not a fourth number glued to a row. Users
  who sell into a thin week choose it deliberately; removing it is a
  regression, not a cleanup.
- The listing ladder already answers "no data" with a tooltip explaining
  *why* (`describeMissingLevel`), so a long-history average is never shown
  as if trusted when it is not.
- Every visible string is Russian; the only English left in feature files is
  in code comments, which the user never sees.
- SIH itself is breaking on the 2026 SSR market (its own support threads:
  "listings vanish when SIH is on"). Feature parity with a page-scraper is
  the wrong target; parity with what the *user* does is the right one, and
  that is the bar the three shipped versions moved.

## 2.23.0 — mylistings walks every page

The comment said "deliberately not the old paginating loop", and for the account
it was written for that was right: a blind crawl spends the budget the prices
need. Live probes changed the calculus — `total_count: 725` while one answer
carried 100 ids, so `complete` never became true, ownership stayed "unknown"
and the self-undercut guard ran permanently on half the truth.

The walk: page 0 first, and one request per further page only while Steam keeps
naming new listing ids. An account that fits in one answer pays exactly one
request — the old behavior; a 727-lot account pays eight and gets a true
`complete`. A repeated page means Steam is done serving; an interruption or a
refusal mid-walk never reports completion, just like every other half-answer
here. Page ids come from the active set only — held and to-confirm lots are
ours but are not in `total_count`, and folding them into completeness was the
easy way to hide a missing page.

`seen` is now part of `MyListingsPage`: the same set `complete` is measured
against, which the walk needs to tell "new" from "again".

## 2.24.0 — every scan is also a spreadsheet

727 lots with verdicts are worth more in Excel than
on a screen. `core/csv.ts` builds RFC 4180 documents: a BOM or Excel reads
"AK-47" as mojibake, quoting or a comma inside a market name splits one row
in two, and the row break has to be CRLF for the same Excel. Quoting is built
from char codes — this repo's file-writing pipeline has eaten escape sequences
twice, and a test file that will not compile is how that gets caught.

The Reprice button exports the filtered plan (name, hash, qty, our price, the
competitor's low, the target, action, reason); the Inventory button exports the
filtered stacks with float ranges where Steam gave them. Both export what is on
screen after filters, not everything — the row the user can see is the row they
export.

## 2.25.0 — wear is a sort key, not just a chip

Once every CS copy has a float, the question on a trading desk is
"which of these 300 skins is the cleanest" — and the answer was three clicks deep.
The sort gained "float ascending": a stack with no reading sinks (unknown is
not pristine 0.00), and a stack where only some copies were measured also sinks,
because min-of-measured would otherwise claim a half-read stack is pristine.
Wear ranks on wear alone — whether a stack is priced is a different question,
and mixing the two rankings buried clean unpriced stacks under junk.

The whole cycle in three releases: mylistings now walks every page (ownership is
complete on a 727-lot account, and the self-undercut guard finally sees all of
our lots), every scan and inventory export hands Excel a sheet with a BOM and
RFC 4180 quoting, and the float column sorts the shelf like a shop.

## 2.25.1 — the endless spinner, killed by its own page size

Ten lots on screen, 'дочитываю…' forever. Mine from 2.23.0: the walk sized its pages
by the visible row count, so a small page meant small pages all the way down a
727-lot account — 73 paced requests, roughly six minutes of spinning for a scan
that costs eight. A regression earns a test, not just a fix: the walk now always
asks Steam for 100, and one test pins the count in the URL, one pins the request
budget, one keeps the single-page account on one request.

Continued in the same release after a design pass: the walk now counts
(`200 из 727`) instead of an eternal «дочитываю», mylistings joined the
listings budget (10/min — same endpoint family, same rate Steam itself
sees), and the status line pulses while paced so a held request is visibly
waiting and not dying. On tiles the wear chip moved above the price badge:
Steam counts stacks in the top corner and the two were fighting for it.
The panel got the rest of its own skin — themed scrollbar, focus rings,
tabular numbers, a muted wear chip so five greens are one voice.

## 2.26.0 — the Cards tab sees the drop debt

The badges page went through the same SSR rewrite as the market: the old
`ajaxallbadges` fragment answers with the full page now, and the gamecards page
lost its start-playing button. Both facts come from probing a logged-in profile,
not from guessing — and the second one decided the architecture: a
content script cannot emulate a game launch through the page, so the extension
will not pretend otherwise.

What landed is the half that is pure read:

- `src/steam/badges.ts` parses the SSR sheet by regex over text, the same way
  the hover refs are read. `id="badge_gamebadge_495570_1_0"` anchors every row
  (appid, badge level, foil suffix); drops and collection progress sit in
  classes the rewrite did not move. Foil rows carry no drop counter and the
  parser keeps them out of the farmable set instead of reading them as zero.
- The walk reads up to 20 pages, stops on Steam's own «Showing … of N badges»
  total, and reports progress into the status line the way the listing walk
  learned to in 2.25.1.
- The «Карточки» tab on /my/badges: a scan fills stats and a picked list of
  games that still owe drops, sorted by debt. «Запустить в Steam» opens
  `steam://run/<appid>` for every ticked game — for one or two games this is
  the whole loop; for thirty-two it is what the ASF rung will take over.
- `test/fixtures/badges-page1.html` is a captured live page, redacted before it
  can reach the public repo (profile URL, steamid64, account id, avatar). The
  fixture test asserts 147 rows / 20 farmable on it — the day Valve renames a
  class, the suite says so first, not the user.
- `badges` joined the governor at 6/min. A scan of a 296-badge library is two
  requests, and a farm account can wait its seconds.

The run button deliberately stops at `steam://`: no fake progress bar. Launch
emulation across 32 games is a SteamKit job, and docs/cards-factory.md keeps
the ASF rung planned with its honest boundaries.

## 2.27.0 — the Cards tab can drive a bot

The badges page taught us the drop debt; this is the hand. Card Factory's trick
— playing up to 32 games at once — is a Steam session protocol, and a browser
extension cannot speak it. ArchiSteamFarm does, properly, over SteamKit2. The
tab now dispatches to it.

Everything about the bot contract was read out of ASF sources rather than
guessed: `POST /Api/Command` takes `{Command}` and answers GenericResponse
`{Success,Message,Result}`; the auth middleware lets loopback callers through
without a password and 403s the rest; `play <appids>` is manual farming,
`reset` hands the bots back. A refused play still arrives as HTTP 200 — the
verdict is inside the text, so `runAsfCommands` sniffs it.

The fetch runs in the worker, not the page: the badges page has no CORS
dealings with a local bot, ASF answers no preflight, and the worker holds the
loopback host permission outright (`asf/exec`). The password rides the query
per ASF's own middleware and is never logged.

Two modes, one button: `steam://run` hands games to the local client one by
one with the client's own confirmations, and ASF mode puts the whole selection
into the bot in 32-game batches. `тест` asks `status` before anything gets
queued; `стоп` resets the bot.

The evening's own bug, caught by its own tests: a heredoc can eat a
backslash so `\b` lands in the file as byte 0x08 — esbuild saw a literal
backspace in the regex. Now the pattern is a named constant, and there is a
test reading a refusal hidden inside a 200.
