import "./support/env";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { calls, reports, resetEnv, setAcquire, setSteam } from "./support/env";

import { cancelBuyOrder, removeListing, sellItem } from "../src/steam/actions";
import { SteamError } from "../src/steam/net";
import { fetchMyListings } from "../src/steam/mylistings";
import { describeRelistFailure, haltsRun, outcomeUnknown } from "../src/content/ui/errors";

/**
 * The two calls that change what the account is selling, and the one question
 * that matters about each of them: after this threw, is the lot still on the
 * market? A wrong answer there is not a wrong number on a screen — it is the
 * user going to look for an item that is not where they were told it is.
 */

const pacing = {};

/** What Steam serves any request once the session has expired. */
const LOGGED_OUT =
  "<!DOCTYPE html><html><head><script>g_steamID = false;</script></head>" +
  "<body>Please sign in</body></html>";

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (err) {
    return err instanceof SteamError ? err.kind : `other:${String(err)}`;
  }
}

describe("a write sent with a session that has already expired", () => {
  beforeEach(async () => {
    await resetEnv();
    setAcquire(() => ({ ok: true as const }));
  });

  it("is not a success just because Steam answered 200", async () => {
    /**
     * Steam does not fail a POST from a dead session; it answers with the
     * logged-out page, HTTP 200. `removelisting` read anything unparseable as
     * its normal empty-body success, so a run whose session died went on to
     * report every lot as delisted while nothing at all was happening.
     */
    setSteam(() => ({ status: 200, body: LOGGED_OUT }));
    assert.equal(await kindOf(removeListing("1", pacing)), "not_logged_in");
    assert.equal(await kindOf(sellItem(
      { appid: 730, contextid: "2", assetid: "9", amount: 1, targetSeller: 500 },
      pacing
    )), "not_logged_in");
    assert.equal(calls.length, 2, "both were actually sent — this is about the reply");
  });

  it("still treats an empty body as this endpoint's ordinary success", async () => {
    setSteam(() => ({ status: 200, body: "" }));
    assert.equal(await kindOf(removeListing("1", pacing)), "resolved");
  });

  it("still reads Steam's own refusal", async () => {
    setSteam(() => ({ status: 200, body: JSON.stringify({ success: false }) }));
    assert.equal(await kindOf(removeListing("1", pacing)), "http");
  });

  it("raises a reply it cannot read as not knowing, never as done", async () => {
    setSteam(() => ({ status: 200, body: "<html><body>maintenance</body></html>" }));
    assert.equal(await kindOf(removeListing("1", pacing)), "not_json");
  });

  it("will not tell a holder their money is back on an unreadable reply", async () => {
    /** `cancelbuyorder` releases wallet money. Guessing here is the worst guess. */
    setSteam(() => ({ status: 200, body: "<html><body>maintenance</body></html>" }));
    assert.equal(await kindOf(cancelBuyOrder("77", pacing)), "not_json");
    setSteam(() => ({ status: 200, body: LOGGED_OUT }));
    assert.equal(await kindOf(cancelBuyOrder("77", pacing)), "not_logged_in");
    setSteam(() => ({ status: 200, body: JSON.stringify({ success: 1 }) }));
    assert.equal(await kindOf(cancelBuyOrder("77", pacing)), "resolved");
  });
});

describe("the rule every bulk loop shares", () => {
  it("stops a run on a refusal that is about the account, not the item", () => {
    /**
     * Two of the three write loops had their own copy of this and both listed
     * only the rate limits. A session that expired part-way through a hundred
     * cancellations therefore kept firing writes at an endpoint that could not
     * accept one of them, once per remaining order.
     */
    assert.equal(haltsRun(new SteamError("not_logged_in")), true);
    assert.equal(haltsRun(new SteamError("rate_limited")), true);
    assert.equal(haltsRun(new SteamError("blocked")), true);
  });

  it("lets one item's own refusal pass — a lot that sold mid-run is not the account", () => {
    assert.equal(haltsRun(new SteamError("http", "already_sold")), false);
    assert.equal(haltsRun(new SteamError("network")), false);
    assert.equal(haltsRun(new Error("boom")), false);
  });

  it("keeps «we do not know» apart from «it failed»", () => {
    assert.equal(outcomeUnknown(new SteamError("network")), true);
    assert.equal(outcomeUnknown(new SteamError("not_json")), true);
    assert.equal(outcomeUnknown(new SteamError("bad_json")), true);
    assert.equal(outcomeUnknown(new SteamError("http", "already_sold")), false);
    assert.equal(outcomeUnknown(new SteamError("rate_limited")), false);
  });
});

describe("what a failed delist says about where the lot is", () => {
  /**
   * Three outcomes, and only one of them is «Steam said no». The other two leave
   * the lot's whereabouts unknown, and the run has to stop: every further step
   * begins by taking a lot off the market.
   */
  const cases: [string, boolean][] = [
    ["network", true],
    ["not_json", true],
    ["bad_json", true],
    ["rate_limited", false],
    ["not_logged_in", false],
    ["http", false],
  ];

  for (const [kind, unknown] of cases) {
    it(`treats ${kind} during the delist as ${unknown ? "unknown" : "refused"}`, () => {
      const failure = describeRelistFailure(
        "removing",
        new SteamError(kind as "http", "why")
      );
      assert.equal(failure.stranded, unknown);
      assert.equal(
        /неизвестно, снят ли лот/.test(failure.message),
        unknown,
        failure.message
      );
    });
  }

  it("stops the run whenever the lot's whereabouts are in doubt", () => {
    for (const [kind, unknown] of cases) {
      if (!unknown) continue;
      assert.equal(describeRelistFailure("removing", new SteamError(kind as "http")).halt, true);
    }
  });

  it("leaves a plain refusal to the existing rule about the next item", () => {
    /** A lot that sold mid-run must not end a reprice of two hundred. */
    assert.equal(describeRelistFailure("removing", new SteamError("http", "already_sold")).halt, false);
    assert.equal(describeRelistFailure("removing", new SteamError("rate_limited")).halt, true);
  });
});

describe("mylistings over the wire, in the shape Steam sends today", () => {
  /** The captured answer, cut to its deciding fields. */
  const ANSWER = {
    success: true,
    pagesize: 10,
    start: 0,
    total_count: 761,
    num_active_listings: 761,
    hovers:
      "	CreateItemHoverFromContainer( g_rgAssets, 'mylisting_1_name', 753, '6', '38162536060', 1 );",
    results_html: '<div id="mylisting_1"></div>',
  };

  beforeEach(async () => {
    await resetEnv();
    setAcquire(() => ({ ok: true as const }));
  });

  it("is an answer, not a soft throttle", async () => {
    /**
     * `isEmpty` marks a 200 as Steam stonewalling, and four in a row open the
     * circuit breaker. Looking for `listinginfo` in a payload that no longer has
     * it therefore did not merely lose the assets — it stopped the whole scan and
     * blamed Steam.
     */
    setSteam(() => ({ status: 200, body: JSON.stringify(ANSWER) }));
    const page = await fetchMyListings(10, pacing);
    assert.equal(page.refs.get("1")?.assetid, "38162536060");
    assert.equal(reports.filter((r) => r.outcome === "empty").length, 0);
    assert.equal(reports.filter((r) => r.outcome === "ok").length, 1);
  });

  it("lets an account with nothing listed say so", async () => {
    setSteam(() => ({ status: 200, body: JSON.stringify({ success: true, total_count: 0 }) }));
    const page = await fetchMyListings(10, pacing);
    assert.equal(page.ids.size, 0);
    assert.equal(reports.filter((r) => r.outcome === "empty").length, 0);
  });

  it("still calls a reply that names nothing at all a refusal", async () => {
    setSteam(() => ({ status: 200, body: JSON.stringify({ pagesize: 10 }) }));
    await assert.rejects(fetchMyListings(10, pacing), (err: unknown) => {
      assert.equal(err instanceof SteamError && err.kind, "empty");
      return true;
    });
  });
});
