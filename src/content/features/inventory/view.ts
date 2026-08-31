import type { Cents } from "../../../core/types";
import type { InventoryGroup } from "../../../steam/inventory";

/**
 * What the inventory list shows, and in what order.
 *
 * Pure on purpose. Filtering and sorting are the part of this feature a user
 * touches most, and a comparator that puts the wrong stack on top is invisible in
 * a screenshot — so it is decided here and asserted in tests. The DOM side only
 * renders what comes back.
 */

export type SortKey = "value" | "price" | "count" | "name" | "wear";

export interface ViewFilters {
  /** Substring of the display name or the hash. Case and spacing are ignored. */
  query: string;
  /** Hide stacks the market will not take. */
  onlyMarketable: boolean;
  /** Hide stacks we could not price. */
  onlyPriced: boolean;
}

export const DEFAULT_FILTERS: ViewFilters = {
  query: "",
  onlyMarketable: false,
  onlyPriced: false,
};

export interface GroupView {
  group: InventoryGroup;
  /** Lowest market price for one copy, when we know it. */
  low: Cents | null;
  /** What the whole stack is worth. Zero when unpriced — never a guess. */
  value: Cents;
  /** Copies of this stack the market will accept. */
  sellable: number;
  /**
   * Float across the stack — min when every copy measured, otherwise null.
   * Only present where Steam gave wear; absent sorts last, never as zero
   * (unmeasured is not "no wear").
   */
  float: number | null;
}

/** Names are compared the way a person reads them: no case, no double spaces. */
function normalize(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesQuery(group: InventoryGroup, query: string): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  /** The hash is searched too: `AK-47 | Redline (Field-Tested)` is where the wear lives. */
  return normalize(group.name).includes(needle) || normalize(group.hash).includes(needle);
}

export function sellableCount(group: InventoryGroup): number {
  let n = 0;
  for (const item of group.items) {
    if (item.marketable) n += item.amount;
  }
  return n;
}

/** Wear across a stack: min of measured floats, null unless the whole stack spoke. */
function stackFloat(
  group: InventoryGroup,
  floatOf: ((assetid: string) => number | null) | null
): number | null {
  if (!floatOf) return null;
  let min: number | null = null;
  let measured = 0;
  for (const item of group.items) {
    const f = floatOf(item.assetid);
    if (f == null) continue;
    measured += item.amount;
    if (min == null || f < min) min = f;
  }
  return measured >= group.count ? min : null;
}

function toView(
  group: InventoryGroup,
  lows: Record<string, Cents | null>,
  floatOf: ((assetid: string) => number | null) | null = null
): GroupView {
  const low = lows[group.key] ?? null;
  return {
    group,
    low,
    value: low == null ? 0 : low * group.count,
    sellable: sellableCount(group),
    float: stackFloat(group, floatOf),
  };
}

/**
 * Unpriced stacks always sink to the bottom: an unknown price is not a low price,
 * and sorting by value must not read it as zero and bury a stack that is merely
 * unmeasured above one that is genuinely cheap.
 */
function compare(a: GroupView, b: GroupView, sort: SortKey): number {
  const byName = a.group.name.localeCompare(b.group.name);
  if (sort === "name") return byName || a.group.key.localeCompare(b.group.key);
  if (sort === "count") return b.group.count - a.group.count || byName;
  if (sort === "wear") {
    /**
     * Wear ranks on wear alone: whether a stack is priced is a different
     * question. A float nobody measured sinks — unknown, not a pristine 0.00.
     */
    const wf = (v: GroupView) => (v.float == null ? Number.POSITIVE_INFINITY : v.float);
    return wf(a) - wf(b) || byName;
  }

  const known = (v: GroupView) => (v.low == null ? 0 : 1);
  const rank = known(b) - known(a);
  if (rank) return rank;

  if (sort === "price") return (b.low ?? 0) - (a.low ?? 0) || byName;
  return b.value - a.value || byName;
}

export function viewGroups(
  groups: Map<string, InventoryGroup> | Iterable<InventoryGroup>,
  lows: Record<string, Cents | null>,
  filters: ViewFilters = DEFAULT_FILTERS,
  sort: SortKey = "value",
  floatOf: ((assetid: string) => number | null) | null = null
): GroupView[] {
  const source = groups instanceof Map ? groups.values() : groups;
  const out: GroupView[] = [];
  for (const group of source) {
    if (!matchesQuery(group, filters.query)) continue;
    const view = toView(group, lows, floatOf);
    if (filters.onlyMarketable && view.sellable < 1) continue;
    if (filters.onlyPriced && view.low == null) continue;
    out.push(view);
  }
  return out.sort((a, b) => compare(a, b, sort));
}

export interface ViewTotals {
  groups: number;
  items: number;
  value: Cents;
  unpriced: number;
}

/** What the rows on screen add up to — the filtered set, not the whole inventory. */
export function viewTotals(views: readonly GroupView[]): ViewTotals {
  let items = 0;
  let value = 0;
  let unpriced = 0;
  for (const view of views) {
    items += view.group.count;
    value += view.value;
    if (view.low == null) unpriced += 1;
  }
  return { groups: views.length, items, value, unpriced };
}

/** Keys worth ticking: an unpriced stack cannot be listed, so it is never selected. */
export function selectableKeys(views: readonly GroupView[]): string[] {
  return views.filter((view) => view.low != null && view.sellable > 0).map((view) => view.group.key);
}

/**
 * What is ticked for selling.
 *
 * Stored as what the user *removed*, not as what is picked: prices arrive in
 * waves («Догрузить цены» adds more), and a positive list would either miss the
 * new stacks or quietly re-tick the ones deliberately dropped. Both sets are
 * exclusions — of whole stacks, and of individual copies picked off the tiles.
 */
export interface Selection {
  groups: Set<string>;
  assets: Set<string>;
}

export type PickState = "all" | "some" | "none";

export function emptySelection(): Selection {
  return { groups: new Set(), assets: new Set() };
}

/** Copies that could be listed at all — the market decides, not the user. */
function sellableItems(group: InventoryGroup) {
  return group.items.filter((item) => item.marketable);
}

export function groupPick(group: InventoryGroup, selection: Selection): PickState {
  const sellable = sellableItems(group);
  if (!sellable.length) return "none";
  if (selection.groups.has(group.key)) return "none";
  const picked = sellable.filter((item) => !selection.assets.has(item.assetid)).length;
  if (picked === 0) return "none";
  return picked === sellable.length ? "all" : "some";
}

/** Ticking a partly-picked stack takes all of it; ticking a full one drops all of it. */
export function toggleGroup(group: InventoryGroup, selection: Selection): void {
  if (groupPick(group, selection) === "all") {
    selection.groups.add(group.key);
    return;
  }
  selection.groups.delete(group.key);
  for (const item of group.items) selection.assets.delete(item.assetid);
}

export function toggleAsset(
  group: InventoryGroup,
  assetid: string,
  selection: Selection
): void {
  if (selection.groups.has(group.key)) {
    /**
     * The stack as a whole was dropped. Clicking one copy means "this one", so the
     * stack comes back with every other copy dropped instead.
     */
    selection.groups.delete(group.key);
    for (const item of group.items) {
      if (item.assetid !== assetid) selection.assets.add(item.assetid);
    }
    selection.assets.delete(assetid);
    return;
  }
  if (selection.assets.has(assetid)) selection.assets.delete(assetid);
  else selection.assets.add(assetid);
}

/** Assetids the seller actually wants listed: priced, marketable, not dropped. */
export function pickedAssetIds(
  groups: Map<string, InventoryGroup> | Iterable<InventoryGroup>,
  lows: Record<string, Cents | null>,
  selection: Selection
): Set<string> {
  const source = groups instanceof Map ? groups.values() : groups;
  const out = new Set<string>();
  for (const group of source) {
    if (lows[group.key] == null) continue;
    if (selection.groups.has(group.key)) continue;
    for (const item of sellableItems(group)) {
      if (!selection.assets.has(item.assetid)) out.add(item.assetid);
    }
  }
  return out;
}
