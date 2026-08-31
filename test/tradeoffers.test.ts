import "./support/env";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { calls, resetEnv, setAcquire, setSteam } from "./support/env";

import {
  classKey,
  clearItemClasses,
  extractHoverJson,
  fetchItemClass,
  hoverUrl,
  parseItemClass,
  resolveItemClasses,
  unknownClasses,
} from "../src/steam/descriptions";
import { SteamError } from "../src/steam/net";
import {
  bannerState,
  countItems,
  directionFromUrl,
  offerIdFrom,
  offersFromDom,
  parseClassRef,
  parseOffer,
  sameProfile,
  stackAmount,
  type OfferParts,
  type TradeOffer,
} from "../src/steam/tradeoffers";
import {
  offerTotals,
  shownPriceItems,
  valueOffer,
  viewOffers,
  type ClassMap,
} from "../src/content/features/offers/view";

const ME = "76561198000000001";
const THEM = "https://steamcommunity.com/profiles/76561198000000002";

/* ------------------------------------------------------------------ parsing */

describe("offerIdFrom", () => {
  it("reads the row id Steam draws", () => {
    assert.equal(offerIdFrom("tradeofferid_6543210"), "6543210");
  });

  it("falls back to a link to the offer", () => {
    assert.equal(offerIdFrom(null, "https://steamcommunity.com/tradeoffer/991/"), "991");
  });

  it("refuses anything it cannot address", () => {
    assert.equal(offerIdFrom("tradeoffer_items_1"), null);
    assert.equal(offerIdFrom(null, null), null);
  });
});

describe("parseClassRef", () => {
  it("reads appid, class and instance off the tile", () => {
    assert.deepEqual(parseClassRef("classinfo/730/310777117/302028390"), {
      appid: 730,
      classid: "310777117",
      instanceid: "302028390",
    });
  });

  it("treats a missing instance as zero, the way Steam does", () => {
    assert.equal(parseClassRef("classinfo/753/1234")?.instanceid, "0");
    assert.equal(classKey({ appid: 753, classid: "1234", instanceid: "0" }), "753:1234:0");
  });

  it("says nothing for a tile with no class on it", () => {
    assert.equal(parseClassRef(""), null);
    assert.equal(parseClassRef("classinfo/730"), null);
  });
});

describe("stackAmount", () => {
  it("reads a stack label", () => {
    assert.equal(stackAmount("12"), 12);
    assert.equal(stackAmount("1 000"), 1000);
  });

  it("assumes one copy when the label says nothing", () => {
    /** Reading one item as forty would invent a windfall that is not there. */
    assert.equal(stackAmount(""), 1);
    assert.equal(stackAmount(null), 1);
    assert.equal(stackAmount("Chroma Case"), 1);
  });
});

describe("sameProfile", () => {
  it("matches two links to the same person", () => {
    assert.equal(sameProfile(`${THEM}/`, `${THEM}?p=2`), true);
  });

  it("does not confuse two people", () => {
    assert.equal(sameProfile(THEM, `https://steamcommunity.com/profiles/${ME}`), false);
  });

  it("needs both sides to be profiles at all", () => {
    assert.equal(sameProfile(THEM, "https://steamcommunity.com/market/"), false);
  });
});

describe("bannerState", () => {
  it("recognises a trade hold", () => {
    assert.equal(bannerState("Items will be held until 12 Sep"), "hold");
    assert.equal(bannerState("Предметы будут удерживаться до 12 сентября"), "hold");
  });

  it("puts a closed offer above everything else", () => {
    /** A declined offer with a hold notice is over; the hold no longer matters. */
    assert.equal(bannerState("Trade Offer Canceled. Items would be held"), "closed");
    assert.equal(bannerState("", "tradeoffer_items_ctn inactive"), "closed");
  });

  it("leaves a plain offer alone", () => {
    assert.equal(bannerState(""), "active");
  });
});

/* ------------------------------------------------------- which side is whose */

function offerParts(overrides: Partial<OfferParts> = {}): OfferParts {
  return {
    id: "tradeofferid_1",
    partnerUrl: THEM,
    partnerName: "Somebody",
    steamId: ME,
    sides: [
      {
        classes: "tradeoffer_items primary",
        avatarHref: THEM,
        items: [{ economy: "classinfo/730/1/1" }],
      },
      {
        classes: "tradeoffer_items secondary",
        avatarHref: `https://steamcommunity.com/profiles/${ME}`,
        items: [{ economy: "classinfo/730/2/1" }, { economy: "classinfo/730/3/1" }],
      },
    ],
    ...overrides,
  };
}

describe("parseOffer", () => {
  it("uses the avatars to decide which side is yours", () => {
    const offer = parseOffer(offerParts())!;
    assert.equal(offer.sideSource, "avatar");
    assert.deepEqual(offer.gets.map((i) => i.classid), ["1"]);
    assert.deepEqual(offer.gives.map((i) => i.classid), ["2", "3"]);
  });

  it("is not fooled when Steam draws your side first", () => {
    /** The layout is a guess; the avatar is a person. */
    const parts = offerParts();
    parts.sides = [parts.sides[1]!, parts.sides[0]!];
    const offer = parseOffer(parts)!;
    assert.equal(offer.sideSource, "avatar");
    assert.deepEqual(offer.gets.map((i) => i.classid), ["1"]);
  });

  it("falls back to the header text when there are no avatars", () => {
    const parts = offerParts();
    for (const side of parts.sides) side.avatarHref = null;
    parts.sides[0]!.headerText = "You will receive:";
    const offer = parseOffer(parts)!;
    assert.equal(offer.sideSource, "header");
    assert.deepEqual(offer.gets.map((i) => i.classid), ["1"]);
  });

  it("admits it when only the layout is left to go on", () => {
    /**
     * The whole reason this is recorded: a silent guess about which side is yours
     * would turn a robbery into a bargain on screen.
     */
    const parts = offerParts();
    for (const side of parts.sides) side.avatarHref = null;
    const offer = parseOffer(parts)!;
    assert.equal(offer.sideSource, "layout");
    assert.deepEqual(offer.gets.map((i) => i.classid), ["1"]);
  });

  it("counts stacks, not tiles", () => {
    const parts = offerParts();
    parts.sides[0]!.items = [{ economy: "classinfo/730/1/1", amountText: "25" }];
    const offer = parseOffer(parts)!;
    assert.equal(countItems(offer.gets), 25);
  });

  it("names the partner from the profile link when the row carries no nickname", () => {
    const offer = parseOffer(offerParts({ partnerName: "" }))!;
    assert.equal(offer.partnerName, "76561198000000002");
  });

  it("refuses a row with no offer id", () => {
    assert.equal(parseOffer(offerParts({ id: "tradeoffer_items" })), null);
  });

  it("calls an offer incoming when it carries an Accept control", () => {
    const offer = parseOffer(offerParts({ direction: "outgoing", hasAccept: true }))!;
    assert.equal(offer.direction, "incoming");
  });
});

describe("directionFromUrl", () => {
  it("knows the sent list from the received one", () => {
    assert.equal(directionFromUrl({ pathname: "/id/me/tradeoffers/sent/" }), "outgoing");
    assert.equal(directionFromUrl({ pathname: "/id/me/tradeoffers/" }), "incoming");
  });
});

/* ---------------------------------------------------------------- the DOM walk */

interface FakeSide {
  classes: string;
  avatar?: string;
  header?: string;
  items: { economy: string; amount?: string }[];
}

interface FakeOffer {
  id: string;
  partner?: string;
  partnerName?: string;
  banner?: string;
  ctnClass?: string;
  accept?: boolean;
  sides: FakeSide[];
}

function node(fields: {
  text?: string;
  href?: string;
  className?: string;
  children?: Record<string, unknown>;
}): unknown {
  return {
    className: fields.className ?? "",
    textContent: fields.text ?? "",
    getAttribute: (name: string) => (name === "href" ? (fields.href ?? null) : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function fakeSide(side: FakeSide): unknown {
  const tiles = side.items.map((item) => ({
    className: "trade_item",
    textContent: item.amount ?? "",
    getAttribute: (name: string) => (name === "data-economy-item" ? item.economy : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  }));
  return {
    className: side.classes,
    textContent: "",
    getAttribute: () => null,
    querySelector(sel: string) {
      if (sel.includes("profiles")) return side.avatar ? node({ href: side.avatar }) : null;
      if (sel.includes("items_header")) return side.header ? node({ text: side.header }) : null;
      return null;
    },
    querySelectorAll: (sel: string) => (sel.includes("trade_item") ? tiles : []),
  };
}

function fakeOffer(offer: FakeOffer): unknown {
  const sides = offer.sides.map(fakeSide);
  return {
    id: offer.id,
    className: "tradeoffer",
    textContent: "",
    getAttribute: () => null,
    querySelector(sel: string) {
      if (sel.includes("tradeoffer_partner")) {
        return offer.partner
          ? {
              className: "tradeoffer_partner",
              textContent: offer.partnerName ?? "",
              getAttribute: () => null,
              querySelector: () => node({ href: offer.partner, text: offer.partnerName }),
              querySelectorAll: () => [],
            }
          : null;
      }
      if (sel.includes("AcceptTradeOffer")) return offer.accept ? node({}) : null;
      if (sel.includes("items_banner")) return offer.banner ? node({ text: offer.banner }) : null;
      if (sel.includes("items_ctn")) return node({ className: offer.ctnClass ?? "" });
      if (sel.includes("/tradeoffer/")) return null;
      if (sel.includes("profiles")) return offer.partner ? node({ href: offer.partner }) : null;
      return null;
    },
    querySelectorAll: (sel: string) => (sel === ".tradeoffer_items" ? sides : []),
  };
}

function fakeRoot(offers: FakeOffer[]): ParentNode {
  const nodes = offers.map(fakeOffer);
  return { querySelectorAll: () => nodes } as unknown as ParentNode;
}

const DOM_OFFER: FakeOffer = {
  id: "tradeofferid_500",
  partner: THEM,
  partnerName: "Trader",
  sides: [
    { classes: "tradeoffer_items primary", avatar: THEM, items: [{ economy: "classinfo/730/1/1" }] },
    {
      classes: "tradeoffer_items secondary",
      avatar: `https://steamcommunity.com/profiles/${ME}`,
      items: [{ economy: "classinfo/730/2/1" }],
    },
  ],
};

describe("offersFromDom", () => {
  it("reads an offer out of the markup Steam draws", () => {
    const offers = offersFromDom(fakeRoot([DOM_OFFER]), { direction: "incoming", steamId: ME });
    assert.equal(offers.length, 1);
    assert.equal(offers[0]!.partnerName, "Trader");
    assert.deepEqual(offers[0]!.gets.map((i) => i.classid), ["1"]);
    assert.deepEqual(offers[0]!.gives.map((i) => i.classid), ["2"]);
  });

  it("counts an offer once even when its id repeats", () => {
    /** The same trap the market rows had: children reuse the row id. */
    const offers = offersFromDom(fakeRoot([DOM_OFFER, { ...DOM_OFFER }]), {
      direction: "incoming",
    });
    assert.equal(offers.length, 1);
  });

  it("drops a row with nothing on either side", () => {
    /** That is a row we failed to read, and an empty offer would read as a gift. */
    const empty: FakeOffer = { ...DOM_OFFER, id: "tradeofferid_501", sides: [] };
    assert.deepEqual(offersFromDom(fakeRoot([empty]), { direction: "incoming" }), []);
  });

  it("marks a held offer from its banner", () => {
    const held: FakeOffer = { ...DOM_OFFER, banner: "Items will be held until 12 Sep" };
    const offers = offersFromDom(fakeRoot([held]), { direction: "incoming" });
    assert.equal(offers[0]!.state, "hold");
  });
});

/* ------------------------------------------------------------- descriptions */

function hoverBody(fields: Record<string, unknown>): string {
  return `BuildHover( 'hover_item', ${JSON.stringify(fields)}, UserYou );`;
}

describe("extractHoverJson", () => {
  it("finds the description Steam wraps in a script call", () => {
    const json = extractHoverJson(hoverBody({ market_hash_name: "Chroma Case" }));
    assert.equal(JSON.parse(json!).market_hash_name, "Chroma Case");
  });

  it("survives a brace inside an item name", () => {
    /** Names are user-visible text; a regex for the closing brace would stop early. */
    const body = hoverBody({ market_hash_name: "Sticker | {LOL} (Foil)", type: "Sticker" });
    assert.equal(JSON.parse(extractHoverJson(body)!).type, "Sticker");
  });

  it("survives an escaped quote inside a name", () => {
    const body = hoverBody({ market_hash_name: 'The "Thing"', type: "Hat" });
    assert.equal(JSON.parse(extractHoverJson(body)!).type, "Hat");
  });

  it("returns nothing rather than half an object", () => {
    assert.equal(extractHoverJson("BuildHover( 'x', {\"a\": 1"), null);
    assert.equal(extractHoverJson(""), null);
  });
});

describe("parseItemClass", () => {
  const ref = { appid: 730, classid: "77", instanceid: "0" };

  it("keeps the hash the prices are keyed by", () => {
    const cls = parseItemClass(ref, hoverBody({ market_hash_name: "Chroma Case", name: "Кейс" }))!;
    assert.equal(cls.hash, "Chroma Case");
    assert.equal(cls.key, "730:77:0");
  });

  it("assumes marketable and tradable, which is what Steam omits", () => {
    const cls = parseItemClass(ref, hoverBody({ market_hash_name: "X" }))!;
    assert.deepEqual([cls.marketable, cls.tradable], [true, true]);
  });

  it("reads a zero flag as the refusal it is", () => {
    const cls = parseItemClass(ref, hoverBody({ market_hash_name: "X", marketable: 0 }))!;
    assert.equal(cls.marketable, false);
  });

  it("refuses an answer with no name in it at all", () => {
    assert.equal(parseItemClass(ref, hoverBody({ type: "Container" })), null);
    assert.equal(parseItemClass(ref, "не то, что обещали"), null);
  });
});

describe("fetchItemClass", () => {
  beforeEach(async () => {
    await resetEnv();
    await clearItemClasses();
    setAcquire(() => ({ ok: true as const }));
  });

  it("asks in English so the hash is the hash", () => {
    assert.match(hoverUrl({ appid: 730, classid: "1", instanceid: "2" }), /l=english/);
    assert.match(hoverUrl({ appid: 730, classid: "1", instanceid: "2" }), /730\/1\/2/);
  });

  it("reads a description out of a script answer", async () => {
    setSteam(() => ({ status: 200, body: hoverBody({ market_hash_name: "Chroma Case" }) }));
    const cls = await fetchItemClass({ appid: 730, classid: "1", instanceid: "0" }, {});
    assert.equal(cls.hash, "Chroma Case");
    assert.match(calls[0]!, /itemclasshover/);
  });

  it("treats an answer with no hover in it as empty, not as an item", async () => {
    setSteam(() => ({ status: 200, body: "<div>ничего</div>" }));
    await assert.rejects(
      fetchItemClass({ appid: 730, classid: "1", instanceid: "0" }, {}),
      (err: unknown) => err instanceof SteamError && err.kind === "empty"
    );
  });
});

describe("resolveItemClasses", () => {
  beforeEach(async () => {
    await resetEnv();
    await clearItemClasses();
    setAcquire(() => ({ ok: true as const }));
    setSteam((url) => {
      const classid = /itemclasshover\/\d+\/(\d+)/.exec(url)?.[1] ?? "0";
      return { status: 200, body: hoverBody({ market_hash_name: `Item ${classid}` }) };
    });
  });

  it("asks once per class however many tiles share it", async () => {
    const ref = { appid: 730, classid: "1", instanceid: "0" };
    const result = await resolveItemClasses([ref, ref, { ...ref, classid: "2" }]);
    assert.equal(result.requests, 2);
    assert.equal(result.classes["730:1:0"]?.hash, "Item 1");
  });

  it("never asks about the same class twice", async () => {
    /** A class is immutable, so a second inbox is nearly free. */
    const ref = { appid: 730, classid: "9", instanceid: "0" };
    await resolveItemClasses([ref]);
    const again = await resolveItemClasses([ref]);
    assert.equal(again.requests, 0);
    assert.equal(again.fromCache, 1);
    assert.equal(again.classes["730:9:0"]?.hash, "Item 9");
  });

  it("says up front how much a scan will cost", async () => {
    const known = { appid: 730, classid: "5", instanceid: "0" };
    await resolveItemClasses([known]);
    const todo = await unknownClasses([known, { appid: 730, classid: "6", instanceid: "0" }]);
    assert.deepEqual(todo.map((r) => r.classid), ["6"]);
  });

  it("stops at the first refusal instead of hammering a live ban", async () => {
    setSteam(() => ({ status: 429, body: "" }));
    const result = await resolveItemClasses([
      { appid: 730, classid: "1", instanceid: "0" },
      { appid: 730, classid: "2", instanceid: "0" },
      { appid: 730, classid: "3", instanceid: "0" },
    ], { concurrency: 1 });
    assert.equal(result.stopped, "blocked");
    assert.equal(result.unresolved.length, 3);
  });

  it("leaves an unreadable answer unresolved rather than caching a lie", async () => {
    setSteam(() => ({ status: 200, body: "BuildHover( 'x', {broken" }));
    const ref = { appid: 730, classid: "4", instanceid: "0" };
    const first = await resolveItemClasses([ref]);
    assert.equal(first.classes["730:4:0"], null);
    const second = await resolveItemClasses([ref]);
    assert.equal(second.fromCache, 0, "nothing was remembered");
  });
});

/* ------------------------------------------------------------- the view model */

function offer(overrides: Partial<TradeOffer> = {}): TradeOffer {
  return {
    offerId: "1",
    direction: "incoming",
    partnerName: "Trader",
    partnerUrl: THEM,
    gets: [{ appid: 730, classid: "1", instanceid: "0", key: "730:1:0", amount: 1 }],
    gives: [{ appid: 730, classid: "2", instanceid: "0", key: "730:2:0", amount: 1 }],
    banner: "",
    state: "active",
    sideSource: "avatar",
    ...overrides,
  };
}

const classes: ClassMap = {
  "730:1:0": {
    appid: 730,
    classid: "1",
    instanceid: "0",
    key: "730:1:0",
    hash: "Chroma Case",
    name: "Chroma Case",
    marketable: true,
    tradable: true,
  },
  "730:2:0": {
    appid: 730,
    classid: "2",
    instanceid: "0",
    key: "730:2:0",
    hash: "AK-47 | Redline",
    name: "AK-47 | Redline",
    marketable: true,
    tradable: true,
  },
};

const lows = { "730\tChroma Case": 50, "730\tAK-47 | Redline": 900 };

describe("valueOffer", () => {
  it("prices both sides and says which way the money goes", () => {
    const value = valueOffer(offer(), classes, lows);
    assert.equal(value.get.total, 50);
    assert.equal(value.give.total, 900);
    assert.equal(value.delta, -850);
    assert.equal(value.complete, true);
  });

  it("multiplies a stack by what one copy costs", () => {
    const stacked = offer({
      gets: [{ appid: 730, classid: "1", instanceid: "0", key: "730:1:0", amount: 20 }],
    });
    assert.equal(valueOffer(stacked, classes, lows).get.total, 1000);
  });

  it("marks the sums incomplete instead of quietly reading a gap as zero", () => {
    const value = valueOffer(offer(), classes, { "730\tChroma Case": 50 });
    assert.equal(value.complete, false);
    assert.equal(value.give.unpriced, 1);
  });
});

describe("offer flags", () => {
  function flagsOf(o: TradeOffer, map: ClassMap = classes, prices = lows): string[] {
    return viewOffers([o], map, prices, { query: "", onlyOpen: false, onlyFlagged: false })[0]!
      .flags.map((f) => f.code);
  }

  it("calls out an offer that takes and gives nothing", () => {
    assert.ok(flagsOf(offer({ gets: [] })).includes("gift-out"));
  });

  it("does not call a gift in your favour a danger", () => {
    const view = viewOffers([offer({ gives: [] })], classes, lows)[0]!;
    assert.equal(view.level, "info");
  });

  it("calls out a trade that costs far more than it returns", () => {
    assert.ok(flagsOf(offer()).includes("lopsided"));
  });

  it("stays quiet about a fair trade", () => {
    const fair = offer();
    const view = viewOffers([fair], classes, {
      "730\tChroma Case": 900,
      "730\tAK-47 | Redline": 900,
    })[0]!;
    assert.equal(view.level, "ok");
  });

  it("warns that it had to guess which side is yours", () => {
    assert.ok(flagsOf(offer({ sideSource: "layout" })).includes("sides-guessed"));
  });

  it("warns about something offered that can never become money", () => {
    const dead: ClassMap = {
      ...classes,
      "730:1:0": { ...classes["730:1:0"]!, marketable: false },
    };
    assert.ok(flagsOf(offer(), dead).includes("not-marketable"));
  });

  it("does not complain about an unsellable item you are giving away", () => {
    /** What leaves your inventory being unsellable is your business, not a trick. */
    const dead: ClassMap = {
      ...classes,
      "730:2:0": { ...classes["730:2:0"]!, marketable: false },
    };
    assert.equal(flagsOf(offer()).includes("not-marketable"), false);
    assert.equal(flagsOf(offer(), dead).includes("not-marketable"), false);
  });
});

describe("viewOffers", () => {
  const risky = offer({ offerId: "1" });
  const gift = offer({ offerId: "2", gives: [] });
  const closed = offer({ offerId: "3", state: "closed" });

  it("hides closed offers unless asked", () => {
    assert.deepEqual(
      viewOffers([risky, closed], classes, lows).map((v) => v.offer.offerId),
      ["1"]
    );
    assert.equal(
      viewOffers([risky, closed], classes, lows, { query: "", onlyOpen: false, onlyFlagged: false })
        .length,
      2
    );
  });

  it("puts the worst verdict on top by default", () => {
    assert.deepEqual(
      viewOffers([gift, risky], classes, lows).map((v) => v.offer.offerId),
      ["1", "2"]
    );
  });

  it("puts the best deal on top when asked for profit", () => {
    assert.deepEqual(
      viewOffers(
        [risky, gift],
        classes,
        lows,
        { query: "", onlyOpen: true, onlyFlagged: false },
        "delta"
      ).map((v) => v.offer.offerId),
      ["2", "1"]
    );
  });

  it("searches the partner and the item names alike", () => {
    const filters = { query: "redline", onlyOpen: true, onlyFlagged: false };
    assert.equal(viewOffers([risky, gift], classes, lows, filters).length, 1);
    assert.equal(
      viewOffers([risky], classes, lows, { ...filters, query: "trader" }).length,
      1
    );
  });

  it("finds nothing rather than everything when the query misses", () => {
    assert.deepEqual(
      viewOffers([risky], classes, lows, {
        query: "karambit",
        onlyOpen: true,
        onlyFlagged: false,
      }),
      []
    );
  });
});

describe("offerTotals", () => {
  it("adds up the shown offers, both directions", () => {
    const views = viewOffers([offer({ offerId: "1" }), offer({ offerId: "2" })], classes, lows);
    const totals = offerTotals(views);
    assert.deepEqual(
      { offers: totals.offers, gets: totals.gets, gives: totals.gives, delta: totals.delta },
      { offers: 2, gets: 2, gives: 2, delta: -1700 }
    );
    assert.equal(totals.risky, 2);
  });
});

describe("shownPriceItems", () => {
  it("asks the market about each item once across every offer", () => {
    const views = viewOffers([offer({ offerId: "1" }), offer({ offerId: "2" })], classes, lows);
    assert.deepEqual(
      shownPriceItems(views, classes).map((i) => i.hash),
      ["Chroma Case", "AK-47 | Redline"]
    );
  });

  it("skips a class Steam would not name", () => {
    const views = viewOffers([offer()], { "730:1:0": classes["730:1:0"]! }, lows);
    assert.deepEqual(
      shownPriceItems(views, { "730:1:0": classes["730:1:0"]! }).map((i) => i.hash),
      ["Chroma Case"]
    );
  });
});
