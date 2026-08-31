import { countPicked, pickedRows, type Picks } from "../../../core/picks";
import type { Cents } from "../../../core/types";
import { orderMoney, type MyBuyOrder } from "../../../steam/buyorders";

/**
 * What the buy-order list shows and what an action will touch.
 *
 * Pure, and deliberately so: these rows are money the wallet has already parted
 * with, and the number next to «Отменить» has to be arrived at by rules that can
 * be asserted rather than eyeballed.
 */

export type OrderSortKey = "money" | "price" | "name";

export interface OrderFilters {
  query: string;
  /**
   * Only orders priced at or above the cheapest listing on the market. Those are
   * the odd ones — Steam should have filled them already — so they are worth being
   * able to isolate.
   */
  onlyAboveMarket: boolean;
}

export const DEFAULT_ORDER_FILTERS: OrderFilters = { query: "", onlyAboveMarket: false };

export interface OrderView {
  order: MyBuyOrder;
  /** Wallet money this order is holding. */
  money: Cents;
  /** Cheapest listing on the market, when we asked for it. */
  low: Cents | null;
  /** Our price minus that minimum. Negative means we are still waiting in line. */
  gap: Cents | null;
}

function normalize(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function orderMatchesQuery(order: MyBuyOrder, query: string): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  return normalize(order.name).includes(needle) || normalize(order.hash).includes(needle);
}

/** The key prices are cached under — same shape the rest of the extension uses. */
export function orderKey(order: MyBuyOrder): string {
  return `${order.appid}\t${order.hash}`;
}

export function orderId(order: MyBuyOrder): string {
  return order.buyOrderId;
}

function toView(order: MyBuyOrder, lows: Record<string, Cents | null>): OrderView {
  const low = lows[orderKey(order)] ?? null;
  return {
    order,
    money: orderMoney(order),
    low,
    gap: low == null ? null : order.unitBuyer - low,
  };
}

function compare(a: OrderView, b: OrderView, sort: OrderSortKey): number {
  const byName =
    a.order.name.localeCompare(b.order.name) || a.order.buyOrderId.localeCompare(b.order.buyOrderId);
  if (sort === "name") return byName;
  if (sort === "price") return b.order.unitBuyer - a.order.unitBuyer || byName;
  return b.money - a.money || byName;
}

export function viewOrders(
  orders: readonly MyBuyOrder[],
  lows: Record<string, Cents | null> = {},
  filters: OrderFilters = DEFAULT_ORDER_FILTERS,
  sort: OrderSortKey = "money"
): OrderView[] {
  const out: OrderView[] = [];
  for (const order of orders) {
    if (!orderMatchesQuery(order, filters.query)) continue;
    const view = toView(order, lows);
    /** Unpriced rows are not "below market" — they are unmeasured, so they stay out. */
    if (filters.onlyAboveMarket && (view.gap == null || view.gap < 0)) continue;
    out.push(view);
  }
  return out.sort((a, b) => compare(a, b, sort));
}

export function shownOrderIds(views: readonly OrderView[]): string[] {
  return views.map((view) => view.order.buyOrderId);
}

export interface OrderTotals {
  orders: number;
  /** Copies still wanted across the shown orders. */
  items: number;
  /** What the shown orders are holding. */
  money: Cents;
  picked: number;
}

export function orderTotals(views: readonly OrderView[], dropped: Picks): OrderTotals {
  let items = 0;
  let money = 0;
  for (const view of views) {
    items += view.order.quantity;
    money += view.money;
  }
  return { orders: views.length, items, money, picked: countPicked(shownOrderIds(views), dropped) };
}

/** What «Отменить» acts on: the ticked rows on screen, in the order shown. */
export function cancellableOrders(views: readonly OrderView[], dropped: Picks): MyBuyOrder[] {
  return pickedRows(
    views.map((view) => view.order),
    orderId,
    dropped
  );
}

/** Distinct items behind the shown orders, for a price scan. */
export function orderItems(
  views: readonly OrderView[]
): { key: string; appid: number; hash: string; name: string }[] {
  const seen = new Map<string, { key: string; appid: number; hash: string; name: string }>();
  for (const { order } of views) {
    if (!order.hash || !order.appid) continue;
    const key = orderKey(order);
    if (seen.has(key)) continue;
    seen.set(key, { key, appid: order.appid, hash: order.hash, name: order.name });
  }
  return [...seen.values()];
}
