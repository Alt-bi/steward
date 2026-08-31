import { send } from "../core/messaging";
import { parseMoneyToCents } from "../core/money";
import type { Cents, ItemKeyed } from "../core/types";
import { fetchJson, SteamError, type Pacing } from "./net";
import { country, currencyId } from "./page-context";
import { batchingRatio, fetchGroupPrices, groupForSearch } from "./search";
import { learnGroups } from "./grouping";

/**
 * Market minimums for a set of items.
 *
 * Two sources, one output. `search` asks the endpoint the market UI itself uses and
 * gets whole families of items per call; `priceoverview` is the one-item-at-a-time
 * metered API. Neither is allowed to fail the caller: when Steam stops us we return
 * what we already have and name what is missing, because a partial answer is useful
 * and an aborted scan is not.
 */

interface PriceOverview {
  success?: boolean;
  lowest_price?: string;
  median_price?: string;
  volume?: string;
}

export type PriceSource = "search" | "priceoverview";

export const DEFAULT_PRICE_TTL_MS = 15 * 60_000;

/** Below this, one query returns one item and search only adds a round trip. */
const MIN_BATCHING_RATIO = 1.2;

/** Groups to try before judging whether search is finding anything at all. */
const SEARCH_SAMPLE = 6;

/** Fraction of sampled groups that must match, or we stop trusting search. */
const SEARCH_MIN_HIT_RATE = 0.3;

/**
 * Where a market minimum lives in the shared cache.
 *
 * Exported because the listing book returns the same number as a by-product of a
 * request that was going to happen anyway, and a fresher answer thrown away is a
 * request paid for twice.
 */
export function priceCacheKey(item: Pick<ItemKeyed, "appid" | "hash">): string {
  return `low:${currencyId()}:${item.appid}:${item.hash}`;
}

function cacheKey(item: ItemKeyed): string {
  return priceCacheKey(item);
}

async function fetchOverview(item: ItemKeyed, pacing: Pacing): Promise<Cents> {
  const url =
    "https://steamcommunity.com/market/priceoverview/" +
    `?appid=${encodeURIComponent(item.appid)}` +
    `&currency=${currencyId()}` +
    `&country=${encodeURIComponent(country())}` +
    `&market_hash_name=${encodeURIComponent(item.hash)}`;

  const data = await fetchJson<PriceOverview>(url, {
    kind: "price",
    ...pacing,
    isEmpty: (d) => {
      const p = d as PriceOverview;
      return p?.success === false || !p?.lowest_price;
    },
  });

  const cents = parseMoneyToCents(data.lowest_price);
  if (cents < 1) throw new SteamError("empty", "price_zero");
  return cents;
}

export interface ScanOptions extends Pacing {
  concurrency: number;
  source: PriceSource;
  ttlMs?: number;
  /** Try the per-item endpoint for whatever a search could not resolve. */
  fallbackToOverview?: boolean;
  /**
   * Answer from the cache and stop; nothing leaves the browser.
   *
   * For a caller that is about to ask a better endpoint the same question: the
   * cache is free, so it is always worth reading, and `priceoverview` is not.
   */
  cacheOnly?: boolean;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface LowsResult {
  /** Item key -> lowest buyer price, or null when we could not learn it. */
  lows: Record<string, Cents | null>;
  /** Items we never resolved. Feed them back in to continue where we stopped. */
  unresolved: ItemKeyed[];
  /** Why we stopped early, if we did. */
  stopped: "blocked" | "aborted" | null;
  requests: number;
  fromCache: number;
  /** Set when search turned out not to fit these items, with why. */
  searchSkipped: "no-batching" | "not-matching" | null;
}

function stopKind(err: unknown): "blocked" | "aborted" | null {
  if (!(err instanceof SteamError)) return null;
  if (err.kind === "aborted") return "aborted";
  /** 429 and the HTML sorry-page are Steam telling us to stop, not a missing price. */
  if (err.kind === "blocked" || err.kind === "rate_limited") return "blocked";
  return null;
}

export async function fetchMarketLows(items: ItemKeyed[], opts: ScanOptions): Promise<LowsResult> {
  const lows: Record<string, Cents | null> = {};
  const result: LowsResult = {
    lows,
    unresolved: [],
    stopped: null,
    requests: 0,
    fromCache: 0,
    searchSkipped: null,
  };
  if (!items.length) return result;

  const ttlMs = opts.ttlMs ?? DEFAULT_PRICE_TTL_MS;

  /** Two of our listings for the same item share one lookup. */
  const byCacheKey = new Map<string, ItemKeyed[]>();
  for (const item of items) {
    const key = cacheKey(item);
    const bucket = byCacheKey.get(key);
    if (bucket) bucket.push(item);
    else byCacheKey.set(key, [item]);
  }

  /** A missing worker costs cache hits, never the scan itself. */
  let hits: Record<string, number | null> = {};
  try {
    hits = (await send("cache/get", { keys: [...byCacheKey.keys()] })).hits ?? {};
  } catch {
    hits = {};
  }

  const pending: ItemKeyed[] = [];
  for (const [key, group] of byCacheKey) {
    const hit = hits[key];
    if (hit != null) {
      for (const item of group) lows[item.key] = hit;
      result.fromCache += group.length;
    } else if (group[0]) {
      pending.push(group[0]);
    }
  }
  if (!pending.length) return result;

  if (opts.cacheOnly) {
    result.unresolved = pending;
    for (const item of pending) if (!(item.key in lows)) lows[item.key] = null;
    return result;
  }

  const fresh: { key: string; cents: number; ttlMs: number }[] = [];
  const resolved = new Set<string>();
  let done = items.length - pending.length;
  let haltNetwork = false;
  const pacing: Pacing = {
    abort: () => Boolean(opts.abort?.() || haltNetwork),
    onWait: opts.onWait,
  };

  function noteStop(kind: "blocked" | "aborted"): void {
    haltNetwork = true;
    result.stopped ??= kind;
  }

  /** One price applies to every listing of that item. */
  function accept(item: ItemKeyed, cents: Cents | null): void {
    const group = byCacheKey.get(cacheKey(item)) ?? [item];
    for (const member of group) lows[member.key] = cents;
    if (cents != null) fresh.push({ key: cacheKey(item), cents, ttlMs });
    resolved.add(item.key);
    done += group.length;
  }

  async function runSearch(todo: ItemKeyed[]): Promise<void> {
    /**
     * Emoticons, backgrounds and cards each need their own query, so search would
     * cost one request per item and then a second one when it misses. Skip it.
     */
    if (batchingRatio(todo) < MIN_BATCHING_RATIO) {
      result.searchSkipped = "no-batching";
      return;
    }

    const groups = groupForSearch(todo);
    let attempted = 0;
    let hitGroups = 0;

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      if (pacing.abort?.()) {
        noteStop("aborted");
        return;
      }
      opts.onProgress?.(done, items.length, `поиск ${i + 1}/${groups.length} · ${group.query}`);
      try {
        const found = await fetchGroupPrices(group, pacing);
        result.requests += 1;
        attempted += 1;
        learnGroups(group.appid, found.groupIds);
        let matched = 0;
        for (const item of group.items) {
          const cents = found.prices.get(item.hash);
          if (cents != null) {
            accept(item, cents);
            matched += 1;
          }
        }
        if (matched) hitGroups += 1;
      } catch (err) {
        const stop = stopKind(err);
        if (stop) {
          noteStop(stop);
          return;
        }
        if (err instanceof SteamError && err.kind === "not_logged_in") throw err;
        /** A failed group is not fatal: its items fall through to the fallback. */
        result.requests += 1;
        attempted += 1;
      }

      /**
       * Stop early when search clearly is not finding these items, instead of
       * spending a request per group to learn the same thing 700 times.
       */
      if (attempted >= SEARCH_SAMPLE && hitGroups / attempted < SEARCH_MIN_HIT_RATE) {
        result.searchSkipped = "not-matching";
        return;
      }
    }
  }

  async function runOverview(todo: ItemKeyed[]): Promise<void> {
    let next = 0;
    let halted = false;

    async function worker(): Promise<void> {
      for (;;) {
        if (halted || haltNetwork) return;
        if (pacing.abort?.()) {
          noteStop("aborted");
          halted = true;
          return;
        }
        const item = todo[next++];
        if (!item) return;

        try {
          const cents = await fetchOverview(item, pacing);
          result.requests += 1;
          accept(item, cents);
        } catch (err) {
          const stop = stopKind(err);
          if (stop) {
            noteStop(stop);
            halted = true;
            return;
          }
          if (err instanceof SteamError && err.kind === "not_logged_in") throw err;
          /**
           * `success:false` is how Steam throttles priceoverview as often as how it
           * answers for a delisted item. Marking it resolved-as-null burned the rest
           * of a scan and hid those keys from «Догрузить цены». Leave them open.
           */
          result.requests += 1;
        }
        opts.onProgress?.(done, items.length, item.name);
      }
    }

    const size = Math.max(1, Math.min(opts.concurrency, todo.length));
    await Promise.all(Array.from({ length: size }, () => worker()));
  }

  try {
    if (opts.source === "search") {
      await runSearch(pending);
      const leftover = pending.filter((i) => !resolved.has(i.key));
      if (opts.fallbackToOverview !== false && !result.stopped && leftover.length) {
        await runOverview(leftover);
      }
    } else {
      await runOverview(pending);
    }
  } finally {
    if (fresh.length) {
      await send("cache/set", { entries: fresh.splice(0, fresh.length) }).catch(() => undefined);
    }
  }

  result.unresolved = pending.filter((i) => !resolved.has(i.key));
  for (const item of result.unresolved) {
    if (!(item.key in lows)) lows[item.key] = null;
  }
  return result;
}
