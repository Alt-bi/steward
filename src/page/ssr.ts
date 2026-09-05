/**
 * Steam's rewritten item page, projected into plain data.
 *
 * `/market/listings/{appid}/{hash}` is no longer a server-rendered document with
 * `g_rgListingInfo` on it. It is a React app that ships its own initial state in
 * `window.SSR`, and the old `/render/` endpoint that used to hand us the listing
 * book now answers with the page itself. So the book has to be read here.
 *
 * This is a strictly better source than `/render/` ever was: it costs no request,
 * it is the same data the page is drawn from, and every listing carries `bMine` —
 * Steam telling us outright which lots are ours, which is the one thing we used
 * to have to infer from `mylistings`.
 *
 * Two things this deliberately does not do. It never reads the loader slot that
 * carries a live WebAPI token: nothing in the extension needs it, and projecting
 * it would put a credential on the page's message bus. And it makes no requests —
 * everything here was already in the document.
 */

interface Bucket {
  bucket_id?: unknown;
  min_price?: unknown;
  classid?: unknown;
}

interface SellOrder {
  listingid?: unknown;
}

interface SsrListing {
  listingid?: unknown;
  unPrice?: unknown;
  unFee?: unknown;
  bMine?: unknown;
  description?: { market_hash_name?: unknown } | null;
  asset?: { assetid?: unknown; id?: unknown; contextid?: unknown } | null;
}

/** The market minimum for one item of the group the open page belongs to. */
export interface PlainBucket {
  hash: string;
  /** Integer cents, buyer total. Null is Steam declining to name one, not zero. */
  min: number | null;
  classid?: string;
}

export interface PlainBookListing {
  listingid: string;
  /** What the seller receives, integer cents — `buylisting`'s subtotal. */
  price: number;
  /** Steam plus publisher fee, integer cents. */
  fee: number;
  /**
   * Steam's own answer to "is this ours", not a guess from listing ids.
   *
   * Undefined means the row never said — a different fact from «not ours», and
   * it has to stay different: `competitorFromListings` reports «every row named
   * its owner» as `flagged`, and the planner reads that as licence to undercut
   * a lot priced exactly like ours. A shape that can only ever say `false`
   * turns that check into a rubber stamp.
   */
  mine?: boolean;
  /** Which item of the group this lot is; the book mixes every wear together. */
  hash?: string;
  assetid?: string;
  contextid?: string;
}

/** `[unix seconds, price in wallet units, sales]` — Steam's own triple, thinned. */
export type PlainHistoryPoint = [number, number, number];

export interface PlainHistory {
  hash: string;
  points: PlainHistoryPoint[];
}

/**
 * The demand side of one item: what buyers have standing offers at.
 *
 * The whole rest of this codebase reads the sell side — what the cheapest lot
 * asks — and that answers «what would I have to price under». It does not answer
 * «will anyone take it», and those are different questions: measured on the live
 * market, Fracture Case has 3 815 419 buy orders against 176 590 lots for sale
 * and a 45-kopeck spread, while a StatTrak Redline has a spread of thousands.
 *
 * Steam ships this for the item the page is focused on, in the page's own query
 * cache. It costs no request.
 */
export interface PlainOrderBook {
  hash: string;
  /** Highest standing buy order, integer cents, buyer total. Null when none. */
  maxBuy: number | null;
  /** Lowest lot for sale, integer cents, buyer total. Steam's own figure. */
  minSell: number | null;
  buyOrders: number;
  sellOrders: number;
}

export interface PlainItemPage {
  appid: number | null;
  /**
   * Wallet currency the prices on this page are in.
   *
   * The rewritten page defines no `g_rgWalletInfo` at all — measured — so this is
   * the only place the currency exists on it, and everything that keys a cache or
   * asks Steam for a price depends on getting it right.
   */
  currency: number | null;
  /** Wallet country, for the same reason: `g_strCountryCode` is gone too. */
  country: string | null;
  /**
   * The name Steam itself queries the book with, taken from the page's own
   * request rather than guessed from the URL. For a grouped page this is a group
   * id, and it is the only string `QueryListingsForItem` will answer to.
   */
  itemName: string | null;
  /**
   * Which item of the group the page is showing. A grouped page stands at a
   * group id that is no item's hash name, so without this every hash-keyed
   * lookup — bucket, book row, history — misses.
   */
  focus: string | null;
  buckets: PlainBucket[];
  listings: PlainBookListing[];
  histories: PlainHistory[];
  /** Standing buy orders, for whichever items the page asked about. */
  orders: PlainOrderBook[];
  /** Listing ids of our own lots on this item, as the page states them. */
  mine: string[];
}

/**
 * The item a page is actually about, by hash name.
 *
 * `/market/listings/730/G1807209A023004` is a real market URL and `G1807209A023004`
 * is not an item — it is the group. The buckets, the book rows and the histories
 * are all keyed by hash name, so reading the URL as one made the whole panel miss
 * on every grouped page: no rows, no minimum, no history, and a "cheapest lot"
 * taken from whichever wear happened to be cheapest in the group.
 */
export function focusedItem(page: PlainItemPage | null, urlName: string): string {
  const buckets = page?.buckets;
  if (!buckets?.length) return urlName;
  if (buckets.some((b) => b.hash === urlName)) return urlName;
  /** Only a focus the page also priced; anything else would miss just as badly. */
  const focus = page?.focus;
  return focus && buckets.some((b) => b.hash === focus) ? focus : urlName;
}

/**
 * Whether this page treats `name` as an item at all.
 *
 * It matters because `pricehistory` answers for a group id — measured, 894 points
 * for `G1807209A023004`, a series mixing every wear and every StatTrak variant of
 * the AK-47 Redline. So asking with a group id does not fail loudly; it returns a
 * plausible chart at a plausible price, and the verdict would be computed against
 * the wrong item entirely.
 *
 * Everything the page keys by hash name — buckets and histories — is the evidence.
 * A page that carries none of it cannot say, and gets the benefit of the doubt:
 * the classic market page is exactly that, and it has always been asked directly.
 */
export function isItemOnPage(page: PlainItemPage | null, name: string): boolean {
  if (!page) return true;
  const known = page.buckets.length + page.histories.length;
  if (!known) return true;
  return page.buckets.some((b) => b.hash === name) || page.histories.some((h) => h.hash === name);
}

/**
 * How much history to carry across. The page ships every point since 2013 for
 * every item in the group — around fifty thousand triples, which is a large clone
 * to push through `postMessage` for averages that only look back a year.
 */
const HISTORY_DAYS = 400;
const HISTORY_CAP = 1200;

function int(value: unknown): number | null {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `loaderData` and `queryData` are JSON *strings*, not objects — React parses them
 * on hydration. A parse failure is one missing section, never a thrown bridge.
 */
function parse(raw: unknown): unknown {
  if (isRecord(raw) || Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * One row of the listing book.
 *
 * Exported because the same rows arrive two ways — embedded in the page, and
 * from `QueryListingsForItem` — and a second parser is a second thing to get
 * wrong the next time Valve renames a field.
 */
export function bookListingFrom(raw: unknown): PlainBookListing | null {
  if (!isRecord(raw)) return null;
  const row = raw as SsrListing;
  const listingid = str(row.listingid);
  const price = int(row.unPrice);
  if (!listingid || price == null || price <= 0) return null;
  const asset = isRecord(row.asset) ? row.asset : null;
  const desc = isRecord(row.description) ? row.description : null;
  return {
    listingid,
    price,
    fee: int(row.unFee) ?? 0,
    /**
     * A literal boolean is Steam answering; anything else is Steam not saying.
     *
     * Both halves matter. Anything but `true` is «not ours», because reading a
     * stranger's lot as our own means passing over it and never undercutting
     * it. And a field that is simply absent must not be written down as
     * `false`: that is the difference between «the book named every owner» and
     * «the book named none», and only the first settles a tie. Measured
     * 2026-09-01, `QueryListingsForItem` ships `bMine` on every row — so this
     * is the guard for the day it stops, not a live bug.
     */
    mine: typeof row.bMine === "boolean" ? row.bMine : undefined,
    hash: str(desc?.market_hash_name),
    assetid: str(asset?.assetid) ?? str(asset?.id),
    contextid: str(asset?.contextid),
  };
}

function historyFrom(hash: string, data: Record<string, unknown>, now: number): PlainHistory | null {
  const prices = Array.isArray(data.prices) ? data.prices : null;
  if (!prices?.length) return null;

  const oldest = now / 1000 - HISTORY_DAYS * 86_400;
  const points: PlainHistoryPoint[] = [];
  for (const entry of prices as unknown[]) {
    if (!isRecord(entry)) continue;
    const time = int(entry.time);
    const price = typeof entry.price_median === "number" ? entry.price_median : null;
    if (time == null || price == null || time < oldest) continue;
    points.push([time, price, int(entry.purchases) ?? 0]);
  }
  if (!points.length) return null;
  return { hash, points: points.length > HISTORY_CAP ? points.slice(-HISTORY_CAP) : points };
}

/**
 * The listing book, the per-item minimums and the sale histories the open item
 * page already holds. Returns null on any page that is not the rewritten one, so
 * callers can fall back to the classic globals without probing for a shape.
 */
export function projectSsr(win: unknown, now = Date.now()): PlainItemPage | null {
  const root = isRecord(win) ? win : null;
  const ssr = isRecord(root?.SSR) ? root.SSR : null;
  if (!ssr) return null;

  try {
    /**
     * The market route's own loader payload, found by shape rather than by
     * position: the array grows a slot whenever Valve nests another wrapper
     * route, and a hard-coded index would then read somebody else's data.
     */
    const slots = Array.isArray(ssr.loaderData) ? ssr.loaderData.map(parse) : [];
    const market = slots.find(
      (slot): slot is Record<string, unknown> => isRecord(slot) && Array.isArray(slot.buckets)
    );

    const buckets: PlainBucket[] = [];
    for (const raw of (market?.buckets ?? []) as unknown[]) {
      if (!isRecord(raw)) continue;
      const bucket = raw as Bucket;
      const hash = str(bucket.bucket_id);
      if (!hash) continue;
      buckets.push({ hash, min: int(bucket.min_price), classid: str(bucket.classid) });
    }

    const mine: string[] = [];
    const orders = isRecord(market?.myOrders) ? market.myOrders : null;
    for (const raw of (Array.isArray(orders?.rgSellOrders) ? orders.rgSellOrders : []) as unknown[]) {
      if (!isRecord(raw)) continue;
      const id = str((raw as SellOrder).listingid);
      if (id) mine.push(id);
    }

    const render = isRecord(ssr.renderContext) ? ssr.renderContext : null;
    const cache = parse(render?.queryData);
    const queries = isRecord(cache) && Array.isArray(cache.queries) ? cache.queries : [];

    const listings: PlainBookListing[] = [];
    const histories: PlainHistory[] = [];
    const orderBooks: PlainOrderBook[] = [];
    let currency: number | null = null;
    let country: string | null = null;

    for (const entry of queries as unknown[]) {
      if (!isRecord(entry)) continue;
      const key = typeof entry.queryHash === "string" ? entry.queryHash : "";
      const state = isRecord(entry.state) ? entry.state : null;
      const data = isRecord(state?.data) ? state.data : null;
      if (!data) continue;

      if (key.includes("market_item_search")) {
        /** An infinite query: one page per "show more" the user has clicked. */
        for (const page of (Array.isArray(data.pages) ? data.pages : []) as unknown[]) {
          if (!isRecord(page)) continue;
          for (const raw of (Array.isArray(page.listings) ? page.listings : []) as unknown[]) {
            const listing = bookListingFrom(raw);
            if (listing) listings.push(listing);
          }
        }
        continue;
      }

      /**
       * The wallet, which the rewritten page keeps here instead of on `window`.
       * Checked before the history's `ecurrency` because it is the wallet itself
       * rather than what one request happened to be priced in.
       */
      if (key.includes("CurrentUserWalletDetails")) {
        currency ??= int(data.currency_code);
        country ??= str(data.wallet_country_code) ?? str(data.user_country_code) ?? null;
        continue;
      }

      /**
       * `["market","orderbook",730,"<hash>"]`. A zero on either side is «nobody
       * is standing there», which is a fact worth showing, not a missing value —
       * but it is not a price, so it is carried as null rather than as 0.
       */
      if (key.includes("orderbook")) {
        currency ??= int(data.eCurrency);
        const parts = Array.isArray(entry.queryKey) ? (entry.queryKey as unknown[]) : [];
        const name = str(parts[parts.length - 1]);
        if (name) {
          const maxBuy = int(data.amtMaxBuyOrder);
          const minSell = int(data.amtMinSellOrder);
          orderBooks.push({
            hash: name,
            maxBuy: maxBuy && maxBuy > 0 ? maxBuy : null,
            minSell: minSell && minSell > 0 ? minSell : null,
            buyOrders: Math.max(0, int(data.cBuyOrders) ?? 0),
            sellOrders: Math.max(0, int(data.cSellOrders) ?? 0),
          });
        }
        continue;
      }

      if (key.includes("pricehistory")) {
        currency ??= int(data.ecurrency);
        /** The key ends with the item's hash: ["market","pricehistory",730,"…"]. */
        const parts = Array.isArray(entry.queryKey) ? (entry.queryKey as unknown[]) : [];
        const name = str(parts[parts.length - 1]);
        const series = name ? historyFrom(name, data, now) : null;
        if (series) histories.push(series);
      }
    }

    if (!buckets.length && !listings.length && !histories.length) return null;
    const query = isRecord(market?.listingQuery) ? market.listingQuery : null;
    return {
      appid: int(market?.appid),
      currency,
      country,
      itemName: str(query?.strItemName) ?? null,
      /** Steam falls back to one of the group when the user picked none. */
      focus: str(market?.initialSelectedBucketID) ?? str(market?.initialFallbackBucketID) ?? null,
      buckets,
      listings,
      histories,
      orders: orderBooks,
      mine,
    };
  } catch {
    /** A shape we did not expect is a page without extras, never a broken bridge. */
    return null;
  }
}
