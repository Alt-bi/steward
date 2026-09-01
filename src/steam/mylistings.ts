import { parseMoneyToCents } from "../core/money";
import type { Cents, Listing, SteamAssetIndex } from "../core/types";
import { fetchJson, SteamError, type Pacing } from "./net";
import { assetIndex, lookupAsset } from "./page-context";

/**
 * Our own listings, read from Steam's own answer.

 * There used to be a page reader here: scrape the table Steam had already
 * drawn and spare the request. The SSR market killed it — the URL answers
 * with JSON now, and where a table does get drawn it holds twenty rows of
 * seven hundred. One reader remains: `myListingsPage` below, whose markup,
 * hover block and assets merge through `assembleListings` — same three
 * sources, complete instead of partial.
 */

interface ListingInfo {
  listingid?: string;
  price?: number | string;
  fee?: number | string;
  converted_price?: number | string;
  converted_fee?: number | string;
  publisher_fee_percent?: number | string;
  asset?: { appid?: number; contextid?: string; id?: string; amount?: number | string };
}

interface HoverRef {
  appid: number;
  contextid: string;
  assetid: string;
}

export interface AssetRef {
  appid: number;
  contextid: string;
  assetid: string;
}

interface ParsedRow {
  listingId: string;
  appid: number | null;
  contextid?: string;
  assetid?: string;
  hash: string;
  name: string;
  buyer: Cents;
  seller: Cents;
}

function toInt(v: unknown): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

const HOVER_RE =
  /CreateItemHoverFromContainer\(\s*[^,]+,\s*'mylisting_(\d+)[^']*',\s*(\d+),\s*'(\d+)',\s*'(\d+)'/g;

function hoverFromBlob(blob: string): (HoverRef & { listingId: string }) | null {
  const m =
    /CreateItemHoverFromContainer\(\s*[^,]+,\s*'mylisting_(\d+)[^']*',\s*(\d+),\s*'(\d+)',\s*'(\d+)'/.exec(
      blob
    );
  if (!m?.[1] || !m[2] || !m[3] || !m[4]) return null;
  return { listingId: m[1], appid: Number(m[2]), contextid: m[3], assetid: m[4] };
}

/** `hovers` is a blob of JS calls; it is the only place assetid survives some rows. */
export function parseHovers(hovers: string): Record<string, HoverRef> {
  const map: Record<string, HoverRef> = {};
  let m: RegExpExecArray | null;
  HOVER_RE.lastIndex = 0;
  while ((m = HOVER_RE.exec(hovers))) {
    const [, listingId, appid, contextid, assetid] = m;
    if (!listingId || !appid || !contextid || !assetid) continue;
    map[listingId] = { appid: Number(appid), contextid, assetid };
  }
  return map;
}

const ROW_SELECTOR = '.market_listing_row[id^="mylisting_"], [id^="mylisting_"]';
const ROW_ID = /^mylisting_(\d+)$/;
const NAME_LINK_SELECTOR = ".market_listing_item_name_link";
const HREF_LINK_SELECTOR = 'a[href*="/market/listings/"]';

/** A number that looks like a Steam money amount, not "3 hours ago". */
const MONEY_TOKEN = /[0-9]+(?:[  ]?[0-9]{3})*(?:[.,][0-9]{1,2})?/g;

function nodeText(node: { innerText?: string; textContent?: string | null } | null): string {
  if (!node) return "";
  return String(node.innerText || node.textContent || "").trim();
}

function isMoneyToken(token: string): boolean {
  /** Steam always renders listings with decimals (`2,58 pуб.`). A bare `3` is a date. */
  if (/[.,]\d{1,2}$/.test(token)) return true;
  /** `1 234` / `1.234` thousands, no decimals. */
  return /(?:[  ]|[.,])\d{3}$/.test(token);
}

/**
 * Buyer (what the market compares) and seller (what you receive) from a price cell.
 *
 * Classic Steam: two spans, with-fee then without-fee.
 * Market Beta: one cell `0,05€ (0,03€)` — buyer, then you-receive in parentheses.
 * A listing row also contains "3 hours ago"; that `3` must never become 3,00 ₽.
 */
export function pricesFromListingText(text: string): { buyer: Cents; seller: Cents } {
  const tokens = String(text ?? "").match(MONEY_TOKEN) ?? [];
  const amounts = tokens.filter(isMoneyToken).map(parseMoneyToCents).filter((n) => n > 0);
  if (amounts.length >= 2) {
    let buyer = amounts[0]!;
    let seller = amounts[1]!;
    /** You-receive is the smaller number. If the cell put it first, unswap. */
    if (seller > buyer) {
      const tmp = buyer;
      buyer = seller;
      seller = tmp;
    }
    return { buyer, seller };
  }
  if (amounts.length === 1) return { buyer: amounts[0]!, seller: 0 };
  return { buyer: 0, seller: 0 };
}

export function pricesFromListingRow(row: ParentNode): { buyer: Cents; seller: Cents } {
  const withFee = row.querySelector(".market_listing_price_with_fee");
  const withoutFee = row.querySelector(".market_listing_price_without_fee");
  if (withFee) {
    const buyer = parseMoneyToCents(nodeText(withFee));
    const seller = parseMoneyToCents(nodeText(withoutFee));
    if (buyer > 0) return { buyer, seller: seller > 0 ? seller : 0 };
  }

  const cell =
    row.querySelector(".market_listing_my_price") ??
    row.querySelector(".market_listing_their_price") ??
    row.querySelector(".market_listing_price");
  if (cell && cell !== row) {
    const parsed = pricesFromListingText(nodeText(cell));
    if (parsed.buyer > 0) return parsed;
  }

  return pricesFromListingText(nodeText(row as unknown as { innerText?: string; textContent?: string | null }));
}

function parseListingDoc(root: ParentNode | null): Record<string, ParsedRow> {
  const map: Record<string, ParsedRow> = {};
  if (!root) return map;
  for (const row of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    /**
     * Children reuse the listing id as `mylisting_123_name`. Taking those would
     * overwrite the row — and they have no price, so the first number in the
     * name or "3 hours ago" would win.
     */
    const idMatch = ROW_ID.exec(String(row.id ?? ""));
    const listingId = idMatch?.[1];
    if (!listingId) continue;

    const link =
      row.querySelector<HTMLAnchorElement>(NAME_LINK_SELECTOR) ??
      row.querySelector<HTMLAnchorElement>(HREF_LINK_SELECTOR);
    const href = link?.getAttribute("href") ?? "";
    const m = href.match(/\/market\/listings\/(\d+)\/([^/?#]+)/);
    const name = (link?.textContent ?? "").trim();
    const hover = hoverFromBlob(row.getAttribute("onmouseover") ?? "");
    const prices = pricesFromListingRow(row);

    map[listingId] = {
      listingId,
      appid: hover?.appid ?? (m?.[1] ? Number(m[1]) : null),
      contextid: hover?.contextid,
      assetid: hover?.assetid,
      hash: m?.[2] ? decodeURIComponent(m[2]) : name,
      name,
      buyer: prices.buyer,
      seller: prices.seller,
    };
  }
  return map;
}

function buyerFromInfo(info: ListingInfo): Cents {
  const price = info.converted_price ?? info.price;
  const fee = info.converted_fee ?? info.fee;
  return toInt(price) + toInt(fee);
}

/**
 * listingid -> the item behind it.
 *
 * Which asset a listing holds is the one thing the answer does not always say in
 * plain fields; the hover block is what names it. Without it a lot can be taken
 * off the market and not put back — the worst possible half-success.
 */
function assetRefs(rows: readonly ListingInfo[]): Map<string, AssetRef> {
  const out = new Map<string, AssetRef>();
  for (const row of rows) {
    const asset = row.asset;
    const assetid = asset?.id == null ? "" : String(asset.id);
    if (!assetid || !row.listingid) continue;
    out.set(String(row.listingid), {
      appid: toInt(asset?.appid),
      contextid: String(asset?.contextid ?? "2"),
      assetid,
    });
  }
  return out;
}

/** What one `mylistings` answer told us about our own listings. */
export interface MyListingsPage {
  refs: Map<string, AssetRef>;
  /** Every listing id Steam named. */
  ids: Set<string>;
  /**
   * Only the *active* ids this answer showed — the same measure `complete` is
   * judged against. Held and to-confirm lots are ours but Steam does not
   * count them in `total_count`, so folding them into a completeness count
   * would let a pending confirmation hide missing pages.
   */
  seen?: Set<string>;
  /**
   * The answer covered every listing we hold, so a listing id outside `ids` is
   * definitely somebody else's.
   *
   * This is the only way to tell a stranger's lot at our price from one of our own
   * lots sitting on the next page — and undercutting the second is bidding against
   * ourselves.
   */
  /**
   * Parsed rows for the page this answer described. The market hands us markup
   * plus a hover block rather than a table now, so the rows only exist once
   * someone parses them — this is where that happens for every reader at once.
   */
  listings?: Listing[];
  complete: boolean;
}

/**
 * Every shape `mylistings` has answered in.
 *
 * Steam replaced the map keyed by listing id with three plain arrays, split by
 * what a listing is waiting on. Both are read, because the old one is still what
 * some layouts hand us and a helper that only knows the current shape breaks on
 * the next rename — this one only stops working if the field names change too.
 */
interface MyListingsResponse {
  success?: boolean;
  listinginfo?: Record<string, ListingInfo>;
  listings?: ListingInfo[];
  /** Sold or listed too recently to be visible to buyers yet. Still ours. */
  listings_on_hold?: ListingInfo[];
  /** Waiting on the mobile confirmation. Ours the moment it is confirmed. */
  listings_to_confirm?: ListingInfo[];
  /**
   * The shape Steam actually answers with today, measured 2026-08-29: no
   * `listinginfo` and no `listings` at all, but a page of markup, the assets it
   * draws, and the block of `CreateItemHoverFromContainer(…)` calls that ties the
   * two together. That block is the only statement of which asset each listing
   * holds, which is the one thing needed to put a lot back on the market.
   */
  hovers?: string;
  results_html?: string;
  /** The `g_rgAssets` the markup was drawn from — same shape the page carries. */
  assets?: Record<string, unknown>;
  total_count?: number;
  num_active_listings?: number;
}

/** Whether an answer is Steam stonewalling rather than an answer. Shared by both reads. */
function myListingsEmpty(r: MyListingsResponse): boolean {
  if (r.success === false) return true;
  if (typeof r.total_count === "number" || typeof r.num_active_listings === "number") return false;
  return rowsOf(r).all.length === 0 && hoverRefs(r).size === 0;
}

/** Parse a string of markup the way a page would. Null where there is no DOM. */
function parseMarkup(markup: string): ParentNode | null {
  if (!markup || typeof DOMParser === "undefined") return null;
  return new DOMParser().parseFromString(markup, "text/html") as unknown as ParentNode;
}

/** listingid -> asset, from the hover block. Empty on the older JSON shapes. */
function hoverRefs(data: MyListingsResponse): Map<string, AssetRef> {
  const out = new Map<string, AssetRef>();
  for (const [id, hover] of Object.entries(parseHovers(String(data.hovers ?? "")))) {
    out.set(id, { appid: hover.appid, contextid: hover.contextid, assetid: hover.assetid });
  }
  return out;
}

function rowsOf(data: MyListingsResponse): { active: ListingInfo[]; all: ListingInfo[] } {
  const fromMap = Object.entries(data.listinginfo ?? {}).map(([id, row]) =>
    row.listingid ? row : { ...row, listingid: id }
  );
  const active = [...fromMap, ...(data.listings ?? [])];
  return { active, all: [...active, ...(data.listings_on_hold ?? []), ...(data.listings_to_confirm ?? [])] };
}

export function myListingsFrom(data: MyListingsResponse): MyListingsPage {
  const { active, all } = rowsOf(data);
  const hovers = hoverRefs(data);

  /**
   * A held or unconfirmed lot is still ours, and mistaking one for a stranger's
   * is exactly the way to undercut yourself. So ownership counts all of them.
   */
  const ids = new Set<string>();
  for (const row of all) if (row.listingid) ids.add(String(row.listingid));
  for (const id of hovers.keys()) ids.add(id);

  /**
   * Completeness, though, is measured against the active set alone: `total_count`
   * counts only active listings, so folding the others in would let one pending
   * confirmation claim we had seen a page we had not.
   */
  const seen = new Set<string>();
  for (const row of active) if (row.listingid) seen.add(String(row.listingid));
  /** The markup Steam sends is one page of active listings, same as `listings`. */
  for (const id of hovers.keys()) seen.add(id);

  const stated = typeof data.total_count === "number" || typeof data.num_active_listings === "number";
  const total = toInt(data.total_count) || toInt(data.num_active_listings);

  const refs = assetRefs(all);
  /** The JSON shapes win where both spoke; the hovers fill in what they did not. */
  for (const [id, ref] of hovers) if (!refs.has(id)) refs.set(id, ref);

  /**
   * The rows, assembled the same way a page would assemble them: markup for
   * name and price, hovers for the asset, `assets` for the hash. This is what
   * makes the scan work on a page Steam now serves as bare JSON — there is no
   * DOM table to read, so the markup in the answer is read instead.
   */
  const listings = assembleListings({
    info: Object.fromEntries(all.filter((r) => r.listingid).map((r) => [String(r.listingid), r])),
    htmlRows: parseListingDoc(parseMarkup(String(data.results_html ?? ""))),
    hovers: parseHovers(String(data.hovers ?? "")),
    assets: (data.assets as SteamAssetIndex | undefined) ?? assetIndex(),
  });

  return {
    listings,
    refs,
    ids,
    seen,
    /**
     * No total at all means we cannot claim to have seen everything. A total of
     * zero, on the other hand, is Steam saying there is nothing to see — and an
     * account with no listings has certainly had all of them accounted for.
     */
    complete: stated && seen.size >= total,
  };
}

/**
 * Our own listings: the asset references the page hid, and the full set of our
 * listing ids.
 *
 * One page is fetched when one page covers the account, and every page is
 * walked when it does not. That used to be backwards: the loop was cut to a
 * single page to spare the budget, and as a result an account with 725 lots
 * never learned `complete` — which is the one fact that tells a stranger's lot
 * at our price from our own lot on the next page. Guessing wrong there is
 * bidding against ourselves, so the few requests are worth it. The walk stops
 * on its own: it only continues while pages keep bringing new ids, so an
 * account that fits in one answer pays exactly one request.
 *
 * The page size is Steam's biggest, never the count from the visible rows.
 * The first release of the walk passed the on-page row count through as the
 * page size, and it turned out to be the cost of the whole walk: ten rows
 * on screen meant ten lots a page, and a 727-lot account crawled for 73
 * paced requests — a spinner that never ends on a scan that costs eight.
 *
 * `onProgress` exists for the same honesty reason: a walk of several pages
 * takes tens of seconds at Steam's pace, and a spinner that says nothing
 * reads exactly like a spinner stuck forever. It gets how far the walk is.
 */
export async function fetchMyListings(
  _visibleCount: number,
  pacing: Pacing,
  onProgress?: (seen: number, total: number) => void
): Promise<MyListingsPage> {
  const size = 100;
  const first = await myListingsPage(0, size, pacing);
  if (first.page.complete || !first.expectMore) return first.page;

  /** Steam's own pages, however many it says there are. */
  const total = first.total;
  const seen = new Set(first.page.seen ?? first.page.ids);
  onProgress?.(seen.size, total);
  const listings = [...(first.page.listings ?? [])];
  const listed = new Set(listings.map((row) => row.listingId));
  const page: MyListingsPage = {
    refs: new Map(first.page.refs),
    ids: new Set(first.page.ids),
    seen,
    listings,
    complete: false,
  };

  for (let start = size; start < total; start += size) {
    let next: Awaited<ReturnType<typeof myListingsPage>>;
    try {
      next = await myListingsPage(start, size, pacing);
    } catch (err) {
      /** A half-told story is not a story: better incomplete than wrong. */
      if (err instanceof SteamError && (err.kind === "aborted" || err.kind === "blocked")) throw err;
      break;
    }
    let fresh = 0;
    for (const id of next.page.seen ?? next.page.ids) {
      if (!seen.has(id)) {
        seen.add(id);
        fresh += 1;
      }
    }
    for (const id of next.page.ids) page.ids.add(id);
    for (const [id, ref] of next.page.refs) if (!page.refs.has(id)) page.refs.set(id, ref);
    for (const row of next.page.listings ?? []) {
      if (listed.has(row.listingId)) continue;
      listed.add(row.listingId);
      listings.push(row);
    }
    /** A page that said "100 more" and brought nothing new is Steam being done. */
    if (!next.expectMore || fresh === 0) break;
    onProgress?.(seen.size, total);
  }

  page.complete = first.expectMore && seen.size >= total;
  return page;
}

/** One page, plus whether Steam claims there is more behind it. */
async function myListingsPage(
  start: number,
  size: number,
  pacing: Pacing
): Promise<{
  page: MyListingsPage;
  expectMore: boolean;
  total: number;
}> {
  const data = await fetchJson<MyListingsResponse>(
    `https://steamcommunity.com/market/mylistings?start=${start}&count=${size}`,
    {
      kind: "mylistings",
      ...pacing,
      /**
       * Steam declining, and nothing else.
       *
       * Reading only one of the shapes here is how a renamed payload gets counted
       * as a throttle four times over and trips the circuit breaker on a perfectly
       * healthy account — and it did, twice: once when `listinginfo` became
       * `listings`, and again when both vanished in favour of markup plus a hover
       * block. So the test is now the other way round: an answer that states a
       * count is an answer, whatever that count is, and an account with nothing
       * listed is entitled to say so.
       */
      isEmpty: (d) => {
        const r = (d ?? {}) as MyListingsResponse;
        if (r.success === false) return true;
        if (typeof r.total_count === "number" || typeof r.num_active_listings === "number") {
          return false;
        }
        return rowsOf(r).all.length === 0 && hoverRefs(r).size === 0;
      },
    }
  );
  const total = toInt(data.total_count) || toInt(data.num_active_listings);
  const page = myListingsFrom(data);
  return { page, expectMore: total > page.ids.size && page.ids.size >= size, total };
}

/** Joins the three half-answers Steam gives us into whole listings. */
export function assembleListings(parts: {
  info?: Record<string, ListingInfo>;
  htmlRows?: Record<string, ParsedRow>;
  hovers?: Record<string, HoverRef>;
  assets?: SteamAssetIndex | null;
}): Listing[] {
  const info = parts.info ?? {};
  const htmlRows = parts.htmlRows ?? {};
  const hovers = parts.hovers ?? {};
  const assets = parts.assets ?? {};

  const ids = new Set<string>([
    ...Object.keys(info),
    ...Object.keys(htmlRows),
    ...Object.keys(hovers),
  ]);
  const out: Listing[] = [];

  for (const id of ids) {
    const row = info[id] ?? {};
    const parsed = htmlRows[id];
    const hover = hovers[id];
    const assetRef = row.asset ?? {};

    const appid = assetRef.appid ?? hover?.appid ?? parsed?.appid ?? null;
    const contextid = String(assetRef.contextid ?? hover?.contextid ?? parsed?.contextid ?? "2");
    const assetid = String(assetRef.id ?? hover?.assetid ?? parsed?.assetid ?? "");
    const asset = lookupAsset(assets, appid, contextid, assetid);

    const hash = asset?.market_hash_name ?? asset?.market_name ?? parsed?.hash ?? asset?.name ?? "";
    if (!hash || appid == null) continue;

    const hasApiPrice = row.price != null || row.converted_price != null;
    const ourBuyer = hasApiPrice ? buyerFromInfo(row) : parsed?.buyer ?? 0;
    const ourSeller = toInt(row.converted_price ?? row.price) || parsed?.seller || 0;

    out.push({
      listingId: String(row.listingid ?? id),
      appid,
      contextid,
      assetid: assetid ? String(assetid) : "",
      amount: toInt(assetRef.amount ?? asset?.amount ?? 1) || 1,
      name: asset?.market_name ?? parsed?.name ?? hash,
      hash,
      ourBuyer,
      ourSeller,
      publisherFeePercent: Number.parseFloat(String(row.publisher_fee_percent ?? "")) || 0.1,
    });
  }
  return out;
}
