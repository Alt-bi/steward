import { buyerPrice, sellerForBuyer, type FeeConfig } from "../../../core/fees";
import type { Cents, Listing, RepricePlan } from "../../../core/types";

/**
 * Putting the prices back.
 *
 * «Переставить» is the one button in the project that cannot be taken back by
 * pressing it again: the repricer aims at the market, so a second run lands
 * wherever the market is now, not where the lots were before the first run. A
 * bad batch — one cheap stranger in a book, a whole page cut thirty percent —
 * therefore had no way home except retyping sixty prices by hand.
 *
 * What makes this possible at all is that the old price is already in the plan:
 * `ourBuyer` is what the lot asked before we moved it. So the record is small,
 * and it is written after the run rather than before, holding only the lots
 * that actually moved.
 *
 * What makes it *hard* is that `sellitem` does not hand back a listing id, and
 * with Steam Guard pending there is no listing yet. So the restore cannot
 * address the new lots directly — it re-reads the page, matches our current
 * lots of each item against the remembered prices, and moves those. Matching is
 * by item and then by price order, which is exact for a single lot and is the
 * only sane pairing for several: the cheapest of ours goes back to the cheapest
 * remembered price.
 */

const UNDO_KEY = "stwLastReprice";

export interface UndoLot {
  appid: number;
  hash: string;
  name: string;
  /** What a buyer paid for this lot before the run touched it. */
  buyer: Cents;
}

export interface UndoRecord {
  at: number;
  lots: UndoLot[];
}

/** The lots a run actually moved, in the state they were in before it. */
export function recordFrom(plans: readonly RepricePlan[]): UndoRecord {
  const lots: UndoLot[] = [];
  for (const plan of plans) {
    if (plan.action !== "reprice" || plan.result !== "ok") continue;
    if (plan.ourBuyer < 1) continue;
    lots.push({ appid: plan.appid, hash: plan.hash, name: plan.name, buyer: plan.ourBuyer });
  }
  return { at: Date.now(), lots };
}

function key(item: { appid: number; hash: string }): string {
  return `${item.appid}\t${item.hash}`;
}

/**
 * What it would take to put the remembered prices back on the lots we hold now.
 *
 * Only lots that are actually somewhere else are planned. A restore that
 * "moves" a lot to the price it already has would take it off the market and
 * put it back for nothing — the most expensive way to do nothing there is.
 */
export function planRestore(
  record: UndoRecord | null,
  listings: readonly Listing[],
  fees: FeeConfig
): RepricePlan[] {
  if (!record?.lots.length) return [];

  const wanted = new Map<string, Cents[]>();
  for (const lot of record.lots) {
    const list = wanted.get(key(lot)) ?? [];
    list.push(lot.buyer);
    wanted.set(key(lot), list);
  }
  for (const list of wanted.values()) list.sort((a, b) => a - b);

  const held = new Map<string, Listing[]>();
  for (const listing of listings) {
    const list = held.get(key(listing)) ?? [];
    list.push(listing);
    held.set(key(listing), list);
  }
  for (const list of held.values()) list.sort((a, b) => a.ourBuyer - b.ourBuyer);

  const plans: RepricePlan[] = [];
  for (const [id, prices] of wanted) {
    const lots = held.get(id) ?? [];
    for (let i = 0; i < prices.length && i < lots.length; i += 1) {
      const listing = lots[i]!;
      const want = prices[i]!;
      if (listing.ourBuyer === want) continue;
      const targetSeller = sellerForBuyer(want, listing.publisherFeePercent, fees);
      if (targetSeller < 1) continue;
      plans.push({
        listingId: listing.listingId,
        name: listing.name,
        hash: listing.hash,
        appid: listing.appid,
        contextid: listing.contextid,
        assetid: listing.assetid,
        amount: listing.amount,
        ourBuyer: listing.ourBuyer,
        ourSeller: listing.ourSeller,
        competitorBuyer: null,
        targetBuyer: buyerPrice(targetSeller, listing.publisherFeePercent, fees),
        targetSeller,
        publisherFeePercent: listing.publisherFeePercent,
        action: "reprice",
        reason: "возвращаю цену, которая была до перестановки",
      });
    }
  }
  return plans;
}

/**
 * How much of the record the page can currently act on.
 *
 * The gap is the honest part: lots still waiting on Steam Guard are not on the
 * market yet, and lots on another page of the table are not in front of us. The
 * panel says so rather than quietly restoring nine of eleven.
 */
export function restoreCoverage(
  record: UndoRecord | null,
  plans: readonly RepricePlan[]
): { remembered: number; found: number; missing: number } {
  const remembered = record?.lots.length ?? 0;
  return { remembered, found: plans.length, missing: Math.max(0, remembered - plans.length) };
}

export async function saveUndo(record: UndoRecord): Promise<void> {
  try {
    await chrome.storage.local.set({ [UNDO_KEY]: record });
  } catch {
    /* an undo we could not write is not worth failing a finished run over */
  }
}

export async function loadUndo(): Promise<UndoRecord | null> {
  try {
    const got = (await chrome.storage.local.get(UNDO_KEY)) as Record<string, unknown>;
    const raw = got[UNDO_KEY] as UndoRecord | undefined;
    if (!raw || !Array.isArray(raw.lots) || !raw.lots.length) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function clearUndo(): Promise<void> {
  try {
    await chrome.storage.local.remove(UNDO_KEY);
  } catch {
    /* nothing to do about it, and nothing depends on it */
  }
}
