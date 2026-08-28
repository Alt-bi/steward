import "./support/env";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { scheduler } from "./support/env";

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
    assert.ok(granted >= 15, `burst should be worth the capacity, got ${granted}`);
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
    assert.ok(halved < 18, `rate should drop, got ${halved}`);

    advance(120_000);
    for (let i = 0; i < 200; i++) await scheduler.report("price", "ok");
    const recovered = (await scheduler.stats()).budget.price.ratePerMin;
    assert.equal(recovered, 18, "sustained success returns the full allowance");
    assert.equal((await scheduler.stats()).hits429, 0, "and the backoff counter unwinds");
  });

  it("never paces below its floor, however many refusals arrive", async () => {
    for (let i = 0; i < 20; i++) {
      await scheduler.report("price", "rate_limited");
      await scheduler.unblock();
    }
    const rate = (await scheduler.stats()).budget.price.ratePerMin;
    assert.ok(rate >= 4, `must stay usable, got ${rate}`);
  });

  it("opens the breaker only after a run of refusals with no success", async () => {
    for (let i = 0; i < 5; i++) await scheduler.report("price", "rate_limited");
    advance(120_000);
    assert.equal((await scheduler.acquire("price")).ok, true, "five is not yet a pattern");

    await scheduler.report("price", "rate_limited");
    const blocked = await scheduler.acquire("price");
    assert.equal(!blocked.ok && blocked.reason, "blocked");
  });

  it("does not open the breaker when successes interleave", async () => {
    for (let i = 0; i < 30; i++) {
      await scheduler.report("price", "rate_limited");
      await scheduler.report("price", "ok");
    }
    advance(600_000);
    assert.equal((await scheduler.acquire("price")).ok, true);
    assert.equal((await scheduler.stats()).blocked, false);
  });

  it("stays blocked until asked to retry, not merely until time passes", async () => {
    for (let i = 0; i < 6; i++) await scheduler.report("price", "rate_limited");
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

  it("budgets each endpoint separately", async () => {
    await spendBurst("price");
    assert.equal((await scheduler.acquire("search")).ok, true, "search has its own allowance");
  });

  it("blocks everything once open, since the limit is per account", async () => {
    for (let i = 0; i < 6; i++) await scheduler.report("price", "rate_limited");
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

  it("backs off gently on a streak of soft throttles only", async () => {
    const before = (await scheduler.stats()).budget.price.ratePerMin;
    await scheduler.report("price", "empty");
    await scheduler.report("price", "empty");
    assert.equal(
      (await scheduler.stats()).budget.price.ratePerMin,
      before,
      "a couple of delisted items are normal"
    );

    await scheduler.report("price", "empty");
    await scheduler.report("price", "empty");
    assert.ok((await scheduler.stats()).budget.price.ratePerMin < before, "a streak is a signal");
  });

  it("reports a budget the popup can render", async () => {
    const stats = await scheduler.stats();
    for (const kind of ["price", "search", "listings", "mylistings", "write"] as const) {
      const b = stats.budget[kind];
      assert.ok(b, `missing budget for ${kind}`);
      assert.ok(b.capacity > 0 && b.ratePerMin > 0);
      assert.ok(b.tokens >= 0 && b.tokens <= b.capacity);
    }
  });
});
