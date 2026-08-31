import type { NetKind, NetOutcome, NetStats } from "../core/messaging";

/**
 * The single rate governor for the whole browser.
 *
 * Steam does not meter a minimum spacing between calls, it meters how many arrive
 * in a window. Modelling it as a fixed inter-request gap was wrong twice over: it
 * paused before the first request even though nothing had been spent yet, and once
 * a refusal widened the gap, every later request paid the penalty. A token bucket
 * spends a burst immediately and only paces once the budget is actually gone.
 *
 * The service worker is single-threaded, which is what makes `acquire` safe with
 * no lock across tabs.
 */

interface Budget {
  /** Requests per minute we aim for when nothing is going wrong. */
  ratePerMin: number;
  /** How much may be spent back-to-back before pacing starts. */
  capacity: number;
  /** Never pace slower than this, or a scan would never finish. */
  minRatePerMin: number;
}

/**
 * Per-endpoint ceilings. They exist so a sell loop cannot steal the price budget,
 * but they are not the real limiter: Steam meters the IP, not the path.
 *
 * Numbers sit below SIH's 20 priceoverview/min and well below a 18+40 combined
 * burst — the user's Steam client and other tabs share the same IPv4 quota.
 */
const LIMITS: Record<NetKind, Budget> = {
  price: { ratePerMin: 15, capacity: 4, minRatePerMin: 3 },
  search: { ratePerMin: 20, capacity: 4, minRatePerMin: 4 },
  listings: { ratePerMin: 10, capacity: 2, minRatePerMin: 3 },
  history: { ratePerMin: 6, capacity: 1, minRatePerMin: 2 },
  /**
   * One call per scan for a small account, and since 2.23.0 a walk of up to
   * eight pages for a big one. 6/min made a 727-lot walk crawl for 80 seconds
   * of waiting — the same shape is used by `listings`, which always sits at
   * 10/min, and Steam meters the IP, not the path.
   */
  mylistings: { ratePerMin: 10, capacity: 3, minRatePerMin: 3 },
  inventory: { ratePerMin: 10, capacity: 2, minRatePerMin: 3 },
  /** Item classes never change, so every one of these is paid for exactly once. */
  description: { ratePerMin: 20, capacity: 5, minRatePerMin: 4 },
  write: { ratePerMin: 8, capacity: 1, minRatePerMin: 2 },
};

/** Shared IP budget wrapping every kind. */
const GLOBAL: Budget = { ratePerMin: 20, capacity: 6, minRatePerMin: 4 };

interface KindState {
  tokens: number;
  lastRefill: number;
  /** Current adaptive rate; walks down on refusals and back up on success. */
  ratePerMin: number;
  okStreak: number;
}

interface State {
  kinds: Record<NetKind, KindState>;
  global: KindState;
  cooldownUntil: number;
  hits429: number;
  hitsEmpty: number;
  ok: number;
  emptyStreak: number;
  consecutive429: number;
  blocked: boolean;
}

const COOLDOWN_CAP = 90_000;

/** First 429 waits this long when Steam sent no Retry-After. SIH uses 30s. */
const BASE_COOLDOWN_MS = 30_000;

/**
 * One 429 is enough. Waiting out a cooldown and then sending the remaining 700
 * prices is how a 30-second microban becomes hours: Steam refreshes the IP block
 * on every hit during it.
 */
const BLOCK_AFTER = 1;

/** Successes before the rate creeps back up. */
const RELAX_AFTER = 8;
const RELAX_STEP = 2;

const SESSION_KEY = "stwScheduler";
const LEGACY_SESSION_KEY = "srpScheduler";
const KINDS = Object.keys(LIMITS) as NetKind[];

function kindState(budget: Budget): KindState {
  return {
    tokens: budget.capacity,
    lastRefill: 0,
    ratePerMin: budget.ratePerMin,
    okStreak: 0,
  };
}

function fresh(): State {
  const kinds = {} as Record<NetKind, KindState>;
  for (const kind of KINDS) kinds[kind] = kindState(LIMITS[kind]);
  return {
    kinds,
    global: kindState(GLOBAL),
    cooldownUntil: 0,
    hits429: 0,
    hitsEmpty: 0,
    ok: 0,
    emptyStreak: 0,
    consecutive429: 0,
    blocked: false,
  };
}

let state: State = fresh();
/**
 * The one load this worker performs, kept as the promise rather than as a flag.
 *
 * A flag was set before the read finished, so every caller that arrived in the
 * same tick — a content script wakes the worker with a burst, which is the normal
 * case — sailed past it and spent a fresh, empty budget while the cooldown the
 * previous worker had recorded was still being read off the disk. Six requests
 * into a live ban, which is precisely how a thirty-second pause becomes hours.
 */
let hydrating: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A killed service worker must not forget an active cooldown or a spent budget,
 * or the next tab would walk straight back into the limit.
 */
function hydrate(): Promise<void> {
  return (hydrating ??= load());
}

async function load(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get([SESSION_KEY, LEGACY_SESSION_KEY]);
    const saved = (stored[SESSION_KEY] ?? stored[LEGACY_SESSION_KEY]) as State | undefined;
    if (!saved?.kinds) return;
    const base = fresh();
    state = { ...base, ...saved, kinds: { ...base.kinds, ...saved.kinds }, global: saved.global ?? base.global };
    /** A kind added in a later version must not come back undefined. */
    for (const kind of KINDS) state.kinds[kind] ??= base.kinds[kind];
    state.global ??= base.global;
  } catch {
    /* session storage is best-effort */
  }
}

function persist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void chrome.storage.session.set({ [SESSION_KEY]: state }).catch(() => {});
  }, 250);
}

function refillBucket(k: KindState, limit: Budget, now: number): KindState {
  if (!k.lastRefill) {
    k.lastRefill = now;
    return k;
  }
  const elapsed = Math.max(0, now - k.lastRefill);
  if (elapsed > 0) {
    k.tokens = Math.min(limit.capacity, k.tokens + (elapsed / 60_000) * k.ratePerMin);
    k.lastRefill = now;
  }
  return k;
}

function waitForToken(k: KindState): number {
  if (k.tokens >= 1) return 0;
  return Math.ceil(((1 - k.tokens) * 60_000) / Math.max(1, k.ratePerMin));
}

export type Slot =
  | { ok: true }
  | { ok: false; waitMs: number; reason: "cooldown" | "budget" | "blocked" };

export async function acquire(kind: NetKind): Promise<Slot> {
  await hydrate();
  const now = Date.now();

  if (state.blocked) {
    return { ok: false, waitMs: Math.max(0, state.cooldownUntil - now), reason: "blocked" };
  }
  if (now < state.cooldownUntil) {
    return { ok: false, waitMs: state.cooldownUntil - now, reason: "cooldown" };
  }

  const k = refillBucket(state.kinds[kind], LIMITS[kind], now);
  const g = refillBucket(state.global, GLOBAL, now);
  if (k.tokens >= 1 && g.tokens >= 1) {
    k.tokens -= 1;
    g.tokens -= 1;
    persist();
    return { ok: true };
  }

  /** Time until both the kind and the IP budget have a token. */
  const waitMs = Math.max(waitForToken(k), waitForToken(g));
  persist();
  return { ok: false, waitMs, reason: "budget" };
}

export async function report(
  kind: NetKind,
  outcome: NetOutcome,
  retryAfterMs?: number
): Promise<void> {
  await hydrate();
  const limit = LIMITS[kind];
  const k = state.kinds[kind];
  const now = Date.now();

  switch (outcome) {
    case "ok": {
      state.ok += 1;
      state.emptyStreak = 0;
      state.consecutive429 = 0;
      k.okStreak += 1;
      state.global.okStreak += 1;
      if (k.okStreak >= RELAX_AFTER) {
        k.okStreak = 0;
        k.ratePerMin = Math.min(limit.ratePerMin, k.ratePerMin + RELAX_STEP);
        if (state.hits429 > 0) state.hits429 -= 1;
      }
      if (state.global.okStreak >= RELAX_AFTER) {
        state.global.okStreak = 0;
        state.global.ratePerMin = Math.min(GLOBAL.ratePerMin, state.global.ratePerMin + RELAX_STEP);
      }
      break;
    }

    case "rate_limited": {
      state.hits429 += 1;
      state.consecutive429 += 1;
      k.okStreak = 0;
      state.global.okStreak = 0;
      /** Multiplicative decrease on the rate, and the burst is spent. */
      k.ratePerMin = Math.max(limit.minRatePerMin, Math.floor(k.ratePerMin / 2));
      k.tokens = 0;
      k.lastRefill = now;
      state.global.ratePerMin = Math.max(GLOBAL.minRatePerMin, Math.floor(state.global.ratePerMin / 2));
      state.global.tokens = 0;
      state.global.lastRefill = now;
      const backoff =
        retryAfterMs && retryAfterMs > 0
          ? retryAfterMs
          : Math.min(COOLDOWN_CAP, BASE_COOLDOWN_MS + 5_000 * Math.min(state.hits429 - 1, 8));
      state.cooldownUntil = Math.max(state.cooldownUntil, now + backoff);
      if (state.consecutive429 >= BLOCK_AFTER) state.blocked = true;
      break;
    }

    /**
     * `success:false` with HTTP 200 is Steam's soft throttle. A streak means a real
     * limit; one-offs are normal, since delisted items answer exactly the same way.
     *
     * Except on `search`, where «found nothing» is the endpoint doing its job.
     * Community items hash as `296830-:CoffeeBreak:` and simply are not findable by
     * name, so a run of misses is routine — and counting it as a ban blocked whole
     * scans that Steam had never refused. Search has its own guard for this: the
     * price scanner drops search after a sample of groups misses (`prices.ts`).
     */
    case "empty":
      state.hitsEmpty += 1;
      if (kind === "search") break;
      state.emptyStreak += 1;
      if (state.emptyStreak >= 4) {
        state.emptyStreak = 0;
        k.ratePerMin = Math.max(limit.minRatePerMin, Math.floor(k.ratePerMin * 0.75));
        state.global.ratePerMin = Math.max(GLOBAL.minRatePerMin, Math.floor(state.global.ratePerMin * 0.75));
        state.cooldownUntil = Math.max(state.cooldownUntil, now + BASE_COOLDOWN_MS);
        /** Same as a 429: stop the scan. Four success:false in a row is a throttle. */
        state.blocked = true;
      }
      break;

    case "error":
      break;
  }
  persist();
}

function snapshot(k: KindState, limit: Budget, now: number): { tokens: number; ratePerMin: number; capacity: number } {
  const elapsed = k.lastRefill ? Math.max(0, now - k.lastRefill) : 0;
  const tokens = Math.min(limit.capacity, k.tokens + (elapsed / 60_000) * k.ratePerMin);
  return { tokens: Math.floor(tokens), ratePerMin: k.ratePerMin, capacity: limit.capacity };
}

export async function stats(): Promise<NetStats> {
  await hydrate();
  const now = Date.now();
  const budget = {} as Record<NetKind, { tokens: number; ratePerMin: number; capacity: number }>;
  for (const kind of KINDS) budget[kind] = snapshot(state.kinds[kind], LIMITS[kind], now);
  return {
    ok: state.ok,
    hits429: state.hits429,
    hitsEmpty: state.hitsEmpty,
    consecutive429: state.consecutive429,
    blocked: state.blocked,
    cooldownMsLeft: Math.max(0, state.cooldownUntil - now),
    budget,
    global: snapshot(state.global, GLOBAL, now),
  };
}

/**
 * Lets a new attempt start after a block. The learned rates stay — the point is to
 * retry more carefully than last time, not to forget what Steam told us.
 */
export async function unblock(): Promise<void> {
  await hydrate();
  state.blocked = false;
  state.consecutive429 = 0;
  state.emptyStreak = 0;
  persist();
}

export async function reset(): Promise<void> {
  state = fresh();
  hydrating = Promise.resolve();
  persist();
}

/**
 * Drops the in-memory copy so the next call loads it from session storage again.
 *
 * This is what a killed service worker does, and it is the only way to reach the
 * hydration path from a test — every other entry point marks the state loaded, so
 * the code that runs on every single worker wake-up had never once been exercised.
 */
export function forget(): void {
  hydrating = null;
  state = fresh();
}
