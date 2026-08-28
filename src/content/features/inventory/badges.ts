import type { Cents } from "../../../core/types";
import type { InventoryItem } from "../../../steam/inventory";

/**
 * Price labels drawn onto Steam's own inventory tiles.
 *
 * Steam gives every tile an id of `{appid}_{contextid}_{assetid}`, which is the
 * only stable hook here — class names and nesting change, that pattern has not.
 * Parsing it is kept separate and tested; the injection itself stays defensive and
 * silently does nothing when the markup is not what we expect, so a Steam redesign
 * degrades the badges rather than the feature.
 */

const BADGE_CLASS = "stw-badge";
const MARK_ATTR = "data-stw-badge";
const TILE_ID = /^(\d+)_(\d+)_(\d+)$/;

export interface TileRef {
  appid: number;
  contextid: string;
  assetid: string;
}

export function parseTileId(id: string | null | undefined): TileRef | null {
  const match = TILE_ID.exec(String(id ?? ""));
  if (!match) return null;
  const [, appid, contextid, assetid] = match;
  if (!appid || !contextid || !assetid) return null;
  return { appid: Number(appid), contextid, assetid };
}

export interface BadgeData {
  /** assetid -> what one copy is worth. */
  priceByAsset: Map<string, Cents | null>;
  format: (cents: Cents | null) => string;
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
    painted += 1;
  }

  return { painted, skipped, noTiles: seen === 0 };
}

export function clearBadges(root: ParentNode): void {
  try {
    for (const badge of root.querySelectorAll(`.${BADGE_CLASS}`)) badge.remove();
    for (const tile of root.querySelectorAll(`[${MARK_ATTR}]`)) tile.removeAttribute(MARK_ATTR);
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
