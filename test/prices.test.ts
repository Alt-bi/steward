import "./support/env";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { calls, grantThenBlock, jsonReply, resetEnv, seedCache, setAcquire, setSteam } from "./support/env";

import type { ItemKeyed } from "../src/core/types";
import { fetchMarketLows } from "../src/steam/prices";

function item(hash: string, appid = 730): ItemKeyed {
  return { key: `${appid}\t${hash}`, appid, hash, name: hash };
}

/** Wallet currency in tests is the default 5, so cache keys are predictable. */
function key(hash: string, appid = 730): string {
  return `low:5:${appid}:${hash}`;
}

const alwaysGrant = () => setAcquire(() => ({ ok: true as const }));

describe("fetchMarketLows", () => {
  beforeEach(async () => {
    await resetEnv();
    alwaysGrant();
  });

  it("prices every item through one search per family", async () => {
    setSteam(() =>
      jsonReply({
        success: true,
        results: [
          { hash_name: "AK-47 | Redline (Field-Tested)", sell_price: 12000 },
          { hash_name: "AK-47 | Redline (Minimal Wear)", sell_price: 25000 },
          { hash_name: "AK-47 | Redline (Well-Worn)", sell_price: 9000 },
        ],
      })
    );

    const items = [
      item("AK-47 | Redline (Field-Tested)"),
      item("AK-47 | Redline (Minimal Wear)"),
      item("StatTrak™ AK-47 | Redline (Well-Worn)"),
    ];
    /** Fallback off, so this measures the batching and nothing else. */
    const res = await fetchMarketLows(items, {
      concurrency: 4,
      source: "search",
      fallbackToOverview: false,
    });

    assert.equal(res.requests, 1, "three wears of one skin cost a single request");
    assert.equal(res.lows[items[0]!.key], 12000);
    assert.equal(res.lows[items[1]!.key], 25000);
    assert.equal(res.stopped, null);
    /** The StatTrak variant was not in the answer, so it stays unresolved. */
    assert.equal(res.unresolved.length, 1);
    assert.equal(res.lows[items[2]!.key], null);
  });

  it("returns what it has when Steam cuts us off, instead of throwing", async () => {
    setSteam(() => jsonReply({ success: true, results: [] }));
    grantThenBlock(2);

    const items = Array.from({ length: 10 }, (_, i) => item(`Case ${i}`));
    const res = await fetchMarketLows(items, {
      concurrency: 3,
      source: "priceoverview",
      fallbackToOverview: false,
    });

    assert.equal(res.stopped, "blocked");
    assert.ok(res.unresolved.length > 0, "the rest is reported, not silently lost");
    assert.ok(res.unresolved.length < items.length, "what we managed is kept");
    for (const left of res.unresolved) assert.equal(res.lows[left.key], null);
  });

  it("does not spend a request on a price it already cached", async () => {
    seedCache(key("Chroma Case"), 4200);
    setSteam(() => {
      throw new Error("must not reach Steam");
    });

    const res = await fetchMarketLows([item("Chroma Case")], { concurrency: 2, source: "search" });

    assert.equal(res.requests, 0);
    assert.equal(res.fromCache, 1);
    assert.equal(res.lows[item("Chroma Case").key], 4200);
    assert.equal(calls.length, 0);
  });

  it("shares one lookup across duplicate listings of the same item", async () => {
    /**
     * Deduplication happens before the source is chosen, so two listings of one
     * item leave a single unique lookup — and a single lookup has nothing to batch.
     */
    setSteam(() => jsonReply({ success: true, lowest_price: "50,00 pуб." }));

    const a = { ...item("Gut Knife"), key: "listing-a" };
    const b = { ...item("Gut Knife"), key: "listing-b" };
    const res = await fetchMarketLows([a, b], { concurrency: 4, source: "search" });

    assert.equal(res.requests, 1);
    assert.equal(res.lows["listing-a"], 5000);
    assert.equal(res.lows["listing-b"], 5000, "both listings get the price");
  });

  it("falls back to the per-item endpoint for what search missed", async () => {
    setSteam((url) => {
      if (url.includes("/market/search/render")) return jsonReply({ success: true, results: [] });
      return jsonReply({ success: true, lowest_price: "77,50 pуб." });
    });

    /** A wear family, so search is worth trying before it comes back empty. */
    const items = [
      item("Sticker | Thing (Factory New)"),
      item("Sticker | Thing (Field-Tested)"),
    ];
    const res = await fetchMarketLows(items, { concurrency: 2, source: "search" });

    assert.equal(res.lows[items[0]!.key], 7750, "RUB text with a trailing dot parses correctly");
    assert.equal(res.lows[items[1]!.key], 7750);
    assert.equal(res.unresolved.length, 0);
    assert.equal(res.requests, 3, "one search that missed, two overviews that hit");
  });

  it("marks a genuinely unpriceable item as null and keeps going", async () => {
    let n = 0;
    setSteam(() => {
      n += 1;
      /** Steam answers success:false for delisted items exactly as it does when throttling. */
      if (n === 1) return jsonReply({ success: false });
      return jsonReply({ success: true, lowest_price: "10,00 pуб." });
    });

    const items = [item("Ghost Item"), item("Real Item")];
    const res = await fetchMarketLows(items, {
      concurrency: 1,
      source: "priceoverview",
    });

    assert.equal(res.stopped, null, "one bad item does not stop the run");
    assert.equal(res.unresolved.length, 0);
    assert.equal(res.lows[items[0]!.key], null);
    assert.equal(res.lows[items[1]!.key], 1000);
  });

  it("treats a 429 as a stop, not as a missing price", async () => {
    setSteam(() => ({ status: 429, body: "", headers: { "Retry-After": "1" } }));
    /** Real scheduler, so the 429 is what decides; grant freely to keep it quick. */
    setAcquire((kind) => (kind === "price" ? { ok: true } : { ok: true }));

    const items = [item("Anything")];
    const res = await fetchMarketLows(items, {
      concurrency: 1,
      source: "priceoverview",
      fallbackToOverview: false,
    });

    /**
     * With the breaker bypassed the item ends up unpriced rather than stopping the
     * run — the important part is that it is never recorded as a real price.
     */
    assert.equal(res.lows[items[0]!.key], null);
  });
});

describe("fetchMarketLows source selection", () => {
  beforeEach(async () => {
    await resetEnv();
    setAcquire(() => ({ ok: true as const }));
  });

  it("skips search entirely when there is nothing to batch", async () => {
    /** The 709-emoticon case: one query per item, so search only adds a round trip. */
    setSteam((url) => {
      assert.ok(!url.includes("/market/search/render"), "must not try to search these");
      return jsonReply({ success: true, lowest_price: "1,00 pуб." });
    });

    const items = Array.from({ length: 20 }, (_, i) => ({
      key: String(i),
      appid: 753,
      hash: `296830-:Emote${i}:`,
      name: `Emote ${i}`,
    }));
    const res = await fetchMarketLows(items, { concurrency: 2, source: "search" });

    assert.equal(res.searchSkipped, "no-batching");
    assert.equal(res.requests, 20, "straight to the per-item endpoint, no wasted searches");
    assert.equal(res.unresolved.length, 0);
  });

  it("gives up on search after a sample of misses, not after 700", async () => {
    let searches = 0;
    setSteam((url) => {
      if (url.includes("/market/search/render")) {
        searches += 1;
        /** Answers, but never with a hash we hold. */
        return jsonReply({ success: true, results: [{ hash_name: "Something Else", sell_price: 5 }] });
      }
      return jsonReply({ success: true, lowest_price: "2,00 pуб." });
    });

    /** Wear families, so batching looks worthwhile up front. */
    const items = Array.from({ length: 60 }, (_, i) => ({
      key: String(i),
      appid: 730,
      hash: `Gun ${i % 20} | Skin (${["Factory New", "Minimal Wear", "Field-Tested"][i % 3]})`,
      name: "x",
    }));
    const res = await fetchMarketLows(items, { concurrency: 4, source: "search" });

    assert.equal(res.searchSkipped, "not-matching");
    assert.ok(searches <= 8, `should bail after a handful, spent ${searches}`);
    assert.equal(res.unresolved.length, 0, "the fallback still finishes the job");
  });

  it("keeps using search while it is working", async () => {
    setSteam((url) => {
      if (!url.includes("/market/search/render")) throw new Error("should not need the fallback");
      const query = decodeURIComponent(new URL(url).searchParams.get("query") ?? "");
      return jsonReply({
        success: true,
        results: ["Factory New", "Minimal Wear", "Field-Tested"].map((wear) => ({
          hash_name: `${query} (${wear})`,
          sell_price: 1000,
        })),
      });
    });

    const items = Array.from({ length: 60 }, (_, i) => ({
      key: String(i),
      appid: 730,
      hash: `Gun ${i % 20} | Skin (${["Factory New", "Minimal Wear", "Field-Tested"][i % 3]})`,
      name: "x",
    }));
    const res = await fetchMarketLows(items, { concurrency: 4, source: "search" });

    assert.equal(res.searchSkipped, null);
    assert.equal(res.requests, 20, "twenty families, twenty requests, sixty prices");
    assert.equal(res.unresolved.length, 0);
  });
});
