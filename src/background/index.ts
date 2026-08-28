import { serve, type Handlers, type LogRow } from "../core/messaging";
import * as cache from "./cache";
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

  "log/note": ({ kind, detail }) => {
    note(kind, detail);
    return { ok: true };
  },

  "log/read": ({ limit }) => ({ rows: log.slice(-(limit ?? 60)) }),
};

serve(handlers);

chrome.runtime.onInstalled.addListener(() => {
  void cache.sweep();
});

chrome.runtime.onStartup.addListener(() => {
  void cache.sweep();
});
