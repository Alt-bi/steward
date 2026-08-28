import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  downsample,
  parseHistoryDate,
  parsePriceHistory,
  sparkline,
  summarizeHistory,
  toCents,
  type HistoryPoint,
} from "../src/steam/pricehistory";

const DAY = 86_400_000;

function point(daysAgo: number, price: number, volume = 1, now = 0): HistoryPoint {
  return { t: now - daysAgo * DAY, price, volume };
}

describe("parseHistoryDate", () => {
  it("reads Steam's own format", () => {
    assert.equal(parseHistoryDate("Jul 25 2016 01: +0"), Date.UTC(2016, 6, 25, 1));
  });

  it("reads a row with no hour", () => {
    assert.equal(parseHistoryDate("Dec 01 2023"), Date.UTC(2023, 11, 1, 0));
  });

  it("is case insensitive about the month", () => {
    assert.equal(parseHistoryDate("JUL 25 2016 01: +0"), parseHistoryDate("Jul 25 2016 01: +0"));
  });

  it("rejects what it cannot read rather than inventing a date", () => {
    assert.equal(parseHistoryDate("Foo 25 2016"), null);
    assert.equal(parseHistoryDate("2016-07-25"), null);
    assert.equal(parseHistoryDate(""), null);
    assert.equal(parseHistoryDate(undefined as unknown as string), null);
  });
});

describe("toCents", () => {
  it("converts wallet floats without drift", () => {
    assert.equal(toCents(12.34), 1234);
    assert.equal(toCents(0.03), 3);
    assert.equal(toCents(1234.5), 123450);
  });

  it("rounds the third decimal Steam sometimes sends", () => {
    assert.equal(toCents(12.345), 1235);
    assert.equal(toCents(12.344), 1234);
  });

  it("treats nothing and nonsense as zero", () => {
    assert.equal(toCents(0), 0);
    assert.equal(toCents(-5), 0);
    assert.equal(toCents("abc"), 0);
    assert.equal(toCents(null), 0);
  });
});

describe("parsePriceHistory", () => {
  it("reads rows into sorted points", () => {
    const points = parsePriceHistory({
      success: true,
      prices: [
        ["Jul 26 2016 01: +0", 2.5, "10"],
        ["Jul 25 2016 01: +0", 2.0, "4"],
      ],
    });
    assert.equal(points.length, 2);
    assert.ok(points[0]!.t < points[1]!.t, "sorted oldest first regardless of input order");
    assert.equal(points[0]!.price, 200);
    assert.equal(points[0]!.volume, 4);
  });

  it("drops rows it cannot use instead of poisoning the series", () => {
    const points = parsePriceHistory({
      prices: [
        ["not a date", 5, "1"],
        ["Jul 25 2016 01: +0", 0, "1"],
        ["Jul 25 2016 01: +0", 1.5, "bad volume"],
      ] as [string, number, string][],
    });
    assert.equal(points.length, 1, "only the row with a date and a real price survives");
    assert.equal(points[0]!.volume, 0, "an unreadable volume counts as zero, not NaN");
  });

  it("survives a missing or empty payload", () => {
    assert.deepEqual(parsePriceHistory({}), []);
    assert.deepEqual(parsePriceHistory({ prices: null }), []);
    assert.deepEqual(parsePriceHistory({ prices: [] }), []);
  });
});

describe("summarizeHistory", () => {
  const now = Date.UTC(2024, 0, 31);

  it("reports the most recent sale", () => {
    const points = [point(10, 1000, 1, now), point(1, 1500, 1, now)];
    const stats = summarizeHistory(points, now);
    assert.equal(stats.last, 1500);
    assert.equal(stats.lastAt, now - DAY);
  });

  it("weights averages by how many actually sold", () => {
    /** One sale at 100, ninety-nine at 200: the average must lean to 200. */
    const points = [point(2, 10000, 1, now), point(1, 20000, 99, now)];
    const stats = summarizeHistory(points, now);
    assert.ok(stats.average7d! > 19000, `got ${stats.average7d}`);
  });

  it("separates the 7 and 30 day windows", () => {
    const points = [point(20, 1000, 1, now), point(2, 3000, 1, now)];
    const stats = summarizeHistory(points, now);
    assert.equal(stats.average7d, 3000, "the old sale is outside the week");
    assert.equal(stats.average30d, 2000);
    assert.equal(stats.min30d, 1000);
    assert.equal(stats.max30d, 3000);
  });

  it("ignores sales older than the windows", () => {
    const stats = summarizeHistory([point(400, 9999, 5, now)], now);
    assert.equal(stats.average30d, null);
    assert.equal(stats.volume30d, 0);
    assert.equal(stats.last, 9999, "but the last known price still stands");
  });

  it("sums volume per window", () => {
    const stats = summarizeHistory([point(2, 100, 7, now), point(20, 100, 5, now)], now);
    assert.equal(stats.volume7d, 7);
    assert.equal(stats.volume30d, 12);
  });

  it("returns empties for no history at all", () => {
    const stats = summarizeHistory([], now);
    assert.equal(stats.points, 0);
    assert.equal(stats.last, null);
    assert.equal(stats.average30d, null);
  });

  it("counts a zero-volume day at weight one rather than discarding it", () => {
    const stats = summarizeHistory([point(1, 500, 0, now)], now);
    assert.equal(stats.average7d, 500);
  });
});

describe("downsample", () => {
  it("leaves a short series alone", () => {
    const points = [point(3, 100), point(2, 200), point(1, 300)];
    assert.deepEqual(downsample(points, 10), points);
  });

  it("collapses a long series to at most the bucket count", () => {
    const points = Array.from({ length: 500 }, (_, i) => point(500 - i, 100 + i));
    const reduced = downsample(points, 40);
    assert.ok(reduced.length <= 40, `got ${reduced.length}`);
    assert.ok(reduced.length >= 30, "and does not throw most buckets away");
  });

  it("averages within a bucket instead of sampling it", () => {
    /** A spike must still move its bucket, wherever the boundary lands. */
    const flat = Array.from({ length: 100 }, (_, i) => point(100 - i, 1000));
    const withSpike = flat.map((p, i) => (i === 95 ? { ...p, price: 100000 } : p));
    const reduced = downsample(withSpike, 10);
    assert.ok(
      reduced.some((p) => p.price > 1000),
      "the spike survives downsampling"
    );
  });

  it("keeps the series in time order", () => {
    const points = Array.from({ length: 200 }, (_, i) => point(200 - i, 100 + (i % 7)));
    const reduced = downsample(points, 20);
    for (let i = 1; i < reduced.length; i++) {
      assert.ok(reduced[i]!.t >= reduced[i - 1]!.t, "time must not go backwards");
    }
  });

  it("sums volume rather than averaging it", () => {
    const points = Array.from({ length: 100 }, (_, i) => point(100 - i, 1000, 2));
    const reduced = downsample(points, 5);
    const total = reduced.reduce((sum, p) => sum + p.volume, 0);
    assert.equal(total, 200, "no sales may be lost to the chart");
  });

  it("handles degenerate requests", () => {
    assert.deepEqual(downsample([], 10), []);
    assert.deepEqual(downsample([point(1, 100)], 0), []);
    const same = [point(1, 100), point(1, 200)];
    assert.equal(downsample(same, 1).length, 1, "a zero time span collapses to one point");
  });
});

describe("sparkline", () => {
  it("draws a path across the full width", () => {
    const geometry = sparkline([point(3, 100), point(2, 200), point(1, 150)], 100, 20, 1);
    assert.ok(geometry);
    assert.ok(geometry.line.startsWith("M1,"), `starts at the left padding: ${geometry.line}`);
    assert.ok(geometry.line.includes("L99,"), `reaches the right padding: ${geometry.line}`);
    assert.equal(geometry.min, 100);
    assert.equal(geometry.max, 200);
  });

  it("puts the cheapest point at the bottom and the dearest at the top", () => {
    const geometry = sparkline([point(2, 100), point(1, 200)], 100, 20, 1)!;
    const [firstY, secondY] = geometry.line
      .slice(1)
      .split("L")
      .map((pair) => Number(pair.split(",")[1]));
    assert.ok(firstY! > secondY!, "lower price means larger y in SVG coordinates");
  });

  it("draws a flat series through the middle instead of dividing by zero", () => {
    const geometry = sparkline([point(2, 500), point(1, 500)], 100, 20, 0)!;
    assert.ok(geometry.line.includes(",10"), `expected the midline, got ${geometry.line}`);
    assert.equal(geometry.min, geometry.max);
  });

  it("closes the area path back along the baseline", () => {
    const geometry = sparkline([point(2, 100), point(1, 200)], 100, 20, 1)!;
    assert.ok(geometry.area.startsWith(geometry.line), "the fill follows the same line");
    assert.ok(geometry.area.endsWith("Z"), "and is closed");
  });

  it("refuses to draw what cannot be drawn", () => {
    assert.equal(sparkline([], 100, 20), null);
    assert.equal(sparkline([point(1, 100)], 100, 20), null, "one point is not a line");
    assert.equal(sparkline([point(2, 1), point(1, 2)], 0, 20), null);
  });
});
