/**
 * A console probe for /market, built out of the shipping parsers.
 *
 * The rule this repo learned the expensive way: the difference between a broken
 * parser and a moved page is one afternoon, and guessing costs more. So this
 * runs the real readers against the real page and prints what they saw —
 * `docs/market-shapes.md` was measured exactly this way.
 *
 * It reads. It never fetches, never writes, never touches a listing.
 *
 *   npm run probe   →  .probe/market.js  →  paste into the Edge console on
 *                      https://steamcommunity.com/market/
 */

import { hoverBlobOnPage, listingsFromDom, parseHovers } from "../src/steam/mylistings";
import { projectAssets } from "../src/page/project";
import type { SteamAssetIndex } from "../src/core/types";

const HOSTS = [
  "tabContentsMyActiveMarketListingsRows",
  "tabContentsMyActiveMarketListingsTable",
  "tabContentsMyListings",
];

/** The one thing the drawn row is supposed to state itself, if it states it. */
const CANCEL = /RemoveMarketListing\(\s*'mylisting'\s*,\s*'(\d+)'\s*,\s*(\d+)\s*,\s*'(\d+)'\s*,\s*'(\d+)'/;

function report(): Record<string, unknown> {
  const win = window as unknown as { g_rgAssets?: unknown; g_sessionID?: string; g_rgWalletInfo?: unknown };
  const assets = projectAssets(win.g_rgAssets) as SteamAssetIndex | null;

  const host = HOSTS.map((id) => document.getElementById(id)).find((n) => n) ?? null;
  const rows = Array.from(
    (host ?? document).querySelectorAll<HTMLElement>('.market_listing_row[id^="mylisting_"]')
  );

  const blob = hoverBlobOnPage();
  const hovers = parseHovers(blob);
  const listings = listingsFromDom(host ?? document.body, { assets, hovers: blob });

  const cancels = rows.filter((row) => CANCEL.test(row.innerHTML)).length;
  const named = listings.filter((l) => l.assetid).length;

  const sample = listings.slice(0, 3).map((l) => ({
    listingId: l.listingId,
    appid: l.appid,
    contextid: l.contextid,
    assetid: l.assetid ? "есть" : "НЕТ",
    hash: l.hash,
    buyer: l.ourBuyer,
    seller: l.ourSeller,
  }));

  return {
    page: location.pathname,
    globals: {
      g_sessionID: Boolean(win.g_sessionID),
      g_rgWalletInfo: Boolean(win.g_rgWalletInfo),
      g_rgAssets: assets ? Object.keys(assets).length : 0,
    },
    hostFound: host?.id ?? null,
    rowsDrawn: rows.length,
    scriptsOnPage: document.scripts.length,
    hoverBlobChars: blob.length,
    hoverRefs: Object.keys(hovers).length,
    rowsWithCancelButton: cancels,
    listingsParsed: listings.length,
    listingsWithAssetid: named,
    listingsWithPrice: listings.filter((l) => l.ourBuyer > 0).length,
    /** What the reprice scan would do with this page, in one line. */
    verdict:
      listings.length === 0
        ? "СТРАНИЦА НЕ ЧИТАЕТСЯ: скан скажет «нет лотов»"
        : named === listings.length
          ? "ОК: все лоты названы страницей, скан не пойдёт в /market/mylistings"
          : `ЧАСТИЧНО: ${listings.length - named} лот(ов) без assetid — скан будет их догружать`,
    sample,
  };
}

const out = report();
console.log("%cSteward · зонд маркета", "font-weight:bold");
console.log(out.verdict);
console.table([
  {
    строк: out.rowsDrawn as number,
    разобрано: out.listingsParsed as number,
    "с assetid": out.listingsWithAssetid as number,
    "с ценой": out.listingsWithPrice as number,
    "hover-ссылок": out.hoverRefs as number,
    "кнопок отмены": out.rowsWithCancelButton as number,
  },
]);
console.table(out.sample as object[]);
(window as unknown as { __steward?: unknown }).__steward = out;
console.log("Скопируй строку ниже целиком:");
console.log(JSON.stringify({ ...out, sample: undefined }));
