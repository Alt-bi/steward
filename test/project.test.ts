import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  projectAppContexts,
  projectAssets,
  projectListingInfo,
  projectRgItem,
  projectWallet,
} from "../src/page/project";

/**
 * The bug these guard against: `postMessage` structure-clones its argument, and
 * Steam's inventory globals hold DOM references. Posting them raised
 * `DataCloneError` and killed the bridge.
 *
 * Node has no DOM, but a function is uncloneable in exactly the same way, so
 * `structuredClone` on the projection is a faithful check.
 */
function assertCloneable(value: unknown, what: string): void {
  assert.doesNotThrow(() => structuredClone(value), `${what} must survive postMessage`);
}

describe("projectAppContexts", () => {
  it("keeps the fields the game picker needs", () => {
    const projected = projectAppContexts({
      "753": {
        appid: 753,
        name: "Steam",
        asset_count: 709,
        rgContexts: {
          "6": { id: "6", name: "Community", asset_count: 709 },
        },
      },
    });

    assert.equal(projected?.["753"]?.appid, 753);
    assert.equal(projected?.["753"]?.name, "Steam");
    assert.equal(projected?.["753"]?.rgContexts?.["6"]?.asset_count, 709);
  });

  it("strips whatever cannot be cloned", () => {
    const withDom = {
      "227300": {
        appid: 227300,
        name: "Euro Truck Simulator 2",
        /** Stands in for the HTMLDivElement Steam attaches here. */
        element: () => undefined,
        rgContexts: {
          "2": { id: "2", name: "Backpack", asset_count: 4, tab: () => undefined },
        },
      },
    };

    const projected = projectAppContexts(withDom);
    assertCloneable(projected, "app context projection");
    assert.equal("element" in (projected?.["227300"] ?? {}), false);
    assert.equal(projected?.["227300"]?.rgContexts?.["2"]?.name, "Backpack");
  });

  it("survives a circular reference, which a raw clone cannot", () => {
    const app: Record<string, unknown> = { appid: 730, name: "CS2" };
    app.self = app;
    const projected = projectAppContexts({ "730": app });
    assertCloneable(projected, "circular app entry");
    assert.equal(projected?.["730"]?.appid, 730);
  });

  it("falls back to the key when the entry has no appid", () => {
    const projected = projectAppContexts({ "440": { name: "TF2" } });
    assert.equal(projected?.["440"]?.appid, 440);
  });

  it("uses the context key when the context has no id", () => {
    const projected = projectAppContexts({
      "570": { appid: 570, rgContexts: { "2": { asset_count: 3 } } },
    });
    assert.equal(projected?.["570"]?.rgContexts?.["2"]?.id, "2");
  });

  it("returns null for anything that is not a table", () => {
    assert.equal(projectAppContexts(null), null);
    assert.equal(projectAppContexts(undefined), null);
    assert.equal(projectAppContexts("nope"), null);
    assert.equal(projectAppContexts([]), null);
  });

  it("skips entries that are not objects instead of failing", () => {
    const projected = projectAppContexts({ "730": null, "440": { appid: 440 } });
    assert.equal(projected?.["730"], undefined);
    assert.equal(projected?.["440"]?.appid, 440);
  });
});

describe("projectAssets", () => {
  it("keeps only what the listing merger reads", () => {
    const projected = projectAssets({
      "730": {
        "2": {
          "12345": {
            amount: "1",
            market_hash_name: "Chroma Case",
            market_name: "Chroma Case",
            name: "Chroma Case",
            commodity: 1,
            /** Steam hangs plenty more off these; none of it is ours. */
            icon_url: "should not survive",
            element: () => undefined,
          },
        },
      },
    });

    const asset = projected?.["730"]?.["2"]?.["12345"];
    assert.equal(asset?.market_hash_name, "Chroma Case");
    assert.equal(asset?.amount, "1");
    assert.equal("icon_url" in (asset ?? {}), false, "unused fields are dropped, not carried");
    assertCloneable(projected, "asset projection");
  });

  it("keeps the three-level shape lookupAsset walks", () => {
    const projected = projectAssets({
      "753": { "6": { "999": { market_hash_name: "296830-:CoffeeBreak:" } } },
    });
    assert.equal(projected?.["753"]?.["6"]?.["999"]?.market_hash_name, "296830-:CoffeeBreak:");
  });

  it("returns null for a missing table and skips broken levels", () => {
    assert.equal(projectAssets(null), null);
    const projected = projectAssets({ "730": { "2": "not an object" } });
    assert.deepEqual(projected?.["730"], {});
  });

  it("lifts the hash off a nested description, which is where Steam often leaves it", () => {
    const projected = projectAssets({
      "730": {
        "2": {
          "1": {
            amount: "1",
            description: {
              market_hash_name: "AK-47 | Redline (Field-Tested)",
              marketable: 1,
            },
            element: () => undefined,
          },
        },
      },
    });
    const asset = projected?.["730"]?.["2"]?.["1"];
    assert.equal(asset?.market_hash_name, "AK-47 | Redline (Field-Tested)");
    assert.equal(asset?.marketable, 1);
    assert.equal("description" in (asset ?? {}), false);
    assertCloneable(projected, "asset with nested description");
  });
});

describe("projectRgItem", () => {
  it("copies named fields and drops the circular element pointer", () => {
    const raw: Record<string, unknown> = {
      appid: 730,
      contextid: "2",
      assetid: "99",
      market_hash_name: "Chroma Case",
      marketable: 1,
    };
    raw.element = raw;
    const projected = projectRgItem(raw);
    assert.equal(projected?.assetid, "99");
    assert.equal(projected?.market_hash_name, "Chroma Case");
    assert.equal("element" in (projected ?? {}), false);
    assertCloneable(projected, "rgItem projection");
  });

  it("fills appid/context/asset from the tile id when rgItem is thin", () => {
    const projected = projectRgItem(
      { description: { market_hash_name: "Knife", marketable: 1 } },
      "730_2_55"
    );
    assert.equal(projected?.appid, 730);
    assert.equal(projected?.contextid, "2");
    assert.equal(projected?.assetid, "55");
    assert.equal(projected?.market_hash_name, "Knife");
  });

  it("returns null when there is no hash to price with", () => {
    assert.equal(projectRgItem({ appid: 730, id: "1" }, "730_2_1"), null);
    assert.equal(projectRgItem(null, "730_2_1"), null);
  });
});

describe("projectListingInfo", () => {
  it("keeps the fields the cheapest-lot parser reads and drops the rest", () => {
    const projected = projectListingInfo({
      "99": {
        listingid: "99",
        converted_price: 500,
        converted_fee: 75,
        steamid_lister: "should not survive",
        element: () => undefined,
      },
    });
    assert.equal(projected?.["99"]?.converted_price, 500);
    assert.equal("steamid_lister" in (projected?.["99"] ?? {}), false);
    assertCloneable(projected, "listing info projection");
  });

  it("returns null when the page has no listing table", () => {
    assert.equal(projectListingInfo(null), null);
  });
});

describe("projectWallet", () => {
  it("keeps the fee fields the arithmetic needs", () => {
    const projected = projectWallet({
      wallet_currency: 5,
      wallet_fee_percent: "0.05",
      wallet_fee_minimum: "1",
      wallet_fee_base: "0",
      wallet_publisher_fee_percent_default: "0.10",
      wallet_balance: "12345",
    });
    assert.equal(projected?.wallet_currency, 5);
    assert.equal(projected?.wallet_fee_percent, "0.05");
    assert.equal("wallet_balance" in (projected ?? {}), false, "the balance is none of our business");
    assertCloneable(projected, "wallet projection");
  });

  it("returns null when there is no wallet", () => {
    assert.equal(projectWallet(null), null);
    assert.equal(projectWallet(undefined), null);
  });

  it("drops fields that are not scalars", () => {
    const projected = projectWallet({ wallet_currency: { nested: true }, wallet_fee_minimum: 1 });
    assert.equal("wallet_currency" in (projected ?? {}), false);
    assert.equal(projected?.wallet_fee_minimum, 1);
  });
});
