import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { badgeDataFrom, parseTileId } from "../src/content/features/inventory/badges";
import type { InventoryItem } from "../src/steam/inventory";

function item(assetid: string, hash: string, appid = 730): InventoryItem {
  return {
    appid,
    contextid: "2",
    assetid,
    amount: 1,
    name: hash,
    hash,
    type: "",
    iconUrl: "",
    marketable: true,
    tradable: true,
  };
}

describe("parseTileId", () => {
  it("reads Steam's tile id", () => {
    assert.deepEqual(parseTileId("730_2_12345678"), {
      appid: 730,
      contextid: "2",
      assetid: "12345678",
    });
  });

  it("reads a community context", () => {
    assert.deepEqual(parseTileId("753_6_98765"), {
      appid: 753,
      contextid: "6",
      assetid: "98765",
    });
  });

  it("rejects anything that is not exactly three numbers", () => {
    assert.equal(parseTileId("item730_2_1"), null, "prefixed ids are a different element");
    assert.equal(parseTileId("730_2"), null);
    assert.equal(parseTileId("730_2_1_extra"), null);
    assert.equal(parseTileId("a_b_c"), null);
    assert.equal(parseTileId(""), null);
    assert.equal(parseTileId(null), null);
    assert.equal(parseTileId(undefined), null);
  });

  it("does not mistake an unrelated underscore id for a tile", () => {
    assert.equal(parseTileId("tabContentsMyListings_2"), null);
  });
});

describe("badgeDataFrom", () => {
  const format = (cents: number | null) => (cents == null ? "—" : String(cents));

  it("maps each copy to the price of its item", () => {
    const items = [item("1", "Case"), item("2", "Case"), item("3", "Knife")];
    const data = badgeDataFrom(items, { "730\tCase": 500, "730\tKnife": 90000 }, format);

    assert.equal(data.priceByAsset.get("1"), 500);
    assert.equal(data.priceByAsset.get("2"), 500, "both copies get the same price");
    assert.equal(data.priceByAsset.get("3"), 90000);
  });

  it("records a known-unpriced item as null, not as missing", () => {
    const data = badgeDataFrom([item("1", "Mystery")], { "730\tMystery": null }, format);
    assert.equal(data.priceByAsset.has("1"), true);
    assert.equal(data.priceByAsset.get("1"), null);
  });

  it("records an item absent from the price table as null too", () => {
    const data = badgeDataFrom([item("1", "Unknown")], {}, format);
    assert.equal(data.priceByAsset.get("1"), null);
  });

  it("keeps games apart when names collide", () => {
    const items = [item("1", "Key", 730), item("2", "Key", 440)];
    const data = badgeDataFrom(items, { "730\tKey": 100, "440\tKey": 200 }, format);
    assert.equal(data.priceByAsset.get("1"), 100);
    assert.equal(data.priceByAsset.get("2"), 200);
  });

  it("carries the formatter through, so badges match the panel", () => {
    const data = badgeDataFrom([item("1", "Case")], { "730\tCase": 1234 }, format);
    assert.equal(data.format(data.priceByAsset.get("1") ?? null), "1234");
    assert.equal(data.format(null), "—");
  });
});
