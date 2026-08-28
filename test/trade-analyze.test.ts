import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeTrade, itemKey, type TradeItem } from "../src/content/features/trade/analyze";
import type { Cents } from "../src/core/types";

function tradeItem(overrides: Partial<TradeItem> & { name: string }): TradeItem {
  return {
    appid: 730,
    contextid: "2",
    assetid: overrides.assetid ?? overrides.name,
    hash: overrides.hash ?? overrides.name,
    amount: 1,
    marketable: true,
    tradable: true,
    ...overrides,
  };
}

function lowsFor(entries: [TradeItem, Cents | null][]): Record<string, Cents | null> {
  const lows: Record<string, Cents | null> = {};
  for (const [item, price] of entries) lows[itemKey(item)] = price;
  return lows;
}

const codes = (result: ReturnType<typeof analyzeTrade>) => result.warnings.map((w) => w.code);

describe("analyzeTrade totals", () => {
  it("adds up each side and reports the gap", () => {
    const mine = tradeItem({ name: "Knife", hash: "Knife" });
    const theirs = tradeItem({ name: "Case", hash: "Case", amount: 3 });
    const result = analyzeTrade({
      yours: [mine],
      theirs: [theirs],
      lows: lowsFor([
        [mine, 10000],
        [theirs, 2000],
      ]),
    });

    assert.equal(result.yours.total, 10000);
    assert.equal(result.theirs.total, 6000, "three cases at 20 each");
    assert.equal(result.delta, -4000, "negative means you are down");
  });

  it("counts stack amounts towards the item count", () => {
    const theirs = tradeItem({ name: "Gems", hash: "Gems", amount: 500 });
    const result = analyzeTrade({ yours: [], theirs: [theirs], lows: lowsFor([[theirs, 1]]) });
    assert.equal(result.theirs.count, 500);
    assert.equal(result.theirs.total, 500);
  });

  it("keeps unpriced items out of the total and says so", () => {
    const theirs = tradeItem({ name: "Mystery", hash: "Mystery" });
    const result = analyzeTrade({ yours: [], theirs: [theirs], lows: lowsFor([[theirs, null]]) });
    assert.equal(result.theirs.total, 0);
    assert.equal(result.theirs.unpriced, 1);
    assert.ok(codes(result).includes("incomplete-prices"));
  });

  it("is quiet about a fair, fully priced trade", () => {
    const mine = tradeItem({ name: "Case A", hash: "Case A" });
    const theirs = tradeItem({ name: "Case B", hash: "Case B" });
    const result = analyzeTrade({
      yours: [mine],
      theirs: [theirs],
      lows: lowsFor([
        [mine, 1000],
        [theirs, 1000],
      ]),
    });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.verdict, "ok");
  });
});

describe("analyzeTrade substitution checks", () => {
  it("flags a homoglyph name as a substitution", () => {
    /** Cyrillic а inside "Chroma": renders identically, worth a fraction. */
    const mine = tradeItem({ name: "Chroma Case", hash: "Chroma Case" });
    const fake = tradeItem({ name: "Chromа Case", hash: "Chromа Case", assetid: "fake" });
    const result = analyzeTrade({
      yours: [mine],
      theirs: [fake],
      lows: lowsFor([
        [mine, 50000],
        [fake, 100],
      ]),
    });

    assert.equal(result.verdict, "danger");
    assert.ok(codes(result).includes("mixed-scripts"), "the disguise itself is reported");
    assert.ok(codes(result).includes("lookalike"), "and so is the value gap");
    assert.equal(result.warnings[0]!.level, "danger", "danger sorts first");
  });

  it("flags a near-identical name worth far less", () => {
    const mine = tradeItem({ name: "Chroma Case", hash: "Chroma Case" });
    const cheap = tradeItem({ name: "Chrome Case", hash: "Chrome Case", assetid: "cheap" });
    const result = analyzeTrade({
      yours: [mine],
      theirs: [cheap],
      lows: lowsFor([
        [mine, 50000],
        [cheap, 100],
      ]),
    });
    const lookalike = result.warnings.find((w) => w.code === "lookalike");
    assert.ok(lookalike, "a one-letter difference at 500x the price is the classic swap");
    assert.equal(lookalike.level, "danger");
    assert.equal(lookalike.assetid, "cheap", "the warning points at their item");
  });

  it("does not flag an equal-value swap of similarly named items", () => {
    const mine = tradeItem({ name: "Chroma Case", hash: "Chroma Case" });
    const theirs = tradeItem({ name: "Chrome Case", hash: "Chrome Case" });
    const result = analyzeTrade({
      yours: [mine],
      theirs: [theirs],
      lows: lowsFor([
        [mine, 1000],
        [theirs, 1000],
      ]),
    });
    assert.equal(codes(result).includes("lookalike"), false);
  });

  it("does not flag trading the very same item", () => {
    const mine = tradeItem({ name: "Case", hash: "Case", assetid: "a" });
    const theirs = tradeItem({ name: "Case", hash: "Case", assetid: "b" });
    const result = analyzeTrade({
      yours: [mine],
      theirs: [theirs],
      lows: lowsFor([[mine, 1000]]),
    });
    assert.equal(codes(result).includes("lookalike"), false);
  });

  it("warns rather than accuses when it cannot price the lookalike", () => {
    const mine = tradeItem({ name: "Chroma Case", hash: "Chroma Case" });
    const unknown = tradeItem({ name: "Chrome Case", hash: "Chrome Case" });
    const result = analyzeTrade({
      yours: [mine],
      theirs: [unknown],
      lows: lowsFor([
        [mine, 50000],
        [unknown, null],
      ]),
    });
    const lookalike = result.warnings.find((w) => w.code === "lookalike");
    assert.equal(lookalike?.level, "warn", "no price means no accusation");
  });

  it("finds invisible characters in an offered name", () => {
    const sneaky = tradeItem({ name: "Chroma​ Case", hash: "x" });
    const result = analyzeTrade({ yours: [], theirs: [sneaky], lows: lowsFor([[sneaky, 100]]) });
    assert.ok(codes(result).includes("hidden-characters"));
    assert.equal(result.verdict, "danger");
  });
});

describe("analyzeTrade balance and usability checks", () => {
  it("calls out losing value beyond the threshold", () => {
    const mine = tradeItem({ name: "Knife", hash: "Knife" });
    const theirs = tradeItem({ name: "Case", hash: "Case" });
    const result = analyzeTrade({
      yours: [mine],
      theirs: [theirs],
      lows: lowsFor([
        [mine, 10000],
        [theirs, 5000],
      ]),
    });
    const imbalance = result.warnings.find((w) => w.code === "imbalance");
    assert.equal(imbalance?.level, "danger");
  });

  it("mentions gaining value without calling it a problem", () => {
    const mine = tradeItem({ name: "Case", hash: "Case" });
    const theirs = tradeItem({ name: "Knife", hash: "Knife" });
    const result = analyzeTrade({
      yours: [mine],
      theirs: [theirs],
      lows: lowsFor([
        [mine, 5000],
        [theirs, 10000],
      ]),
    });
    assert.equal(result.warnings.find((w) => w.code === "imbalance")?.level, "info");
    assert.notEqual(result.verdict, "danger");
  });

  it("tolerates a small gap", () => {
    const mine = tradeItem({ name: "A", hash: "A" });
    const theirs = tradeItem({ name: "B", hash: "B" });
    const result = analyzeTrade({
      yours: [mine],
      theirs: [theirs],
      lows: lowsFor([
        [mine, 1000],
        [theirs, 950],
      ]),
    });
    assert.equal(codes(result).includes("imbalance"), false);
  });

  it("flags an offer that gives you nothing back", () => {
    const mine = tradeItem({ name: "Knife", hash: "Knife" });
    const result = analyzeTrade({ yours: [mine], theirs: [], lows: lowsFor([[mine, 10000]]) });
    const empty = result.warnings.find((w) => w.code === "empty-side");
    assert.equal(empty?.level, "danger");
  });

  it("recognises a gift in your favour as merely notable", () => {
    const theirs = tradeItem({ name: "Knife", hash: "Knife" });
    const result = analyzeTrade({ yours: [], theirs: [theirs], lows: lowsFor([[theirs, 10000]]) });
    assert.equal(result.warnings.find((w) => w.code === "empty-side")?.level, "info");
  });

  it("warns when what they offer cannot be sold on", () => {
    const theirs = tradeItem({ name: "Bound Item", hash: "Bound Item", marketable: false });
    const result = analyzeTrade({ yours: [], theirs: [theirs], lows: lowsFor([[theirs, 100]]) });
    assert.ok(codes(result).includes("not-marketable"));
  });

  it("does not police what you yourself offer", () => {
    const mine = tradeItem({ name: "Bound Item", hash: "Bound Item", marketable: false });
    const theirs = tradeItem({ name: "Case", hash: "Case" });
    const result = analyzeTrade({
      yours: [mine],
      theirs: [theirs],
      lows: lowsFor([
        [mine, 1000],
        [theirs, 1000],
      ]),
    });
    assert.equal(codes(result).includes("not-marketable"), false);
  });

  it("handles a completely empty offer without inventing problems", () => {
    const result = analyzeTrade({ yours: [], theirs: [], lows: {} });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.verdict, "ok");
    assert.equal(result.delta, 0);
  });
});
