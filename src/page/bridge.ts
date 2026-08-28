/**
 * MAIN-world content script. Its only job is to hand the page's own globals to
 * the isolated world — it never makes requests and never touches the DOM.
 *
 * What it sends is a projection, never the raw globals: `postMessage`
 * structure-clones its argument, and Steam's inventory objects carry DOM
 * references that cannot be cloned. See `project.ts`.
 */

import { projectAppContexts, projectAssets, projectWallet, safePost } from "./project";

declare global {
  interface Window {
    g_sessionID?: string;
    g_steamID?: string | false;
    g_rgWalletInfo?: unknown;
    g_strLanguage?: string;
    g_strCountryCode?: string;
    g_rgAssets?: unknown;
    g_rgAppContextData?: unknown;
  }
}

const SOURCE = "steward-page";

function snapshot(): Record<string, unknown> {
  return {
    source: SOURCE,
    sessionid: window.g_sessionID ?? null,
    steamid: typeof window.g_steamID === "string" ? window.g_steamID : null,
    wallet: projectWallet(window.g_rgWalletInfo),
    language: window.g_strLanguage ?? "english",
    country: window.g_strCountryCode ?? null,
    assets: projectAssets(window.g_rgAssets),
    appContexts: projectAppContexts(window.g_rgAppContextData),
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
  if ((window.g_rgWalletInfo || window.g_rgAppContextData) && window.g_sessionID) {
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
