import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { noneDropped, togglePick } from "../src/core/picks";
import type { RepricePlan } from "../src/core/types";
import {
  cancellablePlans,
  isMovable,
  listingTotals,
  movablePlans,
  planDrop,
  planMatchesQuery,
  viewPlans,
} from "../src/content/features/reprice/view";

function plan(overrides: Partial<RepricePlan> = {}): RepricePlan {
  return {
    listingId: "1",
    name: "Chroma Case",
    hash: "Chroma Case",
    appid: 730,
    contextid: "2",
    assetid: "10",
    amount: 1,
    ourBuyer: 1000,
    ourSeller: 870,
    competitorBuyer: 800,
    targetBuyer: 790,
    targetSeller: 690,
    publisherFeePercent: 0.1,
    action: "reprice",
    reason: "оверпрайс",
    ...overrides,
  };
}

const over = plan({ listingId: "1", ourBuyer: 1000, targetBuyer: 790 });
const slightly = plan({ listingId: "2", name: "Glove Case", ourBuyer: 500, targetBuyer: 480 });
const skipped = plan({
  listingId: "3",
  name: "AK-47 | Redline",
  hash: "AK-47 | Redline (Field-Tested)",
  action: "skip",
  reason: "мы уже на минимуме",
  targetBuyer: null,
  targetSeller: null,
  ourBuyer: 9000,
});

describe("planDrop", () => {
  it("measures how far the listing would fall", () => {
    assert.equal(planDrop(over), 210);
  });

  it("is zero for anything that is not moving", () => {
    assert.equal(planDrop(skipped), 0);
    assert.equal(planDrop(plan({ action: "reprice", targetBuyer: null })), 0);
  });

  it("never reports a rise as a drop", () => {
    assert.equal(planDrop(plan({ ourBuyer: 100, targetBuyer: 900 })), 0);
  });
});

describe("planMatchesQuery", () => {
  it("searches the hash as well as the name", () => {
    assert.equal(planMatchesQuery(skipped, "field-tested"), true);
    assert.equal(planMatchesQuery(over, "field-tested"), false);
  });

  it("ignores case and repeated spacing", () => {
    assert.equal(planMatchesQuery(over, "  chroma   CASE "), true);
  });
});

describe("viewPlans", () => {
  it("puts the movable listings first, deepest cut on top", () => {
    /** A skip has no drop; sorting it as a zero would scatter the actionable rows. */
    const views = viewPlans([skipped, slightly, over]);
    assert.deepEqual(
      views.map((v) => v.listingId),
      ["1", "2", "3"]
    );
  });

  it("treats a listing already done as no longer movable", () => {
    const done = plan({ listingId: "4", result: "ok", resultMessage: "выставлен" });
    assert.equal(isMovable(done), false);
    /** Still listed — just at the bottom, where nothing is going to happen to it. */
    assert.deepEqual(viewPlans([done, over]).map((v) => v.listingId), ["1", "4"]);
  });

  it("returns nothing rather than everything when the query matches nothing", () => {
    assert.deepEqual(viewPlans([over, skipped], { query: "karambit", only: "" }), []);
  });
});

describe("listingTotals", () => {
  it("adds up the rows on screen, not the whole page", () => {
    const views = viewPlans([over, slightly, skipped], { query: "case", only: "" });
    const totals = listingTotals(views, noneDropped());
    assert.deepEqual(totals, { shown: 2, movable: 2, picked: 2, value: 1500 });
  });

  it("counts the ticked rows, not the shown ones", () => {
    const dropped = noneDropped();
    togglePick("2", dropped);
    assert.equal(listingTotals(viewPlans([over, slightly]), dropped).picked, 1);
  });
});

describe("what each button acts on", () => {
  it("reprices every ticked overpriced listing, shown or not", () => {
    /** Otherwise the button's number would depend on the search box. */
    const hidden = viewPlans([over, slightly], { query: "glove", only: "" });
    assert.equal(hidden.length, 1, "only one row is on screen");
    assert.deepEqual(
      movablePlans([over, slightly], noneDropped()).map((p) => p.listingId),
      ["1", "2"]
    );
  });

  it("leaves out a listing the user unticked", () => {
    const dropped = noneDropped();
    togglePick("1", dropped);
    assert.deepEqual(
      movablePlans([over, slightly], dropped).map((p) => p.listingId),
      ["2"]
    );
  });

  it("cancels only what is on screen and ticked", () => {
    /** The opposite rule from repricing: a mass cancel is aimed with the filter. */
    const views = viewPlans([over, slightly, skipped], { query: "case", only: "" });
    assert.deepEqual(
      cancellablePlans(views, noneDropped()).map((p) => p.listingId),
      ["1", "2"]
    );
  });

  it("cancels skipped listings too — a skip is still on the market", () => {
    const views = viewPlans([skipped], { query: "", only: "" });
    assert.deepEqual(
      cancellablePlans(views, noneDropped()).map((p) => p.listingId),
      ["3"]
    );
  });

  it("never touches a listing that is already gone", () => {
    const gone = plan({ listingId: "9", result: "ok", resultMessage: "снят — предмет в инвентаре" });
    const views = viewPlans([gone], { query: "", only: "" });
    assert.deepEqual(cancellablePlans(views, noneDropped()), []);
  });
});

/**
 * The counters above the list are the filter.
 *
 * A count is already the name of a subset, so «67 оверпрайс» is a better
 * control than a checkbox beside it saying the same thing — and it costs no
 * width at all, because the number was going to be drawn anyway.
 */
describe("filtering by what a counter counts", () => {
  it("narrows to the lots a run would move", () => {
    const views = viewPlans([over, skipped, slightly], { query: "", only: "over" });
    assert.deepEqual(
      views.map((v) => v.listingId),
      ["1", "2"]
    );
  });

  it("narrows to the ones nobody could check", () => {
    const unsure = plan({ listingId: "9", action: "skip", unverified: true });
    assert.deepEqual(
      viewPlans([over, unsure], { query: "", only: "unsure" }).map((v) => v.listingId),
      ["9"]
    );
  });

  it("narrows to the settled skips, which are neither of those", () => {
    const unsure = plan({ listingId: "9", action: "skip", unverified: true });
    assert.deepEqual(
      viewPlans([over, unsure, skipped], { query: "", only: "skip" }).map((v) => v.listingId),
      ["3"]
    );
  });

  it("shows everything again when no counter is pressed", () => {
    assert.equal(viewPlans([over, skipped, slightly], { query: "", only: "" }).length, 3);
  });

  it("still obeys the search box on top of the counter", () => {
    assert.deepEqual(viewPlans([over, slightly], { query: "karambit", only: "over" }), []);
  });
});
