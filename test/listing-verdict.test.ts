import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseListingUrl } from "../src/content/features/listing";
import { describeLiquidity, judgePrice } from "../src/content/features/listing/verdict";
import type { HistoryStats } from "../src/steam/pricehistory";

function stats(overrides: Partial<HistoryStats> = {}): HistoryStats {
  return {
    points: 100,
    last: 10000,
    lastAt: Date.now(),
    average7d: 10000,
    average30d: 10000,
    min30d: 8000,
    max30d: 12000,
    volume7d: 20,
    volume30d: 90,
    ...overrides,
  };
}

describe("judgePrice", () => {
  it("calls a clear discount cheap", () => {
    const judgement = judgePrice(8000, stats());
    assert.equal(judgement.verdict, "cheap");
    assert.ok(judgement.text.includes("20%"), judgement.text);
  });

  it("says so when the price is also the monthly floor", () => {
    const judgement = judgePrice(7000, stats({ min30d: 8000 }));
    assert.equal(judgement.verdict, "cheap");
    assert.ok(judgement.text.includes("минимум за месяц"), judgement.text);
  });

  it("calls a price near the average fair", () => {
    assert.equal(judgePrice(10000, stats()).verdict, "fair");
    assert.equal(judgePrice(9000, stats()).verdict, "fair", "10% off is still ordinary");
    assert.equal(judgePrice(10900, stats()).verdict, "fair");
  });

  it("warns above the average", () => {
    const judgement = judgePrice(13000, stats());
    assert.equal(judgement.verdict, "expensive");
    assert.ok(judgement.text.includes("30%"), judgement.text);
  });

  it("refuses to judge on a handful of sales", () => {
    /** Two sales in a month is not an average, it is an anecdote. */
    const judgement = judgePrice(1000, stats({ volume30d: 2, average30d: 10000 }));
    assert.equal(judgement.verdict, "unknown");
    assert.ok(judgement.text.includes("2"), judgement.text);
    assert.ok(judgement.ratio != null, "the number is still reported");
  });

  it("refuses to judge without history", () => {
    assert.equal(judgePrice(1000, stats({ average30d: null })).verdict, "unknown");
    assert.equal(judgePrice(1000, stats({ average30d: 0 })).verdict, "unknown");
  });

  it("refuses to judge without a current price", () => {
    assert.equal(judgePrice(null, stats()).verdict, "unknown");
    assert.equal(judgePrice(0, stats()).verdict, "unknown");
  });

  it("reports the ratio it used", () => {
    assert.equal(judgePrice(5000, stats({ average30d: 10000 })).ratio, 0.5);
  });
});

describe("describeLiquidity", () => {
  it("calls a busy item busy", () => {
    assert.ok(describeLiquidity(stats({ volume30d: 900 })).includes("бойко"));
  });

  it("gives a daily rate for ordinary items", () => {
    const text = describeLiquidity(stats({ volume30d: 90 }));
    assert.ok(text.includes("3"), text);
    assert.ok(text.includes("в день"), text);
  });

  it("expresses a rare item as days per sale", () => {
    const text = describeLiquidity(stats({ volume30d: 3 }));
    assert.ok(text.includes("редкий"), text);
    assert.ok(text.includes("10"), text);
  });

  it("says plainly when nothing sold", () => {
    assert.ok(describeLiquidity(stats({ volume30d: 0 })).includes("ни одной"));
  });
});

describe("parseListingUrl", () => {
  it("reads appid and hash from a market listing path", () => {
    const target = parseListingUrl("/market/listings/730/AK-47%20%7C%20Redline%20(Field-Tested)");
    assert.equal(target?.appid, 730);
    assert.equal(target?.hash, "AK-47 | Redline (Field-Tested)");
  });

  it("handles a community item hash", () => {
    const target = parseListingUrl("/market/listings/753/296830-%3ACoffeeBreak%3A");
    assert.equal(target?.appid, 753);
    assert.equal(target?.hash, "296830-:CoffeeBreak:");
  });

  it("survives a malformed escape rather than throwing", () => {
    const target = parseListingUrl("/market/listings/730/broken%ZZ");
    assert.equal(target?.appid, 730);
    assert.equal(target?.hash, "broken%ZZ");
  });

  it("ignores other market pages", () => {
    assert.equal(parseListingUrl("/market/"), null);
    assert.equal(parseListingUrl("/market/mylistings"), null);
    assert.equal(parseListingUrl("/market/listings/730/"), null);
    assert.equal(parseListingUrl("/market/search"), null);
  });
});
