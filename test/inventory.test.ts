import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appidFromHash,
  contextsFromPage,
  groupInventory,
  groupTilesByContext,
  inventoryPageUrl,
  INVENTORY_PAGE_SIZE,
  inventoryValue,
  itemFromPageAsset,
  itemsFromTiles,
  itemsFromVisible,
  marketableGroups,
  mergeInventory,
  mergeItemsByAsset,
  ownerFromUrl,
  pickVisibleItems,
  targetFromHash,
  type InventoryItem,
} from "../src/steam/inventory";

function payload(
  assets: Record<string, unknown>[],
  descriptions: Record<string, unknown>[]
): Parameters<typeof mergeInventory>[0] {
  return { assets, descriptions } as Parameters<typeof mergeInventory>[0];
}

const chromaCase = {
  classid: "111",
  instanceid: "0",
  market_hash_name: "Chroma Case",
  market_name: "Chroma Case",
  name: "Chroma Case",
  type: "Base Grade Container",
  icon_url: "icon-chroma",
  marketable: 1,
  tradable: 1,
};

describe("mergeInventory", () => {
  it("joins assets to descriptions on classid plus instanceid", () => {
    const items = mergeInventory(
      payload(
        [{ appid: 730, contextid: "2", assetid: "1", classid: "111", instanceid: "0", amount: "1" }],
        [chromaCase]
      )
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]!.hash, "Chroma Case");
    assert.equal(items[0]!.marketable, true);
    assert.equal(items[0]!.iconUrl, "icon-chroma");
  });

  it("keeps identical classids with different instanceids apart", () => {
    /** Same skin, different stickers: two descriptions, two prices. */
    const items = mergeInventory(
      payload(
        [
          { appid: 730, contextid: "2", assetid: "1", classid: "9", instanceid: "100" },
          { appid: 730, contextid: "2", assetid: "2", classid: "9", instanceid: "200" },
        ],
        [
          { classid: "9", instanceid: "100", market_hash_name: "AK Plain", marketable: 1 },
          { classid: "9", instanceid: "200", market_hash_name: "AK Stickered", marketable: 1 },
        ]
      )
    );
    assert.deepEqual(
      items.map((i) => i.hash),
      ["AK Plain", "AK Stickered"]
    );
  });

  it("drops assets with no description, since they cannot be priced", () => {
    const items = mergeInventory(
      payload([{ assetid: "1", classid: "missing", instanceid: "0" }], [chromaCase])
    );
    assert.equal(items.length, 0);
  });

  it("drops descriptions with no market hash at all", () => {
    const items = mergeInventory(
      payload([{ assetid: "1", classid: "5", instanceid: "0" }], [{ classid: "5", instanceid: "0" }])
    );
    assert.equal(items.length, 0);
  });

  it("treats a missing instanceid as zero, the way Steam does", () => {
    const items = mergeInventory(
      payload(
        [{ assetid: "1", classid: "111", appid: 730 }],
        [{ ...chromaCase, instanceid: "0" }]
      )
    );
    assert.equal(items.length, 1);
  });

  it("reads stack amounts and marks unmarketable items", () => {
    const items = mergeInventory(
      payload(
        [{ appid: 753, contextid: "6", assetid: "7", classid: "22", instanceid: "0", amount: "13" }],
        [{ classid: "22", instanceid: "0", market_hash_name: "Gems", marketable: 0, tradable: 1 }]
      )
    );
    assert.equal(items[0]!.amount, 13);
    assert.equal(items[0]!.marketable, false);
  });

  it("survives an empty or broken payload", () => {
    assert.deepEqual(mergeInventory(payload([], [])), []);
    assert.deepEqual(mergeInventory({} as Parameters<typeof mergeInventory>[0]), []);
  });
});

describe("groupInventory", () => {
  function item(assetid: string, hash: string, amount = 1, appid = 730): InventoryItem {
    return {
      appid,
      contextid: "2",
      assetid,
      amount,
      name: hash,
      hash,
      type: "",
      iconUrl: "",
      marketable: true,
      tradable: true,
    };
  }

  it("counts copies, including stacks", () => {
    const groups = groupInventory([item("1", "Case"), item("2", "Case", 5)]);
    assert.equal(groups.size, 1);
    assert.equal([...groups.values()][0]!.count, 6);
    assert.equal([...groups.values()][0]!.items.length, 2);
  });

  it("keeps the same name in different games apart", () => {
    const groups = groupInventory([item("1", "Key", 1, 730), item("2", "Key", 1, 440)]);
    assert.equal(groups.size, 2);
  });
});

describe("marketableGroups", () => {
  it("skips groups where nothing can be listed", () => {
    const locked: InventoryItem = {
      appid: 730,
      contextid: "2",
      assetid: "1",
      amount: 1,
      name: "Trade-locked",
      hash: "Trade-locked",
      type: "",
      iconUrl: "",
      marketable: false,
      tradable: false,
    };
    const caseItem: InventoryItem = {
      ...locked,
      assetid: "2",
      name: "Chroma Case",
      hash: "Chroma Case",
      marketable: true,
      tradable: true,
    };
    const { toPrice, skipped } = marketableGroups(groupInventory([locked, caseItem]));
    assert.equal(skipped, 1);
    assert.equal(toPrice.length, 1);
    assert.equal(toPrice[0]!.hash, "Chroma Case");
  });
});

describe("inventoryPageUrl", () => {
  it("asks for 2000 items, the Steam web cap ASF documented", () => {
    const url = inventoryPageUrl({ steamid: "7656", appid: 730, contextid: "2" }, null);
    assert.ok(url.includes(`count=${INVENTORY_PAGE_SIZE}`));
    assert.equal(INVENTORY_PAGE_SIZE, 2000);
    assert.equal(url.includes("start_assetid"), false);
  });
});

describe("inventoryValue", () => {
  it("multiplies price by count and reports what is missing", () => {
    const groups = groupInventory([
      {
        appid: 730,
        contextid: "2",
        assetid: "1",
        amount: 3,
        name: "Case",
        hash: "Case",
        type: "",
        iconUrl: "",
        marketable: true,
        tradable: true,
      },
      {
        appid: 730,
        contextid: "2",
        assetid: "2",
        amount: 1,
        name: "Mystery",
        hash: "Mystery",
        type: "",
        iconUrl: "",
        marketable: true,
        tradable: true,
      },
    ]);
    const totals = inventoryValue(groups, { "730\tCase": 1000, "730\tMystery": null });
    assert.equal(totals.total, 3000);
    assert.equal(totals.priced, 1);
    assert.equal(totals.unpriced, 1);
  });

  it("is zero for an empty inventory", () => {
    assert.deepEqual(inventoryValue(new Map(), {}), { total: 0, priced: 0, unpriced: 0 });
  });
});

describe("targetFromHash", () => {
  it("reads the game and context the user is looking at", () => {
    assert.deepEqual(targetFromHash("#730_2", "7656119"), {
      steamid: "7656119",
      appid: 730,
      contextid: "2",
    });
  });

  it("ignores a hash that names no game", () => {
    assert.equal(targetFromHash("", "7656119"), null);
    assert.equal(targetFromHash("#", "7656119"), null);
    assert.equal(targetFromHash("#730", "7656119"), null);
  });

  it("refuses to guess without a steamid", () => {
    assert.equal(targetFromHash("#730_2", ""), null);
  });

  it("tolerates the trailing junk Steam appends", () => {
    const target = targetFromHash("#753_6_something", "1");
    assert.equal(target?.appid, 753);
    assert.equal(target?.contextid, "6");
  });
});

describe("ownerFromUrl", () => {
  it("takes the steamid straight from a profiles URL", () => {
    const owner = ownerFromUrl("/profiles/76561198000000000/inventory/", "1");
    assert.equal(owner?.steamid, "76561198000000000");
    assert.equal(owner?.assumed, false);
  });

  it("falls back to the viewer on a vanity URL, and admits it", () => {
    const owner = ownerFromUrl("/id/someone/inventory/", "76561198000000001");
    assert.equal(owner?.steamid, "76561198000000001");
    assert.equal(owner?.assumed, true, "the caller has to be able to say so");
  });

  it("gives up when it knows neither", () => {
    assert.equal(ownerFromUrl("/id/someone/inventory/", ""), null);
  });

  it("ignores a short number that cannot be a steamid", () => {
    const owner = ownerFromUrl("/profiles/123/inventory/", "76561198000000001");
    assert.equal(owner?.assumed, true);
  });
});

describe("contextsFromPage", () => {
  const page = {
    "753": {
      appid: 753,
      name: "Steam",
      rgContexts: {
        "1": { id: "1", name: "Gifts", asset_count: 0 },
        "6": { id: "6", name: "Community", asset_count: 709 },
      },
    },
    "730": {
      appid: 730,
      name: "Counter-Strike 2",
      rgContexts: { "2": { id: "2", name: "Backpack", asset_count: 42 } },
    },
  };

  it("lists every context that actually holds items, fullest first", () => {
    const choices = contextsFromPage(page);
    assert.equal(choices.length, 2, "the empty Gifts context is only noise");
    assert.equal(choices[0]!.appid, 753);
    assert.equal(choices[0]!.contextid, "6");
    assert.equal(choices[0]!.count, 709);
    assert.equal(choices[1]!.appid, 730);
  });

  it("labels a context with both the game and the context name", () => {
    const choices = contextsFromPage(page);
    assert.equal(choices[0]!.label, "Steam — Community");
    assert.equal(choices[1]!.label, "Counter-Strike 2 — Backpack");
  });

  it("returns nothing when the page has not handed the table over yet", () => {
    assert.deepEqual(contextsFromPage(null), []);
    assert.deepEqual(contextsFromPage({}), []);
  });

  it("survives holes in the table", () => {
    const choices = contextsFromPage({
      "0": undefined,
      "440": { appid: 440, name: "TF2" },
      "570": { appid: 570, rgContexts: { "2": { asset_count: 3 } } },
    });
    assert.equal(choices.length, 1, "only the one with a counted context");
    assert.equal(choices[0]!.appid, 570);
    assert.equal(choices[0]!.contextid, "2", "context key stands in for a missing id");
  });
});

describe("appidFromHash", () => {
  it("reads the appid-only fragment Steam actually writes", () => {
    /** The real URL from the field: /inventory#227300, with no context part. */
    assert.equal(appidFromHash("#227300"), 227300);
  });

  it("reads the appid out of the full form too", () => {
    assert.equal(appidFromHash("#730_2"), 730);
  });

  it("gives up on a fragment with no number", () => {
    assert.equal(appidFromHash(""), null);
    assert.equal(appidFromHash("#"), null);
    assert.equal(appidFromHash("#tab"), null);
    assert.equal(appidFromHash(undefined as unknown as string), null);
  });
});

describe("itemFromPageAsset", () => {
  it("takes the hash from g_rgAssets and treats unknown marketable as sellable", () => {
    const item = itemFromPageAsset(
      { appid: 730, contextid: "2", assetid: "9" },
      { market_hash_name: "Chroma Case", market_name: "Chroma Case", amount: "2" }
    );
    assert.equal(item?.hash, "Chroma Case");
    assert.equal(item?.amount, 2);
    assert.equal(item?.marketable, true);
  });

  it("refuses a tile with no name — it cannot be priced", () => {
    assert.equal(itemFromPageAsset({ appid: 730, contextid: "2", assetid: "9" }, {}), null);
    assert.equal(itemFromPageAsset({ appid: 730, contextid: "2", assetid: "9" }, null), null);
  });

  it("honours marketable: 0 so unmarketable copies are not priced", () => {
    const item = itemFromPageAsset(
      { appid: 730, contextid: "2", assetid: "9" },
      { market_hash_name: "Trophy", marketable: 0 }
    );
    assert.equal(item?.marketable, false);
  });
});

describe("itemsFromTiles / pickVisibleItems", () => {
  const assets = {
    "730": {
      "2": {
        "1": { market_hash_name: "Chroma Case", marketable: 1 },
        "2": { market_hash_name: "Knife", marketable: 1 },
      },
    },
  };

  it("looks up only the tiles we asked for", () => {
    const items = itemsFromTiles(
      [
        { appid: 730, contextid: "2", assetid: "1" },
        { appid: 730, contextid: "2", assetid: "9" },
      ],
      assets
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]!.assetid, "1");
  });

  it("keeps a full inventory down to the visible set", () => {
    const all: InventoryItem[] = [
      {
        appid: 730,
        contextid: "2",
        assetid: "1",
        amount: 1,
        name: "Case",
        hash: "Case",
        type: "",
        iconUrl: "",
        marketable: true,
        tradable: true,
      },
      {
        appid: 730,
        contextid: "2",
        assetid: "2",
        amount: 1,
        name: "Knife",
        hash: "Knife",
        type: "",
        iconUrl: "",
        marketable: true,
        tradable: true,
      },
    ];
    const visible = pickVisibleItems(all, [{ appid: 730, contextid: "2", assetid: "2" }]);
    assert.equal(visible.length, 1);
    assert.equal(visible[0]!.assetid, "2");
  });

  it("returns nothing when Steam has not painted any tiles", () => {
    assert.deepEqual(pickVisibleItems([itemLike("1")], []), []);
  });

  it("merges page-world items with asset-index items without duplicating", () => {
    const fromPage = itemsFromVisible([
      { appid: 730, contextid: "2", assetid: "1", market_hash_name: "Chroma Case" },
    ]);
    const fromAssets = itemsFromTiles([{ appid: 730, contextid: "2", assetid: "1" }], assets);
    const merged = mergeItemsByAsset(fromPage, fromAssets);
    assert.equal(merged.length, 1);
  });
});

function itemLike(assetid: string): InventoryItem {
  return {
    appid: 730,
    contextid: "2",
    assetid,
    amount: 1,
    name: assetid,
    hash: assetid,
    type: "",
    iconUrl: "",
    marketable: true,
    tradable: true,
  };
}

describe("groupTilesByContext", () => {
  it("splits tiles by the inventory they live in", () => {
    /** CS2 draws the backpack (2) and the storage units (16) on one page. */
    const groups = groupTilesByContext([
      { appid: 730, contextid: "2", assetid: "1" },
      { appid: 730, contextid: "16", assetid: "2" },
      { appid: 730, contextid: "2", assetid: "3" },
    ]);
    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups.map((g) => [g.contextid, g.tiles.length]),
      [["2", 2], ["16", 1]]
    );
  });

  it("keeps games apart even when the context id repeats", () => {
    const groups = groupTilesByContext([
      { appid: 730, contextid: "2", assetid: "1" },
      { appid: 440, contextid: "2", assetid: "2" },
    ]);
    assert.deepEqual(groups.map((g) => g.appid), [730, 440]);
  });

  it("returns nothing for no tiles", () => {
    assert.deepEqual(groupTilesByContext([]), []);
  });
});
