import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeMissingLevel,
  levelLadder,
  levelValue,
  MIN_LEVEL_VOLUME,
} from "../src/core/levels";
import { DEFAULT_SELL_SETTINGS, strategyTarget, type SellSettings } from "../src/core/sell";
import type { HistoryStats } from "../src/steam/pricehistory";

function stats(overrides: Partial<HistoryStats> = {}): HistoryStats {
  return {
    points: 400,
    last: 10000,
    lastAt: Date.now(),
    average7d: 9000,
    average30d: 11000,
    average365d: 15000,
    min30d: 8000,
    max30d: 13000,
    volume7d: 40,
    volume30d: 200,
    volume365d: 2400,
    spanDays: 500,
    ...overrides,
  };
}

describe("levelValue", () => {
  it("answers the market level from the current minimum, with no history at all", () => {
    const value = levelValue("market", 4200, null);
    assert.equal(value.buyer, 4200);
    assert.equal(value.missing, "none");
  });

  it("reads each window off the right average", () => {
    assert.equal(levelValue("avg7", 1, stats()).buyer, 9000);
    assert.equal(levelValue("avg30", 1, stats()).buyer, 11000);
    assert.equal(levelValue("avg365", 1, stats()).buyer, 15000);
  });

  it("refuses to call three weeks of history a yearly average", () => {
    const young = levelValue("avg365", 1, stats({ spanDays: 21 }));
    assert.equal(young.buyer, null);
    assert.equal(young.missing, "too-short");
    /** The same item has a perfectly real weekly average. */
    assert.equal(levelValue("avg7", 1, stats({ spanDays: 21 })).buyer, 9000);
  });

  it("refuses an average built on a handful of sales", () => {
    const thin = levelValue("avg30", 1, stats({ volume30d: MIN_LEVEL_VOLUME - 1 }));
    assert.equal(thin.buyer, null);
    assert.equal(thin.missing, "too-few-sales");
    assert.match(describeMissingLevel(thin), /продаж всего/);
  });

  it("says «no history» rather than guessing when Steam gave nothing", () => {
    assert.equal(levelValue("avg30", 5000, null).missing, "no-history");
    assert.equal(levelValue("avg30", 5000, stats({ points: 0 })).missing, "no-history");
  });

  it("separates a quiet week from an item Steam has never heard of", () => {
    /**
     * `average7d` is null exactly when no sale falls inside the window, and an
     * item with twelve years of history can have a quiet week. Calling that «нет
     * истории продаж» tells the holder the opposite of the truth, and the truth
     * is the reason the level has no number.
     */
    const quiet = levelValue("avg7", 5000, stats({ average7d: null, volume7d: 0 }));
    assert.equal(quiet.buyer, null);
    assert.equal(quiet.missing, "no-sales");
    assert.match(describeMissingLevel(quiet), /не продавалось/);
    assert.doesNotMatch(describeMissingLevel(quiet), /нет истории/);

    /** And the same item still has a perfectly real yearly average. */
    assert.equal(levelValue("avg365", 5000, stats({ average7d: null, volume7d: 0 })).buyer, 15000);
  });

  it("builds the whole ladder, market first", () => {
    const ladder = levelLadder(4200, stats());
    assert.deepEqual(ladder.map((v) => v.level), ["market", "avg7", "avg30", "avg365"]);
    assert.deepEqual(ladder.map((v) => v.buyer), [4200, 9000, 11000, 15000]);
  });
});

describe("strategyTarget", () => {
  const sell = (over: Partial<SellSettings>): SellSettings => ({ ...DEFAULT_SELL_SETTINGS, ...over });

  it("keeps the market strategies exactly as they were", () => {
    assert.equal(strategyTarget(1000, sell({ strategy: "match" })).buyer, 1000);
    assert.equal(strategyTarget(1000, sell({ strategy: "undercut", undercutCents: 5 })).buyer, 995);
    assert.equal(strategyTarget(1000, sell({ strategy: "markup", markupPercent: 10 })).buyer, 1100);
  });

  it("lists above the market when the month says the item is worth more", () => {
    const target = strategyTarget(9000, sell({ strategy: "avg30" }), stats());
    assert.equal(target.buyer, 11000, "asking last month's price and waiting is the point");
    assert.equal(target.clamped, false);
  });

  it("never lists under the market just because the average is lower", () => {
    /** Market has run up to 20000; the month's average is 11000. */
    const target = strategyTarget(20000, sell({ strategy: "avg30" }), stats());
    assert.equal(target.buyer, 20000, "selling below the going rate is a discount nobody asked for");
    assert.equal(target.clamped, true);
    assert.match(target.reason, /ниже рынка/);
  });

  it("refuses to price at all when the level has nothing behind it", () => {
    const target = strategyTarget(9000, sell({ strategy: "avg365" }), stats({ spanDays: 10 }));
    assert.equal(target.buyer, null);
    assert.match(target.reason, /истории меньше/);
  });
});
