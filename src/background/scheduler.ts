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
 * `priceoverview` is the tightest of these by a wide margin — it is a metered API,
 * not a page the market UI itself calls. `search` and `listings` are what browsing
 * the market hits normally, so they tolerate a browsing-like rate.
 */
const LIMITS: Record<NetKind, Budget> = {
  price: { ratePerMin: 18, capacity: 18, minRatePerMin: 4 },
  search: { ratePerMin: 40, capacity: 10, minRatePerMin: 6 },
  listings: { ratePerMin: 30, capacity: 8, minRatePerMin: 5 },
  /** Heavier than a listing page and only ever asked for one item at a time. */
  history: { ratePerMin: 15, capacity: 5, minRatePerMin: 3 },
  mylistings: { ratePerMin: 12, capacity: 4, minRatePerMin: 3 },
  inventory: { ratePerMin: 12, capacity: 4, minRatePerMin: 3 },
  write: { ratePerMin: 20, capacity: 2, minRatePerMin: 4 },
};

interface KindState {
  tokens: number;
  lastRefill: number;
  /** Current adaptive rate; walks down on refusals and back up on success. */
  ratePerMin: number;
  okStreak: number;
}

interface State {
  kinds: Record<NetKind, KindState>;
  cooldownUntil: number;
  hits429: number;
  hitsEmpty: number;
  ok: number;
  emptyStreak: number;
  consecutive429: number;
  blocked: boolean;
}

const COOLDOWN_CAP = 90_000;

/** Consecutive refusals that mean "stop asking for now". */
const BLOCK_AFTER = 6;

/** Successes before the rate creeps back up. */
const RELAX_AFTER = 8;
const RELAX_STEP = 2;

const SESSION_KEY = "srpScheduler";
const KINDS = Object.keys(LIMITS) as NetKind[];

function fresh(): State {
  const kinds = {} as Record<NetKind, KindState>;
  for (const kind of KINDS) {
    kinds[kind] = {
      tokens: LIMITS[kind].capacity,
      lastRefill: 0,
      ratePerMin: LIMITS[kind].ratePerMin,
      okStreak: 0,
    };
  }
  return {
    kinds,
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
let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A killed service worker must not forget an active cooldown or a spent budget,
 * or the next tab would walk straight back into the limit.
 */
async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const stored = await chrome.storage.session.get(SESSION_KEY);
    const saved = stored[SESSION_KEY] as State | undefined;
    if (!saved?.kinds) return;
    const base = fresh();
    state = { ...base, ...saved, kinds: { ...base.kinds, ...saved.kinds } };
    /** A kind added in a later version must not come back undefined. */
    for (const kind of KINDS) state.kinds[kind] ??= base.kinds[kind];
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

function refill(kind: NetKind, now: number): KindState {
  const k = state.kinds[kind];
  const limit = LIMITS[kind];
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

  const k = refill(kind, now);
  if (k.tokens >= 1) {
    k.tokens -= 1;
    persist();
    return { ok: true };
  }

  /** Time until one whole token exists again. */
  const waitMs = Math.ceil(((1 - k.tokens) * 60_000) / Math.max(1, k.ratePerMin));
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
      if (k.okStreak >= RELAX_AFTER) {
        k.okStreak = 0;
        k.ratePerMin = Math.min(limit.ratePerMin, k.ratePerMin + RELAX_STEP);
        if (state.hits429 > 0) state.hits429 -= 1;
      }
      break;
    }

    case "rate_limited": {
      state.hits429 += 1;
      state.consecutive429 += 1;
      k.okStreak = 0;
      /** Multiplicative decrease on the rate, and the burst is spent. */
      k.ratePerMin = Math.max(limit.minRatePerMin, Math.floor(k.ratePerMin / 2));
      k.tokens = 0;
      k.lastRefill = now;
      const backoff =
        retryAfterMs && retryAfterMs > 0
          ? retryAfterMs
          : Math.min(COOLDOWN_CAP, 4000 + 2000 * Math.min(state.hits429, 8));
      state.cooldownUntil = Math.max(state.cooldownUntil, now + backoff);
      if (state.consecutive429 >= BLOCK_AFTER) state.blocked = true;
      break;
    }

    /**
     * `success:false` with HTTP 200 is Steam's soft throttle. A streak means a real
     * limit; one-offs are normal, since delisted items answer exactly the same way.
     */
    case "empty":
      state.hitsEmpty += 1;
      state.emptyStreak += 1;
      if (state.emptyStreak >= 4) {
        state.emptyStreak = 0;
        k.ratePerMin = Math.max(limit.minRatePerMin, Math.floor(k.ratePerMin * 0.75));
        state.cooldownUntil = Math.max(state.cooldownUntil, now + 4000);
      }
      break;

    case "error":
      break;
  }
  persist();
}

export async function stats(): Promise<NetStats> {
  await hydrate();
  const now = Date.now();
  const budget = {} as Record<NetKind, { tokens: number; ratePerMin: number; capacity: number }>;
  for (const kind of KINDS) {
    const k = state.kinds[kind];
    const elapsed = k.lastRefill ? Math.max(0, now - k.lastRefill) : 0;
    const tokens = Math.min(LIMITS[kind].capacity, k.tokens + (elapsed / 60_000) * k.ratePerMin);
    budget[kind] = {
      tokens: Math.floor(tokens),
      ratePerMin: k.ratePerMin,
      capacity: LIMITS[kind].capacity,
    };
  }
  return {
    ok: state.ok,
    hits429: state.hits429,
    hitsEmpty: state.hitsEmpty,
    consecutive429: state.consecutive429,
    blocked: state.blocked,
    cooldownMsLeft: Math.max(0, state.cooldownUntil - now),
    budget,
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
  hydrated = true;
  persist();
}
