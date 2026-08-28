import type { Cents } from "../core/types";
import { postForm, SteamError, type Pacing } from "./net";
import { sessionId } from "./page-context";

/**
 * Everything `sellitem` needs. Both the reprice plan and an inventory sell order
 * satisfy this shape, so neither feature has to know about the other.
 */
export interface SellOrder {
  appid: number;
  contextid: string;
  assetid: string;
  amount: number;
  targetSeller: Cents | null;
}

/** The two mutating calls. Everything else in the extension only reads. */

export async function removeListing(listingId: string, pacing: Pacing): Promise<void> {
  const { status, text } = await postForm(
    `https://steamcommunity.com/market/removelisting/${encodeURIComponent(listingId)}`,
    new URLSearchParams({ sessionid: sessionId() }),
    { kind: "write", ...pacing }
  );
  if (status < 200 || status >= 300) throw new SteamError("http", `remove_http_${status}`);

  const body = text.trim();
  if (!body) return;

  let json: { success?: boolean } | null = null;
  try {
    json = JSON.parse(body) as { success?: boolean };
  } catch {
    /* a non-JSON 200 is a normal success for this endpoint */
    return;
  }
  if (json && json.success === false) throw new SteamError("http", "remove_failed");
}

export interface SellResult {
  success?: boolean;
  needs_mobile_confirmation?: boolean;
  needs_email_confirmation?: boolean;
  requires_confirmation?: number | boolean;
  message?: string;
  error?: string;
}

export async function sellItem(plan: SellOrder, pacing: Pacing): Promise<SellResult> {
  if (plan.targetSeller == null || plan.targetSeller < 1) {
    throw new SteamError("http", "no_target_price");
  }
  const body = new URLSearchParams({
    sessionid: sessionId(),
    appid: String(plan.appid),
    contextid: String(plan.contextid),
    assetid: String(plan.assetid),
    amount: String(plan.amount || 1),
    price: String(plan.targetSeller),
  });

  const { text } = await postForm("https://steamcommunity.com/market/sellitem/", body, {
    kind: "write",
    ...pacing,
  });

  let json: SellResult;
  try {
    json = JSON.parse(text) as SellResult;
  } catch {
    throw new SteamError("bad_json", "sellitem_bad_json");
  }
  if (!json?.success) {
    throw new SteamError("http", String(json?.message ?? json?.error ?? "sell_failed"));
  }
  return json;
}

export function needsConfirmation(result: SellResult): boolean {
  return Boolean(
    result.needs_mobile_confirmation || result.needs_email_confirmation || result.requires_confirmation
  );
}

export interface BuyOrder {
  listingId: string;
  /** Seller's share. */
  subtotal: Cents;
  fee: Cents;
  /** What leaves the wallet. Must equal subtotal + fee. */
  total: Cents;
  currencyId: number;
}

export interface BuyResult {
  wallet_info?: { wallet_currency?: number; wallet_balance?: string };
  message?: string;
  error?: string;
}

/**
 * Buys one listing.
 *
 * The only call in this codebase that spends money, so it refuses anything that
 * does not add up: the total has to equal subtotal plus fee, and the caller has to
 * pass a ceiling it must not exceed. A wrong price here is not a wrong number on a
 * screen, it is a purchase.
 */
export async function buyListing(
  order: BuyOrder,
  maxTotalCents: number,
  pacing: Pacing
): Promise<BuyResult> {
  if (!order.listingId) throw new SteamError("http", "no_listing_id");
  if (order.subtotal < 1 || order.fee < 0) throw new SteamError("http", "bad_price");
  if (order.subtotal + order.fee !== order.total) {
    throw new SteamError("http", "price_does_not_add_up");
  }
  if (!(maxTotalCents > 0) || order.total > maxTotalCents) {
    throw new SteamError("http", "over_the_limit");
  }

  const body = new URLSearchParams({
    sessionid: sessionId(),
    currency: String(order.currencyId),
    subtotal: String(order.subtotal),
    fee: String(order.fee),
    total: String(order.total),
    quantity: "1",
  });

  const { status, text } = await postForm(
    `https://steamcommunity.com/market/buylisting/${encodeURIComponent(order.listingId)}`,
    body,
    { kind: "write", ...pacing }
  );

  let json: BuyResult & { success?: number | boolean };
  try {
    json = JSON.parse(text) as BuyResult & { success?: number | boolean };
  } catch {
    throw new SteamError("bad_json", `buylisting_http_${status}`);
  }
  /** Steam answers 1 here, not true. */
  if (json.success !== 1 && json.success !== true) {
    throw new SteamError("http", String(json.message ?? json.error ?? "buy_failed"));
  }
  return json;
}
