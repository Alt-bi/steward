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

  /**
   * The ASF round-trip runs HERE, in the worker: the badges page has no CORS
   * dealings with a local bot, and ASF answers no preflight anyway. Loopback
   * only per manifest; the password rides the query per ASF's middleware and
   * never touches storage beyond this call.
   */
  "asf/exec": async ({ url, password, command }) => {
    const endpoint = `${url.replace(/\/+$/, "")}/Api/Command${password ? `?password=${encodeURIComponent(password)}` : ""}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Command: command }),
        signal: ac.signal,
      });
      const text = await res.text();
      let body: { Success?: boolean; Message?: string | null; Result?: string } = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        return { ok: false, error: `ASF ответил не-JSON (${res.status})` };
      }
      if (res.status === 401) return { ok: false, error: "ASF требует IPC-пароль" };
      if (res.status === 403) return { ok: false, error: "403: ASF пустит только loopback или с паролем" };
      if (body.Success === false) return { ok: false, error: body.Message || `HTTP ${res.status}` };
      if (!res.ok && body.Success === undefined) return { ok: false, error: `HTTP ${res.status}` };
      note("asf", `${command} ok`);
      return { ok: true, value: body.Result, message: body.Message };
    } catch (err) {
      const why = err instanceof Error && err.name === "AbortError" ? "таймаут" : String(err);
      return { ok: false, error: `ASF не отвечает (${why})` };
    } finally {
      clearTimeout(timer);
    }
  },
  "cm/play": async (req) => {
    // The chat tab's MAIN bridge encodes and pushes into the chat's own
    // CM websocket; we only route. No tab, no trick — the chat must be open.
    const tabs = await chrome.tabs.query({ url: CHAT_TAB_PATTERNS });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      try {
        const reply = (await chrome.tabs.sendMessage(tab.id, { __cmrelay: true, payload: req })) as
          | { ok?: boolean; note?: string }
          | undefined;
        if (reply && reply.ok) return { ok: true, sent: true, note: reply.note };
      } catch {
        /* a chat tab without our content script (or asleep) — try the next */
      }
    }
    return { ok: false, error: "чат не отвечает — открой steamcommunity.com/chat и обнови его" };
  },
  "cm/capture": async (req) => {
    const key = "cmCaptured";
    const prev = await chrome.storage.session.get(key);
    const list: unknown[] = Array.isArray(prev[key]) ? (prev[key] as unknown[]) : [];
    list.push({ ...req });
    while (list.length > 8) list.shift();
    await chrome.storage.session.set({ [key]: list });
    return { ok: true };
  },
  "cm/golden": async () => {
    const prev = await chrome.storage.session.get("cmCaptured");
    const list = Array.isArray(prev.cmCaptured)
      ? (prev.cmCaptured as { bytes: number[]; mine: boolean; at: number }[])
      : [];
    return { frames: list.slice(-8) };
  },
};

/** Where the CM socket lives: the chat client itself. */
const CHAT_TAB_PATTERNS = ["https://steamcommunity.com/chat/*", "https://steamcommunity.com/family/*"];

serve(handlers);

chrome.runtime.onInstalled.addListener(() => {
  void cache.sweep();
});

chrome.runtime.onStartup.addListener(() => {
  void cache.sweep();
});
