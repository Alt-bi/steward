import "./support/env";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { scheduler, seedSession } from "./support/env";

/**
 * The scheduler is pure decision logic over a clock, so the clock is the only
 * thing that needs faking. Every earlier pacing bug was a time-dependent one.
 */
const realNow = Date.now;
let now = 1_700_000_000_000;

function advance(ms: number): void {
  now += ms;
}

/** Spends slots until the budget refuses, returning how many went through. */
async function spendBurst(kind: "price" | "search"): Promise<number> {
  let granted = 0;
  for (let i = 0; i < 200; i++) {
    const slot = await scheduler.acquire(kind);
    if (!slot.ok) break;
    granted += 1;
  }
  return granted;
}

describe("scheduler", () => {
  beforeEach(async () => {
    now = 1_700_000_000_000;
    Date.now = () => now;
    await scheduler.reset();
  });

  afterEach(() => {
    Date.now = realNow;
  });

  it("lets a burst through before pacing anything", async () => {
    /**
     * The regression that made every single request wait: a fixed gap paused
     * before the first call even though no budget had been spent.
     */
    const first = await scheduler.acquire("price");
    assert.equal(first.ok, true, "the very first request must never wait");

    const granted = 1 + (await spendBurst("price"));
    assert.equal(granted, 4, `price burst is the kind capacity, got ${granted}`);
  });

  it("paces only once the budget is gone, and refills over time", async () => {
    await spendBurst("price");
    const spent = await scheduler.acquire("price");
    assert.equal(spent.ok, false);
    assert.equal(!spent.ok && spent.reason, "budget", "this is our own pacing, not a Steam limit");

    advance(60_000);
    const refilled = await scheduler.acquire("price");
    assert.equal(refilled.ok, true, "a minute later there is budget again");
  });

  it("keeps a refusal from becoming a permanent tax", async () => {
    await scheduler.report("price", "rate_limited");
    const halved = (await scheduler.stats()).budget.price.ratePerMin;
    assert.ok(halved < 15, `rate should drop, got ${halved}`);

    advance(120_000);
    for (let i = 0; i < 200; i++) await scheduler.report("price", "ok");
    const recovered = (await scheduler.stats()).budget.price.ratePerMin;
    assert.equal(recovered, 15, "sustained success returns the full allowance");
    assert.equal((await scheduler.stats()).hits429, 0, "and the backoff counter unwinds");
  });

  it("never paces below its floor, however many refusals arrive", async () => {
    for (let i = 0; i < 20; i++) {
      await scheduler.report("price", "rate_limited");
      await scheduler.unblock();
    }
    const rate = (await scheduler.stats()).budget.price.ratePerMin;
    assert.ok(rate >= 3, `must stay usable, got ${rate}`);
  });

  it("opens the breaker on the first 429, so a scan cannot wait-and-retry into a longer ban", async () => {
    await scheduler.report("price", "rate_limited");
    const blocked = await scheduler.acquire("price");
    assert.equal(!blocked.ok && blocked.reason, "blocked");
  });

  it("does not lift a block just because a later success arrives", async () => {
    await scheduler.report("price", "rate_limited");
    await scheduler.report("price", "ok");
    advance(600_000);
    assert.equal((await scheduler.stats()).blocked, true);
    const slot = await scheduler.acquire("price");
    assert.equal(!slot.ok && slot.reason, "blocked");
  });

  it("stays blocked until asked to retry, not merely until time passes", async () => {
    await scheduler.report("price", "rate_limited");
    advance(600_000);
    assert.equal(!(await scheduler.acquire("price")).ok, true);

    const learned = (await scheduler.stats()).budget.price.ratePerMin;
    await scheduler.unblock();
    assert.equal((await scheduler.acquire("price")).ok, true);
    assert.equal(
      (await scheduler.stats()).budget.price.ratePerMin,
      learned,
      "retrying keeps what Steam taught us"
    );
  });

  it("budgets each endpoint separately until the shared IP budget is gone", async () => {
    await spendBurst("price");
    assert.equal((await scheduler.acquire("search")).ok, true, "search still has room in the IP budget");
  });

  it("stops every endpoint once the IP budget is spent, even if a kind has tokens", async () => {
    let granted = 0;
    for (let i = 0; i < 40; i++) {
      const slot = await scheduler.acquire(i % 2 === 0 ? "price" : "search");
      if (!slot.ok) break;
      granted += 1;
    }
    assert.equal(granted, 6, "global burst is 6");
    const listings = await scheduler.acquire("listings");
    assert.equal(listings.ok, false);
    assert.equal(!listings.ok && listings.reason, "budget");
  });

  it("waits at least 30s after a 429 when Steam sent no Retry-After", async () => {
    await scheduler.report("price", "rate_limited");
    const slot = await scheduler.acquire("search");
    assert.equal(slot.ok, false);
    assert.ok(!slot.ok && slot.waitMs >= 30_000, `got ${!slot.ok ? slot.waitMs : 0}`);
  });

  it("blocks everything once open, since the limit is per account", async () => {
    await scheduler.report("price", "rate_limited");
    const search = await scheduler.acquire("search");
    assert.equal(!search.ok && search.reason, "blocked");
  });

  it("prefers Retry-After over its own guess", async () => {
    await scheduler.report("price", "rate_limited", 45_000);
    const slot = await scheduler.acquire("price");
    assert.equal(slot.ok, false);
    assert.ok(!slot.ok && slot.waitMs > 40_000, "Steam knows better than we do");
  });

  it("never shortens a cooldown that is already running", async () => {
    await scheduler.report("price", "rate_limited", 60_000);
    await scheduler.report("price", "rate_limited", 1000);
    const slot = await scheduler.acquire("price");
    assert.ok(!slot.ok && slot.waitMs > 40_000);
  });

  it("treats a streak of success:false as a stop, not as a 30s loop", async () => {
    const before = (await scheduler.stats()).budget.price.ratePerMin;
    await scheduler.report("price", "empty");
    await scheduler.report("price", "empty");
    await scheduler.report("price", "empty");
    assert.equal((await scheduler.stats()).blocked, false, "a couple of delisted items are normal");

    await scheduler.report("price", "empty");
    assert.equal((await scheduler.stats()).blocked, true, "four empties is a throttle");
    assert.ok((await scheduler.stats()).budget.price.ratePerMin < before);
    const slot = await scheduler.acquire("search");
    assert.equal(!slot.ok && slot.reason, "blocked");
  });

  it("reports a budget the popup can render", async () => {
    const stats = await scheduler.stats();
    for (const kind of ["price", "search", "listings", "inventory", "write"] as const) {
      const b = stats.budget[kind];
      assert.ok(b, `missing budget for ${kind}`);
      assert.ok(b.capacity > 0 && b.ratePerMin > 0);
      assert.ok(b.tokens >= 0 && b.tokens <= b.capacity);
    }
    assert.ok(stats.global.capacity >= 6);
    assert.ok(stats.global.tokens <= stats.global.capacity);
  });
});

describe("a search that finds nothing", () => {
  beforeEach(async () => {
    await scheduler.reset();
  });

  it("is not a throttle, however many in a row", async () => {
    /**
     * Community items hash as `296830-:CoffeeBreak:` and are unfindable by name.
     * Counting those misses as a ban blocked whole scans Steam never refused.
     */
    for (let i = 0; i < 8; i++) await scheduler.report("search", "empty");
    const slot = await scheduler.acquire("search");
    assert.equal(slot.ok, true, "search misses must not open the breaker");
    const stats = await scheduler.stats();
    assert.equal(stats.blocked, false);
    assert.equal(stats.cooldownMsLeft, 0);
    assert.ok(stats.hitsEmpty >= 8, "still counted, so the popup log can show them");
  });

  it("leaves the metered endpoints answering exactly as before", async () => {
    for (let i = 0; i < 4; i++) await scheduler.report("price", "empty");
    const stats = await scheduler.stats();
    assert.equal(stats.blocked, true, "four success:false from priceoverview is a throttle");
  });
});

describe("a service worker waking up mid-scan", () => {
  /**
   * The worker is evicted constantly — that is the whole reason the governor
   * persists itself. What it hands back on the way up decides whether the tab
   * that woke it walks straight into a live Steam cooldown.
   */
  beforeEach(async () => {
    await scheduler.reset();
    seedSession("stwScheduler", {
      kinds: {},
      global: undefined,
      cooldownUntil: now + 30_000,
      hits429: 1,
      hitsEmpty: 0,
      ok: 0,
      emptyStreak: 0,
      consecutive429: 1,
      blocked: true,
    });
    scheduler.forget();
  });

  it("remembers the cooldown the last worker was told about", async () => {
    const slot = await scheduler.acquire("price");
    assert.equal(slot.ok, false);
    assert.equal(slot.ok === false && slot.reason, "blocked");
  });

  it("holds back every caller that arrived while it was still loading", async () => {
    /**
     * The bug: a content script wakes the worker with a burst, and the first call
     * marked the state «loaded» before it had loaded anything. Every other call in
     * that same tick sailed past a fresh, empty budget — six requests into a live
     * ban, which is exactly how a thirty-second pause becomes hours.
     */
    const slots = await Promise.all([
      scheduler.acquire("price"),
      scheduler.acquire("price"),
      scheduler.acquire("listings"),
      scheduler.acquire("history"),
    ]);
    assert.deepEqual(
      slots.map((s) => s.ok),
      [false, false, false, false],
      "not one of them may go out during a cooldown the worker had on record"
    );
  });

  it("does not re-read storage once it has the state", async () => {
    await scheduler.acquire("price");
    seedSession("stwScheduler", { kinds: {}, cooldownUntil: 0, blocked: false });
    const slot = await scheduler.acquire("price");
    assert.equal(slot.ok, false, "a stale write from another tab must not lift our cooldown");
  });
});
