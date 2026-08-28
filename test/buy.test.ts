import "./support/env";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { calls, jsonReply, resetEnv, setAcquire, setSteam } from "./support/env";

import { buyListing, type BuyOrder } from "../src/steam/actions";
import { SteamError } from "../src/steam/net";

function order(overrides: Partial<BuyOrder> = {}): BuyOrder {
  return {
    listingId: "555",
    subtotal: 900,
    fee: 100,
    total: 1000,
    currencyId: 5,
    ...overrides,
  };
}

const pacing = {};

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (err) {
    return err instanceof SteamError ? err.message : String(err);
  }
}

/**
 * This is the only call in the project that spends money, so the tests care less
 * about the happy path than about every way it must refuse to send anything.
 */
describe("buyListing refusals", () => {
  beforeEach(async () => {
    await resetEnv();
    setAcquire(() => ({ ok: true as const }));
    setSteam(() => {
      throw new Error("must not reach Steam");
    });
  });

  it("refuses a total above the ceiling", async () => {
    assert.equal(await reason(buyListing(order({ total: 1000 }), 999, pacing)), "over_the_limit");
    assert.equal(calls.length, 0, "nothing may be sent");
  });

  it("refuses when the ceiling is zero or missing", async () => {
    assert.equal(await reason(buyListing(order(), 0, pacing)), "over_the_limit");
    assert.equal(await reason(buyListing(order(), -1, pacing)), "over_the_limit");
    assert.equal(calls.length, 0);
  });

  it("refuses when the parts do not add up to the total", async () => {
    /** A parsing slip here would buy at the wrong price. */
    const bad = order({ subtotal: 900, fee: 100, total: 5000 });
    assert.equal(await reason(buyListing(bad, 100_000, pacing)), "price_does_not_add_up");
    assert.equal(calls.length, 0);
  });

  it("refuses a nonsense price", async () => {
    assert.equal(
      await reason(buyListing(order({ subtotal: 0, fee: 0, total: 0 }), 100_000, pacing)),
      "bad_price"
    );
    assert.equal(
      await reason(buyListing(order({ subtotal: -900, fee: 100, total: -800 }), 100_000, pacing)),
      "bad_price"
    );
    assert.equal(calls.length, 0);
  });

  it("refuses without a listing id", async () => {
    assert.equal(await reason(buyListing(order({ listingId: "" }), 100_000, pacing)), "no_listing_id");
    assert.equal(calls.length, 0);
  });

  it("accepts a total exactly at the ceiling", async () => {
    setSteam(() => jsonReply({ success: 1 }));
    await buyListing(order({ total: 1000 }), 1000, pacing);
    assert.equal(calls.length, 1, "the boundary is allowed, not rejected");
  });
});

describe("buyListing request", () => {
  beforeEach(async () => {
    await resetEnv();
    setAcquire(() => ({ ok: true as const }));
  });

  it("posts the amounts Steam expects, and only one unit", async () => {
    let body = "";
    setSteam((url, init) => {
      assert.ok(url.includes("/market/buylisting/555"), url);
      body = String(init?.body ?? "");
      return jsonReply({ success: 1, wallet_info: { wallet_balance: "1234" } });
    });

    await buyListing(order(), 100_000, pacing);

    const params = new URLSearchParams(body);
    assert.equal(params.get("subtotal"), "900");
    assert.equal(params.get("fee"), "100");
    assert.equal(params.get("total"), "1000");
    assert.equal(params.get("currency"), "5");
    assert.equal(params.get("quantity"), "1", "never more than one copy per click");
  });

  it("treats Steam's numeric success as success", async () => {
    setSteam(() => jsonReply({ success: 1 }));
    const result = await buyListing(order(), 100_000, pacing);
    assert.ok(result);
  });

  it("surfaces the message when Steam declines", async () => {
    setSteam(() => jsonReply({ success: 0, message: "There was a problem" }));
    assert.equal(await reason(buyListing(order(), 100_000, pacing)), "There was a problem");
  });

  it("does not treat an unparseable answer as a purchase", async () => {
    setSteam(() => ({ status: 200, body: "<html>nope</html>" }));
    assert.equal(await reason(buyListing(order(), 100_000, pacing)), "buylisting_http_200");
  });

  it("does not retry on its own", async () => {
    setSteam(() => jsonReply({ success: 0, message: "no" }));
    await reason(buyListing(order(), 100_000, pacing));
    assert.equal(calls.length, 1, "a failed purchase must never be attempted again by itself");
  });
});
