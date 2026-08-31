import type { Cents } from "../core/types";
import { pricesFromListingText } from "./mylistings";

/**
 * Standing buy orders, read off the page Steam has already drawn.
 *
 * Same rule as our own listings: no request. The market home renders every active
 * order into the DOM, and paging `/market/mylistings` to re-read a table that is
 * already on screen spends the budget the prices need.
 *
 * A buy order is money the wallet has already committed, so the numbers here are
 * treated as facts about the user's balance, not decoration — when the quantity
 * cannot be read it is assumed to be one, which understates what is at stake
 * rather than inventing money that is not there.
 */

export interface MyBuyOrder {
  buyOrderId: string;
  /** 0 when the row carried no item link — the order can still be cancelled. */
  appid: number;
  /** market_hash_name; empty when the row carried no item link. */
  hash: string;
  name: string;
  /** Copies still wanted. */
  quantity: number;
  /** What one copy costs if the order fills, fees included. */
  unitBuyer: Cents;
}

const ROW_ID = /^mybuyorder_(\d+)$/;
const CANCEL_CALL = /CancelMarketBuyOrder\(\s*'?(\d+)'?/;
const ITEM_HREF = /\/market\/listings\/(\d+)\/([^/?#]+)/;

/** The order id Steam puts in `javascript:CancelMarketBuyOrder( '123' );`. */
export function buyOrderIdFromCancel(href: string | null | undefined): string | null {
  return CANCEL_CALL.exec(String(href ?? ""))?.[1] ?? null;
}

/**
 * How many copies the order still wants.
 *
 * Zero means "not stated" — the caller decides what to do about it. Separators are
 * dropped because Steam groups thousands by locale; a quantity has no decimals, so
 * there is nothing to lose by removing them all.
 */
export function quantityFromText(text: string | null | undefined): number {
  const cleaned = String(text ?? "").replace(/[\s\u00a0\u202f]/g, "");
  const digits = /(\d[\d.,]*)/.exec(cleaned)?.[1];
  if (!digits) return 0;
  const n = Number.parseInt(digits.replace(/[.,]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface BuyOrderParts {
  /** The row's `id` attribute. */
  id?: string | null;
  /** `href` of the row's cancel link, when the id attribute is missing. */
  cancelHref?: string | null;
  /** `href` of the item link — where appid and market_hash_name come from. */
  href?: string | null;
  name?: string | null;
  qtyText?: string | null;
  priceText?: string | null;
}

/**
 * One row, from strings. Kept apart from the DOM walk so the parsing rules can be
 * asserted without a browser — the same split the listing parser uses.
 */
export function parseBuyOrder(parts: BuyOrderParts): MyBuyOrder | null {
  const buyOrderId =
    ROW_ID.exec(String(parts.id ?? ""))?.[1] ?? buyOrderIdFromCancel(parts.cancelHref);
  if (!buyOrderId) return null;

  const link = ITEM_HREF.exec(String(parts.href ?? ""));
  const hash = link?.[2] ? decodeURIComponent(link[2]) : "";
  const name = String(parts.name ?? "").trim() || hash;

  return {
    buyOrderId,
    appid: link?.[1] ? Number(link[1]) : 0,
    hash,
    name,
    /** An unreadable quantity counts as one: understate the exposure, never inflate it. */
    quantity: quantityFromText(parts.qtyText) || 1,
    unitBuyer: pricesFromListingText(String(parts.priceText ?? "")).buyer,
  };
}

/** Wallet money this order is holding. */
export function orderMoney(order: MyBuyOrder): Cents {
  return order.unitBuyer * order.quantity;
}

const ROW_SELECTOR = '[id^="mybuyorder_"]';
const QTY_SELECTOR = ".market_listing_inline_buyorder_qty, .market_listing_buyorder_qty";
const PRICE_SELECTOR =
  ".market_listing_price_with_fee, .market_listing_my_price, .market_listing_price";
const NAME_SELECTOR = ".market_listing_item_name";

function nodeText(node: { innerText?: string; textContent?: string | null } | null): string {
  if (!node) return "";
  return String(node.innerText || node.textContent || "").trim();
}

export function buyOrdersFromDom(root: ParentNode | null): MyBuyOrder[] {
  if (!root) return [];
  /**
   * By id, because Steam reuses the row id on its children (`mybuyorder_1_name`).
   * Most of those parse to nothing, but one wrapping the cancel link would come
   * back as a second copy of the same order — and cancelling it twice is an error
   * the user would have to read as a real failure.
   */
  const out = new Map<string, MyBuyOrder>();
  for (const row of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const link =
      row.querySelector<HTMLAnchorElement>(".market_listing_item_name_link") ??
      row.querySelector<HTMLAnchorElement>('a[href*="/market/listings/"]');
    const cancel = row.querySelector<HTMLAnchorElement>('a[href*="CancelMarketBuyOrder"]');
    const order = parseBuyOrder({
      id: row.id,
      cancelHref: cancel?.getAttribute("href"),
      href: link?.getAttribute("href"),
      name: nodeText(row.querySelector(NAME_SELECTOR)) || nodeText(link),
      qtyText: nodeText(row.querySelector(QTY_SELECTOR)),
      priceText: nodeText(row.querySelector(PRICE_SELECTOR)) || nodeText(row),
    });
    if (order && !out.has(order.buyOrderId)) out.set(order.buyOrderId, order);
  }
  return [...out.values()];
}

const HOST_IDS = ["tabContentsMyListings", "tabContentsMyActiveMarketListingsRows"];

export function buyOrdersOnPage(): MyBuyOrder[] {
  if (typeof document === "undefined") return [];
  for (const id of HOST_IDS) {
    const host = document.getElementById(id);
    if (!host) continue;
    const found = buyOrdersFromDom(host);
    if (found.length) return found;
  }
  try {
    return buyOrdersFromDom(document.body);
  } catch {
    /* test stub has no querySelectorAll */
    return [];
  }
}
