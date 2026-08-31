import type { Cents, ItemKeyed } from "../core/types";
import { fetchJson, type Pacing } from "./net";
import { country, currencyId } from "./page-context";

/**
 * `market/search/render` is what the market UI itself calls while you browse, and
 * it answers with up to a hundred items at once — each carrying `sell_price`, the
 * same lowest price `priceoverview` returns one item at a time.
 *
 * Two things decide whether it is worth using:
 *
 * 1. Search matches on the *displayed* name, not on `market_hash_name`. Community
 *    items hash as `296830-:CoffeeBreak:`, and sending that as the query finds
 *    nothing — the query has to be built from the display name.
 * 2. It only pays off where one query returns several items we hold. Skins do that
 *    (five wears, StatTrak, Souvenir); emoticons and backgrounds do not.
 */

interface SearchResult {
  name?: string;
  hash_name?: string;
  sell_listings?: number;
  sell_price?: number;
  sell_price_text?: string;
  asset_description?: {
    market_hash_name?: string;
    market_bucket_group_id?: string;
  };
}

interface SearchResponse {
  success?: boolean;
  start?: number;
  pagesize?: number;
  total_count?: number;
  results?: SearchResult[] | null;
}

/** What one search run yields: the prices it found and the group ids it teaches. */
export interface GroupPrices {
  prices: Map<string, Cents>;
  /** Exact `hash_name` → internal group id, for the apps that stopped answering by hash. */
  groupIds: Map<string, string>;
}

export interface SearchGroup {
  /** What we send as `query`. */
  query: string;
  appid: number;
  /** Items whose exact hash we hope to find in the answer. */
  items: ItemKeyed[];
}

/** Wear suffix, e.g. "(Field-Tested)" or "(Well-Worn)". Always trails the name. */
const WEAR_SUFFIX = /\s*\([^()]*\)\s*$/;

/** Quality prefixes that search ignores anyway, so they only narrow the grouping. */
const QUALITY_PREFIX = /^(★\s*)?(StatTrak™|Souvenir)\s+/;

/** Community items (appid 753) hash as "{game appid}-{item name}". */
const COMMUNITY_HASH = /^(\d+)-(.+)$/;

function stripDecorations(text: string): string {
  return text.replace(WEAR_SUFFIX, "").replace(QUALITY_PREFIX, "").trim();
}

/**
 * The query that will bring this item back, ideally along with its siblings.
 * Deliberately lossy: precision comes from matching `hash_name` afterwards.
 */
export function queryForItem(item: Pick<ItemKeyed, "hash" | "name">): string {
  const community = COMMUNITY_HASH.exec(item.hash);
  if (community) {
    /**
     * The hash itself is unsearchable. The display name is what search indexes;
     * the tail of the hash is the fallback when we have no display name.
     */
    const display = stripDecorations(item.name ?? "");
    if (display && display !== item.hash) return display;
    return community[2] ?? item.hash;
  }

  const stripped = stripDecorations(item.hash);
  if (stripped) return stripped;
  return item.hash.trim() || item.hash;
}

export function groupForSearch(items: ItemKeyed[]): SearchGroup[] {
  const groups = new Map<string, SearchGroup>();
  for (const item of items) {
    const query = queryForItem(item);
    const key = `${item.appid}\t${query}`;
    const existing = groups.get(key);
    if (existing) existing.items.push(item);
    else groups.set(key, { query, appid: item.appid, items: [item] });
  }
  return [...groups.values()];
}

/**
 * How much batching a set of items would actually get. One request per item means
 * search has no advantage over `priceoverview` and costs an extra round trip when
 * it misses, so the caller can decide not to bother.
 */
export function batchingRatio(items: ItemKeyed[]): number {
  if (!items.length) return 1;
  return items.length / groupForSearch(items).length;
}

/**
 * Only an exact `hash_name` with a real price counts, never a near miss.
 * Pulled out so the matching rule is testable without a network round trip.
 */
export function pricesFromResults(results: SearchResult[] | null | undefined): Map<string, Cents> {
  const out = new Map<string, Cents>();
  if (!results) return out;
  for (const row of results) {
    const hash = row.hash_name;
    const price = row.sell_price;
    if (!hash || typeof price !== "number" || !Number.isFinite(price) || price < 1) continue;
    /** Steam can repeat a hash across pages; the cheapest wins. */
    const seen = out.get(hash);
    if (seen == null || price < seen) out.set(hash, price);
  }
  return out;
}

/**
 * Group ids learned from search answers, keyed by the exact `hash_name`. Steam
 * hands out `market_bucket_group_id` on skin rows whether we asked or not, and
 * the listing book of appid 730 only answers to that name.
 */
export function groupIdsFromResults(
  results: SearchResult[] | null | undefined
): Map<string, string> {
  const out = new Map<string, string>();
  if (!results) return out;
  for (const row of results) {
    const hash = row.hash_name;
    const groupId = row.asset_description?.market_bucket_group_id;
    if (hash && groupId && groupId !== hash) out.set(hash, groupId);
  }
  return out;
}

export function searchUrl(group: SearchGroup, count: number): string {
  return (
    "https://steamcommunity.com/market/search/render/" +
    "?norender=1" +
    `&appid=${encodeURIComponent(group.appid)}` +
    `&start=0&count=${count}` +
    `&currency=${currencyId()}` +
    `&country=${encodeURIComponent(country())}` +
    `&query=${encodeURIComponent(group.query)}`
  );
}

/** Lowest buyer price per exact market_hash_name, plus the group ids the rows teach. */
export async function fetchGroupPrices(
  group: SearchGroup,
  pacing: Pacing,
  count = 100
): Promise<GroupPrices> {
  const data = await fetchJson<SearchResponse>(searchUrl(group, count), {
    kind: "search",
    ...pacing,
    isEmpty: (d) => {
      const r = d as SearchResponse;
      return r?.success === false;
    },
  });
  return { prices: pricesFromResults(data.results), groupIds: groupIdsFromResults(data.results) };
}
