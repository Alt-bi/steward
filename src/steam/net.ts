import { send, type NetKind, type NetOutcome } from "../core/messaging";

export type ErrorKind =
  | "blocked"
  | "rate_limited"
  | "not_logged_in"
  | "not_json"
  | "bad_json"
  | "empty"
  | "http"
  /** The request never came back. Unlike every other kind, what Steam did with
   *  it is unknown — which for a write is a different fact from «it failed». */
  | "network"
  | "aborted";

export class SteamError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  /**
   * What a rejected answer actually looked like, for the one kind where the
   * shape is the whole story. `not_json` says only "markup where JSON belongs";
   * whether that markup is a sorry-page, an age wall or a robot check is a
   * different diagnosis with a different cure, and guessing it from here is
   * how three reports in a row got three different theories.
   */
  readonly note?: string;

  constructor(
    kind: ErrorKind,
    message?: string,
    extra?: { status?: number; retryAfterMs?: number; note?: string }
  ) {
    super(message ?? kind);
    this.name = "SteamError";
    this.kind = kind;
    this.status = extra?.status;
    this.retryAfterMs = extra?.retryAfterMs;
    this.note = extra?.note;
  }
}

/**
 * The shortest honest description of an unexpected page: its title, or the head
 * of its text if it has none. One line, safe to put in front of the user.
 */
export function markupNote(text: string, maxLen = 80): string {
  const raw = String(text ?? "");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1];
  const body =
    (title ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim() ||
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const clipped = body.length > maxLen ? `${body.slice(0, maxLen).trimEnd()}…` : body;
  return clipped || "пустой ответ";
}

/**
 * Steam's IP limiter often answers HTTP 200 with an HTML sorry-page, not 429.
 * Treating that as `not_json` used to skip the cooldown and retry into a longer ban.
 *
 * The page comes in the interface language of the session, and the Russian copy
 * does not contain «сделали»: the market says «слишком много запросов», the
 * community pages «Слишком много запросов с вашего IP-адреса». Match on stems
 * that survive any phrasing of the apology, or the ban reads as markup noise
 * and the exact-check pass will tell the user the endpoint died.
 */
const RATE_LIMIT_BODY =
  /too many requests|try (?:your request|sending a request) again later|слишком много запросов|превышен(а|о) (?:лимит|частота)/i;

export function isSteamRateLimitBody(text: string): boolean {
  return RATE_LIMIT_BODY.test(String(text ?? ""));
}

export function isRateLimitStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503;
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
    const slice = Math.max(50, Math.min(waitMs, 1000));
    await sleep(slice);
  }
}

/**
 * Whether we may talk to Steam right now.
 *
 * A cooldown or an open breaker means "do not send". Clicking «Догрузить» used to
 * unblock and immediately fire hundreds of requests into a live ban, which is how
 * a 30-second pause becomes hours. If the pause has expired we lift the breaker
 * once so a single retry can probe; the next 429 closes it again.
 */
export async function allowSteamTraffic(): Promise<string | null> {
  try {
    const stats = await send("net/stats", {});
    if (stats.cooldownMsLeft > 0) {
      const secs = Math.ceil(stats.cooldownMsLeft / 1000);
      return (
        `Steam ещё держит паузу ${secs}с. Не стучимся: каждый запрос во время бана удлиняет его. ` +
        `IP-бан бывает на часы. Когда маркет в этой вкладке открывается сам — можно жать снова.`
      );
    }
    if (stats.blocked) await send("net/unblock", {});
  } catch {
    /* worker missing: let the caller try */
  }
  return null;
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
  /**
   * Skip to wherever the value actually starts — and an array is a value.
   *
   * Hunting for `{` alone tore the opening bracket off any top-level array and
   * then reported Steam's perfectly good answer as `bad_json`. Nothing we read
   * today answers with one; the point is that the next endpoint that does must
   * fail for a real reason, not because the junk-stripper only knows one shape.
   */
  const starts = [body.indexOf("{"), body.indexOf("[")].filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start > 0) body = body.slice(start);
  return JSON.parse(body) as T;
}

export interface FetchOptions extends Pacing {
  kind: NetKind;
  init?: RequestInit;
  /** Marks a 200 response as a soft throttle so the governor can back off. */
  isEmpty?: (data: unknown) => boolean;
  /**
   * Whether to sign the request the way the classic pages did (`X-Requested-With`
   * and friends). The rewritten market answers its own actions differently: a
   * logged-in session sending the legacy signature is served the market
   * homepage as markup, while the page's own fetch — which carries only
   * `x-valve-request-type` — gets JSON. Callers chasing an endpoint the new
   * frontend owns set this false and hand over the headers verbatim.
   */
  ajax?: boolean;
}

/**
 * Everything both readers share: the slot, the request, and the ways Steam says
 * no without saying no. Nothing here reports a success — the caller decides that,
 * because a 200 carrying an empty payload is a throttle, not an answer.
 */
async function fetchRaw(url: string, opts: FetchOptions & { html?: boolean }): Promise<string> {
  await waitForSlot(opts.kind, opts);

  let res: Response;
  try {
    res = await fetch(url, {
      credentials: "include",
      ...opts.init,
      headers: {
        /**
         * The classic pages' AJAX signature unless the caller opts out. A
         * logged-in session sending it to an endpoint the rewritten frontend
         * owns is served the market homepage as markup; the frontend's own
         * fetch carries only its loader header and gets JSON. Opting out hands
         * over exactly the headers the caller supplies, no more.
         */
        ...(opts.ajax === false ? {} : AJAX_HEADERS),
        ...(opts.init?.headers as Record<string, string> | undefined),
      },
    });
  } catch (err) {
    reportOutcome(opts.kind, "error", err instanceof Error ? err.message : "network");
    throw new SteamError("network", "network_failed");
  }

  if (isRateLimitStatus(res.status)) {
    const retryAfter = Number.parseInt(res.headers.get("Retry-After") ?? "", 10);
    const retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined;
    reportOutcome(opts.kind, "rate_limited", `HTTP ${res.status} ${url}`, retryAfterMs);
    throw new SteamError("rate_limited", `http_${res.status}`, { status: res.status, retryAfterMs });
  }

  const text = await res.text();

  if (isSteamRateLimitBody(text)) {
    reportOutcome(opts.kind, "rate_limited", `html_ban ${url}`);
    throw new SteamError("rate_limited", "html_rate_limit", { status: res.status });
  }

  if (/g_steamID\s*=\s*false/.test(text)) {
    reportOutcome(opts.kind, "error", "not_logged_in");
    throw new SteamError("not_logged_in");
  }
  /** Only a caller expecting JSON can call markup a failure. */
  if (!opts.html && /^\s*<(!DOCTYPE|html)/i.test(text)) {
    /**
     * Reported as a throttle, not as an error.
     *
     * A Steam endpoint that answers a page where JSON belongs is refusing, not
     * failing: measured on 2026-09-01, `QueryListingsForItem` degrades in two
     * steps under a burst — first an empty book, then the market homepage as
     * markup. Filed as a plain error the governor kept the same pace straight
     * into the wall, which is how a scan of ten items got two homepages in
     * three requests. The thrown error stays `not_json`, so callers that read
     * the page's own title still do.
     */
    reportOutcome(opts.kind, "rate_limited", `not_json ${url}`);
    /** The page names itself; carrying that out costs nothing and ends the guessing. */
    throw new SteamError("not_json", undefined, { status: res.status, note: markupNote(text) });
  }

  return text;
}

export async function fetchJson<T>(url: string, opts: FetchOptions): Promise<T> {
  const text = await fetchRaw(url, opts);

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

/**
 * For the endpoints that answer with a script instead of JSON. The caller gets the
 * body and does its own reading; everything about being refused is already handled.
 */
export async function fetchText(url: string, opts: FetchOptions): Promise<string> {
  const text = await fetchRaw(url, { ...opts, html: true });

  if (opts.isEmpty?.(text)) {
    reportOutcome(opts.kind, "empty", url);
    throw new SteamError("empty");
  }

  reportOutcome(opts.kind, "ok");
  return text;
}

function isFatalNetError(err: unknown): boolean {
  return (
    err instanceof SteamError &&
    (err.kind === "not_logged_in" ||
      err.kind === "aborted" ||
      err.kind === "blocked" ||
      err.kind === "rate_limited")
  );
}

export async function fetchJsonRetry<T>(url: string, opts: FetchOptions, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchJson<T>(url, opts);
    } catch (err) {
      last = err;
      /** A ban extends if we keep hitting it. Retrying 429 is how a 30s pause becomes hours. */
      if (isFatalNetError(err)) throw err;
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
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });
  } catch (err) {
    /**
     * The one failure where the caller cannot know what happened. A read that
     * never came back cost nothing; a write that never came back may well have
     * been carried out, and saying «ошибка» about it would be a guess.
     */
    reportOutcome(opts.kind, "error", err instanceof Error ? err.message : "network");
    throw new SteamError("network", "network_failed");
  }
  if (isRateLimitStatus(res.status)) {
    reportOutcome(opts.kind, "rate_limited", `POST ${res.status} ${url}`);
    throw new SteamError("rate_limited", `http_${res.status}`, { status: res.status });
  }
  const text = await res.text();
  if (isSteamRateLimitBody(text)) {
    reportOutcome(opts.kind, "rate_limited", `POST html_ban ${url}`);
    throw new SteamError("rate_limited", "html_rate_limit", { status: res.status });
  }
  /**
   * The same marker `fetchRaw` has always checked, and the writes never did.
   *
   * A session that expires mid-run makes Steam answer a POST with a logged-out
   * page — HTTP 200, no JSON — and every caller here reads an unparseable 200 as
   * «fine». That is the one answer a write must never be given the benefit of the
   * doubt on: it means nothing happened, and the run should stop rather than walk
   * the whole list taking lots off a market it can no longer put them back on.
   */
  if (/g_steamID\s*=\s*false/.test(text)) {
    reportOutcome(opts.kind, "error", "not_logged_in");
    throw new SteamError("not_logged_in");
  }
  reportOutcome(opts.kind, res.ok ? "ok" : "error", res.ok ? undefined : `POST ${res.status} ${url}`);
  return { status: res.status, text };
}
