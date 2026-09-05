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

  it("does not claim ownership was stated when the book stops flagging", () => {
    /**
     * The tie guard's whole job is to tell «Steam named the owner of every lot»
     * from «nobody named anyone». It reads `mine !== undefined`, so a parser
     * that turns a missing `bMine` into `false` makes it a rubber stamp: always
     * flagged, always allowed to undercut a lot priced exactly like ours — and
     * that lot could be our own on another page, which is the one mistake this
     * whole path exists to avoid.
     */
    const unflagged = listingsFromBook([
      { listingid: "a", unPrice: 1000, unFee: 200 },
      { listingid: "b", unPrice: 1000, unFee: 200 },
    ]);
    const scan = competitorFromListings(unflagged, new Set(), unflagged.length);
    assert.equal(scan.flagged, false);
    assert.equal(competitorFromScan(scan, false).theirs, false);
    /** And with our own ids known, the same book still settles the price. */
    assert.equal(competitorFromScan(scan, true).theirs, true);
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

  it("only ever asks for a depth Steam actually serves", () => {
    /**
     * Measured 2026-09-03: `/render/` answers `count` of 1, 10, 20 and 100, and
     * answers 5, 11, 12, 25, 50 and 75 with `success: false` and an empty book.
     * `ourCount + 10` is 11 for every item we hold a single lot of — so the old
     * window asked an unserved depth on essentially every request and read the
     * refusal back as «nobody is selling this», about items we are selling.
     */
    const served = new Set([1, 10, 20, 100]);
    for (let ours = 0; ours <= 200; ours++) {
      const count = scanWindow(ours);
      assert.ok(served.has(count), `count=${count} для ${ours} наших лотов Steam не отдаёт`);
      assert.ok(count >= Math.min(100, ours + 1), `окно ${count} не перекрывает ${ours} наших лотов`);
    }
  });
});

describe("fetchListingBook, over the wire", () => {
  beforeEach(async () => {
    await resetEnv();
    setAcquire(() => ({ ok: true as const }));
  });

  /**
   * The shape `/market/listings/{appid}/{name}/render/` actually answers with,
   * measured on a live logged-in account on 2026-09-03: `listinginfo` keyed by
   * listing id, prices split into `converted_price` + `converted_fee`, and the
   * `total_count` behind the window.
   */
  function render(rows: [id: string, price: number, fee: number][], total = rows.length) {
    const listinginfo: Record<string, unknown> = {};
    for (const [id, price, fee] of rows) {
      listinginfo[id] = {
        listingid: id,
        price,
        fee,
        converted_price: price,
        converted_fee: fee,
        publisher_fee_percent: "0.10",
      };
    }
    return jsonReply({ success: true, start: 0, pagesize: rows.length, total_count: total, listinginfo });
  }

  it("asks the classic listing page, in the wallet's own currency", async () => {
    let asked = "";
    let seenInit: RequestInit | undefined;
    setSteam((url, init) => {
      asked = String(url);
      seenInit = init;
      return render([["a", 1000, 150]]);
    });

    await scanCompetitors(753, "489260-Rock Golem (Foil)", new Set(), {}, 1);

    assert.ok(
      asked.startsWith(
        "https://steamcommunity.com/market/listings/753/" +
          encodeURIComponent("489260-Rock Golem (Foil)") +
          "/render/"
      ),
      asked
    );
    assert.match(asked, /[?&]count=\d+/, asked);
    assert.match(asked, /[?&]currency=\d+/, asked);
    assert.match(asked, /[?&]country=/, asked);
    const headers = seenInit?.headers as Record<string, string> | undefined;
    assert.equal(
      (headers ?? {})["X-Requested-With"],
      "XMLHttpRequest",
      "this is a classic endpoint and wants the classic signature"
    );
  });

  it("reads the price a buyer pays and leaves our own lots out of it", async () => {
    /** Ours at 11,50 is the cheapest row; the competitor is the 13,80 behind it. */
    setSteam(() => render([["ours", 1000, 150], ["theirs", 1200, 180]]));
    const scan = await scanCompetitors(753, "Card", new Set(["ours"]), {}, 1);
    assert.equal(scan.marketLow, 1150);
    assert.equal(scan.competitor, 1380);
    assert.equal(scan.seen, 2);
    assert.equal(scan.allOurs, false);
  });

  it("hands back an empty book instead of throwing it away, when the name may be wrong", async () => {
    /**
     * An empty book used to be reported to the governor as a throttle and raised
     * as an error, so the one fact worth having — `total_count: 0`, which proves
     * the name wrong — never reached the caller.
     */
    setSteam(() => render([], 0));
    const scan = await scanCompetitors(730, "Fracture Case", new Set(), {}, 1, {
      nameMayBeWrong: true,
    });

    assert.equal(scan.unnamed, true);
    assert.equal(scan.seen, 0);
    assert.equal(scan.competitor, null);
    assert.ok(
      !reports.some((r) => r.outcome === "empty"),
      "an answered book must not count against the request budget as a refusal"
    );
  });

  it("calls an empty book a refusal when we are ourselves selling the item", async () => {
    /**
     * Our own live lot is in that book by definition, so zero cannot be an
     * answer here. Read as one it said «nobody is selling this», and the scan
     * recorded that as a naming problem and checked nothing.
     */
    setSteam(() => render([], 0));
    await assert.rejects(
      () => scanCompetitors(753, "489260-Rock Golem (Foil)", new Set(["7"]), {}, 1),
      (err: Error) => (err as { kind?: string }).kind === "empty"
    );
    assert.ok(
      reports.some((r) => r.outcome === "empty"),
      "the governor has to hear this one"
    );
  });

  it("treats a commodity's empty book as an answer, not as a refusal", async () => {
    /**
     * Measured on `Fracture Case`: `total_count: 1` with no `listinginfo` at
     * all. Cases and keys trade through an order book, not through listings —
     * so this is Steam answering normally, and `priceoverview` is what prices
     * them. Filed as a refusal it would put the whole scan into a cooldown over
     * an item behaving exactly as designed.
     */
    setSteam(() => render([], 1));
    const scan = await scanCompetitors(730, "Fracture Case", new Set(["7"]), {}, 1);
    assert.equal(scan.seen, 0);
    assert.equal(scan.unnamed, false, "the book named a lot — it just is not a listing");
    assert.equal(scan.competitor, null);
    assert.ok(!reports.some((r) => r.outcome === "empty"));
  });

  it("still calls a reply with no book at all a refusal", async () => {
    setSteam(() => jsonReply({ success: false }));
    await assert.rejects(() => scanCompetitors(753, "Card", new Set(), {}, 1));
    assert.ok(reports.some((r) => r.outcome === "empty"));
  });

  it("carries Steam's own count into the verdict", async () => {
    const ours = new Set<string>();
    const rows: [string, number, number][] = [];
    for (let i = 0; i < 20; i++) {
      ours.add(`m${i}`);
      rows.push([`m${i}`, 1000, 150]);
    }
    setSteam(() => render(rows, 1672));

    const scan = await scanCompetitors(730, "AK-47 | Redline (Field-Tested)", ours, {}, 20);
    assert.equal(scan.seen, 20);
    assert.equal(scan.allOurs, true);
    assert.equal(scan.crowded, true, "a full window of our own lots with a book below it");
    assert.equal(scan.unnamed, false);
  });
});
