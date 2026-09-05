import { DEFAULT_FEES, feesFromWallet, type FeeConfig } from "../core/fees";
import type { PlainItemPage, PlainOrderBook } from "../page/ssr";
import type {
  AppContextData,
  Cents,
  PageContext,
  PageListingInfo,
  PageVisibleItem,
  SteamAsset,
  SteamAssetIndex,
} from "../core/types";

/**
 * `g_sessionID`, `g_rgWalletInfo` and `g_rgAssets` only exist on the page's own
 * `window`. The MAIN-world bridge posts them across; nothing else in the
 * extension touches page globals.
 */

export const BRIDGE_FROM_PAGE = "steward-page";
export const BRIDGE_TO_PAGE = "steward-ext";

const ctx: PageContext = {
  sessionid: null,
  steamid: null,
  wallet: null,
  language: "english",
  country: null,
  assets: null,
  appContexts: null,
  listingInfo: null,
  itemPage: null,
  visibleItems: null,
};

let fees: FeeConfig = { ...DEFAULT_FEES };
let resolveReady: (() => void) | null = null;
const ready = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as (Partial<PageContext> & { source?: string }) | null;
  if (!data || data.source !== BRIDGE_FROM_PAGE) return;

  if (data.sessionid) ctx.sessionid = data.sessionid;
  if (data.steamid) ctx.steamid = data.steamid;
  if (data.wallet) {
    ctx.wallet = data.wallet;
    fees = feesFromWallet(data.wallet);
  }
  if (data.language) ctx.language = data.language;
  if (data.country) ctx.country = data.country;
  if (data.assets) ctx.assets = data.assets;
  if (data.appContexts) ctx.appContexts = data.appContexts;
  if (data.listingInfo) ctx.listingInfo = data.listingInfo;
  /**
   * Replaced wholesale, never merged: the item page is a single-page app, so a
   * later snapshot is a different item, and keeping the previous book would
   * price one item against another one's competitors.
   */
  if ("itemPage" in data) ctx.itemPage = data.itemPage ?? null;
  /** Always replace: a missing grid must not keep the previous page's tiles. */
  if ("visibleItems" in data) ctx.visibleItems = data.visibleItems ?? null;

  /**
   * The rewritten item page has no `g_sessionID`, so waiting for one there meant
   * waiting out the whole timeout on every single load — four seconds before the
   * panel would say anything. The session id still arrives, from the cookie.
   */
  if ((ctx.sessionid || ctx.itemPage) && resolveReady) {
    resolveReady();
    resolveReady = null;
  }
});

export function requestPageInfo(): void {
  window.postMessage({ source: BRIDGE_TO_PAGE, type: "request-page" }, "*");
}

/** Resolves once the bridge handed us a session id, or after `timeoutMs`. */
export async function waitForPage(timeoutMs = 4000): Promise<void> {
  requestPageInfo();
  await Promise.race([ready, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

function cookie(name: string): string | null {
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(`${name}=`)) return decodeURIComponent(part.slice(name.length + 1));
  }
  return null;
}

export function sessionId(): string {
  return ctx.sessionid ?? cookie("sessionid") ?? "";
}

export function steamId(): string | null {
  return ctx.steamid;
}

/**
 * The wallet currency every price, cache key and history summary is keyed by.
 *
 * The rewritten item page defines no `g_rgWalletInfo`, no `g_strCountryCode` and
 * no `g_sessionID` — measured on a live page, all three undefined. So on every
 * item page this fell through to the hardcoded RUB, while `search` answers in the
 * user's real wallet currency and `priceoverview` answers in the one we asked
 * for: two currencies landing in one cache under one key, and a verdict comparing
 * a dollar price against a rouble average. The page carries its own wallet in
 * `CurrentUserWalletDetails`, and that is what this reads.
 */
export function currencyId(): number {
  const raw = ctx.wallet?.wallet_currency;
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
  if (Number.isFinite(n) && n) return n as number;
  return ctx.itemPage?.currency || 5;
}

/**
 * The language Steam should answer in. `/render/` prices and names its rows by
 * it, and the classic pages state it outright in `g_strLanguage`.
 */
export function language(): string {
  return ctx.language || "english";
}

export function country(): string {
  if (ctx.country) return ctx.country;
  const raw = cookie("steamCountry") ?? "";
  const cc = raw.split("|")[0]?.split("%7C")[0];
  /** Same story, and the cookie is not readable from script either. */
  return cc || ctx.itemPage?.country || "RU";
}

export function feeConfig(): FeeConfig {
  return fees;
}

export function assetIndex(): SteamAssetIndex | null {
  return ctx.assets;
}

export function appContexts(): AppContextData | null {
  return ctx.appContexts;
}

export function listingInfo(): Record<string, PageListingInfo> | null {
  return ctx.listingInfo;
}

/**
 * What the rewritten item page already knows: the whole listing book with our
 * own lots flagged, the market minimum for every item in the group, and their
 * sale histories. Null on the classic pages, which have none of it.
 */
export function itemPage(): PlainItemPage | null {
  return ctx.itemPage;
}

/**
 * The market minimum for one item of the open group, in cents.
 *
 * Two sources, because the first one is not always filled. Measured on
 * 2026-09-01: a busy commodity (Fracture Case) ships `min_price: 6021` in its
 * bucket, while a thin trading card ships `min_price: null` on a page whose own
 * order book says the cheapest lot is 81,27 ₽. Both numbers are Steam's, both
 * are already in the document, and taking the null as "no minimum" made the
 * panel spend a request — or give no verdict — for an answer it was holding.
 */
export function bucketMinimum(hash: string): Cents | null {
  const bucket = ctx.itemPage?.buckets.find((b) => b.hash === hash);
  if (bucket?.min != null) return bucket.min;
  return orderBook(hash)?.minSell ?? null;
}

/**
 * What buyers are offering for one item of the open group, when the page said.
 *
 * Steam only asks for the item the page is focused on, so this is null for every
 * other item of a group — which is the honest answer, not a zero.
 */
export function orderBook(hash: string): PlainOrderBook | null {
  return ctx.itemPage?.orders.find((o) => o.hash === hash) ?? null;
}

export function visibleInventory(): PageVisibleItem[] {
  return ctx.visibleItems ?? [];
}

/**
 * Asks the page bridge for a fresh snapshot and waits for it (or `timeoutMs`).
 * `waitForPage` resolves once on the first session id; this one is for "what is
 * on screen right now" after the user pages the inventory or listings.
 */
export function refreshPage(timeoutMs = 500): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMsg);
      resolve();
    };
    const onMsg = (event: MessageEvent): void => {
      if (event.source !== window) return;
      const data = event.data as { source?: string } | null;
      if (data?.source === BRIDGE_FROM_PAGE) finish();
    };
    window.addEventListener("message", onMsg);
    requestPageInfo();
    setTimeout(finish, timeoutMs);
  });
}

export function lookupAsset(
  index: SteamAssetIndex | null,
  appid: number | null | undefined,
  contextid: string | null | undefined,
  assetid: string | null | undefined
): SteamAsset | null {
  if (!index || appid == null || contextid == null || assetid == null) return null;
  const byApp = index[String(appid)];
  const byCtx = byApp?.[String(contextid)];
  return byCtx?.[String(assetid)] ?? null;
}
