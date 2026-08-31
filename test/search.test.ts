import "./support/env";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ItemKeyed } from "../src/core/types";
import {
  batchingRatio,
  groupForSearch,
  groupIdsFromResults,
  pricesFromResults,
  queryForItem,
  searchUrl,
} from "../src/steam/search";

function item(hash: string, appid = 730): ItemKeyed {
  return { key: `${appid}\t${hash}`, appid, hash, name: hash };
}

describe("groupForSearch", () => {
  it("collapses a skin family into a single request", () => {
    const items = [
      item("AK-47 | Redline (Field-Tested)"),
      item("AK-47 | Redline (Minimal Wear)"),
      item("StatTrak™ AK-47 | Redline (Well-Worn)"),
    ];
    const groups = groupForSearch(items);
    assert.equal(groups.length, 1, "one query for three listings");
    assert.equal(groups[0]!.items.length, 3);
    assert.equal(groups[0]!.query, "AK-47 | Redline");
  });

  it("keeps different games apart even with identical names", () => {
    const groups = groupForSearch([item("Key", 730), item("Key", 440)]);
    assert.equal(groups.length, 2);
  });

  it("keeps unrelated items in their own groups", () => {
    const groups = groupForSearch([item("Chroma Case"), item("Gamma Case")]);
    assert.equal(groups.length, 2);
  });
});

describe("pricesFromResults", () => {
  it("takes only exact hashes with a real price", () => {
    const prices = pricesFromResults([
      { hash_name: "Chroma Case", sell_price: 4200 },
      { hash_name: "Broken", sell_price: 0 },
      { hash_name: "NoPrice" },
      { sell_price: 999 },
    ]);
    assert.equal(prices.get("Chroma Case"), 4200);
    assert.equal(prices.has("Broken"), false, "a zero price is not a price");
    assert.equal(prices.has("NoPrice"), false);
    assert.equal(prices.size, 1);
  });

  it("keeps the cheapest when a hash repeats", () => {
    const prices = pricesFromResults([
      { hash_name: "Case", sell_price: 5000 },
      { hash_name: "Case", sell_price: 3000 },
    ]);
    assert.equal(prices.get("Case"), 3000);
  });

  it("survives an empty or missing result set", () => {
    assert.equal(pricesFromResults(null).size, 0);
    assert.equal(pricesFromResults(undefined).size, 0);
    assert.equal(pricesFromResults([]).size, 0);
  });
});

describe("searchUrl", () => {
  it("encodes the query so pipes and trademarks survive", () => {
    const url = searchUrl({ query: "AK-47 | Redline", appid: 730, items: [] }, 100);
    assert.ok(url.includes("norender=1"));
    assert.ok(url.includes("appid=730"));
    assert.ok(url.includes("count=100"));
    assert.ok(url.includes(encodeURIComponent("AK-47 | Redline")));
    assert.ok(!url.includes("| Redline"), "raw pipe must not reach the URL");
  });
});

describe("queryForItem", () => {
  it("uses the display name for community items, whose hash is unsearchable", () => {
    /**
     * The regression behind "Цены 4/709": search indexes displayed names, so
     * sending "296830-:CoffeeBreak:" as the query matched nothing.
     */
    const query = queryForItem({ hash: "296830-:CoffeeBreak:", name: "Coffee Break" });
    assert.equal(query, "Coffee Break");
  });

  it("falls back to the hash tail when there is no display name", () => {
    assert.equal(queryForItem({ hash: "296830-:CoffeeBreak:", name: "" }), ":CoffeeBreak:");
    assert.equal(
      queryForItem({ hash: "753-Sack of Gems", name: "753-Sack of Gems" }),
      "Sack of Gems"
    );
  });

  it("still strips wear and quality for ordinary market items", () => {
    assert.equal(
      queryForItem({
        hash: "StatTrak™ AK-47 | Redline (Field-Tested)",
        name: "StatTrak™ AK-47 | Redline (Field-Tested)",
      }),
      "AK-47 | Redline"
    );
  });

  it("handles the knife star prefix", () => {
    assert.equal(
      queryForItem({ hash: "★ StatTrak™ Karambit | Doppler (Factory New)", name: "" }),
      "Karambit | Doppler"
    );
  });
});

describe("groupIdsFromResults", () => {
  it("picks up the internal group id a skin row carries", () => {
    const ids = groupIdsFromResults([
      {
        hash_name: "AK-47 | Redline (Field-Tested)",
        sell_price: 12000,
        asset_description: {
          market_hash_name: "AK-47 | Redline (Field-Tested)",
          market_bucket_group_id: "G1807209A023004",
        },
      },
      { hash_name: "Chroma Case", sell_price: 300 },
    ]);
    assert.equal(ids.get("AK-47 | Redline (Field-Tested)"), "G1807209A023004");
    assert.equal(ids.has("Chroma Case"), false, "a row without one teaches nothing");
  });

  it("does not confuse a row with itself", () => {
    const ids = groupIdsFromResults([
      {
        hash_name: "Case",
        sell_price: 300,
        asset_description: { market_bucket_group_id: "Case" },
      },
    ]);
    assert.equal(ids.size, 0, "an id equal to the hash is not a group");
  });

  it("answers nothing to a missing answer", () => {
    assert.equal(groupIdsFromResults(null).size, 0);
    assert.equal(groupIdsFromResults([]).size, 0);
  });
});

describe("batchingRatio", () => {
  it("is high for a skin family, where one query serves many items", () => {
    const items = ["Field-Tested", "Minimal Wear", "Well-Worn"].map((wear) => ({
      key: wear,
      appid: 730,
      hash: `AK-47 | Redline (${wear})`,
      name: `AK-47 | Redline (${wear})`,
    }));
    assert.equal(batchingRatio(items), 3);
  });

  it("is one for community items, where search buys nothing", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      key: String(i),
      appid: 753,
      hash: `296830-:Emote${i}:`,
      name: `Emote ${i}`,
    }));
    assert.equal(batchingRatio(items), 1, "this is the case that must skip search entirely");
  });

  it("is one for an empty set rather than dividing by zero", () => {
    assert.equal(batchingRatio([]), 1);
  });
});
