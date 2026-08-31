import { isHiddenInventoryPage, parseTileId, type TileRef } from "../../../core/tiles";
import type { Cents } from "../../../core/types";
import type { InventoryItem } from "../../../steam/inventory";

/**
 * Price labels drawn onto Steam's own inventory tiles.
 *
 * The tile id and what counts as a visible page live in `core/tiles`, because the
 * MAIN-world projection reads the same nodes. The injection here stays defensive
 * and silently does nothing when the markup is not what we expect, so a Steam
 * redesign degrades the badges rather than the feature.
 */

const BADGE_CLASS = "stw-badge";
const WEAR_CLASS = "stw-wear";
const MARK_ATTR = "data-stw-badge";

export { parseTileId };
export type { TileRef };

/**
 * Inventory tiles Steam is actually showing. Hidden pages stay out — that is the
 * set SIH prices, not the whole backpack.
 */
export function visibleTileRefs(root: ParentNode): TileRef[] {
  const out: TileRef[] = [];
  const seen = new Set<string>();
  let tiles: NodeListOf<Element> | Element[];
  try {
    tiles = root.querySelectorAll("[id]");
  } catch {
    return out;
  }

  let hasPages = false;
  try {
    hasPages = root.querySelector(".inventory_page") != null;
  } catch {
    hasPages = false;
  }

  for (const tile of tiles) {
    const ref = parseTileId(tile.getAttribute("id"));
    if (!ref) continue;
    if (hasPages) {
      const page = typeof tile.closest === "function" ? tile.closest(".inventory_page") : null;
      if (!page || isHiddenInventoryPage(page)) continue;
    }
    const key = `${ref.appid}_${ref.contextid}_${ref.assetid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export interface BadgeData {
  /** assetid -> what one copy is worth. */
  priceByAsset: Map<string, Cents | null>;
  format: (cents: Cents | null) => string;
  /** Whether this copy is ticked for selling. Absent means "do not mark tiles". */
  picked?: (assetid: string) => boolean;
  /** assetid -> wear text («FT 0.24»), when Steam was asked and answered. */
  wearByAsset?: Map<string, string>;
}

/**
 * Whether a click on the inventory grid was meant for us.
 *
 * A plain click belongs to Steam — it opens the item — so picking is bound to
 * Ctrl (⌘ on a Mac), which Steam's own grid does not use. Kept as a pure function
 * so the rule is testable without a browser.
 */
export function tilePickFromEvent(event: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  button?: number;
  target?: unknown;
}): TileRef | null {
  if (!(event.ctrlKey || event.metaKey)) return null;
  if (event.button != null && event.button !== 0) return null;
  const target = event.target as { closest?: (sel: string) => unknown } | null;
  if (!target || typeof target.closest !== "function") return null;
  const tile = target.closest(".item[id]") as { getAttribute?: (n: string) => string | null } | null;
  if (!tile || typeof tile.getAttribute !== "function") return null;
  return parseTileId(tile.getAttribute("id"));
}

/**
 * Ctrl+click on a tile toggles that copy. Bound in the capture phase and stopped
 * there: Steam's own click handler would otherwise open the item at the same time.
 */
export function watchTilePicks(root: Node, onPick: (ref: TileRef) => void): () => void {
  const handler = (event: Event): void => {
    const ref = tilePickFromEvent(event as MouseEvent);
    if (!ref) return;
    event.preventDefault();
    event.stopPropagation();
    onPick(ref);
  };
  root.addEventListener("click", handler, true);
  return () => root.removeEventListener("click", handler, true);
}

/** Builds the assetid lookup a badge pass needs. */
export function badgeDataFrom(
  items: InventoryItem[],
  lows: Record<string, Cents | null>,
  format: (cents: Cents | null) => string
): BadgeData {
  const priceByAsset = new Map<string, Cents | null>();
  for (const item of items) {
    priceByAsset.set(item.assetid, lows[`${item.appid}\t${item.hash}`] ?? null);
  }
  return { priceByAsset, format };
}

function badgeFor(tile: Element): HTMLElement {
  const existing = tile.querySelector<HTMLElement>(`.${BADGE_CLASS}`);
  if (existing) return existing;
  const badge = document.createElement("div");
  badge.className = BADGE_CLASS;
  tile.appendChild(badge);
  return badge;
}

/**
 * Wear rides on the top edge of the tile, where the price does not sit. Empty
 * text means no answer for this copy — the label comes off rather than showing «?».
 */
function paintWear(tile: Element, text: string | undefined): void {
  let label = tile.querySelector<HTMLElement>(`.${WEAR_CLASS}`);
  if (!text) {
    if (label) label.remove();
    return;
  }
  if (!label) {
    label = document.createElement("div");
    label.className = WEAR_CLASS;
    tile.appendChild(label);
  }
  label.textContent = text;
}

export interface PaintResult {
  painted: number;
  /** Tiles we found but had no price for. */
  skipped: number;
  /** True when no tile matched the expected id pattern at all. */
  noTiles: boolean;
}

/**
 * Writes a price onto every tile we recognise. Idempotent: running it again after
 * Steam re-renders a page of the inventory just refreshes the labels.
 */
export function paintBadges(root: ParentNode, data: BadgeData): PaintResult {
  let painted = 0;
  let skipped = 0;
  let seen = 0;

  let tiles: NodeListOf<Element>;
  try {
    tiles = root.querySelectorAll('[id*="_"]');
  } catch {
    return { painted: 0, skipped: 0, noTiles: true };
  }

  for (const tile of tiles) {
    const ref = parseTileId(tile.getAttribute("id"));
    if (!ref) continue;
    seen += 1;

    const price = data.priceByAsset.get(ref.assetid);
    if (price === undefined) {
      skipped += 1;
      continue;
    }

    const badge = badgeFor(tile);
    badge.textContent = data.format(price);
    badge.dataset.stwKnown = price == null ? "0" : "1";
    (tile as HTMLElement).setAttribute(MARK_ATTR, "1");
    /** Wear rides along on the same pass — it arrives with the prices, not before. */
    paintWear(tile, data.wearByAsset?.get(ref.assetid));
    /** Only the dropped copies are marked; a full selection must look untouched. */
    if (data.picked) {
      (tile as HTMLElement).dataset.stwPick = data.picked(ref.assetid) ? "1" : "0";
    }
    painted += 1;
  }

  return { painted, skipped, noTiles: seen === 0 };
}

export function clearBadges(root: ParentNode): void {
  try {
    for (const badge of root.querySelectorAll(`.${BADGE_CLASS}`)) badge.remove();
    for (const tile of root.querySelectorAll(`[${MARK_ATTR}]`)) {
      tile.removeAttribute(MARK_ATTR);
      (tile as HTMLElement).removeAttribute("data-stw-pick");
    }
  } catch {
    /* nothing to clean up */
  }
}

/**
 * Repaints when Steam swaps an inventory page in. Debounced, because Steam
 * rebuilds a lot of nodes at once and each rebuild would otherwise be a pass.
 */
export function watchForRepaint(root: Node, repaint: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  const observer = new MutationObserver((records) => {
    /** Our own badge writes must not trigger another pass. */
    const relevant = records.some((record) =>
      [...record.addedNodes].some(
        (node) => !(node instanceof Element) || !node.classList.contains(BADGE_CLASS)
      )
    );
    if (!relevant) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(repaint, 250);
  });

  observer.observe(root, { childList: true, subtree: true });
  return () => {
    if (timer) clearTimeout(timer);
    observer.disconnect();
  };
}
