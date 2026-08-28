import { send, type NetKind, type NetOutcome } from "../core/messaging";

export type ErrorKind =
  | "blocked"
  | "rate_limited"
  | "not_logged_in"
  | "not_json"
  | "bad_json"
  | "empty"
  | "http"
  | "aborted";

export class SteamError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(kind: ErrorKind, message?: string, extra?: { status?: number; retryAfterMs?: number }) {
    super(message ?? kind);
    this.name = "SteamError";
    this.kind = kind;
    this.status = extra?.status;
    this.retryAfterMs = extra?.retryAfterMs;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type WaitReason = "cooldown" | "budget";

export interface Pacing {
  /**
   * Called while the governor holds us back. `budget` means we are pacing
   * ourselves and everything is fine; `cooldown` means Steam pushed back.
   * The UI must not present the two the same way.
   */
  onWait?: (msLeft: number, reason: WaitReason) => void;
  abort?: () => boolean;
}

/**
 * Requests are made from the content script, not the worker: only here do they
 * carry the page's own cookies and Referer, which is what Steam's market
 * endpoints expect. The worker only decides *when* we are allowed to go.
 */
/** Conservative pace to fall back on when the worker cannot be reached at all. */
const ORPHAN_GAP_MS = 600;

async function waitForSlot(kind: NetKind, pacing: Pacing): Promise<void> {
  for (;;) {
    if (pacing.abort?.()) throw new SteamError("aborted");

    let slot: Awaited<ReturnType<typeof send<"net/acquire">>>;
    try {
      slot = await send("net/acquire", { kind });
    } catch {
      /* No worker (evicted, reloading, disabled): pace ourselves rather than spin. */
      await sleep(ORPHAN_GAP_MS);
      return;
    }

    if (slot?.ok === true) return;

    /**
     * Steam has refused us repeatedly. Continuing the loop would only renew the
     * cooldown on every remaining item, which reads to the user as a countdown
     * that restarts forever.
     */
    if (slot && slot.ok === false && slot.reason === "blocked") {
      throw new SteamError("blocked", "steam_is_refusing");
    }

    /** A malformed answer must never become a zero-delay retry loop. */
    const valid = Boolean(slot && slot.ok === false && Number.isFinite(slot.waitMs));
    const waitMs = valid && slot.ok === false ? slot.waitMs : ORPHAN_GAP_MS;
    if (valid && slot.ok === false) {
      pacing.onWait?.(waitMs, slot.reason === "cooldown" ? "cooldown" : "budget");
    }
    await sleep(Math.max(50, Math.min(waitMs, 1000)));
  }
}

function reportOutcome(kind: NetKind, outcome: NetOutcome, detail?: string, retryAfterMs?: number): void {
  void send("net/report", { kind, outcome, detail, retryAfterMs }).catch(() => {});
}

const AJAX_HEADERS: Record<string, string> = {
  "X-Requested-With": "XMLHttpRequest",
  "X-Prototype-Version": "1.7",
  Accept: "application/json, text/javascript;q=0.9, */*;q=0.8",
};

/** Steam prefixes some JSON payloads with anti-JSON-hijacking junk. */
export function decodeJson<T>(text: string): T {
  let body = String(text ?? "").replace(/^\uFEFF/, "");
  body = body.replace(/^\s*for \(;;\);\s*/, "").replace(/^\)\]\}'?,?\s*/, "");
  const brace = body.indexOf("{");
  if (brace > 0) body = body.slice(brace);
  return JSON.parse(body) as T;
}

export interface FetchOptions extends Pacing {
  kind: NetKind;
  init?: RequestInit;
  /** Marks a 200 response as a soft throttle so the governor can back off. */
  isEmpty?: (data: unknown) => boolean;
}

export async function fetchJson<T>(url: string, opts: FetchOptions): Promise<T> {
  await waitForSlot(opts.kind, opts);

  let res: Response;
  try {
    res = await fetch(url, {
      credentials: "include",
      ...opts.init,
      headers: { ...AJAX_HEADERS, ...(opts.init?.headers as Record<string, string> | undefined) },
    });
  } catch (err) {
    reportOutcome(opts.kind, "error", err instanceof Error ? err.message : "network");
    throw new SteamError("http", "network_failed");
  }

  if (res.status === 429 || res.status === 502 || res.status === 503) {
    const retryAfter = Number.parseInt(res.headers.get("Retry-After") ?? "", 10);
    const retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined;
    reportOutcome(opts.kind, "rate_limited", `HTTP ${res.status} ${url}`, retryAfterMs);
    throw new SteamError("rate_limited", `http_${res.status}`, { status: res.status, retryAfterMs });
  }

  const text = await res.text();

  if (/g_steamID\s*=\s*false/.test(text)) {
    reportOutcome(opts.kind, "error", "not_logged_in");
    throw new SteamError("not_logged_in");
  }
  if (/^\s*<(!DOCTYPE|html)/i.test(text)) {
    reportOutcome(opts.kind, "error", `not_json ${url}`);
    throw new SteamError("not_json");
  }

  let data: T;
  try {
    data = decodeJson<T>(text);
  } catch {
    reportOutcome(opts.kind, "error", `bad_json ${url}`);
    throw new SteamError("bad_json");
  }

  if (opts.isEmpty?.(data)) {
    reportOutcome(opts.kind, "empty", url);
    throw new SteamError("empty");
  }

  reportOutcome(opts.kind, "ok");
  return data;
}

export async function fetchJsonRetry<T>(url: string, opts: FetchOptions, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchJson<T>(url, opts);
    } catch (err) {
      last = err;
      if (
        err instanceof SteamError &&
        (err.kind === "not_logged_in" || err.kind === "aborted" || err.kind === "blocked")
      ) {
        throw err;
      }
      if (i < tries - 1) await sleep(600 * (i + 1));
    }
  }
  throw last instanceof Error ? last : new SteamError("http", String(last));
}

/** POSTs return bare text on success sometimes; callers decide what counts as ok. */
export async function postForm(
  url: string,
  body: URLSearchParams,
  opts: Pacing & { kind: NetKind }
): Promise<{ status: number; text: string }> {
  await waitForSlot(opts.kind, opts);
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });
  if (res.status === 429) {
    reportOutcome(opts.kind, "rate_limited", `POST ${url}`);
    throw new SteamError("rate_limited", "http_429", { status: 429 });
  }
  const text = await res.text();
  reportOutcome(opts.kind, res.ok ? "ok" : "error", res.ok ? undefined : `POST ${res.status} ${url}`);
  return { status: res.status, text };
}
