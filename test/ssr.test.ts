import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { focusedItem, isItemOnPage, projectSsr } from "../src/page/ssr";
import { listingsFromSsr, competitorFromListings } from "../src/steam/listings";
import { historyFromPage } from "../src/steam/pricehistory";

/**
 * The projection is the only thing standing between Steam's page state and the
 * extension, and it runs in the page's own world where a thrown error is
 * invisible. So the cases that matter here are the malformed ones.
 */

function page(overrides: Record<string, unknown> = {}): { SSR: Record<string, unknown> } {
  const market = {
    appid: 730,
    buckets: [{ bucket_id: "Item A", min_price: "1200", classid: "77" }],
    myOrders: { rgSellOrders: [{ listingid: "1" }], rgBuyOrders: [] },
  };
  const queries = {
    queries: [
      {
        queryHash: '["market_item_search",{"appid":730}]',
        queryKey: ["market_item_search", { appid: 730 }],
        state: {
          data: {
            pages: [
              {
                listings: [
                  {
                    listingid: "1",
                    unPrice: 1000,
                    unFee: 200,
                    bMine: true,
                    description: { market_hash_name: "Item A" },
                    asset: { assetid: "9", contextid: "2" },
                  },
                  {
                    listingid: "2",
                    unPrice: 1100,
                    unFee: 220,
                    bMine: false,
                    description: { market_hash_name: "Item A" },
                    asset: { assetid: "10", contextid: "2" },
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  };
  return {
    SSR: {
      loaderData: ["{}", JSON.stringify(market)],
      renderContext: { queryData: JSON.stringify(queries) },
      ...overrides,
    },
  };
}

describe("projectSsr", () => {
  it("reads the book, the minimums and our own lots off the page", () => {
    const out = projectSsr(page());
    assert.ok(out);
    assert.equal(out!.appid, 730);
    assert.deepEqual(out!.buckets, [{ hash: "Item A", min: 1200, classid: "77" }]);
    assert.deepEqual(out!.mine, ["1"]);
    assert.equal(out!.listings.length, 2);
    assert.equal(out!.listings[0]!.mine, true);
    assert.equal(out!.listings[1]!.mine, false);
  });

  it("finds the market payload by shape, not by its slot", () => {
    /** Valve nesting one more wrapper route must not shift us onto its data. */
    const shifted = page();
    shifted.SSR.loaderData = ["{}", "false", '{"unrelated":1}', (shifted.SSR.loaderData as string[])[1]!];
    assert.equal(projectSsr(shifted)?.buckets[0]?.hash, "Item A");
  });

  it("keeps a bucket Steam named no minimum for, rather than calling it free", () => {
    const noPrice = page();
    const market = JSON.parse((noPrice.SSR.loaderData as string[])[1]!) as Record<string, unknown>;
    market.buckets = [{ bucket_id: "Item A" }];
    (noPrice.SSR.loaderData as string[])[1] = JSON.stringify(market);
    assert.deepEqual(projectSsr(noPrice)?.buckets, [{ hash: "Item A", min: null, classid: undefined }]);
  });

  it("treats anything but a literal true as somebody else's lot", () => {
    const fuzzy = page();
    const cache = JSON.parse((fuzzy.SSR.renderContext as { queryData: string }).queryData) as {
      queries: { state: { data: { pages: { listings: Record<string, unknown>[] }[] } } }[];
    };
    cache.queries[0]!.state.data.pages[0]!.listings[0]!.bMine = 1;
    (fuzzy.SSR.renderContext as { queryData: string }).queryData = JSON.stringify(cache);
    /**
     * Not `false` either: a shape we do not recognise is Steam not answering,
     * and `false` is an answer other code is entitled to act on. What matters
     * here is only that it is never `true` — that is what would have us pass
     * over a stranger's lot as if it were our own.
     */
    assert.notEqual(projectSsr(fuzzy)?.listings[0]?.mine, true);
    assert.equal(projectSsr(fuzzy)?.listings[0]?.mine, undefined);
  });

  it("survives every shape it could be handed instead", () => {
    assert.equal(projectSsr(null), null);
    assert.equal(projectSsr({}), null);
    assert.equal(projectSsr({ SSR: {} }), null);
    assert.equal(projectSsr({ SSR: { loaderData: "not json", renderContext: 7 } }), null);
    assert.equal(projectSsr({ SSR: { loaderData: [null, 3], renderContext: { queryData: "{" } } }), null);
  });

  it("carries no field from the loader slot that holds the WebAPI token", () => {
    /**
     * The token is a live credential and the projection crosses a postMessage
     * bus any page script can listen on, so the rule is that it never leaves.
     */
    const withToken = page();
    (withToken.SSR.loaderData as string[])[0] = JSON.stringify({
      strWebAPIToken: "eyJhbGciOi.SHOULD-NOT-APPEAR",
      steamid: "76561190000000000",
    });
    assert.ok(!JSON.stringify(projectSsr(withToken)).includes("SHOULD-NOT-APPEAR"));
    assert.ok(!JSON.stringify(projectSsr(withToken)).includes("76561190000000000"));
  });
});

describe("the wallet the rewritten page carries instead of a global", () => {
  /**
   * Measured on a live page: `g_rgWalletInfo`, `g_strCountryCode` and
   * `g_sessionID` are all undefined on the rewritten market. The wallet is in the
   * query cache instead, and it is the only statement of currency the page makes.
   */
  function withWallet(data: Record<string, unknown>): { SSR: Record<string, unknown> } {
    const base = page();
    const cache = JSON.parse((base.SSR.renderContext as { queryData: string }).queryData) as {
      queries: unknown[];
    };
    cache.queries.push({
      queryHash: '["CurrentUserWalletDetails",157478535]',
      queryKey: ["CurrentUserWalletDetails", 157478535],
      state: { data },
    });
    (base.SSR.renderContext as { queryData: string }).queryData = JSON.stringify(cache);
    return base;
  }

  it("reads the currency and the country the wallet is in", () => {
    const out = projectSsr(
      withWallet({ currency_code: 1, wallet_country_code: "US", user_country_code: "US" })
    )!;
    assert.equal(out.currency, 1);
    assert.equal(out.country, "US");
  });

  it("falls back to where the user is when the wallet does not say", () => {
    const out = projectSsr(withWallet({ currency_code: 3, user_country_code: "DE" }))!;
    assert.equal(out.currency, 3);
    assert.equal(out.country, "DE");
  });

  it("says null rather than guessing, on a page with no wallet at all", () => {
    const out = projectSsr(page())!;
    assert.equal(out.currency, null, "a logged-out page must not read as roubles");
    assert.equal(out.country, null);
  });
});

describe("the order book the page ships for the item it is focused on", () => {
  /**
   * Measured on the live market, 2026-08-29. `["market","orderbook",730,"<hash>"]`
   * carries `amtMaxBuyOrder`, `amtMinSellOrder`, `eCurrency`, `cBuyOrders`,
   * `cSellOrders` and two compact ladders. Fracture Case answered 6205 / 6250
   * against 3 815 419 buy orders and 176 590 lots; the Redline group answered
   * only for Minimal Wear, the wear the page had in focus.
   */
  function withOrderBook(hash: string, data: Record<string, unknown>): unknown {
    const base = page();
    const cache = JSON.parse((base.SSR.renderContext as { queryData: string }).queryData) as {
      queries: unknown[];
    };
    cache.queries.push({
      queryHash: `["market","orderbook",730,"${hash}"]`,
      queryKey: ["market", "orderbook", 730, hash],
      state: { data },
    });
    (base.SSR.renderContext as { queryData: string }).queryData = JSON.stringify(cache);
    return base;
  }

  it("carries both sides, the counts, and the currency it is priced in", () => {
    const out = projectSsr(
      withOrderBook("Item A", {
        amtMaxBuyOrder: 6205,
        amtMinSellOrder: 6250,
        eCurrency: 5,
        cBuyOrders: 3_815_419,
        cSellOrders: 176_590,
        rgCompactBuyOrders: [6205, 4, 6100, 2],
      })
    )!;
    assert.deepEqual(out.orders, [
      { hash: "Item A", maxBuy: 6205, minSell: 6250, buyOrders: 3_815_419, sellOrders: 176_590 },
    ]);
    assert.equal(out.currency, 5, "and it states the wallet, on a page with no wallet block");
  });

  it("reports an absent side as null, never as a price of zero", () => {
    const out = projectSsr(
      withOrderBook("Item A", { amtMaxBuyOrder: 0, amtMinSellOrder: 6250, cSellOrders: 3 })
    )!;
    assert.deepEqual(out.orders, [
      { hash: "Item A", maxBuy: null, minSell: 6250, buyOrders: 0, sellOrders: 3 },
    ]);
  });

  it("keeps it keyed by item, because a group page asks for one wear only", () => {
    const out = projectSsr(
      withOrderBook("Item B", { amtMaxBuyOrder: 100, amtMinSellOrder: 120 })
    )!;
    assert.equal(out.orders.length, 1);
    assert.equal(out.orders[0]!.hash, "Item B", "not the item the URL happens to name");
  });

  it("is simply absent on a page that shipped none", () => {
    assert.deepEqual(projectSsr(page())!.orders, []);
  });
});

describe("the page book as a competitor scan", () => {
  const book = listingsFromSsr(projectSsr(page())!.listings, "Item A");

  it("sorts by what the buyer pays and keeps Steam's ownership flag", () => {
    assert.deepEqual(
      book.map((l) => [l.buyer, l.mine]),
      [
        [1200, true],
        [1320, false],
      ]
    );
  });

  it("names the competitor behind our own minimum without any listing ids", () => {
    /** The whole point: this used to need `mylistings` and a second request. */
    const scan = competitorFromListings(book, new Set(), book.length);
    assert.equal(scan.marketLow, 1200);
    assert.equal(scan.competitor, 1320);
    assert.equal(scan.allOurs, false);
  });

  it("still believes our own listing ids when the page says nothing", () => {
    const anonymous = book.map((l) => ({ ...l, mine: undefined }));
    const scan = competitorFromListings(anonymous, new Set(["1"]), anonymous.length);
    assert.equal(scan.competitor, 1320);
  });

  it("prices an item the book says nothing about, from its bucket alone", () => {
    /**
     * The live case this exists for: the page ships the book for whichever item
     * of the group it opened on, but a minimum for all ten. Open a different
     * wear and there are no rows — and a market minimum sitting right there.
     */
    const group = page();
    const market = JSON.parse((group.SSR.loaderData as string[])[1]!) as Record<string, unknown>;
    market.buckets = [
      { bucket_id: "Item A", min_price: "1200" },
      { bucket_id: "Item B", min_price: "4500" },
    ];
    (group.SSR.loaderData as string[])[1] = JSON.stringify(market);

    const out = projectSsr(group)!;
    assert.deepEqual(listingsFromSsr(out.listings, "Item B"), [], "no rows for the other wear");
    assert.equal(out.buckets.find((b) => b.hash === "Item B")?.min, 4500);
  });

  it("drops the other items of the group the book is mixed with", () => {
    const mixed = listingsFromSsr(
      [
        { listingid: "3", price: 10, fee: 1, mine: false, hash: "Item B" },
        { listingid: "4", price: 20, fee: 2, mine: false, hash: "Item A" },
      ],
      "Item A"
    );
    assert.deepEqual(mixed.map((l) => l.listingId), ["4"]);
  });
});

describe("a grouped page, which stands at no item's name", () => {
  /**
   * `/market/listings/730/G1807209A023004` is a real market URL and the group id
   * in it is not any item's hash name. Everything the panel reads — buckets, book
   * rows, histories — is keyed by hash name, so reading the URL as one meant the
   * panel found nothing, paid for a book it already had, and then priced the page
   * off whichever wear of the group happened to be cheapest.
   */
  const GROUP = "G1807209A023004";
  const BS = "AK-47 | Redline (Battle-Scarred)";
  const MW = "AK-47 | Redline (Minimal Wear)";

  function grouped(over: Record<string, unknown> = {}): { SSR: Record<string, unknown> } {
    const market = {
      appid: 730,
      buckets: [
        { bucket_id: BS, min_price: "265733" },
        { bucket_id: MW, min_price: "1617507" },
      ],
      listingQuery: { appid: 730, strItemName: GROUP, filters: {} },
      initialSelectedBucketID: null,
      initialFallbackBucketID: MW,
      myOrders: { rgSellOrders: [] },
      ...over,
    };
    const queries = {
      queries: [
        {
          queryHash: `["market_item_search",{"appid":730,"strItemName":"${GROUP}"}]`,
          queryKey: ["market_item_search", { appid: 730 }],
          state: {
            data: {
              pages: [
                {
                  listings: [
                    { listingid: "bs", unPrice: 231073, unFee: 34660, bMine: false, description: { market_hash_name: BS } },
                    { listingid: "mw", unPrice: 1407397, unFee: 210110, bMine: false, description: { market_hash_name: MW } },
                  ],
                },
              ],
            },
          },
        },
      ],
    };
    return {
      SSR: {
        loaderData: ["{}", JSON.stringify(market)],
        renderContext: { queryData: JSON.stringify(queries) },
      },
    };
  }

  it("carries the name Steam queries the book with, and the item in focus", () => {
    const out = projectSsr(grouped())!;
    assert.equal(out.itemName, GROUP, "the group id is what QueryListingsForItem answers to");
    assert.equal(out.focus, MW);
  });

  it("prices the item in focus even when not one shipped row is that item", () => {
    /**
     * The ordinary state of a grouped page, not an edge case. Measured live on
     * 2026-08-29: Steam ships twenty rows for the Redline group — thirteen
     * Battle-Scarred and seven Well-Worn — and focuses the page on Minimal Wear,
     * whose cheapest lot is six times dearer than the group's. So the book
     * filtered to the focus is empty while the bucket names a perfectly good
     * price, and the panel has to tell those two facts apart.
     */
    const out = projectSsr(
      grouped({
        // the book Steam actually sent holds only the cheap wear
      })
    )!;
    const onlyCheap = out.listings.filter((l) => l.hash === BS);
    assert.equal(onlyCheap.length, 1);
    assert.deepEqual(
      listingsFromSsr(onlyCheap, MW),
      [],
      "no lot of the focused wear is in the book"
    );
    assert.equal(
      out.buckets.find((b) => b.hash === MW)?.min,
      1617507,
      "and yet the page states its price outright"
    );
  });

  it("prefers the bucket the user picked to the one Steam fell back to", () => {
    assert.equal(projectSsr(grouped({ initialSelectedBucketID: BS }))!.focus, BS);
  });

  it("resolves the group id in the URL to the item on screen", () => {
    const out = projectSsr(grouped())!;
    assert.equal(focusedItem(out, GROUP), MW);
    /** And a page that already stands at an item is left exactly as it is. */
    assert.equal(focusedItem(out, BS), BS);
  });

  it("never invents a focus the page did not also price", () => {
    /** A name with no bucket behind it misses just as badly as the group id. */
    const stray = projectSsr(grouped({ initialFallbackBucketID: "Some Other Skin" }))!;
    assert.equal(focusedItem(stray, GROUP), GROUP);
    assert.equal(focusedItem(null, GROUP), GROUP);
  });

  it("knows the group id is not one of its items", () => {
    /**
     * `pricehistory` answers for a group id — measured against the live endpoint:
     * 894 points for `G1807209A023004`, a series mixing every wear and StatTrak
     * variant. So asking with one does not fail; it returns a plausible chart at
     * a plausible price, about no item that exists.
     */
    const out = projectSsr(grouped())!;
    assert.equal(isItemOnPage(out, GROUP), false);
    assert.equal(isItemOnPage(out, MW), true);
    assert.equal(isItemOnPage(out, BS), true);
  });

  it("gives a page that keys nothing by hash the benefit of the doubt", () => {
    /** The classic market page carries no buckets and no histories, and asking it
     *  directly is the only thing that has ever worked there. */
    assert.equal(isItemOnPage(null, GROUP), true);
    assert.equal(isItemOnPage({ ...projectSsr(grouped())!, buckets: [], histories: [] }, GROUP), true);
  });

  it("counts a history as proof the name is an item, with no bucket for it", () => {
    /** Buckets and histories are separate sections of the page and either can be
     *  the one Valve stops shipping; one of them naming it is enough. */
    const out = projectSsr(grouped())!;
    assert.equal(
      isItemOnPage({ ...out, buckets: [], histories: [{ hash: MW, points: [] }] }, MW),
      true
    );
  });

  it("stops the mixed book being read as this page's price", () => {
    const out = projectSsr(grouped())!;
    const hash = focusedItem(out, GROUP);

    const wrong = listingsFromSsr(out.listings, GROUP);
    assert.deepEqual(wrong, [], "the group id matches no row, which is how the panel went blind");

    const right = listingsFromSsr(out.listings, hash);
    assert.deepEqual(right.map((l) => l.listingId), ["mw"], "the wear on screen, not the cheapest one");
    assert.equal(out.buckets.find((b) => b.hash === hash)?.min, 1617507);
  });
});

describe("historyFromPage", () => {
  it("turns the page's own series into the same points a request would give", () => {
    const points = historyFromPage([
      [1_700_000_000, 12.5, 3],
      [1_600_000_000, 10, 1],
    ]);
    assert.deepEqual(points, [
      { t: 1_600_000_000_000, price: 1000, volume: 1 },
      { t: 1_700_000_000_000, price: 1250, volume: 3 },
    ]);
  });

  it("has nothing to say about an absent series", () => {
    assert.deepEqual(historyFromPage(undefined), []);
    assert.deepEqual(historyFromPage([[1_700_000_000, 0, 0]]), []);
  });
});
