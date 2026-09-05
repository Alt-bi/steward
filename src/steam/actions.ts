import type { Cents } from "../core/types";
import { postForm, sleep, SteamError, type Pacing } from "./net";
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
    /**
     * An empty 200 is this endpoint's normal success and is already handled
     * above. A 200 carrying something we cannot read is not: an expired session
     * or an interstitial answers exactly like that, and calling it a success told
     * the caller a lot had come off the market when nothing had happened at all.
     * Which of the two it is cannot be known from here, so it is raised as not
     * knowing rather than resolved by guessing.
     */
    throw new SteamError("not_json", "remove_unreadable");
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

/**
 * The one refusal that is a lie about the present and a truth about a second
 * from now.
 *
 * `removelisting` returns before the asset is handed back. For a few seconds the
 * inventory does not hold it yet and `sellitem` answers that the item «is no
 * longer in your inventory» — which reads like a lost lot and stopped a whole
 * run, while waiting out those seconds was the entire cure. Every market tool
 * that survives this account does exactly that: ask again.
 *
 * Waiting is only half of it. Measured 2026-09-04 on a live account: a lot
 * holding asset `38179473068` was cancelled, and the card came back to the
 * inventory as `39042662381`, marketable and tradable. **Steam hands the item
 * back under a new assetid.** So asking again with the same id is asking a
 * question that has become permanently false: eight tries, thirty seconds, the
 * same honest refusal every time, and a lot left off the market. The retry has
 * to re-find the item, not merely re-send it — that is what `relocate` is for.
 */
const ASSET_RETURNING = /no longer in your inventory|не находится в вашем инвентаре/i;

export function assetStillReturning(err: unknown): boolean {
  return err instanceof SteamError && ASSET_RETURNING.test(err.message);
}

/**
 * Steam's shrug, and why it is not a verdict.
 *
 * «Ошибка при выставлении предмета на продажу. Обновите страницу и повторите
 * попытку.» is what `sellitem` answers when it will not say what went wrong —
 * the listing rate limit lives in here, and so does whatever else Steam decides
 * not to name. Measured 2026-09-04 on a live account: nineteen lots moved, the
 * twentieth got this, and because nothing matched it the run stopped with
 * fifty-four lots never touched.
 *
 * It is retried like the returning asset, but slower and fewer times. The
 * returning asset is a second away and will certainly arrive; this one has
 * refused for a reason it declined to give, and hammering it is how a pause
 * becomes a block. The item is in the inventory throughout — the retry risks
 * requests, never the lot.
 */
const SELL_SHRUG = /problem listing your item|Ошибка при выставлении предмета/i;

export function sellRefusedVaguely(err: unknown): boolean {
  return err instanceof SteamError && SELL_SHRUG.test(err.message);
}

/** Which refusal we are sitting out. */
export type RetryReason = "returning" | "shrug";

export interface RelistOptions {
  attempts?: number;
  /** How many times to sit out Steam's unexplained refusal. */
  vagueAttempts?: number;
  /** Overridable so tests do not sit through real backoff. */
  backoffMs?: (attempt: number) => number;
  /** The unexplained refusal waits longer: it is a «slow down», not a «wait a second». */
  vagueBackoffMs?: (attempt: number) => number;
  /** Called before each extra try, with the tries already spent and what we are waiting on. */
  onRetry?: (attempt: number, why: RetryReason) => void;
  /**
   * Where the item went. Answers with the assetid the inventory holds now, or
   * null while it is still on its way back.
   *
   * Without it the retry is a louder version of the same wrong question — see
   * the note above `ASSET_RETURNING`.
   */
  relocate?: (attempt: number) => Promise<string | null>;
}

/**
 * `sellItem`, asking again while Steam finishes handing the asset back.
 *
 * Only the returning-asset refusal is retried: a real refusal — price under the
 * minimum, trade ban, market closed — is a verdict, and firing it ten times per
 * lot would be asking for a rate limit. When the attempts run out the original
 * error is what the caller hears; nothing about the old behavior is swallowed.
 */
export async function sellItemWhenReady(
  plan: SellOrder,
  pacing: Pacing,
  opts: RelistOptions = {}
): Promise<SellResult> {
  const attempts = Math.max(1, opts.attempts ?? 8);
  const vagueAttempts = Math.max(0, opts.vagueAttempts ?? 2);
  const backoff = opts.backoffMs ?? ((n) => Math.min(2_000 * n, 6_000));
  const vagueBackoff = opts.vagueBackoffMs ?? ((n) => Math.min(5_000 * n, 20_000));
  /** The order is re-pointed as the item moves; the caller’s plan is not edited. */
  const order: SellOrder = { ...plan };
  let spent = 0;
  let vagueSpent = 0;
  for (;;) {
    try {
      return await sellItem(order, pacing);
    } catch (err) {
      spent += 1;
      const returning = assetStillReturning(err);
      const vague = !returning && sellRefusedVaguely(err);
      if (vague) vagueSpent += 1;
      const again = returning ? spent < attempts : vague && vagueSpent <= vagueAttempts;
      if (!again || pacing.abort?.()) throw err;
      opts.onRetry?.(spent, vague ? "shrug" : "returning");
      await sleep(vague ? vagueBackoff(vagueSpent) : backoff(spent));
      if (opts.relocate) {
        const fresh = await opts.relocate(spent);
        if (fresh) order.assetid = fresh;
      }
    }
  }
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
