import { buyerPrice, minBuyerPrice, sellerForBuyer, type FeeConfig } from "../../../core/fees";
import type { CompetitorScan } from "../../../steam/listings";
import type { Settings } from "../../../core/settings";
import type { Cents, Listing, RepricePlan } from "../../../core/types";

/** Our own listings that share one market_hash_name. */
export interface ItemGroup {
  key: string;
  appid: number;
  hash: string;
  name: string;
  listings: Listing[];
  /** Cheapest price a buyer would pay for one of ours *on this page*. */
  ourLow: Cents;
  /**
   * Cheapest lot of this item we hold anywhere, when the whole account has been
   * read. Undefined means only the page is known — and then a market minimum
   * below `ourLow` cannot be attributed: it may be our own lot on another page,
   * and undercutting that is bidding against ourselves.
   */
  ourLowAnywhere?: Cents;
  ourListingIds: Set<string>;
}

/** The cheapest of ours we can actually vouch for. */
export function ourLowest(group: ItemGroup): Cents {
  return group.ourLowAnywhere ?? group.ourLow;
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
   * The lot at `buyer` is known not to be ours.
   *
   * `false` is a statement, not a missing value: we looked and could not tell.
   * We recognise our own lots by listing id, and on a page-scoped scan those are
   * one page of the account — so a lot at or below our own price may be our own,
   * sitting on the next page of My Listings, and undercutting it is bidding
   * against ourselves. Nothing is moved against a `false`.
   *
   * It becomes true three ways: the listing book flagged the owner of every row,
   * or Steam has named every listing we hold, or the minimum came from a price
   * endpoint and we know our cheapest lot of that item across the whole account.
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
 *
 * And even the pattern expires. Measured 2026-09-01: the market homepage is the
 * *second* stage of a throttle whose first stage is an empty book, and both are
 * over within a minute of leaving the endpoint alone. A verdict that only a
 * fresh «Сканировать лоты» could clear meant every «Догрузить цены» after a
 * bad minute returned instantly, asked nothing, and printed a refusal that had
 * happened minutes ago — «Запросов 0» under a sentence describing two replies
 * nobody had just received.
 */
export class BookLiveness {
  /** How long «the book is refusing» may stand before it is worth asking again. */
  static readonly TTL_MS = 120_000;

  private htmlStreak = 0;
  private goneAt = 0;
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
    this.goneAt = 0;
    this.lastMarkup = "";
  }

  dead(now = Date.now()): boolean {
    return this.waitMs(now) > 0;
  }

  /** How long is left of the verdict, in ms. Zero means ask again. */
  waitMs(now = Date.now()): number {
    if (!this.goneAt) return 0;
    return Math.max(0, this.goneAt + BookLiveness.TTL_MS - now);
  }

  /** Called for each HTML-as-JSON answer the book gives. */
  sawMarkup(note?: string, now = Date.now()): void {
    this.htmlStreak += 1;
    if (note) this.lastMarkup = note;
    if (this.htmlStreak >= 2) this.goneAt = now;
  }

  /** One answered book means the endpoint is alive and every past markup was noise. */
  sawAnswer(): void {
    this.htmlStreak = 0;
    this.goneAt = 0;
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
  if (marketLow < ourLowest(group)) {
    return {
      buyer: marketLow,
      source: "priceoverview",
      marketLow,
      /**
       * A bare number cannot say whose lot it is. It is only proof of a
       * competitor once it is below every lot we hold — which needs the whole
       * account, not the page. Without that, this is exactly the number that
       * would walk our own price down a kopeck at a time.
       */
      theirs: group.ourLowAnywhere != null,
    };
  }
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

/**
 * One rule, applied to every lot on the page: sit one step under the cheapest
 * listing that is not ours, and never move otherwise.
 *
 * There used to be a second target here — the price the item actually sold for
 * over a week or a month, which could move a lot *up*. It is gone, and with it
 * the slowest endpoint Steam has. What is left is the thing the tab is for and
 * the one number it can establish for free: the market minimum, minus our own
 * lots, minus a kopeck.
 */
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
    const mine = ourLowest(group);
    const tied = mine === competitor;
    if (settings.skipSelfUndercut && mine < competitor) {
      for (const listing of group.listings) {
        plans.push(skip(listing, competitor, "мы уже дешевле конкурента"));
      }
      continue;
    }
    /**
     * A minimum we cannot attribute is never undercut.
     *
     * This is the one rule the whole tab hangs on: the lot at that price may be
     * our own — on the next page of My Listings, or behind a book that did not
     * flag its rows — and stepping under it is bidding against ourselves, a
     * kopeck at a time, every scan. `theirs === false` means we looked and could
     * not tell, which is not the same as not having looked, and both are answered
     * the same way here: say so, move nothing.
     */
    if (settings.skipSelfUndercut && low.theirs === false) {
      const why = tied
        ? "делим минимум — не знаю, чей второй лот"
        : "минимум ниже нашего, но чей он — не проверил";
      for (const listing of group.listings) plans.push(skip(listing, competitor, why, true));
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
        /**
         * The floor is the usual reason, and it deserves its own sentence: a
         * card already at 2,61 ₽ is not «не посчиталось», it is as cheap as
         * Steam allows, and every scan would otherwise offer to move it again.
         */
        const floor = minBuyerPrice(listing.publisherFeePercent, fees);
        plans.push(
          skip(
            listing,
            competitor,
            ceiling < floor ? "дно рынка — дешевле Steam не примет" : "не собралась цена продавца"
          )
        );
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
