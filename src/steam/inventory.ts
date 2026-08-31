import type { TileRef } from "../core/tiles";
import type { AppContextData, Cents, ItemKeyed, PageVisibleItem, SteamAsset, SteamAssetIndex } from "../core/types";
import { fetchJsonRetry, SteamError, type Pacing } from "./net";
import { lookupAsset } from "./page-context";

export type { TileRef };

/**
 * The inventory endpoint the inventory page itself uses. It answers with two flat
 * arrays that have to be joined: `assets` are the individual copies you own,
 * `descriptions` are the shared metadata, keyed by classid plus instanceid.
 */

interface RawAsset {
  appid?: number;
  contextid?: string;
  assetid?: string;
  classid?: string;
  instanceid?: string;
  amount?: string | number;
}

interface RawDescription {
  appid?: number;
  classid?: string;
  instanceid?: string;
  name?: string;
  market_name?: string;
  market_hash_name?: string;
  type?: string;
  icon_url?: string;
  tradable?: number;
  marketable?: number;
  commodity?: number;
  market_fee_app?: number;
  market_marketable_restriction?: number;
}

interface InventoryResponse {
  success?: number | boolean;
  assets?: RawAsset[] | null;
  descriptions?: RawDescription[] | null;
  total_inventory_count?: number;
  more_items?: number;
  last_assetid?: string;
  error?: string;
}

export interface InventoryItem {
  appid: number;
  contextid: string;
  assetid: string;
  amount: number;
  name: string;
  /** market_hash_name — the key every price endpoint wants. */
  hash: string;
  type: string;
  iconUrl: string;
  marketable: boolean;
  tradable: boolean;
}

export interface InventoryGroup {
  key: string;
  appid: number;
  hash: string;
  name: string;
  iconUrl: string;
  items: InventoryItem[];
  /** Total copies, counting stack amounts. */
  count: number;
}

function toInt(v: unknown, fallback = 0): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function descriptionKey(classid: unknown, instanceid: unknown): string {
  return `${String(classid ?? "")}_${String(instanceid ?? "0")}`;
}

/**
 * Joins the two arrays. Pulled out from the fetch so the join rules — which are
 * where the surprises live — can be tested without a network call.
 */
export function mergeInventory(payload: InventoryResponse): InventoryItem[] {
  const assets = payload.assets ?? [];
  const descriptions = payload.descriptions ?? [];

  const byKey = new Map<string, RawDescription>();
  for (const d of descriptions) byKey.set(descriptionKey(d.classid, d.instanceid), d);

  const out: InventoryItem[] = [];
  for (const asset of assets) {
    if (!asset.assetid) continue;
    const description = byKey.get(descriptionKey(asset.classid, asset.instanceid));
    /** Without a description there is no hash, and without a hash nothing can be priced. */
    if (!description) continue;

    const hash = description.market_hash_name ?? description.market_name ?? description.name ?? "";
    if (!hash) continue;

    out.push({
      appid: asset.appid ?? description.appid ?? 0,
      contextid: String(asset.contextid ?? "2"),
      assetid: String(asset.assetid),
      amount: toInt(asset.amount, 1) || 1,
      name: description.market_name ?? description.name ?? hash,
      hash,
      type: description.type ?? "",
      iconUrl: description.icon_url ?? "",
      marketable: description.marketable === 1,
      tradable: description.tradable === 1,
    });
  }
  return out;
}

export function groupInventory(items: InventoryItem[]): Map<string, InventoryGroup> {
  const groups = new Map<string, InventoryGroup>();
  for (const item of items) {
    const key = `${item.appid}\t${item.hash}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        appid: item.appid,
        hash: item.hash,
        name: item.name,
        iconUrl: item.iconUrl,
        items: [],
        count: 0,
      };
      groups.set(key, group);
    }
    group.items.push(item);
    group.count += item.amount;
  }
  return groups;
}

function toAmount(value: unknown): number {
  const n = toInt(value, 1);
  return n || 1;
}

/** Builds a pricable item from a page-world tile (`rgItem` or `g_rgAssets`). */
export function itemFromPageAsset(
  ref: TileRef,
  asset: SteamAsset | PageVisibleItem | null | undefined
): InventoryItem | null {
  const hash = asset?.market_hash_name ?? asset?.market_name ?? asset?.name ?? "";
  if (!hash) return null;
  const marketable = asset?.marketable;
  const tradable = asset?.tradable;
  return {
    appid: ref.appid,
    contextid: ref.contextid,
    assetid: ref.assetid,
    amount: toAmount(asset?.amount),
    name: asset?.market_name ?? asset?.name ?? hash,
    hash,
    type: "",
    iconUrl: "",
    marketable: marketable == null ? true : marketable === 1,
    tradable: tradable == null ? true : tradable === 1,
  };
}

export function itemsFromTiles(tiles: TileRef[], assets: SteamAssetIndex | null): InventoryItem[] {
  const out: InventoryItem[] = [];
  for (const tile of tiles) {
    const item = itemFromPageAsset(tile, lookupAsset(assets, tile.appid, tile.contextid, tile.assetid));
    if (item) out.push(item);
  }
  return out;
}

export function itemsFromVisible(visible: PageVisibleItem[]): InventoryItem[] {
  const out: InventoryItem[] = [];
  for (const row of visible) {
    const item = itemFromPageAsset(
      { appid: row.appid, contextid: row.contextid, assetid: row.assetid },
      row
    );
    if (item) out.push(item);
  }
  return out;
}

export function pickVisibleItems(all: InventoryItem[], tiles: TileRef[]): InventoryItem[] {
  if (!tiles.length) return [];
  const ids = new Set(tiles.map((t) => `${t.appid}_${t.contextid}_${t.assetid}`));
  return all.filter((item) => ids.has(`${item.appid}_${item.contextid}_${item.assetid}`));
}

export interface TileContext {
  appid: number;
  contextid: string;
  tiles: TileRef[];
}

/**
 * Tiles split by the inventory they belong to. One page can show more than one
 * context — CS2 keeps 2 and 16 side by side — so reading only the first one leaves
 * the rest of the grid without names.
 */
export function groupTilesByContext(tiles: TileRef[]): TileContext[] {
  const byKey = new Map<string, TileContext>();
  for (const tile of tiles) {
    const key = `${tile.appid}_${tile.contextid}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.tiles.push(tile);
    else byKey.set(key, { appid: tile.appid, contextid: tile.contextid, tiles: [tile] });
  }
  return [...byKey.values()];
}

export function mergeItemsByAsset(...lists: InventoryItem[][]): InventoryItem[] {
  const byId = new Map<string, InventoryItem>();
  for (const list of lists) {
    for (const item of list) {
      const key = `${item.appid}_${item.contextid}_${item.assetid}`;
      if (!byId.has(key)) byId.set(key, item);
    }
  }
  return [...byId.values()];
}

/** Total of `count × price` over the groups we have a price for. */
export function inventoryValue(
  groups: Map<string, InventoryGroup>,
  lows: Record<string, Cents | null>
): { total: Cents; priced: number; unpriced: number } {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  for (const group of groups.values()) {
    const low = lows[group.key];
    if (low == null) {
      unpriced += 1;
      continue;
    }
    priced += 1;
    total += low * group.count;
  }
  return { total, priced, unpriced };
}

export interface InventoryChoice {
  appid: number;
  contextid: string;
  label: string;
  count: number;
}

/**
 * Games with items, from `g_rgAppContextData`.
 *
 * Requiring `#730_2` in the URL was wrong: Steam only puts it there once the user
 * clicks a game, so a freshly opened inventory has no hash at all. The page always
 * knows the full table, so read that and offer a choice.
 */
export function contextsFromPage(data: AppContextData | null): InventoryChoice[] {
  if (!data) return [];
  const out: InventoryChoice[] = [];
  for (const [appidKey, app] of Object.entries(data)) {
    if (!app) continue;
    const appid = Number(app.appid ?? appidKey);
    if (!Number.isFinite(appid) || appid <= 0) continue;
    const appName = app.name ?? `App ${appid}`;
    const contexts = app.rgContexts ?? {};
    for (const [ctxKey, context] of Object.entries(contexts)) {
      if (!context) continue;
      const count = Number(context.asset_count ?? 0) || 0;
      /** An empty context is only noise in the picker. */
      if (count <= 0) continue;
      const contextid = String(context.id ?? ctxKey);
      const ctxName = context.name ?? "";
      const label = ctxName && ctxName !== appName ? `${appName} — ${ctxName}` : appName;
      out.push({ appid, contextid, label, count });
    }
  }
  /** Fullest first: that is almost always what the user wants to price. */
  out.sort((a, b) => b.count - a.count);
  return out;
}

export interface InventoryTarget {
  steamid: string;
  appid: number;
  contextid: string;
}

/**
 * Whose inventory the page is showing.
 *
 * `/profiles/{steamid}/inventory` says it outright. A vanity `/id/{name}/inventory`
 * does not, and the page global only tells us who is *logged in* — so on someone
 * else's vanity URL we would happily read our own inventory instead. Returning the
 * viewer with `assumed: true` lets the caller say so out loud.
 */
export function ownerFromUrl(
  pathname: string,
  viewerSteamId: string
): { steamid: string; assumed: boolean } | null {
  const explicit = pathname.match(/\/profiles\/(\d{5,})/);
  if (explicit?.[1]) return { steamid: explicit[1], assumed: false };
  if (!viewerSteamId) return null;
  return { steamid: viewerSteamId, assumed: true };
}

/**
 * Steam also writes the fragment as just `#227300`, with no context, so the appid
 * alone has to be readable — it is still enough to pick the right game.
 */
export function appidFromHash(hash: string): number | null {
  const match = /#(\d+)/.exec(String(hash ?? ""));
  if (!match?.[1]) return null;
  const appid = Number(match[1]);
  return Number.isFinite(appid) && appid > 0 ? appid : null;
}

/**
 * The inventory page keeps the selected game in the URL fragment, as `#730_2`.
 * Reading it means the panel follows whatever tab the user is looking at.
 */
export function targetFromHash(hash: string, steamid: string): InventoryTarget | null {
  if (!steamid) return null;
  const m = hash.match(/#(\d+)_(\d+)/);
  if (!m || !m[1] || !m[2]) return null;
  return { steamid, appid: Number(m[1]), contextid: m[2] };
}

export interface LoadInventoryResult {
  items: InventoryItem[];
  /** True when Steam said there is more than we fetched. */
  truncated: boolean;
  total: number;
}

/** ASF's cap: Steam web forcibly limits a single inventory request to this. */
export const INVENTORY_PAGE_SIZE = 2000;
export const INVENTORY_MAX_PAGES = 15;

export function inventoryPageUrl(target: InventoryTarget, startAssetId: string | null): string {
  return (
    `https://steamcommunity.com/inventory/${encodeURIComponent(target.steamid)}/` +
    `${encodeURIComponent(target.appid)}/${encodeURIComponent(target.contextid)}` +
    `?l=english&count=${INVENTORY_PAGE_SIZE}` +
    (startAssetId ? `&start_assetid=${encodeURIComponent(startAssetId)}` : "")
  );
}

/** Groups with at least one marketable copy — the only ones worth a price request. */
export function marketableGroups(groups: Map<string, InventoryGroup>): {
  toPrice: ItemKeyed[];
  skipped: number;
} {
  const toPrice: ItemKeyed[] = [];
  let skipped = 0;
  for (const group of groups.values()) {
    if (group.items.some((item) => item.marketable)) {
      toPrice.push({ key: group.key, appid: group.appid, hash: group.hash, name: group.name });
    } else {
      skipped += 1;
    }
  }
  return { toPrice, skipped };
}

export async function loadInventory(
  target: InventoryTarget,
  pacing: Pacing & { onProgress?: (loaded: number, total: number) => void }
): Promise<LoadInventoryResult> {
  const items: InventoryItem[] = [];
  const seen = new Set<string>();
  let startAssetId: string | null = null;
  let total = 0;
  let pages = 0;
  let truncated = false;

  for (;;) {
    if (pacing.abort?.()) throw new SteamError("aborted");

    const url: string = inventoryPageUrl(target, startAssetId);

    const data: InventoryResponse = await fetchJsonRetry<InventoryResponse>(url, {
      kind: "inventory",
      abort: pacing.abort,
      onWait: pacing.onWait,
    });
    pages += 1;
    if (!total) total = data.total_inventory_count ?? 0;

    for (const item of mergeInventory(data)) {
      if (seen.has(item.assetid)) continue;
      seen.add(item.assetid);
      items.push(item);
    }
    pacing.onProgress?.(items.length, total || items.length);

    if (!data.more_items || !data.last_assetid) break;
    /** Hitting the cap with more to come is the only honest "truncated". */
    if (pages >= INVENTORY_MAX_PAGES) {
      truncated = true;
      break;
    }
    startAssetId = data.last_assetid;
  }

  return { items, truncated, total: total || items.length };
}
