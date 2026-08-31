import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSellPlans, plannedProceeds } from "../src/content/features/inventory/plan";
import { buyerPrice, DEFAULT_FEES } from "../src/core/fees";
import { DEFAULT_SELL_SETTINGS, targetForStrategy, type SellSettings } from "../src/core/sell";
import type { Cents } from "../src/core/types";
import { groupInventory, type InventoryItem } from "../src/steam/inventory";

const fees = DEFAULT_FEES;

function item(assetid: string, hash: string, marketable = true, amount = 1): InventoryItem {
  return {
    appid: 730,
    contextid: "2",
    assetid,
    amount,
    name: hash,
    hash,
    type: "",
    iconUrl: "",
    marketable,
    tradable: true,
  };
}

function plan(
  items: InventoryItem[],
  lows: Record<string, Cents | null>,
  overrides: Partial<SellSettings> = {}
) {
  return buildSellPlans({
    groups: groupInventory(items),
    lows,
    settings: { ...DEFAULT_SELL_SETTINGS, ...overrides },
    fees,
  });
}

const selling = (plans: ReturnType<typeof plan>) => plans.filter((p) => p.action === "sell");

describe("targetForStrategy", () => {
  it("matches the minimum exactly", () => {
    assert.equal(targetForStrategy(10000, { ...DEFAULT_SELL_SETTINGS, strategy: "match" }), 10000);
  });

  it("steps below by the configured kopecks", () => {
    assert.equal(
      targetForStrategy(10000, { ...DEFAULT_SELL_SETTINGS, strategy: "undercut", undercutCents: 25 }),
      9975
    );
  });

  it("asks above by the configured percent", () => {
    assert.equal(
      targetForStrategy(10000, { ...DEFAULT_SELL_SETTINGS, strategy: "markup", markupPercent: 10 }),
      11000
    );
  });

  it("never undercuts by less than a kopeck, whatever the setting says", () => {
    assert.equal(
      targetForStrategy(1000, { ...DEFAULT_SELL_SETTINGS, strategy: "undercut", undercutCents: 0 }),
      999
    );
  });
});

describe("buildSellPlans", () => {
  it("prices every marketable copy at the market minimum", () => {
    const plans = plan([item("1", "Case"), item("2", "Case")], { "730\tCase": 10000 });
    const sells = selling(plans);
    assert.equal(sells.length, 2);
    for (const s of sells) {
      assert.ok(s.targetBuyer! <= 10000);
      assert.equal(buyerPrice(s.targetSeller!, 0.1, fees), s.targetBuyer);
    }
  });

  it("refuses to list what Steam will not let us sell", () => {
    const plans = plan([item("1", "Gems", false)], { "730\tGems": 500 });
    assert.equal(selling(plans).length, 0);
    assert.equal(plans[0]!.reason, "не продаётся на маркете");
  });

  it("refuses to list what it could not price", () => {
    const plans = plan([item("1", "Mystery")], { "730\tMystery": null });
    assert.equal(selling(plans).length, 0);
    assert.equal(plans[0]!.reason, "нет цены рынка");
  });

  it("caps how many copies of one item go out per pass", () => {
    const items = Array.from({ length: 10 }, (_, i) => item(String(i), "Case"));
    const plans = plan(items, { "730\tCase": 10000 }, { maxPerItem: 3 });
    assert.equal(selling(plans).length, 3);
    assert.equal(plans.filter((p) => p.reason.startsWith("хватит")).length, 7);
  });

  it("lists the same copies again on a second pass", () => {
    const items = [item("30", "Case"), item("10", "Case"), item("20", "Case")];
    const first = selling(plan(items, { "730\tCase": 10000 }, { maxPerItem: 1 }));
    const second = selling(plan(items, { "730\tCase": 10000 }, { maxPerItem: 1 }));
    assert.deepEqual(
      first.map((p) => p.assetid),
      second.map((p) => p.assetid),
      "order must not depend on inventory order"
    );
  });

  it("honours a floor so junk is not dumped", () => {
    const plans = plan([item("1", "Junk")], { "730\tJunk": 300 }, { minBuyerCents: 1000 });
    assert.equal(selling(plans).length, 0);
    assert.equal(plans[0]!.reason, "дешевле порога");
  });

  it("refuses to go below the Steam floor when undercutting a 1-kopeck item", () => {
    const plans = plan([item("1", "Dust")], { "730\tDust": 1 }, { strategy: "undercut" });
    assert.equal(selling(plans).length, 0);
  });

  it("lists only the chosen groups", () => {
    const plans = buildSellPlans({
      groups: groupInventory([item("1", "Wanted"), item("2", "Ignored")]),
      lows: { "730\tWanted": 5000, "730\tIgnored": 5000 },
      settings: DEFAULT_SELL_SETTINGS,
      fees,
      onlyKeys: new Set(["730\tWanted"]),
    });
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.hash, "Wanted");
  });

  it("uses the publisher fee of the game it is told about", () => {
    const cheapFee = buildSellPlans({
      groups: groupInventory([item("1", "Thing")]),
      lows: { "730\tThing": 10000 },
      settings: DEFAULT_SELL_SETTINGS,
      fees,
      publisherFeePercent: () => 0,
    });
    const normalFee = plan([item("1", "Thing")], { "730\tThing": 10000 });
    assert.ok(
      cheapFee[0]!.targetSeller! > normalFee[0]!.targetSeller!,
      "no publisher cut means the seller keeps more of the same buyer price"
    );
  });

  it("carries the ids sellitem needs", () => {
    const plans = selling(plan([item("42", "Case")], { "730\tCase": 10000 }));
    assert.equal(plans[0]!.assetid, "42");
    assert.equal(plans[0]!.appid, 730);
    assert.equal(plans[0]!.contextid, "2");
  });
});

describe("plannedProceeds", () => {
  it("adds up only what is actually being listed", () => {
    const plans = plan([item("1", "Case"), item("2", "Gems", false)], {
      "730\tCase": 10000,
      "730\tGems": 10000,
    });
    const expected = selling(plans).reduce((sum, p) => sum + (p.targetSeller ?? 0), 0);
    assert.equal(plannedProceeds(plans), expected);
    assert.ok(expected > 0);
  });

  it("is zero when nothing is listed", () => {
    assert.equal(plannedProceeds([]), 0);
  });
});

describe("buildSellPlans with copies picked on the tiles", () => {
  const items = [
    item("1", "Chroma Case"),
    item("2", "Chroma Case"),
    item("3", "Chroma Case"),
  ];
  const lows = { "730\tChroma Case": 900 };

  function planPicked(picked: string[]) {
    return buildSellPlans({
      groups: groupInventory(items),
      lows,
      settings: { ...DEFAULT_SELL_SETTINGS },
      fees,
      onlyAssets: new Set(picked),
    });
  }

  it("lists exactly the copies that were picked, not the first N", () => {
    const plans = planPicked(["3", "1"]);
    assert.deepEqual(
      selling(plans).map((p) => p.assetid),
      ["1", "3"],
      "stable assetid order, and copy 2 stays out"
    );
  });

  it("says why the untouched copies were left alone", () => {
    const skipped = planPicked(["1"]).filter((p) => p.action === "skip");
    assert.deepEqual(
      skipped.map((p) => p.assetid),
      ["2", "3"]
    );
    assert.ok(
      skipped.every((p) => p.reason.includes("снят")),
      skipped[0]?.reason ?? "no skip reason"
    );
  });

  it("plans nothing when every copy was unticked", () => {
    assert.deepEqual(selling(planPicked([])), []);
  });

  it("still respects the per-pass cap on top of the picked copies", () => {
    const plans = buildSellPlans({
      groups: groupInventory(items),
      lows,
      settings: { ...DEFAULT_SELL_SETTINGS, maxPerItem: 2 },
      fees,
      onlyAssets: new Set(["1", "2", "3"]),
    });
    assert.equal(selling(plans).length, 2);
  });
});
