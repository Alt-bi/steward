import { buyerPrice, sellerForBuyer, type FeeConfig } from "../../../core/fees";
import type { Settings } from "../../../core/settings";
import type { Cents, Listing, RepricePlan } from "../../../core/types";

/** Our own listings that share one market_hash_name. */
export interface ItemGroup {
  key: string;
  appid: number;
  hash: string;
  name: string;
  listings: Listing[];
  /** Cheapest price a buyer would pay for one of ours. */
  ourLow: Cents;
  ourListingIds: Set<string>;
}

/**
 * What the cheapest listing that is not ours costs.
 * `null` means we could not establish it — never a reason to undercut blindly.
 */
export interface CompetitorLow {
  buyer: Cents | null;
  /**
   * How we know — and when we do not, why not:
   * `ours` means we hold the minimum and the competitor is still hidden,
   * `no-price` means the market told us nothing at all.
   */
  source: "priceoverview" | "listings" | "ours" | "no-price";
}

export function groupListings(listings: Listing[]): Map<string, ItemGroup> {
  const groups = new Map<string, ItemGroup>();
  for (const listing of listings) {
    const key = `${listing.appid}\t${listing.hash}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        appid: listing.appid,
        hash: listing.hash,
        name: listing.name,
        listings: [],
        ourLow: Number.POSITIVE_INFINITY,
        ourListingIds: new Set(),
      };
      groups.set(key, group);
    }
    group.listings.push(listing);
    group.ourListingIds.add(listing.listingId);
    if (listing.ourBuyer > 0 && listing.ourBuyer < group.ourLow) group.ourLow = listing.ourBuyer;
  }
  return groups;
}

/**
 * `priceoverview.lowest_price` is the minimum over *all* listings, ours included.
 *
 * When it is strictly below our own cheapest listing, the listing holding it cannot
 * be ours, so it already is the competitor minimum — exact, for free. Only when it
 * equals our own low do we actually have to open the listing page to see who is
 * behind us. That is also the only case where the old build silently gave up.
 */
export function competitorFromMarketLow(group: ItemGroup, marketLow: Cents | null): CompetitorLow {
  if (marketLow == null || marketLow < 1) return { buyer: null, source: "no-price" };
  if (marketLow < group.ourLow) return { buyer: marketLow, source: "priceoverview" };
  return { buyer: null, source: "ours" };
}

function skip(listing: Listing, competitor: Cents | null, reason: string): RepricePlan {
  return {
    listingId: listing.listingId,
    name: listing.name,
    hash: listing.hash,
    appid: listing.appid,
    contextid: listing.contextid,
    assetid: listing.assetid,
    amount: listing.amount,
    ourBuyer: listing.ourBuyer,
    competitorBuyer: competitor,
    targetBuyer: null,
    targetSeller: null,
    publisherFeePercent: listing.publisherFeePercent,
    action: "skip",
    reason,
  };
}

interface Priced {
  targetBuyer: Cents;
  targetSeller: Cents;
}

/** Highest price at or below `ceiling` that survives the fee rounding. */
function priceUnder(ceiling: Cents, publisherFeePercent: number, fees: FeeConfig): Priced | null {
  if (ceiling < 1) return null;
  const targetSeller = sellerForBuyer(ceiling, publisherFeePercent, fees);
  if (targetSeller < 1) return null;
  return { targetBuyer: buyerPrice(targetSeller, publisherFeePercent, fees), targetSeller };
}

export function buildPlans(
  groups: Map<string, ItemGroup>,
  lows: Map<string, CompetitorLow>,
  settings: Settings,
  fees: FeeConfig
): RepricePlan[] {
  const plans: RepricePlan[] = [];

  for (const group of groups.values()) {
    const low = lows.get(group.key) ?? { buyer: null, source: "no-price" as const };
    const competitor = low.buyer;

    if (competitor == null) {
      const reason =
        low.source === "ours" ? "минимум наш — конкурента не видно" : "нет цены рынка";
      for (const listing of group.listings) plans.push(skip(listing, null, reason));
      continue;
    }

    /**
     * We already hold the minimum. Undercutting here means bidding against
     * ourselves, which is the one thing this tool must never do.
     */
    if (settings.skipSelfUndercut && group.ourLow <= competitor) {
      for (const listing of group.listings) {
        plans.push(skip(listing, competitor, "мы уже на минимуме"));
      }
      continue;
    }

    const ceiling = competitor - Math.max(1, settings.undercutCents);
    if (ceiling < 1) {
      for (const listing of group.listings) {
        plans.push(skip(listing, competitor, "нельзя ниже минимума Steam"));
      }
      continue;
    }

    /**
     * One listing per item is enough to take the cheapest slot; moving the rest
     * would just stack our own duplicates at the same price. The cheapest of ours
     * goes first — it has the shortest way down.
     */
    const ordered = [...group.listings].sort((a, b) => a.ourBuyer - b.ourBuyer);
    const movable = settings.onePerItem ? ordered.slice(0, 1) : ordered;
    const held = new Set(movable.map((l) => l.listingId));

    for (const listing of ordered) {
      if (!held.has(listing.listingId)) {
        plans.push(skip(listing, competitor, "хватит одного лота на предмет"));
        continue;
      }
      if (listing.ourBuyer <= competitor) {
        plans.push(skip(listing, competitor, "уже дешевле конкурента"));
        continue;
      }

      const priced = priceUnder(ceiling, listing.publisherFeePercent, fees);
      if (!priced) {
        plans.push(skip(listing, competitor, "не собралась цена продавца"));
        continue;
      }
      if (priced.targetBuyer >= listing.ourBuyer) {
        plans.push(skip(listing, competitor, "после комиссии цена не ниже текущей"));
        continue;
      }

      plans.push({
        ...skip(listing, competitor, "оверпрайс"),
        action: "reprice",
        targetBuyer: priced.targetBuyer,
        targetSeller: priced.targetSeller,
      });
    }
  }

  return plans;
}
