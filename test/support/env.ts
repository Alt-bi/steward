/**
 * Minimal browser-extension environment for node tests.
 *
 * Imported for its side effects and must be imported before anything from `src`:
 * the Steam modules attach a `window` message listener at module scope.
 */

import * as scheduler from "../../src/background/scheduler";
import type { Envelope, NetKind, Protocol } from "../../src/core/messaging";

/**
 * `url` + `redirected` exist because `fetch` follows a 302 in silence: a
 * redirected answer and a refusal arrive as the same HTML, and only these two
 * fields tell them apart. `Response` makes both read-only, so the shim writes
 * them on afterwards.
 */
type Reply = {
  status: number;
  body: string;
  headers?: Record<string, string>;
  url?: string;
  redirected?: boolean;
};
type SteamHandler = (url: string, init?: RequestInit) => Reply;
type Slot = Protocol["net/acquire"]["res"];

const jsonReply = (value: unknown): Reply => ({ status: 200, body: JSON.stringify(value) });

let steam: SteamHandler = () => jsonReply({ success: true });
let acquireOverride: ((kind: NetKind) => Slot) | null = null;

export const calls: string[] = [];
export const reports: { kind: NetKind; outcome: string; detail?: string }[] = [];

const sessionStore: Record<string, unknown> = {};
let localStore: Record<string, unknown> = {};
const priceCache = new Map<string, { cents: number; expires: number }>();
const namingStore = new Map<string, string>();

export function setSteam(handler: SteamHandler): void {
  steam = handler;
}

export { jsonReply };

/** Replaces the scheduler for tests that care about the caller, not the pacing. */
export function setAcquire(fn: ((kind: NetKind) => Slot) | null): void {
  acquireOverride = fn;
}

/** Grants `n` requests, then reports the circuit breaker as open. */
export function grantThenBlock(n: number): void {
  let left = n;
  setAcquire(() => (left-- > 0 ? { ok: true } : { ok: false, waitMs: 0, reason: "blocked" }));
}

export function seedCache(key: string, cents: number, ttlMs = 60_000): void {
  priceCache.set(key, { cents, expires: Date.now() + ttlMs });
}

export function cacheSize(): number {
  return priceCache.size;
}

/** Plants a group id a previous run would have learned. */
export function seedNaming(hash: string, groupId: string): void {
  namingStore.set(hash, groupId);
}

/** What the store holds now, for assertions. */
export function namingFacts(): Record<string, string> {
  return Object.fromEntries(namingStore);
}

/** Puts a value where a previous worker would have left it. */
export function seedSession(key: string, value: unknown): void {
  sessionStore[key] = value;
}

export function setLocalSettings(values: Record<string, unknown>): void {
  localStore = { ...values };
}

export async function resetEnv(): Promise<void> {
  calls.length = 0;
  reports.length = 0;
  postedToPage.length = 0;
  priceCache.clear();
  namingStore.clear();
  localStore = {};
  for (const key of Object.keys(sessionStore)) delete sessionStore[key];
  acquireOverride = null;
  steam = () => jsonReply({ success: true });
  await scheduler.reset();
}

async function dispatch(message: Envelope): Promise<unknown> {
  switch (message.type) {
    case "net/acquire": {
      const { kind } = message.payload as Protocol["net/acquire"]["req"];
      return acquireOverride ? acquireOverride(kind) : await scheduler.acquire(kind);
    }
    case "net/report": {
      const p = message.payload as Protocol["net/report"]["req"];
      reports.push({ kind: p.kind, outcome: p.outcome, detail: p.detail });
      await scheduler.report(p.kind, p.outcome, p.retryAfterMs);
      return { ok: true };
    }
    case "net/stats":
      return await scheduler.stats();
    case "net/unblock":
      await scheduler.unblock();
      return { ok: true };
    case "net/reset":
      await scheduler.reset();
      return { ok: true };
    case "cache/get": {
      const { keys } = message.payload as Protocol["cache/get"]["req"];
      const hits: Record<string, number | null> = {};
      const now = Date.now();
      for (const key of keys) {
        const row = priceCache.get(key);
        hits[key] = row && row.expires > now ? row.cents : null;
      }
      return { hits };
    }
    case "cache/set": {
      const { entries } = message.payload as Protocol["cache/set"]["req"];
      const now = Date.now();
      for (const e of entries) {
        priceCache.set(e.key, { cents: e.cents, expires: now + (e.ttlMs ?? 60_000) });
      }
      return { ok: true };
    }
    case "cache/clear":
      priceCache.clear();
      return { ok: true };
    case "naming/get": {
      const { keys } = message.payload as Protocol["naming/get"]["req"];
      const hits: Record<string, string | null> = {};
      for (const key of keys) hits[key] = namingStore.get(key) ?? null;
      return { hits };
    }
    case "naming/set": {
      const { entries } = message.payload as Protocol["naming/set"]["req"];
      for (const e of entries) namingStore.set(e.hash, e.groupId);
      return { ok: true };
    }
    case "naming/drop": {
      const { keys } = message.payload as Protocol["naming/drop"]["req"];
      for (const key of keys) namingStore.delete(key);
      return { ok: true };
    }
    case "log/note":
      return { ok: true };
    case "log/read":
      return { rows: [] };
    default:
      throw new Error(`unhandled message ${String(message.type)}`);
  }
}

const g = globalThis as unknown as Record<string, unknown>;

/**
 * A real enough message bus: the Steam modules listen on `window` for what the
 * MAIN-world bridges post, and that handoff is worth testing.
 */
type MessageHandler = (event: { source: unknown; data: unknown }) => void;
const messageHandlers = new Set<MessageHandler>();

/** Delivers a payload as if a page-world bridge had posted it. */
export function postFromPage(data: unknown): void {
  for (const handler of [...messageHandlers]) handler({ source: globalThis, data });
}

export const postedToPage: unknown[] = [];

g.window = globalThis;
g.addEventListener = (type: string, handler: MessageHandler) => {
  if (type === "message") messageHandlers.add(handler);
};
g.removeEventListener = (type: string, handler: MessageHandler) => {
  if (type === "message") messageHandlers.delete(handler);
};
g.postMessage = (data: unknown) => {
  postedToPage.push(data);
};
g.document = {
  cookie: "",
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: { innerHTML: "" },
  body: { innerHTML: "" },
};

g.chrome = {
  runtime: {
    sendMessage: (message: Envelope) => dispatch(message),
    onMessage: { addListener: () => {} },
    getManifest: () => ({ version: "0.0-test" }),
  },
  storage: {
    session: {
      get: async (key: string | string[]) => {
        /**
         * A real `chrome.storage` read crosses a process boundary and lands on a
         * later turn of the loop, never on the next microtask. A stub that answers
         * instantly hides every «who else ran while we were loading» bug, which is
         * the whole class the scheduler's hydration belongs to.
         */
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (Array.isArray(key)) {
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = sessionStore[k];
          return out;
        }
        return { [key]: sessionStore[key] };
      },
      set: async (obj: Record<string, unknown>) => {
        Object.assign(sessionStore, obj);
      },
    },
    local: {
      get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...localStore }),
      set: async (obj: Record<string, unknown>) => {
        Object.assign(localStore, obj);
      },
    },
  },
};

g.fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  calls.push(url);
  const reply = steam(url, init);
  const res = new Response(reply.body, { status: reply.status, headers: reply.headers });
  Object.defineProperty(res, "url", { value: reply.url ?? url });
  Object.defineProperty(res, "redirected", { value: reply.redirected === true });
  return res;
};

export { scheduler };
