import type { Cents, ItemKeyed } from "../../../core/types";
import type { ClassRef, ItemClass } from "../../../steam/descriptions";
import { countItems, offerClassRefs, type OfferItem, type TradeOffer } from "../../../steam/tradeoffers";

/**
 * What the inbox looks like once the prices are in.
 *
 * Pure on purpose. This is the layer that decides which offer gets called a
 * robbery, and a verdict that can only be checked by opening a browser and
 * squinting is a verdict nobody checks.
 */

export type ClassMap = Record<string, ItemClass | null>;
export type LowMap = Record<string, Cents | null>;

export type OfferSortKey = "risk" | "delta" | "size" | "partner";

export interface OfferFilters {
  query: string;
  /** Hide the offers Steam has already closed. */
  onlyOpen: boolean;
  /** Only offers with something worth reading. */
  onlyFlagged: boolean;
}

export const DEFAULT_OFFER_FILTERS: OfferFilters = {
  query: "",
  onlyOpen: true,
  onlyFlagged: false,
};

export interface SideValue {
  /** Sum of the prices we know. */
  total: Cents;
  priced: number;
  unpriced: number;
  /** Copies, stacks counted. */
  count: number;
}

export interface OfferValue {
  get: SideValue;
  give: SideValue;
  /** Positive when the offer is in your favour. */
  delta: Cents;
  /** Both sides fully priced. Anything else and the delta is a lower bound. */
  complete: boolean;
}

export type FlagLevel = "info" | "warn" | "danger";

export type OfferFlagCode =
  | "gift-out"
  | "gift-in"
  | "hold"
  | "closed"
  | "lopsided"
  | "unpriced"
  | "not-marketable"
  | "sides-guessed";

export interface OfferFlag {
  level: FlagLevel;
  code: OfferFlagCode;
  text: string;
}

export interface OfferView {
  offer: TradeOffer;
  value: OfferValue;
  flags: OfferFlag[];
  /** Worst flag level present, for sorting and for the row's colour. */
  level: FlagLevel | "ok";
  /** Item names we managed to resolve, for the search box. */
  names: string[];
}

/** Below this share of what you give, an offer is called out. */
const LOPSIDED_RATIO = 0.5;

function money(cents: Cents): string {
  return (cents / 100).toFixed(2);
}

export function priceKey(cls: ItemClass): string {
  return `${cls.appid}\t${cls.hash}`;
}

export function itemPrice(item: OfferItem, classes: ClassMap, lows: LowMap): Cents | null {
  const cls = classes[item.key];
  if (!cls || !cls.hash) return null;
  const low = lows[priceKey(cls)];
  return low == null ? null : low * Math.max(1, item.amount);
}

export function valueSide(
  items: readonly OfferItem[],
  classes: ClassMap,
  lows: LowMap
): SideValue {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  for (const item of items) {
    const value = itemPrice(item, classes, lows);
    if (value == null) unpriced += 1;
    else {
      priced += 1;
      total += value;
    }
  }
  return { total, priced, unpriced, count: countItems(items) };
}

export function valueOffer(offer: TradeOffer, classes: ClassMap, lows: LowMap): OfferValue {
  const get = valueSide(offer.gets, classes, lows);
  const give = valueSide(offer.gives, classes, lows);
  return {
    get,
    give,
    delta: get.total - give.total,
    complete: get.unpriced === 0 && give.unpriced === 0,
  };
}

export function offerFlags(offer: TradeOffer, value: OfferValue): OfferFlag[] {
  const flags: OfferFlag[] = [];

  if (offer.state === "closed") {
    flags.push({ level: "info", code: "closed", text: "обмен уже закрыт" });
  }
  if (offer.state === "hold") {
    flags.push({
      level: "warn",
      code: "hold",
      text: "предметы уйдут в заморозку — Steam придержит их до срока в баннере",
    });
  }

  if (value.give.count && !value.get.count) {
    flags.push({
      level: "danger",
      code: "gift-out",
      text: `забирают ${value.give.count} предм. и ничего не дают взамен`,
    });
  } else if (value.get.count && !value.give.count) {
    flags.push({ level: "info", code: "gift-in", text: "от тебя ничего не просят" });
  } else if (
    value.give.total > 0 &&
    value.give.priced > 0 &&
    value.get.priced > 0 &&
    value.get.total < value.give.total * LOPSIDED_RATIO
  ) {
    flags.push({
      level: "danger",
      code: "lopsided",
      text: `отдаёшь на ${money(value.give.total)}, получаешь на ${money(value.get.total)}`,
    });
  }

  const unpriced = value.get.unpriced + value.give.unpriced;
  if (unpriced) {
    flags.push({
      level: "warn",
      code: "unpriced",
      text: `цены неизвестны у ${unpriced} позиц. — суммы неполные`,
    });
  }

  if (offer.sideSource === "layout") {
    flags.push({
      level: "warn",
      code: "sides-guessed",
      text: "не удалось определить по аватарам, где чья сторона — сверься на самой странице обмена",
    });
  }

  return flags;
}

/**
 * Items coming your way that could never become money.
 *
 * Only about what lands in your inventory: an unsellable thing you give away is
 * your business, an unsellable thing offered as payment is the trick.
 */
export function unmarketableFlags(offer: TradeOffer, classes: ClassMap): OfferFlag[] {
  const names: string[] = [];
  for (const item of offer.gets) {
    const cls = classes[item.key];
    if (cls && !cls.marketable) names.push(cls.name || cls.hash || item.classid);
  }
  if (!names.length) return [];
  return [
    {
      level: "warn",
      code: "not-marketable",
      text: `нельзя продать на маркете: ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}`,
    },
  ];
}

const LEVEL_RANK: Record<FlagLevel | "ok", number> = { danger: 0, warn: 1, info: 2, ok: 3 };

function worstLevel(flags: readonly OfferFlag[]): FlagLevel | "ok" {
  let worst: FlagLevel | "ok" = "ok";
  for (const flag of flags) if (LEVEL_RANK[flag.level] < LEVEL_RANK[worst]) worst = flag.level;
  return worst;
}

function normalize(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function offerNames(offer: TradeOffer, classes: ClassMap): string[] {
  const out: string[] = [];
  for (const item of [...offer.gets, ...offer.gives]) {
    const cls = classes[item.key];
    const name = cls?.name || cls?.hash;
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export function offerMatchesQuery(view: OfferView, query: string): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  if (normalize(view.offer.partnerName).includes(needle)) return true;
  if (view.offer.offerId.includes(needle.replace(/\D/g, "")) && /\d/.test(needle)) return true;
  return view.names.some((name) => normalize(name).includes(needle));
}

function toView(offer: TradeOffer, classes: ClassMap, lows: LowMap): OfferView {
  const value = valueOffer(offer, classes, lows);
  const flags = [...offerFlags(offer, value), ...unmarketableFlags(offer, classes)];
  /** Worst first: the reader must not have to scan a row to find the danger in it. */
  flags.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
  return { offer, value, flags, level: worstLevel(flags), names: offerNames(offer, classes) };
}

function compare(a: OfferView, b: OfferView, sort: OfferSortKey): number {
  const byId = Number(a.offer.offerId) - Number(b.offer.offerId);
  if (sort === "partner") return a.offer.partnerName.localeCompare(b.offer.partnerName) || byId;
  if (sort === "size") {
    const sizeA = a.value.get.count + a.value.give.count;
    const sizeB = b.value.get.count + b.value.give.count;
    return sizeB - sizeA || byId;
  }
  /** Best deal first when sorting by profit; that is what the word means. */
  if (sort === "delta") return b.value.delta - a.value.delta || byId;
  /** Risk: the worst verdict on top, and within it the deepest loss. */
  return LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.value.delta - b.value.delta || byId;
}

export function viewOffers(
  offers: readonly TradeOffer[],
  classes: ClassMap = {},
  lows: LowMap = {},
  filters: OfferFilters = DEFAULT_OFFER_FILTERS,
  sort: OfferSortKey = "risk"
): OfferView[] {
  const out: OfferView[] = [];
  for (const offer of offers) {
    if (filters.onlyOpen && offer.state === "closed") continue;
    const view = toView(offer, classes, lows);
    if (filters.onlyFlagged && view.level === "ok") continue;
    if (!offerMatchesQuery(view, filters.query)) continue;
    out.push(view);
  }
  return out.sort((a, b) => compare(a, b, sort));
}

export interface OfferTotals {
  offers: number;
  /** Copies coming in and going out across the shown offers. */
  gets: number;
  gives: number;
  /** Money, as far as it is known. */
  getValue: Cents;
  giveValue: Cents;
  delta: Cents;
  risky: number;
}

export function offerTotals(views: readonly OfferView[]): OfferTotals {
  const totals: OfferTotals = {
    offers: views.length,
    gets: 0,
    gives: 0,
    getValue: 0,
    giveValue: 0,
    delta: 0,
    risky: 0,
  };
  for (const view of views) {
    totals.gets += view.value.get.count;
    totals.gives += view.value.give.count;
    totals.getValue += view.value.get.total;
    totals.giveValue += view.value.give.total;
    if (view.level === "danger") totals.risky += 1;
  }
  totals.delta = totals.getValue - totals.giveValue;
  return totals;
}

/** Every distinct item class across the shown offers — one description lookup each. */
export function shownClassRefs(views: readonly OfferView[]): ClassRef[] {
  const seen = new Map<string, ClassRef>();
  for (const view of views) {
    for (const ref of offerClassRefs(view.offer)) {
      const key = `${ref.appid}:${ref.classid}:${ref.instanceid}`;
      if (!seen.has(key)) seen.set(key, ref);
    }
  }
  return [...seen.values()];
}

/** Distinct market items behind the resolved classes, for a price scan. */
export function shownPriceItems(views: readonly OfferView[], classes: ClassMap): ItemKeyed[] {
  const seen = new Map<string, ItemKeyed>();
  for (const view of views) {
    for (const item of [...view.offer.gets, ...view.offer.gives]) {
      const cls = classes[item.key];
      if (!cls?.hash || !cls.appid) continue;
      const key = priceKey(cls);
      if (seen.has(key)) continue;
      seen.set(key, { key, appid: cls.appid, hash: cls.hash, name: cls.name || cls.hash });
    }
  }
  return [...seen.values()];
}
