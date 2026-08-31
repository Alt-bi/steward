import type { ItemKeyed } from "../core/types";
import { SteamError, type Pacing } from "./net";
import { currencyId } from "./page-context";
import { fetchPriceHistory, summarizeHistory, type HistoryStats } from "./pricehistory";

/**
 * Sale histories for many items, fetched once and kept.
 *
 * `pricehistory` is the most expensive endpoint we touch — the governor allows
 * about six a minute, because it is the one Steam is quickest to refuse. So a
 * scan of thirty items is five minutes, and that number has to be said out loud
 * before it starts, not discovered halfway through.
 *
 * It is also the most cacheable thing we ask for: a thirty-day average does not
 * move in an afternoon. Answers live in `chrome.storage.local` for hours, so the
 * cost is paid once a day rather than once a scan.
 */

const STORE_KEY = "stwHistory";

/** Enough for a large portfolio; past it the oldest entries go. */
const STORE_CAP = 2000;

/** How long a summary stays good. Averages over weeks do not move in hours. */
export const DEFAULT_HISTORY_TTL_MS = 6 * 3_600_000;

interface StoredHistory {
  at: number;
  /** Which wallet currency the prices are in — a summary is not portable. */
  currency: number;
  stats: HistoryStats;
}

type Store = Record<string, StoredHistory>;

let memory: Store | null = null;

export function historyKey(item: Pick<ItemKeyed, "appid" | "hash">): string {
  return `${currencyId()}:${item.appid}:${item.hash}`;
}

async function loadStore(): Promise<Store> {
  if (memory) return memory;
  try {
    const got = (await chrome.storage.local.get({ [STORE_KEY]: {} })) as Record<string, unknown>;
    const raw = got[STORE_KEY];
    memory = raw && typeof raw === "object" ? ({ ...raw } as Store) : {};
  } catch {
    /** No storage is a slower scan, never a failed one. */
    memory = {};
  }
  return memory;
}

async function saveStore(store: Store): Promise<void> {
  const keys = Object.keys(store);
  const trimmed =
    keys.length <= STORE_CAP
      ? store
      : Object.fromEntries(keys.slice(keys.length - STORE_CAP).map((k) => [k, store[k]!]));
  memory = trimmed;
  try {
    await chrome.storage.local.set({ [STORE_KEY]: trimmed });
  } catch {
    /* The scan already has its answers; failing to keep them is not a failure. */
  }
}

export async function clearHistories(): Promise<void> {
  memory = {};
  try {
    await chrome.storage.local.set({ [STORE_KEY]: {} });
  } catch {
    /* nothing to undo */
  }
}

function fresh(entry: StoredHistory | undefined, ttlMs: number, now: number): boolean {
  if (!entry?.stats) return false;
  if (entry.currency !== currencyId()) return false;
  return now - entry.at < ttlMs;
}

/**
 * Which of these we would have to actually ask Steam about.
 *
 * Exists so a caller can price the scan before running it: at six requests a
 * minute, «212 items» and «35 minutes» are the two facts a user needs in order to
 * say no.
 */
export async function unknownHistories(
  items: readonly ItemKeyed[],
  ttlMs = DEFAULT_HISTORY_TTL_MS,
  now = Date.now()
): Promise<ItemKeyed[]> {
  const store = await loadStore();
  const out = new Map<string, ItemKeyed>();
  for (const item of items) {
    if (!item.appid || !item.hash) continue;
    const key = historyKey(item);
    if (fresh(store[key], ttlMs, now) || out.has(key)) continue;
    out.set(key, item);
  }
  return [...out.values()];
}

export interface ResolveHistoryOptions extends Pacing {
  ttlMs?: number;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface HistoryResult {
  /** Item key -> what it has been selling for, or null when Steam would not say. */
  stats: Record<string, HistoryStats | null>;
  /** Items we never resolved. Feed them back to continue where we stopped. */
  unresolved: ItemKeyed[];
  stopped: "blocked" | "aborted" | null;
  requests: number;
  fromCache: number;
}

function stopKind(err: unknown): "blocked" | "aborted" | null {
  if (!(err instanceof SteamError)) return null;
  if (err.kind === "aborted") return "aborted";
  if (err.kind === "blocked" || err.kind === "rate_limited") return "blocked";
  return null;
}

/**
 * Strictly one at a time. This is the endpoint Steam refuses first, and the
 * answers are worth hours — there is nothing to gain by rushing them and a
 * multi-hour IP block to lose.
 */
export async function resolveHistories(
  items: readonly ItemKeyed[],
  opts: ResolveHistoryOptions = {}
): Promise<HistoryResult> {
  const result: HistoryResult = {
    stats: {},
    unresolved: [],
    stopped: null,
    requests: 0,
    fromCache: 0,
  };
  if (!items.length) return result;

  const ttlMs = opts.ttlMs ?? DEFAULT_HISTORY_TTL_MS;
  const now = Date.now();

  /** Two listings of one item share one history, however many rows they fill. */
  const wanted = new Map<string, ItemKeyed>();
  for (const item of items) {
    if (!item.appid || !item.hash) continue;
    const key = historyKey(item);
    if (!wanted.has(key)) wanted.set(key, item);
  }

  const store = await loadStore();
  const todo: ItemKeyed[] = [];
  for (const [key, item] of wanted) {
    const hit = store[key];
    if (fresh(hit, ttlMs, now)) {
      result.stats[item.key] = hit!.stats;
      result.fromCache += 1;
    } else {
      todo.push(item);
    }
  }
  if (!todo.length) return result;

  let done = result.fromCache;
  let learned = 0;

  try {
    for (const item of todo) {
      if (opts.abort?.()) {
        result.stopped = "aborted";
        break;
      }
      try {
        const points = await fetchPriceHistory(item.appid, item.hash, {
          abort: opts.abort,
          onWait: opts.onWait,
        });
        result.requests += 1;
        const stats = summarizeHistory(points);
        result.stats[item.key] = stats;
        store[historyKey(item)] = { at: Date.now(), currency: currencyId(), stats };
        learned += 1;
      } catch (err) {
        const stop = stopKind(err);
        if (stop) {
          result.stopped = stop;
          break;
        }
        if (err instanceof SteamError && err.kind === "not_logged_in") throw err;
        result.requests += 1;
        /** An empty answer means «Steam said nothing», not «this never sold». */
      }
      done += 1;
      opts.onProgress?.(done, wanted.size, item.name);
    }
  } finally {
    if (learned) await saveStore(store);
  }

  for (const item of todo) {
    if (result.stats[item.key] == null) {
      result.stats[item.key] = null;
      result.unresolved.push(item);
    }
  }
  return result;
}
