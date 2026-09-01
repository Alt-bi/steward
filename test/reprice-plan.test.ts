import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BookLiveness,
  buildPlans,
  competitorFromMarketLow,
  competitorFromScan,
  groupListings,
  needsExactCheck,
  type CompetitorLow,
} from "../src/content/features/reprice/plan";
import type { CompetitorScan } from "../src/steam/listings";
import { buyerPrice, DEFAULT_FEES } from "../src/core/fees";
import { DEFAULT_SETTINGS, type Settings } from "../src/core/settings";
import type { PriceLevel } from "../src/core/levels";
import type { Cents, Listing } from "../src/core/types";
import type { HistoryStats } from "../src/steam/pricehistory";

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
  for (const g of groups.values()) {
    lows.set(g.key, { buyer: competitor, source: "listings", theirs: true });
  }
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

  it("does not reprice a listing whose price we failed to read", () => {
    const plans = planFromCompetitor([listing("1", "AK", 0)], 258);
    assert.equal(repriced(plans).length, 0);
    assert.equal(plans[0]!.reason, "не разобрал цену лота");
  });

  it("does not undercut 2.58 when we already listed at 2.58", () => {
    const { plans } = planFromMarketLow([listing("1", "AK", 258)], 258);
    assert.equal(repriced(plans).length, 0);
    assert.match(plans[0]!.reason, /минимум/);
  });

  it("says why it skipped, and marks both as unchecked", () => {
    const noPrice = planFromMarketLow([listing("1", "AK", 500)], null);
    assert.match(noPrice.plans[0]!.reason, /нет цены рынка/);
    assert.equal(noPrice.plans[0]!.unverified, true);

    const ours = planFromMarketLow([listing("1", "AK", 500)], 500);
    assert.match(ours.plans[0]!.reason, /не проверял/);
    assert.equal(
      ours.plans[0]!.unverified,
      true,
      "priceoverview is cached for hours; yesterday's minimum was ours"
    );
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

describe("a listing whose asset we cannot name", () => {
  it("is never planned for repricing, because cancelling it is one-way", () => {
    /**
     * `removelisting` succeeds without an assetid; `sellitem` cannot. Planning one
     * of these means cancelling a lot that can never be put back.
     */
    const blind = { ...listing("1", "Chroma Case", 1000), assetid: "" };
    const plans = planFromCompetitor([blind], 500);
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.action, "skip");
    assert.match(plans[0]!.reason, /assetid/);
  });

  it("does not stop the listings next to it from being repriced", () => {
    const blind = { ...listing("1", "Chroma Case", 1000), assetid: "" };
    const fine = listing("2", "Glove Case", 1000);
    const plans = planFromCompetitor([blind, fine], 500);
    const repriced = plans.filter((p) => p.action === "reprice");
    assert.deepEqual(
      repriced.map((p) => p.listingId),
      ["2"]
    );
  });
});

function scan(over: Partial<CompetitorScan> = {}): CompetitorScan {
  return {
    marketLow: null,
    competitor: null,
    seen: 0,
    allOurs: false,
    crowded: false,
    flagged: false,
    unnamed: false,
    ...over,
  };
}

describe("competitorFromScan", () => {
  it("takes the competitor off the book and records who vouches for it", () => {
    const low = competitorFromScan(scan({ marketLow: 100, competitor: 120, seen: 5 }), true);
    assert.equal(low.buyer, 120);
    assert.equal(low.source, "listings");
    assert.equal(low.theirs, true);
    assert.equal(needsExactCheck(low), false);
  });

  it("only calls us sole holder when the window had room to prove it", () => {
    const alone = competitorFromScan(scan({ marketLow: 100, seen: 3, allOurs: true }), true);
    assert.equal(alone.source, "sole");
    assert.equal(needsExactCheck(alone), false, "this one was actually looked at");

    const crowded = competitorFromScan(
      scan({ marketLow: 100, seen: 10, allOurs: true, crowded: true }),
      true
    );
    assert.equal(crowded.source, "ours");
    assert.equal(needsExactCheck(crowded), true, "a competitor may sit just past the window");
  });

  it("reports an empty book as no price, not as a win", () => {
    assert.equal(competitorFromScan(scan(), true).source, "no-price");
  });
});

describe("a minimum we share with a stranger", () => {
  const tied = (theirs: boolean, over: Partial<Settings> = {}) => {
    const settings = { ...DEFAULT_SETTINGS, ...over };
    const groups = groupListings([listing("1", "AK", 10000)]);
    const lows = new Map<string, CompetitorLow>();
    for (const g of groups.values()) {
      lows.set(g.key, { buyer: 10000, source: "listings", theirs });
    }
    return buildPlans(groups, lows, settings, fees);
  };

  it("moves under it, because at equal prices the older listing sells first", () => {
    const moved = repriced(tied(true));
    assert.equal(moved.length, 1, "a tie is not a held minimum");
    assert.ok(moved[0]!.targetBuyer! < 10000);
    assert.equal(moved[0]!.reason, "делим минимум с чужим лотом");
  });

  it("stands pat, and says so, while the lot at our price might be our own", () => {
    const plans = tied(false);
    assert.equal(repriced(plans).length, 0);
    assert.equal(plans[0]!.unverified, true);
    assert.match(plans[0]!.reason, /не знаю, чей/);
  });

  it("does not confuse a tie with actually being cheaper", () => {
    const ahead = planFromCompetitor([listing("1", "AK", 9000)], 10000);
    assert.equal(repriced(ahead).length, 0);
    assert.equal(ahead[0]!.unverified, false, "this one was checked and we won");
  });
});

describe("a minimum the listing book confirmed is ours alone", () => {
  it("is the only skip that counts as checked", () => {
    const groups = groupListings([listing("1", "AK", 10000)]);
    const lows = new Map<string, CompetitorLow>();
    for (const g of groups.values()) lows.set(g.key, { buyer: null, source: "sole", marketLow: 10000 });
    const plans = buildPlans(groups, lows, DEFAULT_SETTINGS, fees);
    assert.equal(plans[0]!.action, "skip");
    assert.equal(plans[0]!.unverified, false);
    assert.match(plans[0]!.reason, /одни на минимуме/);
  });
});

function history(over: Partial<HistoryStats> = {}): HistoryStats {
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
    ...over,
  };
}

function planAtLevel(
  listings: Listing[],
  level: PriceLevel,
  low: CompetitorLow,
  stats: HistoryStats | null,
  over: Partial<Settings> = {}
) {
  const settings = { ...DEFAULT_SETTINGS, ...over };
  const groups = groupListings(listings);
  const lows = new Map<string, CompetitorLow>();
  const statsByKey: Record<string, HistoryStats | null> = {};
  for (const g of groups.values()) {
    lows.set(g.key, low);
    statsByKey[g.key] = stats;
  }
  return buildPlans(groups, lows, settings, fees, { level, stats: statsByKey });
}

describe("pricing at a historical level", () => {
  const onMarket: CompetitorLow = { buyer: 9000, source: "listings", marketLow: 9000, theirs: true };

  it("moves a listing up to what the month says it is worth", () => {
    const plans = planAtLevel([listing("1", "AK", 9500)], "avg30", onMarket, history());
    const moved = repriced(plans);
    assert.equal(moved.length, 1, "repricing is not only ever downwards");
    assert.ok(moved[0]!.targetBuyer! > 9500);
    assert.ok(moved[0]!.targetBuyer! <= 11000);
    assert.match(moved[0]!.reason, /вверх/);
  });

  it("moves it down when the year says we are asking too much", () => {
    const plans = planAtLevel([listing("1", "AK", 40000)], "avg365", onMarket, history());
    const moved = repriced(plans);
    assert.equal(moved.length, 1);
    assert.ok(moved[0]!.targetBuyer! < 40000);
    assert.match(moved[0]!.reason, /вниз/);
  });

  it("holds above the market when the average sits below it", () => {
    /** Competitor at 200.00, month average 110.00: pricing at the average is a gift. */
    const rich: CompetitorLow = { buyer: 20000, source: "listings", marketLow: 20000, theirs: true };
    const plans = planAtLevel([listing("1", "AK", 30000)], "avg30", rich, history());
    const moved = repriced(plans);
    assert.equal(moved.length, 1);
    assert.ok(moved[0]!.targetBuyer! < 20000, "still under the competitor");
    assert.ok(moved[0]!.targetBuyer! > 11000, "but nowhere near the average");
    assert.match(moved[0]!.reason, /ниже рынка/);
  });

  it("ignores «we already hold the minimum» — the target is a price, not a place", () => {
    const ours: CompetitorLow = { buyer: null, source: "sole", marketLow: 9000 };
    const plans = planAtLevel([listing("1", "AK", 9000)], "avg30", ours, history());
    assert.equal(repriced(plans).length, 1, "cheapest on the market is not «done» here");
  });

  it("refuses to move anything on a level it cannot compute, and says so", () => {
    const plans = planAtLevel([listing("1", "AK", 9500)], "avg365", onMarket, history({ spanDays: 12 }));
    assert.equal(repriced(plans).length, 0);
    assert.equal(plans[0]!.unverified, true);
    assert.match(plans[0]!.reason, /истории меньше/);
  });

  it("still refuses a listing with no assetid, for the same one-way reason", () => {
    const blind = { ...listing("1", "AK", 9500), assetid: "" };
    const plans = planAtLevel([blind], "avg30", onMarket, history());
    assert.equal(repriced(plans).length, 0);
    assert.match(plans[0]!.reason, /assetid/);
  });

  it("still moves one lot per item", () => {
    const plans = planAtLevel(
      [listing("1", "AK", 9500), listing("2", "AK", 9600)],
      "avg30",
      onMarket,
      history()
    );
    assert.equal(repriced(plans).length, 1);
  });

  it("leaves a listing already sitting on the level alone", () => {
    const moved = repriced(planAtLevel([listing("1", "AK", 9500)], "avg30", onMarket, history()));
    const settled = planAtLevel(
      [listing("1", "AK", moved[0]!.targetBuyer!)],
      "avg30",
      onMarket,
      history()
    );
    assert.equal(repriced(settled).length, 0);
    assert.match(settled[0]!.reason, /уже на уровне/);
  });
});

describe("BookLiveness", () => {
  it("treats one markup answer as weather, not a dead endpoint", () => {
    /**
     * The bug this exists for. Two HTML answers in a live scan used to become a
     * module-level flag that no later scan could clear, so nine items that were
     * never even asked were reported as uncheckable — while the very same
     * endpoint answered a real book of 1652 rows on the same hour.
     */
    const live = new BookLiveness();
    live.sawMarkup();
    assert.equal(live.dead(), false, "a single HTML page must not stop the run");
  });

  it("calls the endpoint dead only after a second markup with nothing between", () => {
    const live = new BookLiveness();
    live.sawMarkup();
    live.sawMarkup();
    assert.equal(live.dead(), true, "a pattern, not a one-off");
  });

  it("lets one answered book wash the streak away", () => {
    const live = new BookLiveness();
    live.sawMarkup();
    live.sawAnswer();
    live.sawMarkup();
    assert.equal(live.dead(), false, "the endpoint answered in between; this is noise again");
  });

  it("clears a dead verdict when the user asks again", () => {
    const live = new BookLiveness();
    live.sawMarkup();
    live.sawMarkup();
    assert.equal(live.dead(), true);
    live.restart();
    assert.equal(live.dead(), false, "a fresh scan is allowed to find it alive again");
  });

  it("lets the verdict expire on its own, without anyone asking again", () => {
    /**
     * «Догрузить цены» does not restart the verdict, and it should not have to:
     * the refusal it describes is a throttle that is over within a minute. As a
     * flag only a fresh scan could clear, it turned every later press into an
     * instant refusal that asked Steam nothing — «Запросов 0» under a sentence
     * about two replies nobody had just received.
     */
    const t0 = 1_000_000;
    const live = new BookLiveness();
    live.sawMarkup(undefined, t0);
    live.sawMarkup("Сообщество Steam :: Торговая площадка сообщества Steam", t0);

    assert.equal(live.dead(t0), true);
    assert.equal(live.dead(t0 + BookLiveness.TTL_MS - 1), true, "внутри окна — молчим");
    assert.equal(live.waitMs(t0 + 30_000), BookLiveness.TTL_MS - 30_000);
    assert.equal(live.dead(t0 + BookLiveness.TTL_MS), false, "окно вышло — снова спрашиваем");
    assert.equal(live.waitMs(t0 + BookLiveness.TTL_MS), 0);
  });

  it("carries the page's own name out with the verdict", () => {
    /**
     * «not_json» hides sorry-pages, age walls and login redirects under one
     * word, and each needs a different fix. The title rides along so the panel
     * reports what Steam sent, not what we guessed.
     */
    const live = new BookLiveness();
    live.sawMarkup("Страница входа Steam");
    live.sawMarkup("Steam Error");
    assert.equal(live.lastMarkup, "Steam Error");
    live.restart();
    assert.equal(live.lastMarkup, "");
  });
});
