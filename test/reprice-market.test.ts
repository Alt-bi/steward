import "./support/env";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { calls, jsonReply, postFromPage, resetEnv, setAcquire, setSteam } from "./support/env";
import { byTag, createElement, fire, installDom, type DomHandle, type FakeElement } from "./support/dom";

import "../src/content/features/reprice";
import { allFeatures } from "../src/content/features/registry";
import { DEFAULT_SETTINGS } from "../src/core/settings";

/**
 * The market tab against a Steam that refuses the listing book.
 *
 * Reported three times in a row as «ничего не работает», and it was: in exact
 * mode the price pass runs cache-only, because the book answers better and
 * cheaper. When the book is the thing refusing, that reasoning inverts — and
 * nothing inverted it, so the run made no requests, learned nothing, and
 * printed «Посчитано по рыночному минимуму: 0 из 10» having computed no
 * minimum at all.
 */

const HOME_PAGE =
  "<!DOCTYPE html><html><head><title>Сообщество Steam :: Торговая площадка сообщества Steam</title>" +
  "</head><body></body></html>";

const LISTINGS: [id: string, hash: string, price: string][] = [
  ["111", "489260-Rock Golem (Foil)", "100,00 руб."],
  ["222", "555920-Guardians (Foil)", "120,00 руб."],
];

/** The rows Steam has already drawn on /market, in the shape it draws them. */
function marketRows(): FakeElement {
  const host = createElement("div");
  host.id = "tabContentsMyActiveMarketListingsRows";
  for (const [id, hash, price] of LISTINGS) {
    const row = createElement("div");
    row.className = "market_listing_row";
    row.id = `mylisting_${id}`;

    const link = createElement("a");
    link.className = "market_listing_item_name_link";
    link.setAttribute("href", `https://steamcommunity.com/market/listings/753/${encodeURIComponent(hash)}`);
    link.textContent = hash;

    const cell = createElement("div");
    cell.className = "market_listing_my_price";
    cell.textContent = price;

    row.append(link, cell);
    host.append(row);
  }
  return host;
}

/** The hover blob, where /market really keeps it: a page-level script. */
function hoverScript(): { textContent: string } {
  const calls = LISTINGS.map(
    ([id], i) =>
      `CreateItemHoverFromContainer( g_rgAssets, 'mylisting_${id}_image', 753, '6', '${9000 + i}', 0 );`
  );
  return { textContent: calls.join(" ") };
}

function fakePanel(): { body: FakeElement; status: string[]; panel: never } {
  const body = createElement("div");
  const status: string[] = [];
  const panel = {
    addSection: () => ({
      id: "reprice",
      body,
      setStatus: (text: string) => status.push(text),
      show: () => {},
    }),
  };
  return { body, status, panel: panel as never };
}

describe("the market tab when Steam will not hand over the listing book", () => {
  let dom: DomHandle;

  beforeEach(async () => {
    await resetEnv();
    setAcquire(() => ({ ok: true as const }));
    dom = installDom("https://steamcommunity.com/market/", {
      byId: { tabContentsMyActiveMarketListingsRows: marketRows() },
      scripts: [hoverScript()],
    });
    // The MAIN-world bridge's snapshot: without a session id the scan refuses
    // before it starts, exactly as it does on a logged-out page.
    postFromPage({
      source: "steward-page",
      sessionid: "abc123",
      steamid: "76561198000000000",
      wallet: { wallet_currency: 5 },
      country: "RU",
    });
    setSteam((url) => {
      if (url.includes("QueryListingsForItem")) return { status: 200, body: HOME_PAGE };
      if (url.includes("/market/priceoverview/")) {
        return jsonReply({ success: true, lowest_price: "50,00 руб." });
      }
      if (url.includes("/market/search/render/")) {
        return jsonReply({ success: true, total_count: 0, results: [] });
      }
      if (url.includes("/market/mylistings")) {
        return jsonReply({
          success: true,
          pagesize: 100,
          start: 0,
          total_count: 2,
          num_active_listings: 2,
          assets: {
            "753": {
              "6": {
                "9000": { appid: 753, contextid: "6", id: "9000", market_hash_name: "489260-Rock Golem (Foil)", market_name: "Rock Golem (Металлическая)", amount: "1" },
                "9001": { appid: 753, contextid: "6", id: "9001", market_hash_name: "555920-Guardians (Foil)", market_name: "Guardians (Металлическая)", amount: "1" },
              },
            },
          },
          hovers:
            "CreateItemHoverFromContainer( g_rgAssets, 'mylisting_111_image', 753, '6', '9000', 0 );" +
            "CreateItemHoverFromContainer( g_rgAssets, 'mylisting_222_image', 753, '6', '9001', 0 );",
          results_html:
            '<div class="market_listing_row" id="mylisting_111">' +
            '<a class="market_listing_item_name_link" href="https://steamcommunity.com/market/listings/753/489260-Rock%20Golem%20%28Foil%29">Rock Golem (Foil)</a>' +
            '<div class="market_listing_my_price">100,00 руб.<br>(70,00 руб.)</div></div>' +
            '<div class="market_listing_row" id="mylisting_222">' +
            '<a class="market_listing_item_name_link" href="https://steamcommunity.com/market/listings/753/555920-Guardians%20%28Foil%29">Guardians (Foil)</a>' +
            '<div class="market_listing_my_price">120,00 руб.<br>(84,00 руб.)</div></div>',
        });
      }
      return jsonReply({ success: true });
    });
  });

  afterEach(() => {
    setAcquire(null);
    dom.restore();
  });

  it("still prices what it can, instead of doing nothing at all", async () => {
    const { body, panel, status } = fakePanel();
    const reprice = allFeatures().find((f) => f.id === "reprice")!;
    await reprice.mount({
      panel,
      settings: DEFAULT_SETTINGS,
      url: new URL("https://steamcommunity.com/market/"),
    });

    fire(byTag(body, "button").find((b) => b.textContent === "Сканировать лоты")!);
    for (let i = 0; i < 400 && !/из 2/.test(status.at(-1) ?? ""); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const said = status.at(-1) ?? "";
    // The whole point: two items priced, not zero. The book refused; the market
    // minimum is a different endpoint and it was never even asked before.
    assert.match(said, /по рыночному минимуму: 2 из 2/, said);
    assert.ok(
      calls.some((url) => url.includes("/market/priceoverview/")),
      "рыночный минимум так и не спросили — прогон снова ничего не сделал"
    );
    // And the run must not claim it spent nothing while it was working.
    assert.equal(/Запросов 0\./.test(said), false, said);
  });

  it("reads the listings off the page, hovers and all", async () => {
    // Same fixture, checked from the other side: the rows carry assetid and
    // contextid straight from the page script, so nothing has to page
    // /market/mylistings to recover what was already drawn.
    const { body, panel, status } = fakePanel();
    const reprice = allFeatures().find((f) => f.id === "reprice")!;
    await reprice.mount({
      panel,
      settings: DEFAULT_SETTINGS,
      url: new URL("https://steamcommunity.com/market/"),
    });

    fire(byTag(body, "button").find((b) => b.textContent === "Сканировать лоты")!);
    for (let i = 0; i < 400 && !/из 2/.test(status.at(-1) ?? ""); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      status.some((line) => /Лотов 2/.test(line) || /из 2/.test(line)),
      true,
      status.join(" | ")
    );
  });
});
