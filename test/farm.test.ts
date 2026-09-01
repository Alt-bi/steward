import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FARM_MAX, claimChanged, farmTick, type FarmTickInput } from "../src/content/features/farm/engine";

function row(appid: number, dropsRemaining: number | null, foil = false): FarmTickInput["rows"][number] {
  return {
    appid,
    name: `g${appid}`,
    dropsRemaining,
    cardsCollected: null,
    cardsTotal: null,
    foil,
    level: 1,
  };
}

function input(over: Partial<FarmTickInput> = {}): FarmTickInput {
  return {
    rows: [],
    scanComplete: true,
    prevPlaying: [],
    ...over,
  };
}

describe("farmTick", () => {
  it("farms everything that owes cards — there is nothing to opt into", () => {
    // The whole feature in one line: no queue, no ticks, no auto switch. Three
    // games owe drops, three games play.
    const r = farmTick(input({ rows: [row(1, 4), row(2, 1), row(3, 2)] }));
    assert.deepEqual(r.playing, [1, 2, 3]);
    assert.deepEqual(r.waiting, []);
    assert.equal(r.done, false);
  });

  it("never farms a game Steam owes nothing for", () => {
    const r = farmTick(input({ rows: [row(1, 0), row(2, 3), row(3, null)] }));
    assert.deepEqual(r.playing, [2]);
  });

  it("an alive bench keeps its seats, and free slots take the next in line", () => {
    const r = farmTick(
      input({ rows: [row(1, 2), row(2, 1), row(3, 5)], prevPlaying: [3, 1], max: 3 })
    );
    // 3 and 1 were already claimed and stay claimed, in their old order.
    assert.deepEqual(r.playing, [3, 1, 2]);
    assert.deepEqual(r.finishedNow, []);
  });

  it("a visible zero finishes the game even mid-pagination", () => {
    const r = farmTick(
      input({ scanComplete: false, rows: [row(1, 0), row(2, 1)], prevPlaying: [1, 2] })
    );
    assert.deepEqual(r.finishedNow, [1]);
    assert.deepEqual(r.playing, [2]);
  });

  it("an absence during a partial scan does NOT finish a game", () => {
    // Page 3 timed out; appid 1 simply not visible. A live game must survive —
    // evicting on pagination noise is «ферма встала сама по себе».
    const r = farmTick(input({ scanComplete: false, rows: [row(2, 1)], prevPlaying: [1] }));
    assert.deepEqual(r.finishedNow, []);
    assert.equal(r.playing.includes(1), true);
  });

  it("an absence during a COMPLETE scan does finish it", () => {
    const r = farmTick(input({ scanComplete: true, rows: [row(2, 1)], prevPlaying: [1] }));
    assert.deepEqual(r.finishedNow, [1]);
    assert.deepEqual(r.playing, [2]);
  });

  it("a finished game is gone for good — the counter says zero, so nothing re-adds it", () => {
    const r = farmTick(input({ rows: [row(1, 0), row(2, 0), row(3, 1)], prevPlaying: [1, 2, 3] }));
    assert.deepEqual(r.playing, [3]);
    assert.deepEqual(r.finishedNow, [1, 2]);
    assert.deepEqual(r.waiting, []);
  });

  it("the bench caps at 32, the rest waits for a slot", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i + 1, 1));
    const r = farmTick(input({ rows }));
    assert.equal(r.playing.length, FARM_MAX);
    assert.equal(r.waiting.length, 40 - FARM_MAX);
    assert.equal(r.playing.includes(33), false);
    assert.equal(r.waiting[0], 33);
  });

  it("a foil row claiming zero does not evict the normal game", () => {
    // Steam counts normal drops into the badge; the foil row has no counter and
    // must never speak for the game.
    const r = farmTick(input({ rows: [row(1, 2), row(1, null, true)], prevPlaying: [1] }));
    assert.deepEqual(r.finishedNow, []);
    assert.deepEqual(r.playing, [1]);
  });

  it("empty bench means done — and an empty library closes the factory", () => {
    const r = farmTick(input({ rows: [] }));
    assert.equal(r.done, true);
    assert.deepEqual(r.waiting, []);
  });

  it("nothing playing after a failed scan is still 'done' — the caller checks completeness", () => {
    // The engine only reports the bench; refusing to close the factory on an
    // outage is the loop's job, and it needs scan.complete to do it.
    const r = farmTick(input({ scanComplete: false, rows: [] }));
    assert.equal(r.done, true);
  });
});

describe("claimChanged", () => {
  it("an unanswered socket always needs the claim pushed", () => {
    // The regression this pins: after a page reload the bridge holds nothing
    // while storage still lists the bench. Comparing storage to storage found
    // "no change", skipped the swap, and farmed air under a green status.
    assert.equal(claimChanged([730, 440], null), true);
    assert.equal(claimChanged([], null), true);
  });

  it("a socket already carrying the same games needs nothing", () => {
    assert.equal(claimChanged([730, 440], [730, 440]), false);
  });

  it("order is not a change — Steam is told a set", () => {
    assert.equal(claimChanged([730, 440], [440, 730]), false);
  });

  it("any real difference is a change", () => {
    assert.equal(claimChanged([730, 440], [730]), true);
    assert.equal(claimChanged([730], [730, 440]), true);
    assert.equal(claimChanged([730], [440]), true);
    assert.equal(claimChanged([], [730]), true);
  });

  it("an empty bench against an empty socket is quiet", () => {
    assert.equal(claimChanged([], []), false);
  });
});
