/**
 * MAIN-world content script. Its only job is to hand the page's own globals
 * and the inventory tiles currently on screen to the isolated world — it never
 * makes requests and never mutates the DOM.
 *
 * What it sends is a projection, never the raw globals: `postMessage`
 * structure-clones its argument, and Steam's inventory objects carry DOM
 * references that cannot be cloned. See `project.ts`.
 */

import {
  projectAppContexts,
  projectAssets,
  projectListingInfo,
  projectVisibleInventory,
  projectWallet,
  safePost,
} from "./project";
import { projectSsr } from "./ssr";

declare global {
  interface Window {
    g_sessionID?: string;
    g_steamID?: string | false;
    /** `{url, steamid, personaname, ...}` — whose profile page this is. */
    g_rgProfileData?: { steamid?: unknown } | null;
    g_rgWalletInfo?: unknown;
    g_strLanguage?: string;
    g_strCountryCode?: string;
    g_rgAssets?: unknown;
    g_rgAppContextData?: unknown;
    g_rgListingInfo?: unknown;
    /** The rewritten item page's own initial state. Absent on classic pages. */
    SSR?: unknown;
  }
}

const SOURCE = "steward-page";

/**
 * Whose backpack this is, from the page rather than from the URL.
 *
 * The inventory tab used to work this out with `ownerFromUrl`, which cannot see
 * past a vanity name and therefore fell back to the logged-in id — so on a
 * friend's inventory the panel believed the items were ours and offered to
 * list them. Steam states the owner outright on every profile page; read it.
 */
function profileSteamId(win: Window): string | null {
  const raw = (win.g_rgProfileData as { steamid?: unknown } | null | undefined)?.steamid;
  if (typeof raw === "string" && /^\d{5,}$/.test(raw)) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

function snapshot(): Record<string, unknown> {
  return {
    source: SOURCE,
    sessionid: window.g_sessionID ?? null,
    steamid: typeof window.g_steamID === "string" ? window.g_steamID : null,
    profileSteamid: profileSteamId(window),
    wallet: projectWallet(window.g_rgWalletInfo),
    language: window.g_strLanguage ?? "english",
    country: window.g_strCountryCode ?? null,
    assets: projectAssets(window.g_rgAssets),
    appContexts: projectAppContexts(window.g_rgAppContextData),
    listingInfo: projectListingInfo(window.g_rgListingInfo),
    itemPage: projectSsr(window),
    visibleItems: projectVisibleInventory(document),
  };
}

function send(): void {
  safePost(snapshot(), "page snapshot");
}

send();

/** Steam fills the globals a beat after document_idle, so poll briefly. */
let ticks = 0;
const timer = setInterval(() => {
  ticks += 1;
  /**
   * `window.SSR` on its own is enough. The rewritten item page defines none of
   * the classic globals — no `g_sessionID`, no `g_rgWalletInfo` — so requiring
   * one meant this poll never settled there and never sent its second snapshot.
   * A page that finished hydrating after document_idle was simply missed.
   */
  if (window.SSR || ((window.g_rgWalletInfo || window.g_rgAppContextData) && window.g_sessionID)) {
    send();
    clearInterval(timer);
    return;
  }
  if (ticks >= 60) clearInterval(timer);
}, 250);

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { source?: string; type?: string } | null;
  if (data?.source === "steward-ext" && data.type === "request-page") send();
});

export {};
