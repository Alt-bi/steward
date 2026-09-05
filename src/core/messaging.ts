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
  | "badges"
  | "write";

/**
 * How one request ended, as the governor needs to hear it.
 *
 * `wrong_shape` is markup where JSON belongs — a refusal by one endpoint, not
 * a limit on the IP. It used to be filed as `rate_limited`, and since one
 * `rate_limited` opens the breaker for every kind, the very first homepage from
 * the listing book switched off the price endpoints that exist to rescue that
 * exact run. Same refusal, different blast radius.
 */
export type NetOutcome = "ok" | "rate_limited" | "wrong_shape" | "empty" | "error";

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
  /**
   * Drive the chat client's CM socket in a chat tab. The worker finds the
   * tab, the tab's MAIN bridge encodes and sends; play/stop is an
   * appid-boolean list so the same shape carries both.
   */
  "cm/play": {
    req: {
      stop: boolean;
      verify?: boolean;
      replay?: number[];
      /** Swap the claimed set without disturbing the keep-alive timer. */
      swap?: boolean;
      entries: { appid: number; playing: boolean; secure: boolean; offline: boolean }[];
    };
    res: { ok: true; sent: boolean; note?: string } | { ok: false; error: string } | { ok: false; sent: true; note?: string };
  };
  /** A MAIN-bridge captured 742 frame (ours or a golden one from another
   * extension's Start press). The worker keeps a small ring in storage. */
  "cm/capture": {
    req: { bytes: number[]; mine: boolean };
    res: { ok: true };
  };
  /** What the capture ring holds right now — the tab reads it to offer replay. */
  "cm/golden": { req: Record<string, never>; res: { frames: { bytes: number[]; mine: boolean; at: number }[] } };
  /** Bring up the farm view in a chat tab. Nothing is seeded: the factory
   * farms everything the badge scan says is owed, so there is no queue to
   * hand it. The farm itself lives on /chat and talks to the MAIN bridge. */
  "farm/open": {
    req: Record<string, never>;
    res: { ok: true } | { ok: false; error: string };
  };
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
