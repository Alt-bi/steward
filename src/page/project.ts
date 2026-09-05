/**
 * Projections of Steam's page globals into plain, cloneable data.
 *
 * `postMessage` structure-clones its argument, and Steam's globals are not
 * cloneable: `g_rgAppContextData` holds references to the DOM elements the
 * inventory page built, so posting it raises `DataCloneError` and the bridge dies
 * silently. Sending the whole object was wrong anyway — it is large and its shape
 * is not ours to depend on.
 *
 * Everything here copies named fields only, so whatever else Steam hangs off
 * these objects cannot reach the extension or break the handoff.
 */

import { isHiddenInventoryPage, parseTileId } from "../core/tiles";

function str(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function scalar(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function int(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** Drops keys whose value is undefined, so the payload stays small. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PlainWallet {
  wallet_currency?: string | number;
  wallet_country?: string;
  wallet_fee_percent?: string | number;
  wallet_fee_minimum?: string | number;
  wallet_fee_base?: string | number;
  wallet_market_minimum?: string | number;
  wallet_publisher_fee_percent_default?: string | number;
}

export function projectWallet(raw: unknown): PlainWallet | null {
  if (!isRecord(raw)) return null;
  return compact({
    wallet_currency: scalar(raw.wallet_currency),
    wallet_country: str(raw.wallet_country),
    wallet_fee_percent: scalar(raw.wallet_fee_percent),
    wallet_fee_minimum: scalar(raw.wallet_fee_minimum),
    wallet_fee_base: scalar(raw.wallet_fee_base),
    wallet_market_minimum: scalar(raw.wallet_market_minimum),
    wallet_publisher_fee_percent_default: scalar(raw.wallet_publisher_fee_percent_default),
  });
}

export interface PlainContext {
  id?: string;
  name?: string;
  asset_count?: number;
}

export interface PlainApp {
  appid?: number;
  name?: string;
  asset_count?: number;
  rgContexts?: Record<string, PlainContext>;
}

/** `g_rgAppContextData` — the table the inventory game picker is built from. */
export function projectAppContexts(raw: unknown): Record<string, PlainApp> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, PlainApp> = {};

  for (const [appidKey, app] of Object.entries(raw)) {
    if (!isRecord(app)) continue;
    const contexts: Record<string, PlainContext> = {};

    if (isRecord(app.rgContexts)) {
      for (const [ctxKey, context] of Object.entries(app.rgContexts)) {
        if (!isRecord(context)) continue;
        contexts[ctxKey] = compact({
          id: str(context.id) ?? ctxKey,
          name: str(context.name),
          asset_count: int(context.asset_count),
        });
      }
    }

    out[appidKey] = compact({
      appid: int(app.appid) ?? int(appidKey),
      name: str(app.name),
      asset_count: int(app.asset_count),
      rgContexts: contexts,
    });
  }
  return out;
}

export interface PlainAsset {
  amount?: string | number;
  market_hash_name?: string;
  market_name?: string;
  name?: string;
  commodity?: number;
  marketable?: number;
  tradable?: number;
}

function hashFromAsset(asset: Record<string, unknown>): string | undefined {
  const desc = isRecord(asset.description) ? asset.description : null;
  return (
    str(asset.market_hash_name) ??
    str(desc?.market_hash_name) ??
    str(asset.market_name) ??
    str(desc?.market_name) ??
    str(asset.name) ??
    str(desc?.name)
  );
}

/**
 * `g_rgAssets` — three levels of appid, contextid, assetid. Steam often leaves
 * the hash on a nested `description`; we lift it so the isolated world does not
 * have to know that shape.
 */
export function projectAssets(
  raw: unknown
): Record<string, Record<string, Record<string, PlainAsset>>> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, Record<string, Record<string, PlainAsset>>> = {};

  for (const [appid, byContext] of Object.entries(raw)) {
    if (!isRecord(byContext)) continue;
    const contexts: Record<string, Record<string, PlainAsset>> = {};

    for (const [contextid, byAsset] of Object.entries(byContext)) {
      if (!isRecord(byAsset)) continue;
      const assets: Record<string, PlainAsset> = {};

      for (const [assetid, asset] of Object.entries(byAsset)) {
        if (!isRecord(asset)) continue;
        const desc = isRecord(asset.description) ? asset.description : null;
        assets[assetid] = compact({
          amount: scalar(asset.amount) ?? scalar(desc?.amount),
          market_hash_name: hashFromAsset(asset),
          market_name: str(asset.market_name) ?? str(desc?.market_name),
          name: str(asset.name) ?? str(desc?.name),
          commodity: int(asset.commodity) ?? int(desc?.commodity),
          marketable: int(asset.marketable) ?? int(desc?.marketable),
          tradable: int(asset.tradable) ?? int(desc?.tradable),
        });
      }
      contexts[contextid] = assets;
    }
    out[appid] = contexts;
  }
  return out;
}

export interface PlainVisibleItem {
  appid?: number;
  contextid?: string;
  assetid?: string;
  amount?: string | number;
  market_hash_name?: string;
  market_name?: string;
  name?: string;
  marketable?: number;
  tradable?: number;
}

/**
 * Steam hangs the live item off the tile as `rgItem` (circular: it points back
 * at the element). Only named fields leave this function, so postMessage can
 * clone it.
 */
export function projectRgItem(raw: unknown, tileId?: string): PlainVisibleItem | null {
  const rec = isRecord(raw) ? raw : null;
  const desc = rec && isRecord(rec.description) ? rec.description : null;
  const fromId = parseTileId(tileId);
  const appid = int(rec?.appid) ?? fromId?.appid;
  const contextid = str(rec?.contextid) ?? fromId?.contextid;
  const assetid = str(rec?.assetid) ?? str(rec?.id) ?? fromId?.assetid;
  const hash = rec ? hashFromAsset(rec) : undefined;
  if (appid == null || !contextid || !assetid || !hash) return null;
  return compact({
    appid,
    contextid,
    assetid,
    amount: scalar(rec?.amount) ?? scalar(desc?.amount) ?? 1,
    market_hash_name: hash,
    market_name: str(rec?.market_name) ?? str(desc?.market_name),
    name: str(rec?.name) ?? str(desc?.name),
    marketable: int(rec?.marketable) ?? int(desc?.marketable),
    tradable: int(rec?.tradable) ?? int(desc?.tradable),
  });
}

/**
 * Tiles on the current inventory page, with names taken from `rgItem`. Hidden
 * Steam pages (`display:none`) are skipped — that is the SIH "what you see" set.
 */
export function projectVisibleInventory(root?: ParentNode | null): PlainVisibleItem[] | null {
  const host = root ?? (typeof document !== "undefined" ? document : null);
  if (!host || typeof host.querySelectorAll !== "function") return null;
  try {
    const nodes = host.querySelectorAll(".item[id], .inventory_page .item[id]");
    const out: PlainVisibleItem[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      const el = node as HTMLElement & { rgItem?: unknown };
      const page = typeof el.closest === "function" ? el.closest(".inventory_page") : null;
      if (isHiddenInventoryPage(page)) continue;
      const item = projectRgItem(el.rgItem, el.id || el.getAttribute?.("id") || undefined);
      if (!item?.assetid || item.appid == null || !item.contextid) continue;
      const key = `${item.appid}_${item.contextid}_${item.assetid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Posts to the page, refusing to let a clone failure escape as an uncaught error.
 * The projections above should make that impossible; this is the net under them.
 */
export interface PlainListing {
  listingid?: string;
  price?: string | number;
  fee?: string | number;
  converted_price?: string | number;
  converted_fee?: string | number;
}

/** `g_rgListingInfo` on a single-item market page — already the cheapest lots. */
export function projectListingInfo(raw: unknown): Record<string, PlainListing> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, PlainListing> = {};
  for (const [id, row] of Object.entries(raw)) {
    if (!isRecord(row)) continue;
    out[id] = compact({
      listingid: str(row.listingid) ?? id,
      price: scalar(row.price),
      fee: scalar(row.fee),
      converted_price: scalar(row.converted_price),
      converted_fee: scalar(row.converted_fee),
    });
  }
  return out;
}

export function safePost(payload: unknown, label: string): boolean {
  try {
    window.postMessage(payload, "*");
    return true;
  } catch (err) {
    console.warn(`[Steward] ${label} could not be posted`, err);
    return false;
  }
}
