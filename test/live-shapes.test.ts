import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseMoneyToCents } from "../src/core/money";
import { extractHoverJson, parseItemClass } from "../src/steam/descriptions";
import { myListingsFrom } from "../src/steam/mylistings";
import { focusedItem, projectSsr } from "../src/page/ssr";
import { pricesFromResults } from "../src/steam/search";

/**
 * Parsers against payloads Steam actually sent.
 *
 * Everything else in this suite is our own idea of what Steam returns. These four
 * files were captured from steamcommunity.com on 2026-08-28 and are checked in
 * verbatim, so the day Valve changes a field the suite says so instead of a user
 * discovering it as an empty panel.
 *
 * Re-capture with the browser and overwrite the file; do not hand-edit them.
 *
 * Read from the repo root, not from `import.meta.url`: the suite is bundled into
 * `.test-build/` before it runs, so a path relative to the module would point at
 * the build directory.
 */

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "test", "fixtures", name), "utf8");
}

describe("itemclasshover, as served", () => {
  const body = fixture("itemclasshover-730.txt");

  it("is a script, not JSON — which is why the transport has fetchText", () => {
    assert.ok(body.includes("BuildHover("));
    assert.throws(() => JSON.parse(body) as unknown);
  });

  it("yields a parseable object through the brace walker", () => {
    const json = extractHoverJson(body);
    assert.ok(json, "the object inside BuildHover( … ) must be found");
    const raw = JSON.parse(json!) as Record<string, unknown>;
    assert.equal(raw.market_hash_name, "AK-47 | Redline (Battle-Scarred)");
  });

  it("becomes the item class the offers tab prices against", () => {
    const cls = parseItemClass({ appid: 730, classid: "7993038091", instanceid: "0" }, body);
    assert.ok(cls);
    assert.equal(cls!.hash, "AK-47 | Redline (Battle-Scarred)");
    assert.equal(cls!.name, "AK-47 | Redline (Battle-Scarred)");
    /** Steam sends these as the numbers 1, not booleans and not omitted. */
    assert.equal(cls!.marketable, true);
    assert.equal(cls!.tradable, true);
  });

  it("survives the escaped slashes and newlines in the description", () => {
    /** `<\/i>` and `\n\n` inside a JSON string are what break a naive scanner. */
    assert.ok(body.includes("<\\/i>"));
    assert.ok(extractHoverJson(body)!.includes("<\\/i>"));
  });
});

describe("priceoverview, as served", () => {
  const data = JSON.parse(fixture("priceoverview-730.json")) as {
    success: boolean;
    lowest_price: string;
  };

  it("still answers with the fields the price scanner reads", () => {
    assert.equal(data.success, true);
    assert.equal(typeof data.lowest_price, "string");
  });

  it("prices as a localised string that our parser turns into cents", () => {
    /** `32,91€` — comma decimal, symbol suffixed, no thousands separator. */
    assert.equal(parseMoneyToCents(data.lowest_price), 3291);
  });
});

describe("search/render, as served", () => {
  const data = JSON.parse(fixture("search-render-730.json")) as {
    results: { hash_name: string; sell_price: number; sell_price_text: string }[];
  };

  it("still carries hash_name and an integer sell_price", () => {
    const prices = pricesFromResults(data.results);
    assert.equal(prices.get("AK-47 | Redline (Field-Tested)"), 3830);
    assert.equal(prices.get("AK-47 | Redline (Minimal Wear)"), 18550);
  });

  it("prices in the session's own wallet, not the currency in the query", () => {
    /**
     * Captured anonymously with `currency=3` (EUR): `priceoverview` honoured it
     * and said `32,91€`, while search answered `$38.30 USD` for the same item at
     * the same moment. Signed in, both answer in the wallet currency — search
     * ignores the parameter and uses the wallet, and with no wallet that is USD.
     *
     * So the number is safe to cache under the wallet currency, which is what
     * `historyKey` and the price cache already key on. What would not be safe is
     * trusting the `currency` parameter to mean anything.
     */
    assert.match(data.results[0]!.sell_price_text, /USD/);
    assert.equal(data.results[0]!.sell_price, 3830);
    const asEuro = parseMoneyToCents("32,91€");
    assert.notEqual(data.results[0]!.sell_price, asEuro);
  });
});

describe("mylistings, as it answers today", () => {
  /**
   * Captured 2026-08-29 from an account holding 761 listings. Steam no longer
   * sends `listinginfo`, `listings`, `listings_on_hold` or `listings_to_confirm`
   * — none of them. It sends `results_html`, the `assets` that markup draws, and
   * a `hovers` block of `CreateItemHoverFromContainer(…)` calls, which is now the
   * only place a listing is tied to the asset behind it.
   *
   * The fixture keeps two listings' worth of hovers and one row of markup; the
   * fields that decide anything are verbatim.
   */
  const answer = JSON.parse(fixture("mylistings-hovers.json")) as Record<string, unknown>;

  it("is not an empty answer, whatever the old fields say", () => {
    /**
     * This is what actually broke. `isEmpty` looked for the JSON shapes, found
     * none, and reported a soft throttle — so a perfectly good answer counted as
     * Steam stonewalling, four in a row opened the breaker, and the scan stopped.
     * The fourth time this codebase has made the same mistake.
     */
    assert.equal(myListingsFrom(answer).ids.size, 2);
  });

  it("recovers the asset behind each listing, which is what re-listing needs", () => {
    /**
     * Without it a lot can be taken off the market and not put back — the one
     * half-success the reprice loop must never reach. The page itself no longer
     * carries this: measured on the live market, no row has an `onmouseover` and
     * `g_rgListingInfo` is an empty object.
     */
    const refs = myListingsFrom(answer).refs;
    assert.deepEqual(refs.get("555779260420047567"), {
      appid: 753,
      contextid: "6",
      assetid: "38162536060",
    });
    assert.equal(refs.get("555779260420050411")?.assetid, "38161958638");
  });

  it("does not claim to have seen 761 listings after being shown two", () => {
    /** A lot at our price could be ours, on a page we never asked for. */
    assert.equal(myListingsFrom(answer).complete, false);
  });

  it("counts an account with nothing listed as an answer, not as a refusal", () => {
    const empty = myListingsFrom({ success: true, total_count: 0, num_active_listings: 0 });
    assert.equal(empty.ids.size, 0);
    assert.equal(empty.complete, true, "nothing listed is a set we have seen all of");
  });
});

describe("the rewritten item page, as served", () => {
  /** The file is the `window.SSR` object itself, as the page carries it. */
  const win = { SSR: JSON.parse(fixture("item-page-ssr.json")) as unknown };
  /** Pinned: the projection drops points older than a year, and fixtures age. */
  const NOW = Date.UTC(2026, 7, 29);

  it("hands over the book Steam stopped serving at /render/", () => {
    const out = projectSsr(win, NOW);
    assert.ok(out, "the page must still be recognisable as the rewritten one");
    assert.equal(out!.appid, 753);
    assert.equal(out!.listings.length, 1);
  });

  it("says outright that the only lot is ours — no ids, no second request", () => {
    /**
     * `/render/` never told us this. It is the whole reason the exact competitor
     * check needed `mylistings` first, and why a lot on the next page of it
     * could be mistaken for a stranger's and undercut.
     */
    const listing = projectSsr(win, NOW)!.listings[0]!;
    assert.equal(listing.mine, true);
    assert.equal(listing.listingid, "555779000000000001");
    /** 355 to the seller plus 172 in fees is the 5,27 руб. the page shows. */
    assert.equal(listing.price + listing.fee, 527);
  });

  it("keeps our own sell order, which is how the page states ownership twice", () => {
    assert.deepEqual(projectSsr(win, NOW)!.mine, ["555779000000000001"]);
  });

  it("does not invent a minimum for a bucket Steam priced at nothing", () => {
    /** This item's bucket carries no `min_price` at all — null, never zero. */
    assert.deepEqual(projectSsr(win, NOW)!.buckets, [
      { hash: "318680-Remy Chaveau", min: null, classid: undefined },
    ]);
  });

  it("is its own item, so the name in the URL is left exactly as it stands", () => {
    /**
     * The counterpart to a grouped page: a card is listed under its own hash, so
     * resolving the URL against the page's focus must not move us off it.
     */
    const out = projectSsr(win, NOW)!;
    assert.equal(focusedItem(out, "318680-Remy Chaveau"), "318680-Remy Chaveau");
  });

  it("ships the sale history the panel would otherwise pay a request for", () => {
    const history = projectSsr(win, NOW)!.histories;
    assert.equal(history.length, 1);
    assert.equal(history[0]!.hash, "318680-Remy Chaveau");
    /** Unix seconds and a wallet-unit float, where the old endpoint sent a date string. */
    assert.deepEqual(history[0]!.points.at(-1), [1784937600, 5.773963451385498, 1]);
  });
});

describe("mylistings, as served", () => {
  const data = JSON.parse(fixture("mylistings-render.json")) as Parameters<typeof myListingsFrom>[0];

  it("no longer carries the listinginfo map the old parser read", () => {
    /**
     * The whole reason this fixture exists. Steam moved our own listings from a
     * map keyed by listing id to three arrays, and the reader that only knew the
     * map saw «no listings» — which the governor counts as a throttle.
     */
    assert.equal((data as { listinginfo?: unknown }).listinginfo, undefined);
    assert.ok(Array.isArray((data as { listings?: unknown[] }).listings));
  });

  it("still names every listing of ours, held and unconfirmed included", () => {
    const page = myListingsFrom(data);
    assert.equal(page.ids.size, 3, "two active plus the one awaiting confirmation");
    assert.ok(page.ids.has("500000000000000005"), "a lot we have not confirmed is still ours");
  });

  it("resolves the asset behind each listing, which is what re-listing needs", () => {
    const refs = myListingsFrom(data).refs;
    assert.deepEqual(refs.get("500000000000000001"), {
      appid: 753,
      contextid: "6",
      assetid: "900000000000000002",
    });
  });

  it("does not claim to have seen everything from one page of 778", () => {
    assert.equal(myListingsFrom(data).complete, false);
  });

  it("counts completeness against active listings alone", () => {
    /** `total_count` counts only active lots, so the pending one must not pad it. */
    const onePage = { ...data, total_count: 2 };
    assert.equal(myListingsFrom(onePage).complete, true);
    const short = { ...data, total_count: 3 };
    assert.equal(myListingsFrom(short).complete, false);
  });

  it("still reads the classic map, because /market/ has not been rewritten", () => {
    const page = myListingsFrom({
      listinginfo: { "77": { listingid: "77", asset: { appid: 730, contextid: "2", id: "9" } } },
      total_count: 1,
    });
    assert.deepEqual([...page.ids], ["77"]);
    assert.equal(page.refs.get("77")?.assetid, "9");
    assert.equal(page.complete, true);
  });
});
