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
}

/**
 * `g_rgAssets` — three levels of appid, contextid, assetid. Only the four fields
 * the listing merger reads survive, which also shrinks a big inventory by orders
 * of magnitude.
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
        assets[assetid] = compact({
          amount: scalar(asset.amount),
          market_hash_name: str(asset.market_hash_name),
          market_name: str(asset.market_name),
          name: str(asset.name),
          commodity: int(asset.commodity),
        });
      }
      contexts[contextid] = assets;
    }
    out[appid] = contexts;
  }
  return out;
}

/**
 * Posts to the page, refusing to let a clone failure escape as an uncaught error.
 * The projections above should make that impossible; this is the net under them.
 */
export function safePost(payload: unknown, label: string): boolean {
  try {
    window.postMessage(payload, "*");
    return true;
  } catch (err) {
    console.warn(`[Steward] ${label} could not be posted`, err);
    return false;
  }
}
