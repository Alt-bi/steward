import { bookListingFrom, type PlainBookListing } from "../page/ssr";
import type { Cents, PageListingInfo } from "../core/types";
import { fetchJson, type Pacing } from "./net";
import { country, currencyId, language } from "./page-context";

/**
 * The public listing page for one item. Unlike `priceoverview` this returns the
 * individual listings keyed by listing id — and since we already know our own
 * listing ids from `mylistings`, that is enough to find the cheapest listing
 * that genuinely belongs to somebody else.
 */

/**
 * `/market/listings/{appid}/{name}/render/` — the classic book, measured alive.
 *
 * An earlier session concluded it was dead and moved everything onto the
 * rewritten frontend's `market/actions?q=QueryListingsForItem`. Measured on a
 * live logged-in Edge on 2026-09-03, both halves of that turned out to be
 * backwards:
 *
 * - `actions` answers **the market homepage as HTML, 200, 1 MB**, with the
 *   loader header, without it, and with the classic AJAX signature. Not a
 *   redirect and not a throttle — it simply does not answer this context. That
 *   is the «Steam дважды прислал веб-страницу» every scan was ending in.
 * - `/render/` answers `application/json` on the first try, every try: the
 *   listings keyed by listing id with `converted_price` + `converted_fee`, the
 *   `total_count` behind them, and it honours `count` (asked 20, got 20 — the
 *   action endpoint always served twenty whatever we asked).
 *
 * Two facts fell out of the same measurement and are worth keeping here:
 *
 * - **There is no group-id wall.** `AK-47 | Redline (Field-Tested)` answers by
 *   `market_hash_name`, 1201 listings deep. The whole `strItemName`-is-a-group-id
 *   detour existed only because the action endpoint needed it.
 * - **A commodity has no rows.** `Fracture Case` answers `total_count: 1` with
 *   an empty `listinginfo`: cases and keys trade through an order book, not
 *   through listings. That is an answer, not a refusal, and the caller settles
 *   those from `priceoverview` instead.
 */
interface RenderResponse {
  success?: boolean;
  start?: number;
  pagesize?: number | string;
  total_count?: number;
  /** listingid -> the row, same shape `g_rgListingInfo` has on the item page. */
  listinginfo?: Record<string, PageListingInfo>;
}

export const BOOK_PAGE = 20;

export interface MarketListing {
  listingId: string;
  /** What the buyer pays in total. */
  buyer: Cents;
  /** The seller's share, which `buylisting` calls the subtotal. */
  price: Cents;
  /** Steam plus publisher fees, which `buylisting` wants separately. */
  fee: Cents;
  /**
   * Set only when the source said so outright. The rewritten item page flags our
   * own lots; `/render/` never did, which is why the id set still exists.
   */
  mine?: boolean;
  /**
   * Which item of the group this lot is. A grouped book mixes every wear
   * together, and buying the cheapest row without checking this is buying a
   * different item from the one on screen.
   */
  hash?: string;
}

function toInt(v: unknown): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Same shape as `g_rgListingInfo` on the item page and `listinginfo` in /render. */
export function listingsFromInfo(info: Record<string, PageListingInfo> | null | undefined): MarketListing[] {
  const out: MarketListing[] = [];
  if (!info) return out;
  for (const [id, row] of Object.entries(info)) {
    const price = toInt(row.converted_price ?? row.price);
    const fee = toInt(row.converted_fee ?? row.fee);
    if (price <= 0) continue;
    out.push({ listingId: String(row.listingid ?? id), buyer: price + fee, price, fee });
  }
  out.sort((a, b) => a.buyer - b.buyer);
  return out;
}

/**
 * The book as the item page itself holds it.
 *
 * Costs nothing — it is the data the page was drawn from — and unlike anything
 * we could fetch, each row already says whether the lot is ours. The book mixes
 * every item of the group together, so it is filtered by hash name; a row with
 * no hash is kept, because losing a stranger's lot is worse than keeping one.
 */
export function listingsFromSsr(
  rows: readonly PlainBookListing[] | null | undefined,
  hash?: string
): MarketListing[] {
  const out: MarketListing[] = [];
  for (const row of rows ?? []) {
    if (row.price <= 0) continue;
    if (hash && row.hash && row.hash !== hash) continue;
    out.push({
      listingId: row.listingid,
      buyer: row.price + row.fee,
      price: row.price,
      fee: row.fee,
      mine: row.mine,
      hash: row.hash,
    });
  }
  out.sort((a, b) => a.buyer - b.buyer);
  return out;
}

/**
 * The listing book for one item, from Steam.
 *
 * `strItemName` is whatever stands in the item's own market URL, which is not
 * always its hash name: a trading card is listed under its hash, but a CS item
 * with wear variants is listed under a group id, and asking for the hash there
 * answers with an empty book. An empty book is therefore «we did not learn
 * anything», never «nobody is selling» — the caller must not read it as the
 * latter, and `competitorFromListings` reports zero listings as unknown.
 */
export interface BookPage {
  listings: MarketListing[];
  /**
   * Steam has rows past the ones it sent. This is the only honest answer to «did
   * we see the whole book», because `count` is decoration: the endpoint serves a
   * fixed page of twenty whether we ask for one or a hundred.
   */
  more: boolean;
  /** How many lots exist in total, ours included. Null when Steam did not say. */
  total: number | null;
}

export interface BookOptions {
  /**
   * Treat a book of zero as Steam refusing rather than answering.
   *
   * Set when we are ourselves selling the item asked about: our own live lot is
   * in that book by definition, so `total_count: 0` cannot be true. Measured on
   * 2026-09-01 — fifteen quick calls in, the endpoint started answering `{data:
   * {total_count: 0, listings: []}}` for a card whose book it had just returned,
   * and went back to the truth after a minute's pause. Read as an answer it says
   * «nobody is selling this», which is how a scan of ten items checked none of
   * them and reported it as a naming problem.
   */
  emptyIsRefusal?: boolean;
}

export async function fetchListingBook(
  appid: number,
  itemName: string,
  pacing: Pacing,
  count = BOOK_PAGE,
  opts: BookOptions = {}
): Promise<BookPage> {
  /**
   * `query=` empty and `start=0`: the whole book from the top, in the wallet's
   * own currency. `language` and `country` ride along because Steam prices the
   * answer by them — leave them off and a rouble account can be quoted in
   * dollars, which lands in the same cache key as the roubles.
   */
  const url =
    `https://steamcommunity.com/market/listings/${appid}/${encodeURIComponent(itemName)}/render/` +
    `?query=&start=0&count=${count}` +
    `&currency=${currencyId()}&language=${encodeURIComponent(language())}` +
    `&country=${encodeURIComponent(country())}`;

  const data = await fetchJson<RenderResponse>(url, {
    kind: "listings",
    ...pacing,
    /**
     * A book of zero is an answer, not a stonewall.
     *
     * Counting it as one cost twice over: the governor saw four «empty» replies
     * in a row and throttled the whole scan, and the caller got an exception
     * where it needed to see `total_count: 0` — the one fact that proves we asked
     * with a name Steam does not answer to.
     *
     * An empty `listinginfo` under a non-zero `total_count` is neither: that is
     * a commodity, whose lots live in an order book rather than in listings.
     * `priceoverview` prices those, and calling it a refusal here would put the
     * whole scan into a cooldown over cases and keys behaving normally.
     */
    isEmpty: (d) => {
      const body = (d ?? {}) as RenderResponse;
      if (body.success === false) return true;
      if (typeof body.total_count !== "number") return true;
      return opts.emptyIsRefusal === true && body.total_count === 0;
    },
  });

  const listings = listingsFromInfo(data.listinginfo);
  const total = typeof data.total_count === "number" ? data.total_count : null;
  return {
    listings,
    /**
     * Steam does not say «more» here, but it does say how many exist, and that
     * is the stronger statement: rows we did not receive are rows we did not
     * look at, and a window of nothing but our own lots must never be read as
     * «nobody is under us».
     */
    more: total != null && listings.length < total,
    total,
  };
}

/** Just the rows, for callers that do not care how deep the book went. */
export async function fetchCheapestListings(
  appid: number,
  itemName: string,
  pacing: Pacing,
  count = BOOK_PAGE
): Promise<MarketListing[]> {
  return (await fetchListingBook(appid, itemName, pacing, count)).listings;
}

/**
 * The rows as Steam sends them, in either delivery. Shares one parser with the
 * copy embedded in the item page, because they are the same rows.
 */
export function listingsFromBook(
  rows: readonly unknown[] | null | undefined,
  hash?: string
): MarketListing[] {
  const parsed: PlainBookListing[] = [];
  for (const raw of rows ?? []) {
    const row = bookListingFrom(raw);
    if (row) parsed.push(row);
  }
  return listingsFromSsr(parsed, hash);
}

/**
 * What the listing book says about one item, read once.
 *
 * `priceoverview` answers a strictly smaller question for the same one request:
 * it gives the market minimum but not who holds it, so an answer equal to our own
 * price settles nothing. This returns both, which is why the exact mode does not
 * pay for the hint first.
 */
export interface CompetitorScan {
  /** Cheapest listing in the window, ours included. */
  marketLow: Cents | null;
  /** Cheapest listing in the window that is not ours. */
  competitor: Cents | null;
  /** Listings we actually looked at. Zero means the page told us nothing. */
  seen: number;
  /** Every listing in the window was ours. */
  allOurs: boolean;
  /**
   * The book named the owner of each lot itself, rather than us matching listing
   * ids. When it did, a tie is settled and needs no complete set of our own ids.
   */
  flagged: boolean;
  /**
   * The window came back full and all of it was ours, so a competitor may simply
   * not have fit. Read `allOurs` as a floor, never as «we hold the minimum».
   */
  crowded: boolean;
  /**
   * Steam holds no book at all under the name we asked with — for an item we are
   * ourselves selling, which proves the name wrong rather than the item unsold.
   *
   * Our own live listing is in that book by definition, so a total of zero cannot
   * mean «nobody is selling». It means `strItemName` is not what this app answers
   * to: every Counter-Strike item now lives under a group id, and a hash name
   * there returns an empty book however many times it is asked.
   */
  unnamed: boolean;
  /**
   * The rows the book handed over, in price order.
   *
   * Kept so ownership can be re-decided without asking Steam again: learning
   * that one of these lots is ours after the fact is a pure recount, not a
   * second request.
   */
  rows: readonly MarketListing[];
  /** Something sits past what we read, so `allOurs` is a floor and not a verdict. */
  truncated: boolean;
}

/**
 * The same book, counted again against a bigger set of our own listing ids.
 *
 * Learning after the fact that the cheapest lot was ours is a recount, not a
 * second request — the rows are still here.
 */
export function rescanOwnership(
  scan: CompetitorScan,
  ourListingIds: ReadonlySet<string>
): CompetitorScan {
  let competitor: Cents | null = null;
  for (const listing of scan.rows) {
    if (isOurs(listing, ourListingIds)) continue;
    competitor = listing.buyer;
    break;
  }
  const allOurs = scan.rows.length > 0 && competitor == null;
  return { ...scan, competitor, allOurs, crowded: allOurs && scan.truncated };
}

/**
 * Either source may know. The page states ownership outright and is believed
 * when it does; `mylistings` ids are what the classic book has to fall back on.
 * Deliberately a union rather than a preference: a lot counted as a stranger's
 * by mistake is one we would undercut, and the stranger would be us.
 */
function isOurs(listing: MarketListing, ourListingIds: ReadonlySet<string>): boolean {
  return listing.mine === true || ourListingIds.has(listing.listingId);
}

/** What Steam said about the book beyond the rows themselves. */
export interface BookMeta {
  /** Steam's own `more`. Undefined means nobody said, so the window has to guess. */
  more?: boolean;
  total?: number | null;
}

export function competitorFromListings(
  listings: readonly MarketListing[],
  ourListingIds: ReadonlySet<string>,
  requested = 0,
  book?: BookMeta
): CompetitorScan {
  /** Sorted by what the buyer pays, so the first lot that is not ours is the low. */
  let competitor: Cents | null = null;
  for (const listing of listings) {
    if (isOurs(listing, ourListingIds)) continue;
    competitor = listing.buyer;
    break;
  }
  const first = listings[0];
  /**
   * Whether anything sits past what we read.
   *
   * Steam answers this outright and its answer wins, because the window it
   * compares against is a fiction: the endpoint serves twenty rows however many
   * we ask for, so «we asked for thirty-five and got twenty» used to read as
   * «room to spare» — and a book of twenty lots that were all ours was reported
   * as «checked, nobody is under us». The guess is only for the classic page,
   * which hands over whatever it drew and says nothing about the rest.
   */
  const truncated = book?.more ?? (requested > 0 && listings.length >= requested);
  return {
    marketLow: first ? first.buyer : null,
    competitor,
    seen: listings.length,
    allOurs: listings.length > 0 && competitor == null,
    crowded: listings.length > 0 && competitor == null && truncated,
    flagged: listings.length > 0 && listings.every((l) => l.mine !== undefined),
    unnamed: listings.length === 0 && book?.total === 0,
    rows: listings,
    truncated,
  };
}

/**
 * How deep to ask the book to go — and the depth has to be one Steam accepts.
 *
 * Measured 2026-09-03 against a live account, same item, one request each:
 *
 * | count | answer |
 * |-------|--------|
 * | 1, 10, 20, 100 | `success: true`, the book |
 * | 5, 11, 12, 25, 50, 75 | `success: false`, `total_count: 0`, no rows |
 *
 * So `count` is a whitelist, not a number, and everything off it comes back as
 * an empty book — which this codebase reads, correctly, as Steam refusing. The
 * old window was `ourCount + 10`, i.e. **11 for every item we hold one lot of**:
 * every request would have answered «no listings» about items we are ourselves
 * selling, two of those stop the run, and four in a row put the governor into a
 * cooldown. A silent, total failure that looks exactly like a throttle.
 *
 * The depth still has to clear our own lots, because they sit at the bottom of
 * the book precisely when we hold the minimum — so we round *up* to the next
 * size Steam will serve.
 */
export function scanWindow(ourCount: number): number {
  const wanted = ourCount + 10;
  if (wanted <= 10) return 10;
  if (wanted <= 20) return 20;
  return 100;
}

/** One request: the market minimum, the competitor behind it, and which is which. */
export interface ScanOptions {
  /**
   * Whether an empty book could honestly mean «wrong name».
   *
   * Both stories end in `total_count: 0` for an item we hold a lot of, and they
   * need opposite responses: a hash name on a group-id app is wrong forever and
   * must be learned around, while a throttled book is right again in a minute
   * and must never be recorded as a fact. The caller is the only one that knows
   * which is possible here — it knows whether it asked with a learned group id,
   * and whether this app hides its items behind one at all.
   */
  nameMayBeWrong?: boolean;
}

export async function scanCompetitors(
  appid: number,
  hash: string,
  ourListingIds: ReadonlySet<string>,
  pacing: Pacing,
  /** How many lots of *this* item are ours — the whole id set spans every item. */
  ourCount = ourListingIds.size,
  opts: ScanOptions = {}
): Promise<CompetitorScan> {
  const count = scanWindow(ourCount);
  const book = await fetchListingBook(appid, hash, pacing, count, {
    emptyIsRefusal: ourCount > 0 && opts.nameMayBeWrong !== true,
  });
  return competitorFromListings(book.listings, ourListingIds, count, book);
}
