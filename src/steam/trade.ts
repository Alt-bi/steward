import type { TradeItem } from "../content/features/trade/analyze";

/**
 * Receives what the MAIN-world trade bridge sends. Nothing here talks to Steam;
 * the trade contents come from the page, and prices come from the usual price
 * service afterwards.
 */

export const TRADE_FROM_PAGE = "steward-trade";
export const TRADE_TO_PAGE = "steward-ext";

export interface TradeSnapshot {
  version: number;
  /** False when the page has no trade on it at all. */
  present: boolean;
  yours: TradeItem[];
  theirs: TradeItem[];
  /** Items whose description the page had not loaded yet. */
  undescribed: number;
}

type Listener = (snapshot: TradeSnapshot) => void;

const listeners = new Set<Listener>();
let latest: TradeSnapshot | null = null;

interface RawFlatItem {
  appid?: number;
  contextid?: string;
  assetid?: string;
  name?: string;
  hash?: string;
  amount?: number;
  marketable?: boolean;
  tradable?: boolean;
  described?: boolean;
}

function toItems(raw: unknown): { items: TradeItem[]; undescribed: number } {
  if (!Array.isArray(raw)) return { items: [], undescribed: 0 };
  const items: TradeItem[] = [];
  let undescribed = 0;
  for (const entry of raw as RawFlatItem[]) {
    if (!entry?.assetid) continue;
    if (!entry.described) undescribed += 1;
    items.push({
      appid: Number(entry.appid) || 0,
      contextid: String(entry.contextid ?? ""),
      assetid: String(entry.assetid),
      name: entry.name ?? entry.hash ?? "",
      hash: entry.hash ?? "",
      amount: Number(entry.amount) || 1,
      marketable: entry.marketable !== false,
      tradable: entry.tradable !== false,
    });
  }
  return { items, undescribed };
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as
    | { source?: string; version?: number; present?: boolean; yours?: unknown; theirs?: unknown }
    | null;
  if (!data || data.source !== TRADE_FROM_PAGE) return;

  const yours = toItems(data.yours);
  const theirs = toItems(data.theirs);
  latest = {
    version: Number(data.version) || 0,
    present: Boolean(data.present),
    yours: yours.items,
    theirs: theirs.items,
    undescribed: yours.undescribed + theirs.undescribed,
  };
  for (const listener of listeners) listener(latest);
});

export function onTradeSnapshot(listener: Listener): () => void {
  listeners.add(listener);
  if (latest) listener(latest);
  return () => listeners.delete(listener);
}

export function requestTrade(): void {
  window.postMessage({ source: TRADE_TO_PAGE, type: "request-trade" }, "*");
}

export function currentTrade(): TradeSnapshot | null {
  return latest;
}

/** Unique items across both sides, for pricing. */
export function tradeItemKeys(snapshot: TradeSnapshot): Map<string, TradeItem> {
  const unique = new Map<string, TradeItem>();
  for (const item of [...snapshot.yours, ...snapshot.theirs]) {
    if (!item.hash || !item.appid) continue;
    const key = `${item.appid}\t${item.hash}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return unique;
}
