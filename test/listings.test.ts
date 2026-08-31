import "./support/env";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { jsonReply, reports, resetEnv, setAcquire, setSteam } from "./support/env";

import {
  competitorFromListings,
  listingsFromBook,
  listingsFromInfo,
  scanCompetitors,
  scanWindow,
} from "../src/steam/listings";
import { competitorFromScan, needsExactCheck } from "../src/content/features/reprice/plan";

describe("listingsFromInfo", () => {
  it("sorts by what the buyer pays and keeps fee split for buylisting", () => {
    const listings = listingsFromInfo({
      b: { listingid: "b", converted_price: 1000, converted_fee: 150 },
      a: { listingid: "a", converted_price: 800, converted_fee: 120 },
    });
    assert.equal(listings[0]!.listingId, "a");
    assert.equal(listings[0]!.buyer, 920);
    assert.equal(listings[0]!.price, 800);
    assert.equal(listings[0]!.fee, 120);
  });

  it("returns nothing for a missing table so the caller can fetch", () => {
    assert.deepEqual(listingsFromInfo(null), []);
    assert.deepEqual(listingsFromInfo({}), []);
  });
});

describe("competitorFromListings", () => {
  const book = listingsFromInfo({
    mine: { listingid: "mine", converted_price: 100, converted_fee: 15 },
    theirs: { listingid: "theirs", converted_price: 200, converted_fee: 30 },
  });

  it("skips our own lots and reports the market low separately", () => {
    const scan = competitorFromListings(book, new Set(["mine"]), 10);
    assert.equal(scan.marketLow, 115, "the minimum is ours");
    assert.equal(scan.competitor, 230, "but the competitor is the next one up");
    assert.equal(scan.allOurs, false);
  });

  it("calls a stranger at our exact price a competitor", () => {
    const tied = listingsFromInfo({
      mine: { listingid: "mine", converted_price: 100, converted_fee: 15 },
      other: { listingid: "other", converted_price: 100, converted_fee: 15 },
    });
    const scan = competitorFromListings(tied, new Set(["mine"]), 10);
    assert.equal(scan.competitor, 115, "a shared minimum is not a held minimum");
  });

  it("separates «we are alone down here» from «the window was full of us»", () => {
    const alone = competitorFromListings(book, new Set(["mine", "theirs"]), 10);
    assert.equal(alone.competitor, null);
    assert.equal(alone.allOurs, true);
    assert.equal(alone.crowded, false, "two answers for a window of ten leave room");

    const crowded = competitorFromListings(book, new Set(["mine", "theirs"]), 2);
    assert.equal(crowded.crowded, true, "a full window of our own lots hides the rest");
  });

  it("believes Steam's «more» over the window we asked for", () => {
    /**
     * The bug this locks out. `count` is decoration — the endpoint serves twenty
     * rows whatever we ask — so a seller with twenty lots of one item asked for
     * thirty, got twenty of their own, and the window heuristic called that «room
     * to spare»: checked, nobody under us. There was a whole book under us.
     */
    const ours = new Set(["mine", "theirs"]);
    const guessed = competitorFromListings(book, ours, 30);
    assert.equal(guessed.crowded, false, "the window alone cannot tell");

    const told = competitorFromListings(book, ours, 30, { more: true });
    assert.equal(told.crowded, true, "Steam said there is more book below");
    assert.equal(competitorFromScan(told, true).source, "ours");
    assert.equal(needsExactCheck(competitorFromScan(told, true)), true);
  });

  it("believes «no more» over a window that happens to be full", () => {
    /** The other half: a complete book of two is settled, not «maybe truncated». */
    const scan = competitorFromListings(book, new Set(["mine", "theirs"]), 2, { more: false });
    assert.equal(scan.crowded, false);
    assert.equal(competitorFromScan(scan, true).source, "sole");
  });

  it("calls an empty book for an item we are selling a wrong name, not an empty market", () => {
    /**
     * We only ever scan items we currently have listed, so our own lot is in that
     * book by definition. A total of zero cannot mean «nobody is selling» — it
     * means Steam does not answer to the name we asked with, which is now every
     * Counter-Strike item, cases included.
     */
    const scan = competitorFromListings([], new Set(["mine"]), 10, { total: 0 });
    assert.equal(scan.unnamed, true);
    /** Still nothing learned about the price — the naming is a separate fact. */
    assert.equal(competitorFromScan(scan, true).source, "no-price");
    assert.equal(needsExactCheck(competitorFromScan(scan, true)), true);
  });

  it("does not blame the name when Steam never said how big the book was", () => {
    assert.equal(competitorFromListings([], new Set(), 10).unnamed, false);
    assert.equal(competitorFromListings([], new Set(), 10, { more: false }).unnamed, false);
  });

  it("says nothing at all when the book came back empty", () => {
    const scan = competitorFromListings([], new Set(["mine"]), 10);
    assert.equal(scan.seen, 0);
    assert.equal(scan.marketLow, null);
    assert.equal(scan.allOurs, false, "no listings is not «all of them are ours»");
  });
});

describe("listingsFromBook", () => {
  /** Exactly the rows `QueryListingsForItem` answers with. */
  const rows = [
    {
      listingid: "theirs",
      unPrice: 1100,
      unFee: 220,
      bMine: false,
      description: { market_hash_name: "Item" },
      asset: { assetid: "10", contextid: "2" },
    },
    {
      listingid: "mine",
      unPrice: 1000,
      unFee: 200,
      bMine: true,
      description: { market_hash_name: "Item" },
      asset: { assetid: "9", contextid: "2" },
    },
  ];

  it("reads the fee split the way buylisting needs it", () => {
    const book = listingsFromBook(rows);
    assert.deepEqual(book.map((l) => [l.listingId, l.price, l.fee, l.buyer]), [
      ["mine", 1000, 200, 1200],
      ["theirs", 1100, 220, 1320],
    ]);
  });

  it("keeps Steam's own word on which lot is ours", () => {
    assert.deepEqual(listingsFromBook(rows).map((l) => l.mine), [true, false]);
  });

  it("ignores rows it cannot price", () => {
    assert.deepEqual(listingsFromBook([{ listingid: "x" }, null, 7, { unPrice: 5 }]), []);
    assert.deepEqual(listingsFromBook(null), []);
  });
});

describe("ownership straight from the book", () => {
  const book = listingsFromBook([
    { listingid: "mine", unPrice: 1000, unFee: 200, bMine: true },
    { listingid: "theirs", unPrice: 1000, unFee: 200, bMine: false },
  ]);

  it("settles a tie without the complete set of our listing ids", () => {
    /**
     * The case the old build could not call: somebody is priced exactly at our
     * own low. It used to stay unverified until `mylistings` had been read to
     * the last page; now the book says whose each lot is.
     */
    const scan = competitorFromListings(book, new Set(), book.length);
    assert.equal(scan.flagged, true);
    assert.equal(scan.competitor, 1200);

    const low = competitorFromScan(scan, false);
    assert.equal(low.theirs, true, "flagged beats an incomplete id set");
    assert.equal(low.source, "listings");
  });

  it("does not claim ownership was stated when the rows never said", () => {
    const anonymous = listingsFromInfo({ a: { listingid: "a", price: 100, fee: 15 } });
    assert.equal(competitorFromListings(anonymous, new Set(), 10).flagged, false);
  });

  it("treats an empty book as unlearned, never as «nobody is selling»", () => {
    /**
     * Safety-critical: `strItemName` is not always the hash name, so a wrong one
     * answers with an empty book. Reading that as «we are alone» would price an
     * item against a market nobody looked at.
     */
    const scan = competitorFromListings([], new Set(), 10);
    const low = competitorFromScan(scan, true);
    assert.equal(low.source, "no-price");
    assert.notEqual(low.source, "sole");
    assert.equal(needsExactCheck(low), true, "it must stay on the list to settle");
  });
});

describe("scanWindow", () => {
  it("clears our own lots before looking for a competitor", () => {
    /** Ten of our own cases used to fill a fixed window of ten. */
    assert.ok(scanWindow(10) > 10);
    assert.equal(scanWindow(0), 10);
    assert.equal(scanWindow(500), 100, "still one page, never a crawl");
  });
});

describe("fetchListingBook, over the wire", () => {
  beforeEach(async () => {
    await resetEnv();
    setAcquire(() => ({ ok: true as const }));
  });

  const row = (id: string, mine: boolean) => ({
    listingid: id,
    unPrice: 1000,
    unFee: 150,
    bMine: mine,
    description: { market_hash_name: "Item" },
  });

  it("hands back an empty book instead of throwing it away", async () => {
    /**
     * The regression this exists for. An empty book used to be reported to the
     * governor as a throttle and raised as an error, so the one fact worth having
     * — `total_count: 0`, which proves the name wrong — never reached the caller,
     * and four Counter-Strike items in a row backed the whole scan off.
     */
    setSteam(() => jsonReply({ data: { listings: [], total_count: 0, more: false } }));
    const scan = await scanCompetitors(730, "Fracture Case", new Set(), {}, 1);

    assert.equal(scan.unnamed, true);
    assert.equal(scan.seen, 0);
    assert.equal(scan.competitor, null);
    assert.ok(
      !reports.some((r) => r.outcome === "empty"),
      "an answered book must not count against the request budget as a refusal"
    );
  });

  it("still calls a reply with no book at all a refusal", async () => {
    /** No `data` block is Steam declining to speak, which the governor must see. */
    setSteam(() => jsonReply({ success: false }));
    await assert.rejects(() => scanCompetitors(753, "Card", new Set(), {}, 1));
    assert.ok(reports.some((r) => r.outcome === "empty"));
  });

  it("carries Steam's own «there is more» into the verdict", async () => {
    const ours = new Set<string>();
    const listings = Array.from({ length: 20 }, (_, i) => {
      ours.add(`m${i}`);
      return row(`m${i}`, true);
    });
    setSteam(() => jsonReply({ data: { listings, total_count: 1672, more: true } }));

    const scan = await scanCompetitors(730, "G1807209A023004", ours, {}, 20);
    assert.equal(scan.seen, 20);
    assert.equal(scan.allOurs, true);
    assert.equal(scan.crowded, true, "a full page of our own lots with a book below it");
    assert.equal(scan.unnamed, false);
  });

  it("asks the book by the learned group id and keeps only this wear", async () => {
    let asked = "";
    const wearRow = (id: string, hash: string, mine = false) => ({
      listingid: id,
      unPrice: 1000,
      unFee: 150,
      bMine: mine,
      description: { market_hash_name: hash },
    });
    setSteam((url) => {
      asked = String(url);
      return jsonReply({
        data: {
          listings: [
            wearRow("a", "AK-47 | Redline (Field-Tested)"),
            wearRow("b", "AK-47 | Redline (Minimal Wear)"),
          ],
          total_count: 1390,
          more: true,
        },
      });
    });

    const scan = await scanCompetitors(
      730,
      "AK-47 | Redline (Minimal Wear)",
      new Set(),
      {},
      1,
      "G1807209A023004"
    );

    assert.ok(
      asked.includes(encodeURIComponent("G1807209A023004")),
      "the request went out under the internal name"
    );
    assert.equal(scan.seen, 1, "the other wear of the group is not this item's book");
    assert.equal(scan.competitor, 1150);
    assert.equal(scan.marketLow, 1150);
    assert.equal(scan.unnamed, false);
  });

  it("signed exactly like the rewritten frontend's own fetch", async () => {
    /**
     * The bug this guards. A logged-in session sending the classic AJAX
     * signature to `/market/actions` is served the market homepage as markup;
     * the frontend's own fetch — only `x-valve-request-type: queryAction`, the
     * filter objects in `qp`, no `country`/`currency` — gets JSON. Measured
     * 2026-08-30: the homepage's own title arrived twice and the exact check
     * died, while the shape below answered 200 with twenty rows.
     */
    let asked = "";
    let seenInit: RequestInit | undefined;
    setSteam((url, init) => {
      asked = String(url);
      seenInit = init;
      return jsonReply({ data: { listings: [], total_count: 1600, more: true } });
    });

    await scanCompetitors(730, "G1807209A023004", new Set(), {}, 1, "G1807209A023004");

    const headers = seenInit?.headers as Record<string, string>;
    assert.equal(headers["x-valve-request-type"], "queryAction");
    assert.ok(!("X-Requested-With" in headers), "the legacy AJAX mark must not ride along");

    const qp = JSON.parse(decodeURIComponent(asked.split("qp=")[1]!.split("&")[0]!))[0];
    assert.deepEqual(
      { appid: qp.appid, filters: qp.filters, accessoryFilters: qp.accessoryFilters, propertyFilters: qp.propertyFilters, start: qp.start },
      { appid: 730, filters: {}, accessoryFilters: {}, propertyFilters: {}, start: 0 }
    );
    assert.ok(!asked.includes("country="), "the frontend's URL carries no wallet params");
  });

  it("does not call a group book without our wear unanswerable", async () => {
    /**
     * The group answered — `total_count` is far from zero — the window is just
     * full of the other wears. That is «unknown», not «the name is wrong».
     */
    setSteam(() => jsonReply({ data: { listings: [], total_count: 1390, more: true } }));
    const scan = await scanCompetitors(730, "AK-47 | Redline (Field-Tested)", new Set(), {}, 1, "G1807209A023004");

    assert.equal(scan.unnamed, false);
    assert.equal(scan.competitor, null);
  });
});
