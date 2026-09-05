import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createElement, type FakeElement } from "./support/dom";
import { DEFAULT_FEES } from "../src/core/fees";
import {
  classifyRow,
  historyFromDom,
  historyPageUrl,
  summarizeMarketHistory,
  type HistoryEvent,
} from "../src/steam/myhistory";

/**
 * The market ledger.
 *
 * Everything here turns on one decision: a row is a sale or a purchase only
 * when there is a person on the other end of it. Steam's own `+`/`-` cannot
 * carry that, because creating a listing also takes the item away — read the
 * sign alone and every lot ever listed is counted as revenue.
 */

function cell(className: string, text = ""): FakeElement {
  const node = createElement("div");
  node.className = className;
  node.append(text);
  return node;
}

function link(href: string, text = ""): FakeElement {
  const node = createElement("a");
  node.setAttribute("href", href);
  node.append(text);
  return node;
}

interface RowSpec {
  id: string;
  sign: string;
  price?: string;
  name?: string;
  game?: string;
  acted?: string;
  listed?: string;
  partner?: string;
  hashHref?: string;
}

function row(spec: RowSpec): FakeElement {
  const node = createElement("div");
  node.className = "market_listing_row market_recent_listing_row";
  node.id = spec.id;

  const who = cell("market_listing_whoactedwith");
  if (spec.partner) who.append(link(spec.partner, "кто-то"));
  else who.append("Выставлено");

  const nameBlock = cell("market_listing_item_name_block");
  const name = cell("market_listing_item_name", spec.name ?? "Fracture Case");
  nameBlock.append(
    link(spec.hashHref ?? "https://steamcommunity.com/market/listings/730/Fracture%20Case"),
    name,
    cell("market_listing_game_name", spec.game ?? "Counter-Strike 2")
  );

  node.append(
    cell("market_listing_gainorloss", spec.sign),
    cell("market_listing_price", spec.price ?? "150,00 pуб."),
    cell("market_listing_listed_date", spec.acted ?? "4 сен"),
    cell("market_listing_listed_date", spec.listed ?? "1 сен"),
    who,
    nameBlock
  );
  return node;
}

function doc(...rows: FakeElement[]): FakeElement {
  const root = createElement("div");
  root.append(...rows);
  return root;
}

const PARTNER = "https://steamcommunity.com/profiles/76561198000000009";

describe("what a market-history row means", () => {
  /**
   * The bug this rules out: a listing created and a sale both show the item
   * leaving. Counting «-» as income turns every lot ever posted into revenue,
   * which on an account that relists daily is off by an order of magnitude.
   */
  it("does not call an item leaving a sale on its own", () => {
    assert.equal(classifyRow("-", false), "listed");
    assert.equal(classifyRow("-", true), "sold");
  });

  it("does not call an item arriving a purchase on its own", () => {
    assert.equal(classifyRow("+", false), "cancelled");
    assert.equal(classifyRow("+", true), "bought");
  });

  it("refuses to guess when the row moved nothing", () => {
    assert.equal(classifyRow("", false), "unknown");
    assert.equal(classifyRow(" ", true), "unknown");
  });

  it("reads the parts of a sale off the markup", () => {
    const events = historyFromDom(
      doc(row({ id: "history_row_111_1", sign: "-", partner: PARTNER })) as never
    );
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.action, "sold");
    assert.equal(event.name, "Fracture Case");
    assert.equal(event.game, "Counter-Strike 2");
    assert.equal(event.appid, 730);
    assert.equal(event.hash, "Fracture Case", "имя предмета приходит из ссылки, раскодированным");
    assert.equal(event.price, 15000);
    assert.equal(event.actedOn, "4 сен");
    assert.equal(event.listedOn, "1 сен");
  });

  /**
   * A history row prints a date next to the price, and «4 сен» has a number in
   * it. Reading the first number in the cell would have made that a price.
   */
  it("does not take a day of the month for money", () => {
    const events = historyFromDom(
      doc(row({ id: "history_row_112_1", sign: "-", price: "4 сен 7,50 pуб.", partner: PARTNER })) as never
    );
    assert.equal(events[0]?.price, 750);
  });

  it("keeps one row per event and ignores anything that is not one", () => {
    const stray = createElement("div");
    stray.id = "not_a_history_row";
    const events = historyFromDom(
      doc(
        row({ id: "history_row_1_1", sign: "-", partner: PARTNER }),
        row({ id: "history_row_1_2", sign: "+", partner: PARTNER }),
        stray
      ) as never
    );
    assert.deepEqual(
      events.map((e) => e.action),
      ["sold", "bought"]
    );
  });

  /**
   * Measured 2026-09-05 on a live account: 300 rows read, 200 «не разобрал».
   *
   * Steam builds the ids of the cells *inside* a row on the row's own stem, so
   * an unanchored `^history_row_\d+_\d+` matched the row and both of its
   * children — every real event counted three times, twice as an empty shell,
   * and every sum computed over a list two thirds furniture.
   */
  it("counts a row once, not once per cell that borrows its id", () => {
    const real = row({ id: "history_row_777_1", sign: "-", partner: PARTNER });
    for (const suffix of ["name", "price"]) {
      const cell2 = createElement("div");
      cell2.id = `history_row_777_1_${suffix}`;
      real.append(cell2);
    }
    const events = historyFromDom(doc(real) as never);
    assert.deepEqual(
      events.map((event) => event.id),
      ["history_row_777_1"]
    );
  });

  /**
   * Three ways Steam draws the other side, and it does not always draw all of
   * them. Reading only the profile link made every sale on the account look
   * like a listing — «продано 0» over three hundred events.
   */
  it("sees a person in the avatar and in the miniprofile, not only in the link", () => {
    const avatar = row({ id: "history_row_778_1", sign: "-" });
    const who = avatar.querySelector(".market_listing_whoactedwith")!;
    who.append(createElement("img"));
    assert.equal(historyFromDom(doc(avatar) as never)[0]?.action, "sold");

    const hover = row({ id: "history_row_779_1", sign: "-" });
    const block = hover.querySelector(".market_listing_whoactedwith")!;
    const named = createElement("div");
    named.setAttribute("data-miniprofile", "12345");
    block.append(named);
    assert.equal(historyFromDom(doc(hover) as never)[0]?.action, "sold");
  });

  /** And a listing still has nobody in it, which is the whole point of the rule. */
  it("keeps a plain listing a listing", () => {
    const listed = row({ id: "history_row_780_1", sign: "-" });
    assert.equal(historyFromDom(doc(listed) as never)[0]?.action, "listed");
  });

  /**
   * The evidence for a verdict of «продано 0».
   *
   * Whether an account made no sales or this reader is looking at the wrong
   * cell cannot be told apart from inside the reader, so it carries out what
   * the cell actually said and lets the panel show it.
   */
  it("carries out what the deciding cell said, word for word", () => {
    const events = historyFromDom(
      doc(row({ id: "history_row_900_1", sign: "-" })) as never
    );
    assert.equal(events[0]?.who, "Выставлено");
  });

  it("says outright when the row has no such cell at all", () => {
    const bare = createElement("div");
    bare.className = "market_listing_row";
    bare.id = "history_row_901_1";
    bare.append(cell("market_listing_gainorloss", "-"));
    assert.equal(historyFromDom(doc(bare) as never)[0]?.who, null);
  });

  it("asks for a page by where it starts and how many it wants", () => {
    assert.match(historyPageUrl(100, 50), /start=100&count=50/);
  });
});

describe("the report over a stack of history rows", () => {
  const events: HistoryEvent[] = [
    { id: "1", action: "sold", name: "A", game: "", appid: 730, hash: "A", price: 10000, actedOn: "4 сен", listedOn: "", who: null },
    { id: "2", action: "sold", name: "A", game: "", appid: 730, hash: "A", price: 20000, actedOn: "3 сен", listedOn: "", who: null },
    { id: "3", action: "sold", name: "B", game: "", appid: 730, hash: "B", price: 5000, actedOn: "2 сен", listedOn: "", who: null },
    { id: "4", action: "bought", name: "C", game: "", appid: 730, hash: "C", price: 7000, actedOn: "2 сен", listedOn: "", who: null },
    { id: "5", action: "listed", name: "D", game: "", appid: 730, hash: "D", price: 3000, actedOn: "1 сен", listedOn: "", who: null },
    { id: "6", action: "cancelled", name: "D", game: "", appid: 730, hash: "D", price: 3000, actedOn: "1 сен", listedOn: "", who: null },
  ];

  it("counts money only where money moved", () => {
    const sums = summarizeMarketHistory(events, DEFAULT_FEES);
    assert.equal(sums.sold, 3);
    assert.equal(sums.gross, 35000, "выручка — только продажи");
    assert.equal(sums.spent, 7000, "покупки не смешиваются с выручкой");
    assert.equal(sums.listed, 1);
    assert.equal(sums.cancelled, 1);
  });

  /** The one computed number, and it is always less than what the buyer paid. */
  it("takes the fee off before calling it «на руки»", () => {
    const sums = summarizeMarketHistory(events, DEFAULT_FEES);
    assert.ok(sums.net > 0, "что-то же осталось");
    assert.ok(sums.net < sums.gross, `на руки ${sums.net} не может равняться выручке ${sums.gross}`);
  });

  it("says how many rows carried no price instead of quietly dropping them", () => {
    const blind = [...events, { ...events[0]!, id: "7", price: 0 }];
    const sums = summarizeMarketHistory(blind, DEFAULT_FEES);
    assert.equal(sums.unpriced, 1);
    assert.equal(sums.gross, 35000, "нулевая строка ничего не прибавила");
  });

  it("ranks by what an item actually brought in, not by how often it sold", () => {
    const sums = summarizeMarketHistory(events, DEFAULT_FEES);
    assert.deepEqual(
      sums.top.map((t) => t.name),
      ["A", "B"]
    );
    assert.equal(sums.top[0]?.count, 2);
    assert.equal(sums.top[0]?.gross, 30000);
  });

  /** Steam serves newest first, so the ends of the list are the ends of the range. */
  it("collects what the deciding cell said, without repeating itself", () => {
    const sums = summarizeMarketHistory(
      [
        { ...events[0]!, who: "Выставлено" },
        { ...events[1]!, who: "Выставлено" },
        { ...events[2]!, who: null },
      ],
      DEFAULT_FEES
    );
    assert.deepEqual(sums.whoSaid, ["Выставлено", "(ячейки нет)"]);
  });

  it("reports the range in the words Steam printed, not in parsed dates", () => {
    const sums = summarizeMarketHistory(events, DEFAULT_FEES);
    assert.equal(sums.to, "4 сен");
    assert.equal(sums.from, "1 сен");
  });
});
