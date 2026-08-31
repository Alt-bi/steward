import "./support/env";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { calls, grantThenBlock, jsonReply, resetEnv, setAcquire, setSteam } from "./support/env";

import type { ItemKeyed } from "../src/core/types";
import { clearHistories, resolveHistories, unknownHistories } from "../src/steam/histories";
import { summarizeHistory, type HistoryPoint } from "../src/steam/pricehistory";

function item(hash: string, appid = 730): ItemKeyed {
  return { key: `${appid}\t${hash}`, appid, hash, name: hash };
}

/** Steam's own shape: `["Jul 25 2016 01: +0", 12.34, "5"]`, prices as wallet floats. */
function sale(day: number, price: number, volume = 10): [string, number, string] {
  const date = new Date(Date.now() - day * 86_400_000);
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return [`${month} ${date.getUTCDate()} ${date.getUTCFullYear()} 01: +0`, price, String(volume)];
}

const alwaysGrant = () => setAcquire(() => ({ ok: true as const }));

describe("summarizeHistory", () => {
  const now = Date.UTC(2024, 5, 1);
  const at = (daysAgo: number, price: number, volume: number): HistoryPoint => ({
    t: now - daysAgo * 86_400_000,
    price,
    volume,
  });

  it("weights each window by how much actually sold in it", () => {
    const points = [at(300, 20000, 1), at(20, 10000, 1), at(2, 5000, 9)];
    const stats = summarizeHistory(points, now);
    assert.equal(stats.average7d, 5000, "only the recent sale is inside a week");
    /** 10000×1 + 5000×9 over 10 sales. */
    assert.equal(stats.average30d, 5500);
    assert.equal(stats.average365d, Math.round((20000 + 10000 + 5000 * 9) / 11));
  });

  it("reports how far back the history reaches, so a young item cannot fake a year", () => {
    const stats = summarizeHistory([at(20, 100, 5), at(1, 110, 5)], now);
    assert.equal(stats.spanDays, 20);
    assert.equal(stats.volume365d, 10);
  });

  it("has no averages and no span for an empty series", () => {
    const stats = summarizeHistory([], now);
    assert.equal(stats.average365d, null);
    assert.equal(stats.spanDays, 0);
  });
});

describe("resolveHistories", () => {
  beforeEach(async () => {
    await resetEnv();
    await clearHistories();
    alwaysGrant();
  });

  it("asks once per item and keeps the answer for the next scan", async () => {
    setSteam(() => jsonReply({ success: true, prices: [sale(3, 12.5), sale(1, 13)] }));

    const items = [item("Chroma Case"), item("Chroma Case"), item("Glove Case")];
    const first = await resolveHistories(items);

    assert.equal(first.requests, 2, "two listings of one item share one history");
    assert.equal(first.stats[items[0]!.key]?.points, 2);
    assert.equal(first.stopped, null);

    calls.length = 0;
    const second = await resolveHistories(items);
    assert.equal(second.requests, 0);
    assert.equal(second.fromCache, 2);
    assert.equal(calls.length, 0, "nothing left the browser the second time");
  });

  it("says up front what a run would cost", async () => {
    setSteam(() => jsonReply({ success: true, prices: [sale(1, 5)] }));
    const items = [item("A"), item("B"), item("C")];
    assert.equal((await unknownHistories(items)).length, 3);

    await resolveHistories([items[0]!]);
    assert.deepEqual(
      (await unknownHistories(items)).map((i) => i.hash),
      ["B", "C"],
      "the quote only counts what we would actually have to ask for"
    );
  });

  it("stops at the first refusal instead of hammering the slowest endpoint", async () => {
    setSteam(() => jsonReply({ success: true, prices: [sale(1, 5)] }));
    grantThenBlock(1);

    const items = [item("A"), item("B"), item("C")];
    const result = await resolveHistories(items);

    assert.equal(result.stopped, "blocked");
    assert.equal(result.requests, 1);
    assert.equal(result.unresolved.length, 2, "what we never asked about is handed back");
  });

  it("remembers that an item has never sold, instead of asking again every scan", async () => {
    /**
     * Steam answering `{"success":true,"prices":[]}` is Steam speaking: this item
     * has no recorded sales. Treating it as a refusal meant a thrown error, and a
     * thrown error is never cached — so the same item was re-asked on every run,
     * on the endpoint we are rationed hardest on.
     */
    setSteam(() => jsonReply({ success: true, prices: [] }));
    const items = [item("Never Sold")];

    const first = await resolveHistories(items);
    assert.equal(first.stats[items[0]!.key]?.points, 0, "an answer, and an empty one");
    assert.equal(first.unresolved.length, 0);
    assert.equal((await unknownHistories(items)).length, 0, "and we do not come back for it");
  });

  it("does not cache a refusal", async () => {
    /**
     * The other shape, measured against the live endpoint: a name Steam does not
     * know answers HTTP 500 with `success:false`. That says nothing about the
     * item, so it must stay unknown and be asked again.
     */
    setSteam(() => ({ status: 500, body: JSON.stringify({ success: false, prices: false }) }));
    const items = [item("Never Sold")];

    const first = await resolveHistories(items);
    assert.equal(first.stats[items[0]!.key], null);
    assert.equal(first.unresolved.length, 1);
    assert.equal((await unknownHistories(items)).length, 1);
  });

  it("returns a partial result rather than throwing when a run is aborted", async () => {
    setSteam(() => jsonReply({ success: true, prices: [sale(1, 5)] }));
    let done = 0;
    const result = await resolveHistories([item("A"), item("B"), item("C")], {
      abort: () => done++ >= 2,
    });
    assert.equal(result.stopped, "aborted");
    assert.ok(result.requests < 3);
  });
});
