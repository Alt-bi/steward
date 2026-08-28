import { parseMoneyToCents } from "../core/money";
import type { Cents, Listing, SteamAssetIndex } from "../core/types";
import { fetchJsonRetry, sleep, SteamError, type Pacing } from "./net";
import { assetIndex, lookupAsset } from "./page-context";

/**
 * Reading our own listings is the most brittle part of the whole extension:
 * Steam splits the data across three fields that each go missing under different
 * conditions, so everything is merged and nothing is trusted alone.
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

interface MyListingsResponse {
  success?: boolean;
  pagesize?: number;
  total_count?: number;
  num_active_listings?: number;
  results_html?: string;
  hovers?: string;
  listinginfo?: Record<string, ListingInfo>;
  assets?: SteamAssetIndex;
}

interface HoverRef {
  appid: number;
  contextid: string;
  assetid: string;
}

interface ParsedRow {
  listingId: string;
  appid: number | null;
  hash: string;
  name: string;
  buyer: Cents;
  seller: Cents;
}

export interface LoadMeta {
  total: number;
  pages: number;
  extracted: number;
}

function toInt(v: unknown): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

const HOVER_RE =
  /CreateItemHoverFromContainer\(\s*[^,]+,\s*'mylisting_(\d+)[^']*',\s*(\d+),\s*'(\d+)',\s*'(\d+)'/g;

/** `hovers` is a blob of JS calls; it is the only place assetid survives some responses. */
function parseHovers(hovers: string): Record<string, HoverRef> {
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
const NAME_LINK_SELECTOR = ".market_listing_item_name_link";
const HREF_LINK_SELECTOR = 'a[href*="/market/listings/"]';

function parseListingDoc(root: ParentNode | null): Record<string, ParsedRow> {
  const map: Record<string, ParsedRow> = {};
  if (!root) return map;
  for (const row of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const listingId = String(row.id ?? "")
      .replace(/^mylisting_/, "")
      .split("_")[0];
    if (!listingId) continue;

    const link =
      row.querySelector<HTMLAnchorElement>(NAME_LINK_SELECTOR) ??
      row.querySelector<HTMLAnchorElement>(HREF_LINK_SELECTOR);
    const href = link?.getAttribute("href") ?? "";
    const m = href.match(/\/market\/listings\/(\d+)\/([^/?#]+)/);

    const priceCell = row.querySelector<HTMLElement>(".market_listing_price") ?? row;
    const priceText = (priceCell.innerText || priceCell.textContent || "").trim();
    const nums = priceText.match(/[0-9]+(?:[  ]?[0-9]{3})*(?:[.,][0-9]{1,2})?/g) ?? [];
    const name = (link?.textContent ?? "").trim();

    map[listingId] = {
      listingId,
      appid: m?.[1] ? Number(m[1]) : null,
      hash: m?.[2] ? decodeURIComponent(m[2]) : name,
      name,
      buyer: nums[0] ? parseMoneyToCents(nums[0]) : 0,
      seller: nums[1] ? parseMoneyToCents(nums[1]) : 0,
    };
  }
  return map;
}

function parseHtml(html: string): Record<string, ParsedRow> {
  if (!html) return {};
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  return parseListingDoc(doc);
}

function buyerFromInfo(info: ListingInfo): Cents {
  const price = info.converted_price ?? info.price;
  const fee = info.converted_fee ?? info.fee;
  return toInt(price) + toInt(fee);
}

export function mergePage(data: MyListingsResponse): Listing[] {
  const info = data.listinginfo ?? {};
  const htmlRows = parseHtml(data.results_html ?? "");
  const hovers = parseHovers(data.hovers ?? "");
  const assets = data.assets ?? assetIndex();

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
    const contextid = String(assetRef.contextid ?? hover?.contextid ?? "2");
    const assetid = assetRef.id ?? hover?.assetid ?? "";
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

function hasRows(data: MyListingsResponse): boolean {
  if (!data) return false;
  if (data.listinginfo && Object.keys(data.listinginfo).length) return true;
  if (data.results_html && /mylisting_/.test(data.results_html)) return true;
  const n = data.num_active_listings ?? data.total_count;
  return Boolean(data.success && n === 0);
}

/** Steam has moved this endpoint around; try the known spellings before giving up. */
async function fetchPage(start: number, count: number, pacing: Pacing): Promise<MyListingsResponse> {
  const qs = `start=${start}&count=${count}`;
  const urls = [
    `https://steamcommunity.com/market/mylistings?${qs}`,
    `https://steamcommunity.com/market/mylistings/?${qs}`,
    `https://steamcommunity.com/market/mylistings/render/?${qs}&query=`,
  ];
  let last: unknown = null;
  for (const url of urls) {
    try {
      const data = await fetchJsonRetry<MyListingsResponse>(
        url,
        { kind: "mylistings", ...pacing },
        2
      );
      if (hasRows(data)) return data;
      last = new SteamError("empty", "mylistings_empty_payload");
    } catch (err) {
      last = err;
      if (
        err instanceof SteamError &&
        (err.kind === "not_logged_in" || err.kind === "aborted" || err.kind === "blocked")
      ) {
        throw err;
      }
    }
  }
  throw last instanceof Error ? last : new SteamError("http", "mylistings_failed");
}

export interface LoadResult {
  listings: Listing[];
  meta: LoadMeta;
}

export async function loadMyListings(
  pacing: Pacing & { onProgress?: (loaded: number, total: number) => void }
): Promise<LoadResult> {
  const count = 100;
  const listings: Listing[] = [];
  const seen = new Set<string>();
  let start = 0;
  let total: number | null = null;
  let pages = 0;

  while (pages < 40) {
    if (pacing.abort?.()) throw new SteamError("aborted");
    const data = await fetchPage(start, count, pacing);
    pages += 1;
    total ??= data.total_count ?? data.num_active_listings ?? 0;

    const batch = mergePage(data);
    for (const listing of batch) {
      if (seen.has(listing.listingId)) continue;
      seen.add(listing.listingId);
      listings.push(listing);
    }
    pacing.onProgress?.(listings.length, total || listings.length);

    if (!batch.length) break;
    start += data.pagesize ?? batch.length ?? count;
    if (total && start >= total) break;
    await sleep(250);
  }

  /** Last resort: scrape whatever the page already rendered. */
  if (!listings.length) {
    const host = document.getElementById("tabContentsMyListings") ?? document.body;
    listings.push(
      ...mergePage({
        results_html: host.innerHTML,
        hovers: document.documentElement.innerHTML,
        assets: assetIndex() ?? {},
        listinginfo: {},
      })
    );
  }

  return { listings, meta: { total: total ?? 0, pages, extracted: listings.length } };
}
