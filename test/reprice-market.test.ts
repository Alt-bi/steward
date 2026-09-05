import "./support/env";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { calls, jsonReply, postFromPage, resetEnv, setAcquire, setSteam } from "./support/env";
import {
  byTag,
  createElement,
  fire,
  installDom,
  walk,
  type DomHandle,
  type FakeElement,
} from "./support/dom";

import { runTimeMs } from "../src/content/features/reprice";
import { humanMinutes } from "../src/core/duration";
import { listingsOnPage } from "../src/steam/mylistings";
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

  async function scanned(): Promise<{ body: FakeElement; status: string[] }> {
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
    return { body, status };
  }

  it("still prices what it can, instead of doing nothing at all", async () => {
    const { status } = await scanned();
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

  it("prices through the real governor after the book answers with a page", async () => {
    // No stubbed permission: the scheduler itself decides, so a markup answer
    // filed as a throttle would leave the rescue pass with no requests to spend.
    setAcquire(null);
    const { status } = await scanned();
    const said = status.at(-1) ?? "";
    assert.match(said, /из 2/, said);
    assert.equal(/0 из 2/.test(said), false, said);
  });

  it("reads the listings off the page, hovers and all", async () => {
    // Same fixture, checked from the other side: the rows carry assetid and
    // contextid straight from the page script, so nothing has to page
    // /market/mylistings before the prices are asked for.
    const { status } = await scanned();
    const firstPrice = calls.findIndex((url) => url.includes("/market/priceoverview/"));
    const firstWalk = calls.findIndex((url) => url.includes("/market/mylistings"));
    assert.ok(
      firstWalk === -1 || (firstPrice !== -1 && firstWalk > firstPrice),
      `страница уже назвала предметы — ходить за ними в /market/mylistings незачем: ${calls.join(" | ")}`
    );
    assert.equal(
      status.some((line) => /Без assetid/.test(line)),
      false,
      status.join(" | ")
    );
  });
});

/**
 * The rule the whole tab hangs on: the cheapest lot on the market may be our
 * own, sitting on a page we are not looking at. The page shows two lots; the
 * account holds a third, of the same item, cheaper than both — and that third
 * lot is exactly what `priceoverview` reports as the market minimum.
 *
 * Stepping under it would be bidding against ourselves, one kopeck per scan,
 * forever. This is the case that has to end in «не двигаю» — and it is settled
 * by the item's own page, which names our lots of that item, rather than by
 * walking the entire account for ten listing ids that mattered.
 */
describe("a market minimum that is our own lot on another page", () => {
  let dom: DomHandle;
  /** What the market page states the account holds. Empty means it said nothing. */
  let totalCell: FakeElement;

  /** listingid -> [hash, price] for what the account holds, page or not. */
  const ACCOUNT: [string, string, number][] = [
    ["111", "489260-Rock Golem (Foil)", 10000],
    ["222", "555920-Guardians (Foil)", 12000],
    ["333", "489260-Rock Golem (Foil)", 4000],
  ];

  function money(cents: number): string {
    return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")} руб.`;
  }

  /**
   * What a stranger asks for Guardians. Golem's minimum is always our own
   * hidden 40,00 — that is the subject of the suite — while Guardians has a
   * real competitor, and how far under him the move lands is what the ceiling
   * test below turns up by lowering this one number.
   */
  let guardiansLow = 11500;

  beforeEach(async () => {
    await resetEnv();
    setAcquire(() => ({ ok: true as const }));
    totalCell = createElement("div");
    totalCell.id = "tabContentsMyActiveMarketListings_total";
    totalCell.textContent = "";
    dom = installDom("https://steamcommunity.com/market/", {
      byId: {
        tabContentsMyActiveMarketListingsRows: marketRows(),
        tabContentsMyActiveMarketListings_total: totalCell,
      },
      scripts: [hoverScript()],
    });
    guardiansLow = 11500;
    postFromPage({
      source: "steward-page",
      sessionid: "abc123",
      steamid: "76561198000000000",
      wallet: { wallet_currency: 5 },
      country: "RU",
    });
    setSteam((url) => {
      if (url.includes("QueryListingsForItem")) return { status: 200, body: HOME_PAGE };
      /** Golem's minimum is our own 40,00 — Steam just does not say whose it is. */
      if (url.includes("/market/priceoverview/")) {
        const guardians = decodeURIComponent(url).includes("Guardians");
        return jsonReply({ success: true, lowest_price: money(guardians ? guardiansLow : 4000) });
      }
      if (url.includes("/market/search/render/")) {
        return jsonReply({ success: true, total_count: 0, results: [] });
      }
      /**
       * The item's own page, which states our lots of *that item*. This is the
       * answer that used to cost a walk of the entire account.
       */
      const item = /\/market\/listings\/753\/([^/?#]+)$/.exec(url);
      if (item) {
        const hash = decodeURIComponent(item[1]!);
        const ours = ACCOUNT.filter(([, name]) => name === hash);
        return {
          status: 200,
          body:
            "<html><body><script>var g_rgListingInfo = {};</script>" +
            ours
              .map(
                ([id, , price]) =>
                  `<div class="market_listing_row" id="mylisting_${id}">` +
                  `<a class="market_listing_item_name_link" href="https://steamcommunity.com/market/listings/753/${encodeURIComponent(hash)}">${hash}</a>` +
                  `<div class="market_listing_my_price">${money(price)}<br>(${money(Math.round(price * 0.85))})</div></div>`
              )
              .join("") +
            "</body></html>",
        };
      }
      if (url.includes("/market/mylistings")) {
        return jsonReply({
          success: true,
          pagesize: 100,
          start: 0,
          total_count: ACCOUNT.length,
          num_active_listings: ACCOUNT.length,
          assets: {
            "753": {
              "6": Object.fromEntries(
                ACCOUNT.map(([id, hash]) => [
                  `9${id}`,
                  { appid: 753, contextid: "6", id: `9${id}`, market_hash_name: hash, market_name: hash, amount: "1" },
                ])
              ),
            },
          },
          hovers: ACCOUNT.map(
            ([id]) => `CreateItemHoverFromContainer( g_rgAssets, 'mylisting_${id}_image', 753, '6', '9${id}', 0 );`
          ).join(""),
          results_html: ACCOUNT.map(
            ([id, hash, price]) =>
              `<div class="market_listing_row" id="mylisting_${id}">` +
              `<a class="market_listing_item_name_link" href="https://steamcommunity.com/market/listings/753/${encodeURIComponent(hash)}">${hash}</a>` +
              `<div class="market_listing_my_price">${money(price)}<br>(${money(Math.round(price * 0.85))})</div></div>`
          ).join(""),
        });
      }
      return jsonReply({ success: true });
    });
  });

  afterEach(() => {
    setAcquire(null);
    dom.restore();
  });

  it("leaves the item alone and moves the other one", async () => {
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

    const rows = walk(body).filter((n) => n.dataset.id);
    const golem = rows.find((n) => n.dataset.id === "111");
    const guardians = rows.find((n) => n.dataset.id === "222");
    assert.ok(golem && guardians, "обе строки должны быть нарисованы");
    assert.notEqual(
      golem!.dataset.kind,
      "reprice",
      `подрезали собственный лот: ${golem!.textContent}`
    );
    assert.equal(guardians!.dataset.kind, "reprice", guardians!.textContent);
    assert.match(status.at(-1) ?? "", /к переносу: 1/, status.at(-1) ?? "");
    /** Two items to settle, and the page says nothing about the account size. */
    assert.equal(
      calls.filter((url) => /\/market\/mylistings/.test(url)).length,
      0,
      `весь аккаунт читать было незачем: ${calls.join(" | ")}`
    );
  });

  /**
   * The guard rail on the one button that cannot be taken back.
   *
   * Undercutting by a kopeck lands on whatever the cheapest stranger asks, and
   * a thin book turns that into «минус 67%». Sixty-seven of those go out on one
   * click that nobody read row by row, so a move past the ceiling comes back
   * shown, counted and **unticked** — refusing it outright would hide the row,
   * and hiding it is how the owner never learns the number.
   */
  it("shows a move deeper than the ceiling but does not tick it", async () => {
    guardiansLow = 4000;
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

    const rows = walk(body).filter((n) => n.dataset.id);
    const guardians = rows.find((n) => n.dataset.id === "222")!;
    assert.equal(guardians.dataset.kind, "reprice", "строка остаётся на виду");
    assert.match(guardians.textContent ?? "", /−\d+%/, "и называет глубину");
    assert.match(guardians.textContent ?? "", /не отмечен/, guardians.textContent ?? "");
    assert.equal(
      /к переносу/.test(status.at(-1) ?? ""),
      false,
      `в очередь такой сдвиг не встаёт: ${status.at(-1)}`
    );
  });

  /**
   * The same question, priced the other way round.
   *
   * Per item is cheap only while there are few items. A page of a hundred lots
   * left sixty-seven of them unattributed on a live account — sixty-seven
   * requests against seven for the entire account. So the two roads are priced
   * against each other, and the number the page itself states is what decides.
   */
  it("reads the whole account when that is the shorter road", async () => {
    totalCell.textContent = "100 лотов";
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
      calls.filter((url) => /\/market\/mylistings/.test(url)).length,
      1,
      `один проход по аккаунту дешевле двух страниц предметов: ${calls.join(" | ")}`
    );
    assert.equal(
      calls.filter((url) => /\/market\/listings\/753\/[^/?#]+$/.test(url)).length,
      0,
      `страницы предметов спрашивать было незачем: ${calls.join(" | ")}`
    );
    const rows = walk(body).filter((n) => n.dataset.id);
    assert.notEqual(rows.find((n) => n.dataset.id === "111")!.dataset.kind, "reprice");
    assert.equal(rows.find((n) => n.dataset.id === "222")!.dataset.kind, "reprice");
  });

  /**
   * The walk reads every lot the account holds, and used to keep only the
   * handful that asked. Page two of the market then paid the same seven paced
   * requests over again for lots that had been in hand a minute earlier — and
   * on a live account those seven requests are half a minute of «бюджет
   * запросов 6с» with the answer already sitting in memory.
   */
  it("answers a second scan out of the walk it already made", async () => {
    totalCell.textContent = "100 лотов";
    const { body, panel, status } = fakePanel();
    const reprice = allFeatures().find((f) => f.id === "reprice")!;
    await reprice.mount({
      panel,
      settings: DEFAULT_SETTINGS,
      url: new URL("https://steamcommunity.com/market/"),
    });

    const scanBtn = byTag(body, "button").find((b) => b.textContent === "Сканировать лоты")!;
    fire(scanBtn);
    for (let i = 0; i < 400 && !/из 2/.test(status.at(-1) ?? ""); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const mark = status.length;
    fire(scanBtn);
    for (let i = 0; i < 400 && !status.slice(mark).some((line) => /из 2/.test(line)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(
      calls.filter((url) => /\/market\/mylistings/.test(url)).length,
      1,
      `аккаунт прочитан один раз на оба скана: ${calls.join(" | ")}`
    );
    assert.match(status.at(-1) ?? "", /из 2/, status.at(-1) ?? "");
  });
});

/**
 * The pager rewrites the rows and leaves the hovers behind.
 *
 * Measured 2026-09-03 on a live /market: paging «Мои лоты» to page two swaps
 * every row over AJAX, but `document.scripts` is untouched — the hover block
 * still describes page one, and `g_rgAssets` still holds page one’s assets, so
 * every one of those absent listings resolves cleanly. Read without scoping,
 * the page reader does not fill rows in from the block, it invents ten of them:
 * listings the owner cannot see, priced at zero, offered up for repricing.
 */
describe("the rows on screen, when the hover block still describes the last page", () => {
  let dom: DomHandle;

  const drawn = () => {
    const host = createElement("div");
    host.id = "tabContentsMyActiveMarketListingsRows";
    const row = createElement("div");
    row.className = "market_listing_row";
    row.id = "mylisting_111";
    const link = createElement("a");
    link.className = "market_listing_item_name_link";
    link.setAttribute("href", "https://steamcommunity.com/market/listings/753/489260-Rock%20Golem%20%28Foil%29");
    link.textContent = "Rock Golem (Foil)";
    const cell = createElement("div");
    cell.className = "market_listing_my_price";
    cell.textContent = "2,61 руб. (0,87 руб.)";
    row.append(link, cell);
    host.append(row);
    return host;
  };

  beforeEach(async () => {
    await resetEnv();
    dom = installDom("https://steamcommunity.com/market/", {
      byId: { tabContentsMyActiveMarketListingsRows: drawn() },
      scripts: [
        {
          textContent:
            "CreateItemHoverFromContainer( g_rgAssets, 'mylisting_111_image', 753, '6', '9000', 0 );" +
            "CreateItemHoverFromContainer( g_rgAssets, 'mylisting_999_image', 753, '6', '9999', 0 );",
        },
      ],
    });
    postFromPage({
      source: "steward-page",
      sessionid: "abc123",
      assets: {
        "753": {
          "6": {
            "9000": { appid: 753, contextid: "6", id: "9000", market_hash_name: "489260-Rock Golem (Foil)" },
            "9999": { appid: 753, contextid: "6", id: "9999", market_hash_name: "555920-Guardians (Foil)" },
          },
        },
      },
    });
  });

  afterEach(() => {
    dom.restore();
  });

  it("counts the drawn row and refuses to invent the one only the script remembers", () => {
    const listings = listingsOnPage();
    assert.deepEqual(
      listings.map((l) => l.listingId),
      ["111"],
      "a listing on another page is not on this one"
    );
    assert.equal(listings[0]!.ourBuyer, 261);
    assert.equal(listings[0]!.ourSeller, 87);
  });

  it("still takes the asset the block names for a row that is drawn", () => {
    assert.equal(listingsOnPage()[0]!.assetid, "9000", "the row itself has no cancel button");
  });
});

/**
 * What the click costs, said before it is clicked.
 *
 * Sixty-seven lots is not «a click»: every one of them is two paced writes and
 * two pauses, and each is off the market in between. Half an hour is a fact the
 * owner is entitled to before agreeing, not after.
 */
describe("naming the cost of a run", () => {
  it("prices a batch by its writes and its pauses", () => {
    /** Two writes at eight a minute is fifteen seconds, plus two pauses. */
    assert.equal(runTimeMs(1, 2500), 15_000 + 5_000);
    assert.equal(runTimeMs(67, 2500), 67 * 20_000);
  });

  it("says it in the unit a person would use", () => {
    assert.equal(humanMinutes(40_000), "40 с");
    assert.equal(humanMinutes(67 * 20_000), "22 мин");
    assert.equal(humanMinutes(65 * 60_000), "1 ч 5 мин");
    assert.equal(humanMinutes(120 * 60_000), "2 ч");
  });
});
