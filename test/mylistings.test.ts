import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assembleListings,
  myListingsFrom,
  parseHovers,
  pricesFromListingText,
} from "../src/steam/mylistings";

describe("assembleListings", () => {
  it("builds a listing from listinginfo plus g_rgAssets, without HTML", () => {
    const listings = assembleListings({
      info: {
        "42": {
          listingid: "42",
          converted_price: 100,
          converted_fee: 15,
          asset: { appid: 730, contextid: "2", id: "99", amount: 1 },
        },
      },
      assets: {
        "730": { "2": { "99": { market_hash_name: "Chroma Case", market_name: "Chroma Case" } } },
      },
    });
    assert.equal(listings.length, 1);
    assert.equal(listings[0]!.listingId, "42");
    assert.equal(listings[0]!.hash, "Chroma Case");
    assert.equal(listings[0]!.assetid, "99");
    assert.equal(listings[0]!.ourBuyer, 115);
  });

  it("recovers assetid from the hover blob when listinginfo has no asset", () => {
    const listings = assembleListings({
      hovers: parseHovers(
        "CreateItemHoverFromContainer( g_rgAssets, 'mylisting_7', 730, '2', '55' );"
      ),
      assets: {
        "730": { "2": { "55": { market_hash_name: "AK-47 | Redline (Field-Tested)" } } },
      },
    });
    assert.equal(listings.length, 1);
    assert.equal(listings[0]!.listingId, "7");
    assert.equal(listings[0]!.assetid, "55");
    assert.equal(listings[0]!.appid, 730);
  });
});

describe("pricesFromListingText", () => {
  it("reads the classic two-line cell: buyer on top, you-receive below", () => {
    assert.deepEqual(pricesFromListingText("3,00 pуб.\n2,58 pуб."), { buyer: 300, seller: 258 });
  });

  it("reads the Market Beta cell: buyer, then you-receive in parentheses", () => {
    assert.deepEqual(pricesFromListingText("2,58 pуб. (2,21 pуб.)"), { buyer: 258, seller: 221 });
    assert.deepEqual(pricesFromListingText("0,05€ (0,03€)"), { buyer: 5, seller: 3 });
  });

  it("does not turn «3 часа назад» into 3,00 ₽ when the real price is 2,58", () => {
    const parsed = pricesFromListingText("AK-47 | Redline\n3 часа назад\n2,58 pуб. (2,21 pуб.)");
    assert.deepEqual(parsed, { buyer: 258, seller: 221 });
  });

  it("ignores English listed-date numbers the same way", () => {
    const parsed = pricesFromListingText("3 hours ago\n2,58 pуб.");
    assert.equal(parsed.buyer, 258);
    assert.equal(parsed.seller, 0);
  });

  it("does not glue buyer and seller into one huge number", () => {
    /** The Beta-UI bug: `0,05€ (0,03€)` parsed as a single token became €50.03. */
    assert.notEqual(pricesFromListingText("0,05€ (0,03€)").buyer, 5003);
    assert.equal(pricesFromListingText("0,05€ (0,03€)").buyer, 5);
  });

  it("treats a single price as what the buyer pays", () => {
    assert.deepEqual(pricesFromListingText("2,58 pуб."), { buyer: 258, seller: 0 });
  });

  it("swaps if the smaller you-receive amount was written first", () => {
    assert.deepEqual(pricesFromListingText("2,58 pуб.\n3,00 pуб."), { buyer: 300, seller: 258 });
  });

  it("returns zeros when the row has no money at all", () => {
    assert.deepEqual(pricesFromListingText("3 hours ago"), { buyer: 0, seller: 0 });
    assert.deepEqual(pricesFromListingText(""), { buyer: 0, seller: 0 });
  });
});

describe("myListingsFrom", () => {
  it("only claims completeness when the answer covered every listing", () => {
    const page = myListingsFrom({
      total_count: 2,
      listinginfo: { "1": { listingid: "1" }, "2": { listingid: "2" } },
    });
    assert.deepEqual([...page.ids].sort(), ["1", "2"]);
    assert.equal(page.complete, true);
  });

  it("admits it saw only part of them", () => {
    const page = myListingsFrom({ total_count: 300, listinginfo: { "1": { listingid: "1" } } });
    assert.equal(page.complete, false, "a lot at our price could be ours, on page two");
  });

  it("refuses to claim completeness without a total to compare against", () => {
    assert.equal(myListingsFrom({ listinginfo: { "1": { listingid: "1" } } }).complete, false);
    assert.equal(myListingsFrom({}).complete, false);
  });
});
