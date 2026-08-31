import { countPicked, pickedRows, type Picks } from "../../../core/picks";
import type { Cents, RepricePlan } from "../../../core/types";

/**
 * Which of our own listings the panel shows, in what order, and which of them an
 * action will touch.
 *
 * Pure, like the inventory view next door and for the same reason: a comparator
 * that puts the wrong listing on top is invisible in a screenshot, and here the
 * list decides what a mass cancel is about to remove.
 */

export type ListingSortKey = "drop" | "price" | "name";

export interface ListingFilters {
  /** Substring of the display name or the hash. Case and spacing are ignored. */
  query: string;
  /** Hide everything the plan is not going to move. */
  onlyMovable: boolean;
}

export const DEFAULT_LISTING_FILTERS: ListingFilters = { query: "", onlyMovable: false };

function normalize(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function planMatchesQuery(plan: RepricePlan, query: string): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  return normalize(plan.name).includes(needle) || normalize(plan.hash).includes(needle);
}

/**
 * How far this listing would fall.
 *
 * Not a profit: repricing always lowers the price. It is the size of the cut, and
 * sorting by it puts the listings that are furthest above the market first — which
 * is the order a seller actually wants to look at.
 */
export function planDrop(plan: RepricePlan): Cents {
  if (plan.action !== "reprice" || plan.targetBuyer == null) return 0;
  return Math.max(0, plan.ourBuyer - plan.targetBuyer);
}

/**
 * How far the price moves, in either direction.
 *
 * A level target can move a listing *up* — that is the point of pricing against
 * last month's average rather than against the cheapest lot. Sorting by `planDrop`
 * would file every one of those as a zero and bury them under the cuts.
 */
export function planMove(plan: RepricePlan): Cents {
  if (plan.action !== "reprice" || plan.targetBuyer == null) return 0;
  return Math.abs(plan.targetBuyer - plan.ourBuyer);
}

/** A listing that is still on the market: nothing has been done to it yet. */
export function isLive(plan: RepricePlan): boolean {
  return plan.result !== "ok";
}

/** A listing this run would move: overpriced, still live, still ticked. */
export function isMovable(plan: RepricePlan): boolean {
  return plan.action === "reprice" && isLive(plan);
}

function compare(a: RepricePlan, b: RepricePlan, sort: ListingSortKey): number {
  const byName = a.name.localeCompare(b.name) || a.listingId.localeCompare(b.listingId);
  if (sort === "name") return byName;
  if (sort === "price") return b.ourBuyer - a.ourBuyer || byName;
  /**
   * Skips sink under everything movable. A skip has no drop, and letting it sort
   * as a zero would scatter the actionable rows through the list.
   */
  const rank = Number(isMovable(b)) - Number(isMovable(a));
  if (rank) return rank;
  return planMove(b) - planMove(a) || b.ourBuyer - a.ourBuyer || byName;
}

export function viewPlans(
  plans: readonly RepricePlan[],
  filters: ListingFilters = DEFAULT_LISTING_FILTERS,
  sort: ListingSortKey = "drop"
): RepricePlan[] {
  const out: RepricePlan[] = [];
  for (const plan of plans) {
    if (!planMatchesQuery(plan, filters.query)) continue;
    if (filters.onlyMovable && !isMovable(plan)) continue;
    out.push(plan);
  }
  return out.sort((a, b) => compare(a, b, sort));
}

export function listingId(plan: RepricePlan): string {
  return plan.listingId;
}

/** Ids of the rows on screen — what «Все» / «Ничего» are allowed to touch. */
export function shownIds(views: readonly RepricePlan[]): string[] {
  return views.map(listingId);
}

export interface ListingTotals {
  shown: number;
  /** Rows on screen that would be repriced. */
  movable: number;
  /** Rows on screen still ticked. */
  picked: number;
  /** What the shown listings are asking, in buyer money. */
  value: Cents;
}

export function listingTotals(views: readonly RepricePlan[], dropped: Picks): ListingTotals {
  let movable = 0;
  let value = 0;
  for (const plan of views) {
    if (isMovable(plan)) movable += 1;
    value += plan.ourBuyer;
  }
  return {
    shown: views.length,
    movable,
    picked: countPicked(shownIds(views), dropped),
    value,
  };
}

/**
 * What «Переставить» will move. Filtered out of the *whole* plan list, not the
 * visible one: a listing hidden by a search box was never unticked, and silently
 * dropping it would make the button's number depend on scrolling.
 */
export function movablePlans(plans: readonly RepricePlan[], dropped: Picks): RepricePlan[] {
  return pickedRows(plans.filter(isMovable), listingId, dropped);
}

/**
 * What «Снять» will cancel: the ticked rows *on screen*, whatever the plan says
 * about them. Cancelling is the one action a user aims with the filter — «show me
 * everything that says Copenhagen 2024 and take it all down» — so here the visible
 * set is the set.
 */
export function cancellablePlans(views: readonly RepricePlan[], dropped: Picks): RepricePlan[] {
  return pickedRows(views.filter(isLive), listingId, dropped);
}
