import { DEFAULT_FEES, feesFromWallet, type FeeConfig } from "../core/fees";
import type { AppContextData, PageContext, SteamAsset, SteamAssetIndex } from "../core/types";

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

  if (ctx.sessionid && resolveReady) {
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

export function currencyId(): number {
  const raw = ctx.wallet?.wallet_currency;
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
  return Number.isFinite(n) && n ? (n as number) : 5;
}

export function country(): string {
  if (ctx.country) return ctx.country;
  const raw = cookie("steamCountry") ?? "";
  const cc = raw.split("|")[0]?.split("%7C")[0];
  return cc || "RU";
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
