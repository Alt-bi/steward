import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_FEES } from "../src/core/fees";
import type { Cents, Listing, RepricePlan } from "../src/core/types";
import { planRestore, recordFrom, restoreCoverage } from "../src/content/features/reprice/undo";

/**
 * The way back from «Переставить».
 *
 * Pressing it again is not an undo: the repricer aims at the market, so a
 * second run lands wherever the market is now. The prices from before have to
 * be remembered, and they already are — `ourBuyer` on each plan is what the lot
 * asked before the run touched it.
 */

function listing(over: Partial<Listing> & { listingId: string; ourBuyer: Cents }): Listing {
  return {
    appid: 730,
    contextid: "2",
    assetid: `a${over.listingId}`,
    amount: 1,
    name: "Fracture Case",
    hash: "Fracture Case",
    ourSeller: Math.round(over.ourBuyer * 0.87),
    publisherFeePercent: 10,
    ...over,
  };
}

function moved(over: Partial<RepricePlan> & { listingId: string; ourBuyer: Cents }): RepricePlan {
  return {
    name: "Fracture Case",
    hash: "Fracture Case",
    appid: 730,
    contextid: "2",
    assetid: `a${over.listingId}`,
    amount: 1,
    ourSeller: 0,
    competitorBuyer: null,
    targetBuyer: 9000,
    targetSeller: 7800,
    publisherFeePercent: 10,
    action: "reprice",
    reason: "",
    result: "ok",
    ...over,
  };
}

describe("remembering what a run overwrote", () => {
  it("keeps only the lots that actually moved", () => {
    const record = recordFrom([
      moved({ listingId: "1", ourBuyer: 15000 }),
      moved({ listingId: "2", ourBuyer: 12000, result: "fail" }),
      moved({ listingId: "3", ourBuyer: 11000, action: "skip" }),
      moved({ listingId: "4", ourBuyer: 0 }),
    ]);
    assert.deepEqual(
      record.lots.map((lot) => lot.buyer),
      [15000],
      "неудача, пропуск и лот без цены возвращать нечем"
    );
  });

  it("remembers the price from before the move, not the one it moved to", () => {
    const record = recordFrom([moved({ listingId: "1", ourBuyer: 15000, targetBuyer: 9000 })]);
    assert.equal(record.lots[0]?.buyer, 15000);
  });
});

describe("putting the prices back", () => {
  const record = recordFrom([
    moved({ listingId: "1", ourBuyer: 15000 }),
    moved({ listingId: "2", ourBuyer: 20000 }),
  ]);

  /**
   * `sellitem` hands back no listing id, and a lot waiting on Steam Guard is not
   * on the market at all — so the restore cannot address the new lots. It reads
   * the page again and pairs by item, then by price.
   */
  it("pairs the cheapest lot we hold with the cheapest price we remember", () => {
    const plans = planRestore(
      record,
      [
        listing({ listingId: "new-b", ourBuyer: 9500 }),
        listing({ listingId: "new-a", ourBuyer: 9000 }),
      ],
      DEFAULT_FEES
    );
    const byId = new Map(plans.map((plan) => [plan.listingId, plan.targetBuyer]));
    assert.equal(plans.length, 2);
    assert.ok((byId.get("new-a") ?? 0) < (byId.get("new-b") ?? 0), "порядок цен сохраняется");
  });

  it("never aims above the price it remembers", () => {
    const plans = planRestore(record, [listing({ listingId: "n", ourBuyer: 9000 })], DEFAULT_FEES);
    const target = plans[0]?.targetBuyer ?? 0;
    assert.ok(target > 0);
    assert.ok(target <= 15000, `цена восстановления ${target} выше запомненной 15000`);
  });

  /**
   * A "restore" onto the price a lot already has would cancel it and re-list it
   * for nothing — the most expensive possible way to change nothing, paid in
   * queue position and a Steam Guard prompt.
   */
  it("leaves alone a lot that is already at the remembered price", () => {
    const one = recordFrom([moved({ listingId: "1", ourBuyer: 15000 })]);
    const plans = planRestore(one, [listing({ listingId: "n", ourBuyer: 15000 })], DEFAULT_FEES);
    assert.deepEqual(plans, []);
  });

  it("plans nothing when the items on the page are different items", () => {
    const plans = planRestore(
      record,
      [listing({ listingId: "n", ourBuyer: 9000, hash: "AK-47 | Redline", name: "AK" })],
      DEFAULT_FEES
    );
    assert.deepEqual(plans, []);
  });

  it("says nothing to do rather than inventing one when there is no record", () => {
    assert.deepEqual(planRestore(null, [listing({ listingId: "n", ourBuyer: 1 })], DEFAULT_FEES), []);
  });

  /** Half a batch restored quietly is worse than a number saying it was half. */
  it("counts what it could not find", () => {
    const plans = planRestore(record, [listing({ listingId: "n", ourBuyer: 9000 })], DEFAULT_FEES);
    assert.deepEqual(restoreCoverage(record, plans), { remembered: 2, found: 1, missing: 1 });
  });
});
