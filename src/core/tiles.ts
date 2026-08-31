/**
 * Inventory tile ids, and which of Steam's inventory pages are actually on screen.
 *
 * Both worlds need this: the MAIN-world projection reads the tiles to send names
 * across, and the badge painter writes prices back onto the same nodes. They are
 * bundled separately, so this file deliberately imports nothing — it is the one
 * place the tile format is written down.
 */

export interface TileRef {
  appid: number;
  contextid: string;
  assetid: string;
}

/**
 * Steam ids every tile `{appid}_{contextid}_{assetid}`. Class names and nesting
 * change with every market redesign; this pattern has not.
 */
const TILE_ID = /^(\d+)_(\d+)_(\d+)$/;

export function parseTileId(id: string | null | undefined): TileRef | null {
  const match = TILE_ID.exec(String(id ?? ""));
  if (!match) return null;
  const [, appid, contextid, assetid] = match;
  if (!appid || !contextid || !assetid) return null;
  return { appid: Number(appid), contextid, assetid };
}

/**
 * Steam keeps every page of the inventory in the DOM and hides all but the current
 * one, so a hidden page is not what the user is looking at. Checked three ways
 * because which one Steam uses depends on the layout version.
 */
export function isHiddenInventoryPage(page: Element | null): boolean {
  if (!page) return false;
  const el = page as HTMLElement;
  if (el.classList?.contains("disabled")) return true;
  if (el.style?.display === "none") return true;
  const style = typeof el.getAttribute === "function" ? el.getAttribute("style") ?? "" : "";
  return /display\s*:\s*none/i.test(style);
}
