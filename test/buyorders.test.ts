import "./support/env";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { calls, jsonReply, resetEnv, setAcquire, setSteam } from "./support/env";

import { noneDropped, togglePick } from "../src/core/picks";
import { cancelBuyOrder } from "../src/steam/actions";
import {
  buyOrderIdFromCancel,
  buyOrdersFromDom,
  buyOrdersOnPage,
  orderMoney,
  parseBuyOrder,
  quantityFromText,
  type MyBuyOrder,
} from "../src/steam/buyorders";
import { SteamError } from "../src/steam/net";
import {
  cancellableOrders,
  orderItems,
  orderTotals,
  viewOrders,
} from "../src/content/features/buyorders/view";

const REDLINE_HREF =
  "https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Redline%20%28Field-Tested%29";

describe("quantityFromText", () => {
  it("reads a plain count", () => {
    assert.equal(quantityFromText("7"), 7);
  });

  it("reads a grouped thousand in either locale", () => {
    assert.equal(quantityFromText("1 000"), 1000);
    assert.equal(quantityFromText("1,000"), 1000);
    assert.equal(quantityFromText("1.000"), 1000);
  });

  it("says nothing rather than guessing", () => {
    assert.equal(quantityFromText(""), 0);
    assert.equal(quantityFromText("шт."), 0);
    assert.equal(quantityFromText(null), 0);
  });
});

describe("buyOrderIdFromCancel", () => {
  it("reads the id out of Steam's cancel call", () => {
    assert.equal(
      buyOrderIdFromCancel("javascript:CancelMarketBuyOrder( '5566778899' );"),
      "5566778899"
    );
  });

  it("returns nothing for an unrelated link", () => {
    assert.equal(buyOrderIdFromCancel("https://steamcommunity.com/market/"), null);
  });
});

describe("parseBuyOrder", () => {
  it("builds an order from the row Steam draws", () => {
    const order = parseBuyOrder({
      id: "mybuyorder_123",
      href: REDLINE_HREF,
      name: "AK-47 | Redline",
      qtyText: "3",
      priceText: "0,05€",
    });
    assert.deepEqual(order, {
      buyOrderId: "123",
      appid: 730,
      hash: "AK-47 | Redline (Field-Tested)",
      name: "AK-47 | Redline",
      quantity: 3,
      unitBuyer: 5,
    });
  });

  it("falls back to the cancel link when the row has no id", () => {
    const order = parseBuyOrder({
      cancelHref: "javascript:CancelMarketBuyOrder( '77' );",
      href: REDLINE_HREF,
      priceText: "1,50€",
    });
    assert.equal(order?.buyOrderId, "77");
    assert.equal(order?.name, "AK-47 | Redline (Field-Tested)", "the hash stands in for a name");
  });

  it("refuses a row it cannot address", () => {
    /** Without an id there is nothing to cancel, and a half-order would just mislead. */
    assert.equal(parseBuyOrder({ href: REDLINE_HREF, priceText: "1,00€" }), null);
    assert.equal(parseBuyOrder({ id: "mylisting_123", priceText: "1,00€" }), null);
  });

  it("keeps an order whose item link is missing — it can still be cancelled", () => {
    const order = parseBuyOrder({ id: "mybuyorder_9", name: "Что-то", priceText: "2,00€" });
    assert.equal(order?.buyOrderId, "9");
    assert.equal(order?.appid, 0);
    assert.equal(order?.hash, "");
  });

  it("assumes one copy when the quantity cell is unreadable", () => {
    /** Understating what is at stake beats inventing money that is not committed. */
    const order = parseBuyOrder({ id: "mybuyorder_5", href: REDLINE_HREF, priceText: "3,00€" });
    assert.equal(order?.quantity, 1);
    assert.equal(orderMoney(order!), 300);
  });

  it("does not read a date as a price", () => {
    const order = parseBuyOrder({
      id: "mybuyorder_6",
      href: REDLINE_HREF,
      qtyText: "2",
      priceText: "3 hours ago 0,05€",
    });
    assert.equal(order?.unitBuyer, 5);
  });
});

interface FakeFields {
  itemHref?: string;
  cancelHref?: string;
  name?: string;
  qty?: string;
  price?: string;
}

/** Just enough of an element for the DOM walk: an id and a selector lookup. */
function fakeRow(id: string, fields: FakeFields): unknown {
  const node = (text?: string, href?: string) => ({
    textContent: text ?? "",
    getAttribute: () => href ?? null,
  });
  return {
    id,
    textContent: "",
    querySelector(sel: string) {
      if (sel.includes("item_name_link") || sel.includes("/market/listings/")) {
        return fields.itemHref ? node(fields.name, fields.itemHref) : null;
      }
      if (sel.includes("CancelMarketBuyOrder")) {
        return fields.cancelHref ? node("", fields.cancelHref) : null;
      }
      if (sel.includes("buyorder_qty")) return fields.qty ? node(fields.qty) : null;
      if (sel.includes("price")) return fields.price ? node(fields.price) : null;
      return null;
    },
  };
}

function fakeRoot(rows: unknown[]): ParentNode {
  return { querySelectorAll: () => rows } as unknown as ParentNode;
}

describe("buyOrdersFromDom", () => {
  it("reads one order per row", () => {
    const orders = buyOrdersFromDom(
      fakeRoot([
        fakeRow("mybuyorder_1", { itemHref: REDLINE_HREF, qty: "2", price: "0,05€" }),
        fakeRow("mybuyorder_2", { itemHref: REDLINE_HREF, qty: "1", price: "0,07€" }),
      ])
    );
    assert.deepEqual(
      orders.map((o) => o.buyOrderId),
      ["1", "2"]
    );
  });

  it("ignores the children that reuse the row id", () => {
    /** `mylisting_123_name` once overwrote its own row; the same trap lives here. */
    const orders = buyOrdersFromDom(
      fakeRoot([
        fakeRow("mybuyorder_1", { itemHref: REDLINE_HREF, qty: "2", price: "0,05€" }),
        fakeRow("mybuyorder_1_name", { price: "3 hours ago" }),
      ])
    );
    assert.equal(orders.length, 1);
    assert.equal(orders[0]!.quantity, 2, "the row won, not the name cell");
  });

  it("counts an order once even if a child carries the cancel link", () => {
    /** Two rows with one id would mean cancelling the same order twice. */
    const orders = buyOrdersFromDom(
      fakeRoot([
        fakeRow("mybuyorder_1", {
          itemHref: REDLINE_HREF,
          qty: "2",
          price: "0,05€",
          cancelHref: "javascript:CancelMarketBuyOrder( '1' );",
        }),
        fakeRow("mybuyorder_1_qty", { cancelHref: "javascript:CancelMarketBuyOrder( '1' );" }),
      ])
    );
    assert.equal(orders.length, 1);
    assert.equal(orders[0]!.unitBuyer, 5, "the full row is the one that survives");
  });
});

describe("buyOrdersOnPage", () => {
  it("returns nothing when Steam has not painted any orders", () => {
    assert.deepEqual(buyOrdersOnPage(), []);
  });
});

function order(overrides: Partial<MyBuyOrder> = {}): MyBuyOrder {
  return {
    buyOrderId: "1",
    appid: 730,
    hash: "Chroma Case",
    name: "Chroma Case",
    quantity: 2,
    unitBuyer: 100,
    ...overrides,
  };
}

const cheap = order({ buyOrderId: "1", quantity: 2, unitBuyer: 100 });
const big = order({ buyOrderId: "2", name: "Glove Case", hash: "Glove Case", quantity: 10, unitBuyer: 300 });
const nameless = order({ buyOrderId: "3", appid: 0, hash: "", name: "Без ссылки", quantity: 1 });

describe("viewOrders", () => {
  it("puts the biggest commitment first", () => {
    const views = viewOrders([cheap, big]);
    assert.deepEqual(
      views.map((v) => v.money),
      [3000, 200]
    );
  });

  it("sorts by unit price when asked, which is a different order", () => {
    const views = viewOrders([big, cheap], {}, { query: "", onlyAboveMarket: false }, "price");
    assert.deepEqual(
      views.map((v) => v.order.unitBuyer),
      [300, 100]
    );
  });

  it("measures the gap to the market minimum", () => {
    const views = viewOrders([cheap], { "730\tChroma Case": 120 });
    assert.equal(views[0]!.low, 120);
    assert.equal(views[0]!.gap, -20, "we are still waiting in line");
  });

  it("leaves the gap unknown rather than guessing at zero", () => {
    const views = viewOrders([cheap]);
    assert.equal(views[0]!.gap, null);
  });

  it("isolates the orders that should have filled already", () => {
    const lows = { "730\tChroma Case": 90, "730\tGlove Case": 400 };
    const views = viewOrders([cheap, big], lows, { query: "", onlyAboveMarket: true });
    assert.deepEqual(
      views.map((v) => v.order.buyOrderId),
      ["1"]
    );
  });

  it("does not call an unpriced order below market", () => {
    const views = viewOrders([cheap], {}, { query: "", onlyAboveMarket: true });
    assert.deepEqual(views, [], "unmeasured is not the same as waiting");
  });

  it("filters by name and by hash", () => {
    assert.equal(viewOrders([cheap, big], {}, { query: "glove", onlyAboveMarket: false }).length, 1);
  });
});

describe("orderTotals", () => {
  it("adds up copies and money for the rows on screen", () => {
    const views = viewOrders([cheap, big]);
    assert.deepEqual(orderTotals(views, noneDropped()), {
      orders: 2,
      items: 12,
      money: 3200,
      picked: 2,
    });
  });

  it("counts the ticked rows separately from the shown ones", () => {
    const dropped = noneDropped();
    togglePick("2", dropped);
    assert.equal(orderTotals(viewOrders([cheap, big]), dropped).picked, 1);
  });
});

describe("orderItems", () => {
  it("asks the market about each item once", () => {
    const twin = order({ buyOrderId: "4", unitBuyer: 90 });
    assert.deepEqual(
      orderItems(viewOrders([cheap, twin, big])).map((i) => i.hash),
      ["Glove Case", "Chroma Case"]
    );
  });

  it("skips an order with no item behind it", () => {
    assert.deepEqual(orderItems(viewOrders([nameless])), []);
  });
});

describe("cancellableOrders", () => {
  it("takes the ticked rows on screen", () => {
    const dropped = noneDropped();
    togglePick("1", dropped);
    const views = viewOrders([cheap, big]);
    assert.deepEqual(
      cancellableOrders(views, dropped).map((o) => o.buyOrderId),
      ["2"]
    );
  });

  it("respects the filter — what is hidden is not cancelled", () => {
    const views = viewOrders([cheap, big], {}, { query: "chroma", onlyAboveMarket: false });
    assert.deepEqual(
      cancellableOrders(views, noneDropped()).map((o) => o.buyOrderId),
      ["1"]
    );
  });
});

describe("cancelBuyOrder", () => {
  beforeEach(async () => {
    await resetEnv();
    setAcquire(() => ({ ok: true as const }));
  });

  async function reason(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
      return "";
    } catch (err) {
      return err instanceof SteamError ? err.message : String(err);
    }
  }

  it("sends the order id and the session", async () => {
    let body = "";
    setSteam((_url, init) => {
      body = String(init?.body ?? "");
      return jsonReply({ success: 1 });
    });
    await cancelBuyOrder("4242", {});
    assert.equal(calls[0], "https://steamcommunity.com/market/cancelbuyorder/");
    assert.match(body, /buy_orderid=4242/);
    assert.match(body, /sessionid=/);
  });

  it("refuses to send an empty id", async () => {
    setSteam(() => {
      throw new Error("must not reach Steam");
    });
    assert.equal(await reason(cancelBuyOrder("", {})), "no_buy_order_id");
    assert.equal(calls.length, 0);
  });

  it("treats any success code but 1 as a failure", async () => {
    /** Steam answers numbers here; reporting the money as returned would be a lie. */
    setSteam(() => jsonReply({ success: 8, message: "нет такой заявки" }));
    assert.equal(await reason(cancelBuyOrder("7", {})), "нет такой заявки");
  });

  it("accepts a bare 200 with no body", async () => {
    setSteam(() => ({ status: 200, body: "" }));
    assert.equal(await reason(cancelBuyOrder("7", {})), "");
  });

  it("reports an HTTP failure instead of pretending", async () => {
    setSteam(() => ({ status: 500, body: "" }));
    assert.equal(await reason(cancelBuyOrder("7", {})), "cancel_buyorder_http_500");
  });
});
