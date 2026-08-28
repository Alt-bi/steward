import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPlans,
  competitorFromMarketLow,
  groupListings,
  type CompetitorLow,
} from "../src/content/features/reprice/plan";
import { buyerPrice, DEFAULT_FEES } from "../src/core/fees";
import { DEFAULT_SETTINGS, type Settings } from "../src/core/settings";
import type { Cents, Listing } from "../src/core/types";

const fees = DEFAULT_FEES;

function listing(id: string, hash: string, buyer: Cents): Listing {
  return {
    listingId: id,
    appid: 730,
    contextid: "2",
    assetid: `asset-${id}`,
    amount: 1,
    name: hash,
    hash,
    ourBuyer: buyer,
    ourSeller: Math.round(buyer * 0.85),
    publisherFeePercent: 0.1,
  };
}

function planFromMarketLow(
  listings: Listing[],
  marketLow: Cents | null,
  overrides: Partial<Settings> = {}
) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  const groups = groupListings(listings);
  const lows = new Map<string, CompetitorLow>();
  for (const g of groups.values()) lows.set(g.key, competitorFromMarketLow(g, marketLow));
  return { groups, lows, plans: buildPlans(groups, lows, settings, fees) };
}

function planFromCompetitor(
  listings: Listing[],
  competitor: Cents,
  overrides: Partial<Settings> = {}
) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  const groups = groupListings(listings);
  const lows = new Map<string, CompetitorLow>();
  for (const g of groups.values()) lows.set(g.key, { buyer: competitor, source: "listings" });
  return buildPlans(groups, lows, settings, fees);
}

const repriced = (plans: ReturnType<typeof planFromCompetitor>) =>
  plans.filter((p) => p.action === "reprice");

describe("competitorFromMarketLow", () => {
  it("trusts a market low that sits below our cheapest listing", () => {
    const groups = groupListings([listing("1", "AK", 10000)]);
    const low = competitorFromMarketLow([...groups.values()][0]!, 9000);
    assert.equal(low.buyer, 9000);
    assert.equal(low.source, "priceoverview");
  });

  it("refuses to call our own listing a competitor", () => {
    const groups = groupListings([listing("1", "AK", 10000)]);
    const low = competitorFromMarketLow([...groups.values()][0]!, 10000);
    assert.equal(low.buyer, null);
    assert.equal(low.source, "ours", "this is the case that needs a listing page");
  });

  it("separates no price at all from a price that is ours", () => {
    const groups = groupListings([listing("1", "AK", 10000)]);
    assert.equal(competitorFromMarketLow([...groups.values()][0]!, null).source, "no-price");
    assert.equal(competitorFromMarketLow([...groups.values()][0]!, 0).source, "no-price");
  });
});

describe("buildPlans", () => {
  it("moves exactly one listing per item, the cheapest of ours", () => {
    const { plans } = planFromMarketLow(
      [listing("1", "AK", 10000), listing("2", "AK", 20000)],
      9000
    );
    const moved = repriced(plans);
    assert.equal(moved.length, 1);
    assert.equal(moved[0]!.listingId, "1");
    assert.ok(moved[0]!.targetBuyer! < 9000);
    assert.ok(moved[0]!.targetBuyer! >= 8900, "undercut by a kopeck, not by a rouble");
  });

  it("never undercuts itself when we already hold the minimum", () => {
    const { plans } = planFromMarketLow(
      [listing("1", "AK", 10000), listing("2", "AK", 20000)],
      10000
    );
    assert.equal(repriced(plans).length, 0);
  });

  it("still stands pat when a listing page shows the competitor above us", () => {
    const plans = planFromCompetitor([listing("1", "AK", 10000), listing("2", "AK", 20000)], 15000);
    assert.equal(repriced(plans).length, 0, "our 100 already beats their 150");
  });

  it("moves our only listing down when the competitor undercuts it", () => {
    const plans = planFromCompetitor([listing("2", "AK", 20000)], 15000);
    const moved = repriced(plans);
    assert.equal(moved.length, 1);
    assert.ok(moved[0]!.targetBuyer! < 15000);
    assert.ok(moved[0]!.targetBuyer! > 14000);
  });

  it("moves every overpriced lot when one-per-item is off", () => {
    const { plans } = planFromMarketLow(
      [listing("1", "AK", 10000), listing("2", "AK", 20000)],
      9000,
      { onePerItem: false }
    );
    assert.equal(repriced(plans).length, 2);
  });

  it("refuses to go below the Steam floor", () => {
    const { plans } = planFromMarketLow([listing("1", "AK", 500)], 1);
    assert.equal(repriced(plans).length, 0);
    assert.equal(plans[0]!.reason, "нельзя ниже минимума Steam");
  });

  it("says why it skipped: no price versus minimum is ours", () => {
    const noPrice = planFromMarketLow([listing("1", "AK", 500)], null);
    assert.equal(noPrice.plans[0]!.reason, "нет цены рынка");

    const ours = planFromMarketLow([listing("1", "AK", 500)], 500);
    assert.equal(ours.plans[0]!.reason, "минимум наш — конкурента не видно");
  });

  it("keeps separate items independent", () => {
    const { plans } = planFromMarketLow(
      [listing("1", "AK", 10000), listing("2", "AWP", 10000)],
      9000
    );
    assert.equal(repriced(plans).length, 2, "one move per item, two items");
  });

  it("honours a larger undercut", () => {
    const plans = planFromCompetitor([listing("1", "AK", 20000)], 15000, { undercutCents: 100 });
    const moved = repriced(plans);
    assert.ok(moved[0]!.targetBuyer! <= 15000 - 100);
  });

  it("skips when the fee rounding cannot beat our current price", () => {
    /** Competitor one kopeck under us leaves no room after fees. */
    const plans = planFromCompetitor([listing("1", "AK", 1001)], 1000);
    const moved = repriced(plans);
    if (moved.length) {
      assert.ok(moved[0]!.targetBuyer! < 1001);
    } else {
      assert.ok(plans[0]!.reason.length > 0);
    }
  });

  it("produces a seller price that regenerates the planned buyer price", () => {
    const plans = planFromCompetitor([listing("1", "AK", 50000)], 30000);
    const moved = repriced(plans)[0]!;
    assert.equal(buyerPrice(moved.targetSeller!, 0.1, fees), moved.targetBuyer);
  });

  it("carries assetid through, since sellitem cannot work without it", () => {
    const plans = planFromCompetitor([listing("7", "AK", 50000)], 30000);
    assert.equal(repriced(plans)[0]!.assetid, "asset-7");
  });
});
