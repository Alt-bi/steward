import { buyerPrice, sellerForBuyer, type FeeConfig } from "../../../core/fees";
import {
  describeMissingLevel,
  levelLabel,
  levelValue,
  type PriceLevel,
} from "../../../core/levels";
import type { CompetitorScan } from "../../../steam/listings";
import type { HistoryStats } from "../../../steam/pricehistory";
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
   * `priceoverview` — the market minimum was strictly below ours, so it is theirs;
   * `listings`      — read off the listing book, exact;
   * `sole`          — the book was read and nobody else is down there with us;
   * `ours`          — the minimum matches ours and nobody checked the book;
   * `no-price`      — the market told us nothing at all.
   */
  source: "priceoverview" | "listings" | "sole" | "ours" | "no-price";
  /** Market minimum including our own listings, when we learned it. */
  marketLow?: Cents | null;
  /**
   * The listing at `buyer` is known not to be ours.
   *
   * Only matters on a tie. We recognise our own lots by listing id, and the ids we
   * have are the ones on this page — so a lot priced exactly like ours may be our
   * own, sitting on the next page of My Listings. Undercutting that is bidding
   * against ourselves, so a tie only becomes actionable once Steam has told us the
   * complete set of our listings.
   */
  theirs?: boolean;
}

/**
 * Sources that never opened the listing book.
 *
 * `ours` in particular is an inference from a number Steam caches for hours: if
 * somebody undercut us this morning, `lowest_price` can still be yesterday's, and
 * yesterday's minimum was ours. Believing it is how a listing that stopped selling
 * keeps being reported as fine.
 */
export function needsExactCheck(low: CompetitorLow | undefined): boolean {
  return !low || low.source === "ours" || low.source === "no-price";
}

/**
 * Whether the listing book is still answering at all.
 *
 * Markup where JSON belongs stopped meaning one thing and started meaning two.
 * Measured 2026-08-30: `QueryListingsForItem` answers JSON today — a 200 with a
 * book of 1652 rows — yet a scan run the same hour was handed an HTML 200 twice
 * (a proxy interstitial, or a Steam sorry-page in a shape
 * `isSteamRateLimitBody` does not know). The old code turned the first such
 * answer into a permanent verdict: a module-level flag, never reset, so the
 * items that were never even asked inherited a transient page's death sentence.
 *
 * An endpoint being gone and a connection being noisy are different facts, and
 * only the first deserves permanence. Two markups in a row with nothing good
 * between them is a pattern; one is weather.
 */
export class BookLiveness {
  private htmlStreak = 0;
  private gone = false;
  /**
   * The last page that arrived where JSON belongs, named by its own title.
   * A sorry-page, an age wall and a robot check all look identical from here
   * (`not_json`) but need different answers from the user, so whatever the
   * page said about itself rides along with the verdict.
   */
  lastMarkup = "";

  /** A new scan is the user asking again; a dead verdict expires with the last one. */
  restart(): void {
    this.htmlStreak = 0;
    this.gone = false;
    this.lastMarkup = "";
  }

  get dead(): boolean {
    return this.gone;
  }

  /** Called for each HTML-as-JSON answer the book gives. */
  sawMarkup(note?: string): void {
    this.htmlStreak += 1;
    if (note) this.lastMarkup = note;
    if (this.htmlStreak >= 2) this.gone = true;
  }

  /** One answered book means the endpoint is alive and every past markup was noise. */
  sawAnswer(): void {
    this.htmlStreak = 0;
    this.gone = false;
  }
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
  if (marketLow == null || marketLow < 1) return { buyer: null, source: "no-price", marketLow: null };
  if (marketLow < group.ourLow) return { buyer: marketLow, source: "priceoverview", marketLow };
  return { buyer: null, source: "ours", marketLow };
}

/**
 * What the listing book actually showed.
 *
 * The distinction the old build could not make: «checked, we are alone down
 * there» versus «did not check». Only the first is good news.
 */
export function competitorFromScan(
  scan: CompetitorScan,
  ownershipComplete: boolean
): CompetitorLow {
  if (scan.competitor != null) {
    return {
      buyer: scan.competitor,
      source: "listings",
      marketLow: scan.marketLow,
      /**
       * When the book flagged each lot's owner, a tie is already settled and the
       * complete set of our own listing ids no longer matters. That set was only
       * ever a stand-in for the answer Steam now gives directly.
       */
      theirs: scan.flagged || ownershipComplete,
    };
  }
  if (scan.seen === 0) return { buyer: null, source: "no-price", marketLow: null };
  /** A full window of nothing but our own lots hides whatever sits right behind it. */
  if (scan.crowded) return { buyer: null, source: "ours", marketLow: scan.marketLow };
  return { buyer: null, source: "sole", marketLow: scan.marketLow };
}

function skip(
  listing: Listing,
  competitor: Cents | null,
  reason: string,
  unverified = false
): RepricePlan {
  return {
    unverified,
    listingId: listing.listingId,
    name: listing.name,
    hash: listing.hash,
    appid: listing.appid,
    contextid: listing.contextid,
    assetid: listing.assetid,
    amount: listing.amount,
    ourBuyer: listing.ourBuyer,
    ourSeller: listing.ourSeller,
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

/** Where the repricer is aiming. `market` is the classic «just under the cheapest». */
export interface PlanTarget {
  level: PriceLevel;
  /** Group key -> what that item has been selling for. */
  stats: Record<string, HistoryStats | null>;
}

const MARKET_TARGET: PlanTarget = { level: "market", stats: {} };

/**
 * Prices a group at a historical level instead of under the competitor.
 *
 * The whole point is that this may move a listing *up*: an item whose market has
 * been walked down a kopeck at a time is worth relisting at what it actually sold
 * for last month and waiting. So none of the «are we already cheapest» rules
 * apply here — the target is an absolute price, not a position in a queue.
 */
function planAtLevel(
  group: ItemGroup,
  low: CompetitorLow,
  target: PlanTarget,
  settings: Settings,
  fees: FeeConfig
): RepricePlan[] {
  const plans: RepricePlan[] = [];
  const label = levelLabel(target.level);
  const stats = target.stats[group.key] ?? null;
  const value = levelValue(target.level, low.marketLow ?? low.buyer ?? null, stats);

  if (value.buyer == null) {
    const why = describeMissingLevel(value);
    for (const listing of group.listings) plans.push(skip(listing, low.buyer, why, true));
    return plans;
  }

  /**
   * Never under what somebody is already asking. An average below the current
   * market is a discount nobody is making us give — so the level becomes «just
   * under the cheapest», and the row says that is what happened.
   */
  const floor =
    low.buyer != null ? low.buyer - Math.max(1, settings.undercutCents) : low.marketLow ?? null;
  const clamped = floor != null && floor >= 1 && value.buyer < floor;
  const wanted = clamped ? floor! : value.buyer;

  const ordered = [...group.listings].sort((a, b) => a.ourBuyer - b.ourBuyer);
  const movable = settings.onePerItem ? ordered.slice(0, 1) : ordered;
  const held = new Set(movable.map((l) => l.listingId));

  for (const listing of ordered) {
    if (!held.has(listing.listingId)) {
      plans.push(skip(listing, low.buyer, "хватит одного лота на предмет"));
      continue;
    }
    if (listing.ourBuyer < 1) {
      plans.push(skip(listing, low.buyer, "не разобрал цену лота"));
      continue;
    }
    if (!listing.assetid) {
      plans.push(skip(listing, low.buyer, "не вижу assetid — снимать нельзя, назад не выставлю"));
      continue;
    }

    const priced = priceUnder(wanted, listing.publisherFeePercent, fees);
    if (!priced) {
      plans.push(skip(listing, low.buyer, "не собралась цена продавца"));
      continue;
    }
    if (priced.targetBuyer === listing.ourBuyer) {
      plans.push(skip(listing, low.buyer, `уже на уровне «${label}»`));
      continue;
    }

    const direction = priced.targetBuyer > listing.ourBuyer ? "вверх" : "вниз";
    const note = clamped ? ` («${label}» ниже рынка — держим под минимумом)` : "";
    plans.push({
      ...skip(listing, low.buyer, `${direction}, до уровня «${label}»${note}`),
      action: "reprice",
      targetBuyer: priced.targetBuyer,
      targetSeller: priced.targetSeller,
    });
  }

  return plans;
}

export function buildPlans(
  groups: Map<string, ItemGroup>,
  lows: Map<string, CompetitorLow>,
  settings: Settings,
  fees: FeeConfig,
  target: PlanTarget = MARKET_TARGET
): RepricePlan[] {
  const plans: RepricePlan[] = [];

  for (const group of groups.values()) {
    const low = lows.get(group.key) ?? { buyer: null, source: "no-price" as const };
    const competitor = low.buyer;

    if (target.level !== "market") {
      plans.push(...planAtLevel(group, low, target, settings, fees));
      continue;
    }

    if (competitor == null) {
      /** Only `sole` actually looked; the rest are «did not check», not «fine». */
      const reason =
        low.source === "sole"
          ? "мы одни на минимуме — чужих лотов ниже нет"
          : low.source === "ours"
            ? "минимум по данным Steam наш, но чужие лоты не проверял"
            : "нет цены рынка — конкурент неизвестен";
      for (const listing of group.listings) {
        plans.push(skip(listing, null, reason, low.source !== "sole"));
      }
      continue;
    }

    /**
     * We hold the minimum *alone*. Strictly below, not «not above»: at equal
     * prices Steam sells the older listing first, so sharing the minimum with a
     * stranger is a lot that sits there. Reading a tie as a win is what made this
     * report «всё ок» on items that were not selling.
     */
    const tied = group.ourLow === competitor;
    if (settings.skipSelfUndercut && group.ourLow < competitor) {
      for (const listing of group.listings) {
        plans.push(skip(listing, competitor, "мы уже дешевле конкурента"));
      }
      continue;
    }
    /** A tie we cannot attribute: say so rather than move a lot against ourselves. */
    if (settings.skipSelfUndercut && tied && !low.theirs) {
      for (const listing of group.listings) {
        plans.push(
          skip(listing, competitor, "делим минимум — не знаю, чей второй лот", true)
        );
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
      if (listing.ourBuyer < 1) {
        plans.push(skip(listing, competitor, "не разобрал цену лота"));
        continue;
      }
      /**
       * Without an assetid the listing can be cancelled but never re-listed, so it
       * must be refused here — after `removelisting` it is too late to find out.
       */
      if (!listing.assetid) {
        plans.push(skip(listing, competitor, "не вижу assetid — снимать нельзя, назад не выставлю"));
        continue;
      }
      if (listing.ourBuyer < competitor) {
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
        ...skip(
          listing,
          competitor,
          /** A tie is not an overprice, and calling it one hides why it must move. */
          listing.ourBuyer === competitor ? "делим минимум с чужим лотом" : "оверпрайс"
        ),
        action: "reprice",
        targetBuyer: priced.targetBuyer,
        targetSeller: priced.targetSeller,
      });
    }
  }

  return plans;
}
