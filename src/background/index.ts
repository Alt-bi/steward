import { serve, type Handlers, type LogRow } from "../core/messaging";
import * as cache from "./cache";
import * as naming from "./naming";
import * as scheduler from "./scheduler";

/** Ring buffer of what Steam told us, for the panel's diagnostics view. */
const LOG_LIMIT = 200;
let log: LogRow[] = [];

function note(kind: string, detail: string): void {
  log.push({ t: Date.now(), kind, detail });
  if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT);
}

const handlers: Handlers = {
  "net/acquire": ({ kind }) => scheduler.acquire(kind),

  "net/report": async ({ kind, outcome, retryAfterMs, detail }) => {
    await scheduler.report(kind, outcome, retryAfterMs);
    /** Successes are logged too — otherwise a healthy scan looks like silence. */
    note(outcome, `${kind} ${detail ?? ""}`.trim());
    return { ok: true };
  },

  "net/stats": () => scheduler.stats(),

  "net/unblock": async () => {
    await scheduler.unblock();
    return { ok: true };
  },

  "net/reset": async () => {
    await scheduler.reset();
    log = [];
    return { ok: true };
  },

  "cache/get": async ({ keys }) => ({ hits: await cache.get(keys) }),

  "cache/set": async ({ entries }) => {
    await cache.set(entries);
    return { ok: true };
  },

  "cache/clear": async () => {
      await cache.clear();
      return { ok: true };
    },

    "naming/get": async ({ keys }) => ({ hits: await naming.get(keys) }),

    "naming/set": async ({ entries }) => {
      await naming.set(entries);
      return { ok: true };
    },

    "naming/drop": async ({ keys }) => {
      await naming.drop(keys);
      return { ok: true };
    },

  "log/note": ({ kind, detail }) => {
    note(kind, detail);
    return { ok: true };
  },

  "log/read": ({ limit }) => ({ rows: log.slice(-(limit ?? 60)) }),

  "cm/play": async (req) => {
    // The chat tab's MAIN bridge encodes and pushes into the chat's own
    // CM websocket; we only route. No tab, no trick — the chat must be open.
    const tabs = await chrome.tabs.query({ url: CHAT_TAB_PATTERNS });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      try {
        const reply = (await chrome.tabs.sendMessage(tab.id, { __cmrelay: true, payload: req })) as
          | { ok?: boolean; note?: string; extVersion?: string }
          | undefined;
        // A chat tab opened before the last extension update still runs the
        // OLD content script - it would send old bytes while we believe the
        // opposite. Refuse to route through an orphaned relay (an unversioned
        // relay predates the handshake, so it is orphaned by definition).
        if (reply && reply.extVersion !== chrome.runtime.getManifest().version) {
          return { ok: false, error: "вкладка чата старая - обнови её (F5)" };
        }
        if (reply && reply.ok) return { ok: true, sent: true, note: reply.note };
        // The chat answered and said "Steam does not see it" — that is an
        // answer, not a missing tab. Carry the receipt, do not swallow it.
        if (reply && reply.ok === false) return { ok: false, sent: true, note: reply.note };
      } catch {
        /* a chat tab without our content script (or asleep) — try the next */
      }
    }
    return { ok: false, error: "чат не отвечает — открой steamcommunity.com/chat и обнови его" };
  },
  "cm/capture": async (req) => {
    const key = "cmCaptured";
    const prev = await chrome.storage.local.get(key);
    const list: unknown[] = Array.isArray(prev[key]) ? (prev[key] as unknown[]) : [];
    list.push({ ...req });
    while (list.length > 24) list.shift();
    // storage.local survives service-worker restarts, and Edge keeps it in a
    // leveldb we can read from disk — the golden-bytes loop depends on that.
    await chrome.storage.local.set({ [key]: list });
    return { ok: true };
  },
  "farm/open": async () => {
    // Bring a chat tab up on the farm hash. Nothing is seeded any more: the
    // factory farms every game the badge scan says still owes cards, so there
    // is no queue to plant here.
    const tabs = await chrome.tabs.query({ url: CHAT_TAB_PATTERNS });
    const first = tabs.find((t) => t.id !== undefined);
    if (first) {
      // Keep the tab's own path and change only the hash: navigating an open
      // /chat to /chat/ is a full reload, which drops the CM socket and with
      // it the claim the factory was holding. A hash change just opens the
      // section (the farm listens for hashchange).
      const base = (first.url ?? "").split("#")[0] || "https://steamcommunity.com/chat/";
      await chrome.tabs.update(first.id!, { url: `${base}#stw-farm`, active: true });
    } else {
      await chrome.tabs.create({ url: "https://steamcommunity.com/chat/#stw-farm" });
    }
    return { ok: true };
  },
  "cm/golden": async () => {
    const prev = await chrome.storage.local.get("cmCaptured");
    const list = Array.isArray(prev.cmCaptured)
      ? (prev.cmCaptured as { bytes: number[]; mine: boolean; at: number }[])
      : [];
    return { frames: list.slice(-8) };
  },
};

/**
 * Where the CM socket lives: the chat client itself.
 *
 * The patterns end in `/chat*`, not `/chat/*`: Steam's own links land on
 * `steamcommunity.com/chat` with no trailing slash, and a `/chat/*` query
 * misses that tab entirely — so «открыть фабрику» opened a SECOND chat tab
 * beside the working one, and every duplicate is another ghost that can grab
 * the farm lease.
 */
const CHAT_TAB_PATTERNS = ["https://steamcommunity.com/chat*", "https://steamcommunity.com/family*"];

serve(handlers);

chrome.runtime.onInstalled.addListener(() => {
  void cache.sweep();
  // Content scripts orphaned by an extension update are dead code that
  // throws "Extension context invalidated" on every call - and the user
  // never sees the new UI until F5. Steam pages hold no state worth losing;
  // reload them ourselves.
  void chrome.tabs
    .query({ url: "https://steamcommunity.com/*" })
    .then((tabs) => tabs.forEach((tab) => tab.id != null && chrome.tabs.reload(tab.id).catch(() => {})))
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  void cache.sweep();
});
