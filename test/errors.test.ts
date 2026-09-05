import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeError, describeRelistFailure } from "../src/content/ui/errors";
import { isOrphanError } from "../src/content/ui/orphan";
import { SteamError } from "../src/steam/net";

describe("describeError", () => {
  it("says what each refusal was, in one sentence", () => {
    assert.equal(describeError(new SteamError("not_logged_in")), "нужен логин Steam в этой вкладке");
    assert.equal(describeError(new SteamError("rate_limited")), "Steam упёрся в лимит");
  });

  it("lets the endpoint speak for itself when the kind says nothing", () => {
    /** `http` carries whatever Steam replied, which beats any sentence of ours. */
    assert.equal(describeError(new SteamError("http", "There was a problem listing your item.")),
      "There was a problem listing your item.");
  });

  it("still has something to say about an error that is not ours", () => {
    assert.equal(describeError(new TypeError("Failed to fetch")), "Failed to fetch");
    assert.equal(describeError("nope"), "nope");
  });
});

describe("describeRelistFailure", () => {
  /**
   * Repricing is delist-then-relist, and the gap between the two is where a lot
   * can end up off the market with nothing put back. That used to read as plain
   * «ошибка» — the same word as a failure that never touched the listing.
   */
  it("says outright that the lot came off the market and did not go back", () => {
    const failure = describeRelistFailure("relisting", new SteamError("http", "There was a problem"));
    assert.match(failure.message, /снят, но НЕ выставлен/);
    assert.match(failure.message, /There was a problem/, "and why, in Steam's own words");
    /**
     * And not a word about where the item is. This table never looked; the run
     * reads the inventory once the write has failed and says what it found, so
     * an unchecked «предмет в инвентаре» here would be a guess printed in the
     * one place the owner reads for a fact.
     */
    assert.equal(/в инвентаре/.test(failure.message), false, failure.message);
    assert.equal(failure.stranded, true);
  });

  it("stops the run on a stranded lot, whatever the reason was", () => {
    /**
     * The reason is unknown, and the next item would be delisted before we found
     * out it is the same reason. One lot to put back by hand is a mistake; the
     * whole ticked list is the panel emptying the account's market page.
     */
    for (const err of [new SteamError("bad_json"), new SteamError("http", "x"), new TypeError("offline")]) {
      assert.equal(describeRelistFailure("relisting", err).halt, true, String(err));
    }
  });

  it("does not blame a failure that never got as far as the listing", () => {
    const failure = describeRelistFailure("before", new SteamError("http", "нет assetid"));
    assert.equal(failure.stranded, false);
    assert.equal(failure.halt, false, "one unlistable item must not end the run");
    assert.match(failure.message, /^ошибка: /);
  });

  it("still ends the run when Steam refuses, or the session is gone", () => {
    assert.equal(describeRelistFailure("before", new SteamError("rate_limited")).halt, true);
    assert.equal(describeRelistFailure("before", new SteamError("blocked")).halt, true);
    /**
     * Added with the stranding fix: a dead session fails every remaining item,
     * and each attempt is a delist that may well succeed before the relist does
     * not. Retrying it two hundred times is the failure mode, not the diagnosis.
     */
    assert.equal(describeRelistFailure("before", new SteamError("not_logged_in")).halt, true);
  });
});

describe("a write that never came back", () => {
  /**
   * The only failure where what Steam did with the request is unknown. A read
   * that vanishes cost nothing and gets retried; a delist that vanishes may well
   * have been carried out, and calling that «ошибка» is a guess about the user's
   * own inventory.
   */
  it("does not claim the lot is still listed", () => {
    const failure = describeRelistFailure("removing", new SteamError("network", "network_failed"));
    assert.match(failure.message, /неизвестно, снят ли лот/);
    assert.equal(failure.stranded, true);
    assert.equal(failure.halt, true);
  });

  it("is the only removal failure that stops the run on its own", () => {
    /**
     * Steam answering «no» is different in kind: the listing is exactly where it
     * was, and one lot that sold mid-run must not end a reprice of two hundred.
     */
    const answered = describeRelistFailure("removing", new SteamError("http", "remove_failed"));
    assert.equal(answered.stranded, false);
    assert.equal(answered.halt, false);
  });
});

describe("isOrphanError — the severed bridge, not Steam", () => {
  it("names every wording Chrome uses for a content script left behind", () => {
    // An extension update does not migrate running content scripts; all three
    // of these mean the same thing and all three used to reach the console
    // once per farm watchdog tick, forever.
    assert.equal(isOrphanError(new Error("Extension context invalidated.")), true);
    assert.equal(isOrphanError(new Error("Could not establish connection. Receiving end does not exist.")), true);
    assert.equal(isOrphanError(new Error("The message port closed before a response was received.")), true);
    assert.equal(isOrphanError("Extension context invalidated"), true);
  });

  it("never mistakes a Steam failure for an orphaned page", () => {
    assert.equal(isOrphanError(new SteamError("rate_limited")), false);
    assert.equal(isOrphanError(new Error("network_failed")), false);
    assert.equal(isOrphanError(null), false);
    assert.equal(isOrphanError(undefined), false);
  });
});
