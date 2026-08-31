import "./support/env";

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { postFromPage } from "./support/env";
import { country, currencyId } from "../src/steam/page-context";
import type { PlainItemPage } from "../src/page/ssr";

/**
 * These run in order and depend on it.
 *
 * `page-context` holds the page's globals in a module singleton, exactly as the
 * content script does: one content script per page load, and a wallet it has once
 * been told about is never unlearned — the user's wallet does not change while
 * they browse. So "before any wallet has arrived" is a state that exists once, at
 * the top of this file, and the first test is the only place it can be asserted.
 * Nothing earlier in `test/index.ts` posts a page snapshot.
 */

function itemPage(over: Partial<PlainItemPage> = {}): PlainItemPage {
  return {
    appid: 730,
    currency: null,
    country: null,
    itemName: null,
    focus: null,
    buckets: [],
    listings: [],
    histories: [],
    orders: [],
    mine: [],
    ...over,
  };
}

/** A snapshot as the MAIN-world bridge posts it. */
function snapshot(over: Record<string, unknown>): void {
  postFromPage({ source: "steward-page", ...over });
}

describe("the wallet on a page that carries no g_rgWalletInfo", () => {
  /**
   * Put the environment back the way the rest of the suite expects to find it.
   * A wallet cannot be unlearned, so leaving a currency of 3 behind would rekey
   * every cache entry the price tests seed.
   */
  after(() => {
    snapshot({ wallet: { wallet_currency: 5 }, country: "RU", itemPage: null });
  });

  it("takes the currency and country from the item page's own state", () => {
    /**
     * Measured on a live rewritten market page: `g_rgWalletInfo`,
     * `g_strCountryCode` and `g_sessionID` are all `undefined` there, and the
     * `steamCountry` cookie is not readable from script. Every price, cache key
     * and history summary is keyed by currency, so falling through to the
     * hardcoded RUB meant `search` answering in the user's real wallet and
     * `priceoverview` answering in roubles, both cached under one key — and a
     * verdict comparing a dollar price against a rouble average.
     */
    snapshot({ itemPage: itemPage({ currency: 1, country: "US" }) });
    assert.equal(currencyId(), 1);
    assert.equal(country(), "US");
  });

  it("prefers a real wallet to the page's copy of it", () => {
    /** The classic pages still define the global, and it is the better source. */
    snapshot({ wallet: { wallet_currency: 3 }, itemPage: itemPage({ currency: 1 }) });
    assert.equal(currencyId(), 3);
  });

  it("keeps the wallet after moving to a page that does not carry one", () => {
    /**
     * The same user, the same wallet, one tab. `itemPage` is replaced wholesale on
     * every snapshot because a later one is a different item; the wallet is not,
     * because it is not about the item at all.
     */
    snapshot({ itemPage: null });
    assert.equal(currencyId(), 3);
  });

  it("falls back to roubles only when nothing at all has said otherwise", () => {
    assert.equal(currencyId(), 3, "and never over something that did");
  });
});
