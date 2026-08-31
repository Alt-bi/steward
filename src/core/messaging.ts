/**
 * Typed RPC between content scripts / popup and the service worker.
 *
 * Requests are short-lived on purpose: the scheduler answers "not yet, wait N ms"
 * instead of holding a response open, so a service worker that gets evicted
 * mid-wait costs nothing.
 */

/** Request classes the scheduler budgets independently. */
export type NetKind =
  | "price"
  | "search"
  | "listings"
  | "history"
  | "mylistings"
  | "inventory"
  | "description"
  | "write";

export type NetOutcome = "ok" | "rate_limited" | "empty" | "error";

export interface KindBudget {
  /** Whole requests available right now. */
  tokens: number;
  /** Current adaptive allowance. */
  ratePerMin: number;
  /** How large a burst this kind may spend at once. */
  capacity: number;
}

export interface NetStats {
  ok: number;
  hits429: number;
  hitsEmpty: number;
  /** 429s since the last success. Non-zero means Steam is actively refusing us. */
  consecutive429: number;
  /** Set once the refusals stop looking like a blip. Nothing runs until it is cleared. */
  blocked: boolean;
  cooldownMsLeft: number;
  budget: Record<NetKind, KindBudget>;
  /** Shared IP allowance sitting on top of the per-endpoint buckets. */
  global: KindBudget;
}

export interface LogRow {
  t: number;
  kind: string;
  detail: string;
}

export interface CacheEntry {
  key: string;
  cents: number;
  ttlMs?: number;
}

/** A learned internal name for the listing book: item hash → Steam group id. */
export interface GroupEntry {
  hash: string;
  appid: number;
  groupId: string;
}

export interface Protocol {
  "net/acquire": {
    req: { kind: NetKind };
    res: { ok: true } | { ok: false; waitMs: number; reason: "cooldown" | "budget" | "blocked" };
  };
  "net/report": {
    req: { kind: NetKind; outcome: NetOutcome; retryAfterMs?: number; detail?: string };
    res: { ok: true };
  };
  "net/stats": { req: Record<string, never>; res: NetStats };
  "net/reset": { req: Record<string, never>; res: { ok: true } };
  /** Clears the circuit breaker so a new attempt may start, keeping the learned rates. */
  "net/unblock": { req: Record<string, never>; res: { ok: true } };
  "cache/get": { req: { keys: string[] }; res: { hits: Record<string, number | null> } };
  "cache/set": { req: { entries: CacheEntry[] }; res: { ok: true } };
  "cache/clear": { req: Record<string, never>; res: { ok: true } };
  /** Learned internal names for the listing book, kept without TTL. */
  "naming/get": { req: { keys: string[] }; res: { hits: Record<string, string | null> } };
  "naming/set": { req: { entries: GroupEntry[] }; res: { ok: true } };
  "naming/drop": { req: { keys: string[] }; res: { ok: true } };
  "log/note": { req: { kind: string; detail: string }; res: { ok: true } };
  "log/read": { req: { limit?: number }; res: { rows: LogRow[] } };
}

export type MsgType = keyof Protocol;

export interface Envelope<K extends MsgType = MsgType> {
  __srp: true;
  type: K;
  payload: Protocol[K]["req"];
}

export function isEnvelope(v: unknown): v is Envelope {
  return typeof v === "object" && v !== null && (v as { __srp?: unknown }).__srp === true;
}

export async function send<K extends MsgType>(
  type: K,
  payload: Protocol[K]["req"]
): Promise<Protocol[K]["res"]> {
  const envelope: Envelope<K> = { __srp: true, type, payload };
  return (await chrome.runtime.sendMessage(envelope)) as Protocol[K]["res"];
}

export type Handlers = {
  [K in MsgType]: (payload: Protocol[K]["req"]) => Promise<Protocol[K]["res"]> | Protocol[K]["res"];
};

/** Wires handlers onto chrome.runtime.onMessage, keeping the async response channel open. */
export function serve(handlers: Handlers): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isEnvelope(message)) return false;
    const handler = handlers[message.type] as
      | ((p: unknown) => Promise<unknown> | unknown)
      | undefined;
    if (!handler) return false;
    void (async () => {
      try {
        sendResponse(await handler(message.payload));
      } catch (err) {
        sendResponse({ __error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  });
}
