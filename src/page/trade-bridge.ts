/**
 * MAIN-world reader for the trade offer page.
 *
 * What is in the slots lives in `g_rgCurrentTradeStatus`, but that only carries
 * ids. The names, hashes and marketable flags live in the two `CUser` inventory
 * objects. Joining them has to happen here, in the page world — the isolated
 * world cannot see either.
 *
 * The offer changes while the user drags items around, so this watches the trade
 * version and re-posts whenever it moves.
 */

import { safePost } from "./project";

interface AssetRef {
  appid?: number | string;
  contextid?: string | number;
  assetid?: string | number;
  id?: string | number;
  amount?: string | number;
}

interface TradeStatusSide {
  assets?: AssetRef[];
  ready?: boolean;
}

interface TradeStatus {
  version?: number;
  me?: TradeStatusSide;
  them?: TradeStatusSide;
}

interface RawItem {
  appid?: number | string;
  contextid?: string | number;
  id?: string | number;
  assetid?: string | number;
  amount?: string | number;
  name?: string;
  market_name?: string;
  market_hash_name?: string;
  marketable?: number | boolean;
  tradable?: number | boolean;
}

interface InventoryLike {
  rgInventory?: Record<string, RawItem | undefined>;
}

interface ContextLike {
  inventory?: InventoryLike | null;
}

interface UserLike {
  rgContexts?: Record<string, Record<string, ContextLike | undefined> | undefined>;
}

declare global {
  interface Window {
    g_rgCurrentTradeStatus?: TradeStatus;
    UserYou?: UserLike;
    UserThem?: UserLike;
  }
}

const SOURCE = "steward-trade";

interface FlatItem {
  appid: number;
  contextid: string;
  assetid: string;
  name: string;
  hash: string;
  amount: number;
  marketable: boolean;
  tradable: boolean;
  /** False when we found the slot but not its description. */
  described: boolean;
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function truthy(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function lookup(user: UserLike | undefined, ref: AssetRef): RawItem | null {
  const appid = String(ref.appid ?? "");
  const contextid = String(ref.contextid ?? "");
  const assetid = String(ref.assetid ?? ref.id ?? "");
  if (!appid || !contextid || !assetid) return null;

  const context = user?.rgContexts?.[appid]?.[contextid];
  const inventory = context?.inventory?.rgInventory;
  if (!inventory) return null;

  /** Steam keys these by assetid, sometimes suffixed with the amount. */
  return (
    inventory[assetid] ??
    inventory[`${assetid}_0`] ??
    Object.values(inventory).find(
      (candidate) => candidate && String(candidate.id ?? candidate.assetid ?? "") === assetid
    ) ??
    null
  );
}

function flatten(side: TradeStatusSide | undefined, user: UserLike | undefined): FlatItem[] {
  const out: FlatItem[] = [];
  for (const ref of side?.assets ?? []) {
    const assetid = String(ref.assetid ?? ref.id ?? "");
    if (!assetid) continue;
    const raw = lookup(user, ref);
    const hash = raw?.market_hash_name ?? raw?.market_name ?? raw?.name ?? "";
    out.push({
      appid: num(ref.appid ?? raw?.appid),
      contextid: String(ref.contextid ?? raw?.contextid ?? ""),
      assetid,
      name: raw?.market_name ?? raw?.name ?? hash,
      hash,
      amount: num(ref.amount ?? raw?.amount, 1) || 1,
      /** Absent flags are treated as permissive; the panel says when it is guessing. */
      marketable: raw ? truthy(raw.marketable) : true,
      tradable: raw ? truthy(raw.tradable) : true,
      described: Boolean(raw && hash),
    });
  }
  return out;
}

function snapshot(): Record<string, unknown> {
  const status = window.g_rgCurrentTradeStatus;
  return {
    source: SOURCE,
    version: num(status?.version, 0),
    present: Boolean(status),
    yours: flatten(status?.me, window.UserYou),
    theirs: flatten(status?.them, window.UserThem),
  };
}

function send(): void {
  safePost(snapshot(), "trade snapshot");
}

let lastVersion = -1;
let lastCounts = "";

function pollTrade(): void {
  const status = window.g_rgCurrentTradeStatus;
  if (!status) return;
  const version = num(status.version, 0);
  /**
   * The version does not always move when only the description data finishes
   * loading, so the slot counts are watched too.
   */
  const counts = `${status.me?.assets?.length ?? 0}:${status.them?.assets?.length ?? 0}`;
  if (version === lastVersion && counts === lastCounts) return;
  lastVersion = version;
  lastCounts = counts;
  send();
}

send();
setInterval(pollTrade, 700);

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { source?: string; type?: string } | null;
  if (data?.source === "steward-ext" && data.type === "request-trade") send();
});

export {};
