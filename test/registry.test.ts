import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { allFeatures, activeFeatures } from "../src/content/features/registry";
import { DEFAULT_SETTINGS } from "../src/core/settings";

/** Importing the features is what registers them. */
import "../src/content/features/reprice";
import "../src/content/features/sales";
import "../src/content/features/inventory";
import "../src/content/features/offers";
import "../src/content/features/trade";
import "../src/content/features/listing";
import "../src/content/features/cards";
import "../src/content/features/farm";

function idsFor(href: string): string[] {
  return activeFeatures(new URL(href), DEFAULT_SETTINGS).map((f) => f.id);
}

describe("feature routing", () => {
  it("registers every feature exactly once", () => {
    const ids = allFeatures().map((f) => f.id);
    assert.deepEqual([...new Set(ids)].sort(), ids.slice().sort(), "no duplicate registrations");
    assert.deepEqual(ids.slice().sort(), [
      "cards",
      "farm",
      "inventory",
      "listing",
      "offers",
      "reprice",
      "sales",
      "trade",
    ]);
  });

  it("puts both market tabs on the market front page", () => {
    /** The buy-order tab died with the old market: it read a DOM table Steam
     * no longer draws anywhere. What lives here now is «Мои лоты» and the
     * ledger that says what came of them. */
    assert.deepEqual(idsFor("https://steamcommunity.com/market/").sort(), ["reprice", "sales"]);
  });

  it("hands a single item page to the listing tab alone", () => {
    /** Both used to mount here, which put two unrelated tabs on one page. */
    assert.deepEqual(
      idsFor("https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Redline"),
      ["listing"]
    );
  });

  it("keeps both market tabs on other market subpages", () => {
    assert.deepEqual(idsFor("https://steamcommunity.com/market/mylistings").sort(), ["reprice", "sales"]);
    assert.deepEqual(idsFor("https://steamcommunity.com/market/search").sort(), ["reprice", "sales"]);
  });

  it("puts inventory on both profile URL shapes", () => {
    assert.deepEqual(idsFor("https://steamcommunity.com/id/someone/inventory/#730_2"), ["inventory"]);
    assert.deepEqual(idsFor("https://steamcommunity.com/profiles/765611/inventory/"), ["inventory"]);
  });

  it("puts trade on the offer page", () => {
    assert.deepEqual(idsFor("https://steamcommunity.com/tradeoffer/12345/"), ["trade"]);
  });

  it("mounts nothing on unrelated pages", () => {
    assert.deepEqual(idsFor("https://steamcommunity.com/"), []);
    assert.deepEqual(idsFor("https://steamcommunity.com/id/someone/"), []);
  });

  it("honours a feature turned off in settings, and only that one", () => {
    const off = { ...DEFAULT_SETTINGS, features: { reprice: false } };
    const ids = activeFeatures(new URL("https://steamcommunity.com/market/"), off).map((f) => f.id);
    assert.deepEqual(ids, ["sales"], "выключили одну — соседка по странице осталась");
  });
});
describe("cards routing", () => {
  it("mounts on both badges URL shapes", () => {
    assert.deepEqual(idsFor("https://steamcommunity.com/my/badges/"), ["cards"]);
    assert.deepEqual(idsFor("https://steamcommunity.com/id/someone/badges/"), ["cards"]);
  });
  it("stays off the inventory and the market", () => {
    assert.ok(!idsFor("https://steamcommunity.com/id/someone/inventory/").includes("cards"));
    assert.ok(!idsFor("https://steamcommunity.com/market/").includes("cards"));
  });
});
