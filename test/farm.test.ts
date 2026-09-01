import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FARM_MAX, farmTick, type FarmTickInput } from "../src/content/features/farm/engine";

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
    prevPlaying: [1],
    queued: [2, 3],
    dropped: new Set<number>(),
    auto: false,
    ...over,
  };
}

describe("farmTick", () => {
  it("an alive bench survives: nothing finished, queue promoted into free slots", () => {
    const r = farmTick(input({ rows: [row(1, 2), row(2, 1), row(3, 1)] }));
    assert.deepEqual(r.finishedNow, []);
    assert.deepEqual(r.playing, [1, 2, 3]); // bench fills from the queue
    assert.deepEqual(r.queue, []);
    assert.equal(r.done, false);
  });

  it("manual mode never pulls unqueued games in; auto does", () => {
    const rows = [row(1, 2), row(2, 1), row(3, 1)];
    const manual = farmTick(input({ rows, queued: [] }));
    assert.deepEqual(manual.playing, [1]); // only what was playing/queued
    assert.deepEqual(manual.queue, []);
    const auto = farmTick(input({ rows, queued: [], auto: true }));
    assert.deepEqual(auto.playing, [1, 2, 3]); // scan owed joined the bench
  });

  it("a visible zero finishes the game even mid-pagination", () => {
    // Evidence rule: a row saying zero always counts; only ABSENCE needs a
    // complete scan.
    const r = farmTick(
      input({ auto: true, scanComplete: false, rows: [row(1, 0), row(2, 1)], queued: [2] })
    );
    assert.deepEqual(r.finishedNow, [1]);
    assert.deepEqual(r.playing, [2]);
    assert.deepEqual(r.queue, []);
  });

  it("an absence during a partial scan does NOT finish a game", () => {
    // Page 3 timed out; appid 1 simply not visible. A live game must survive.
    const r = farmTick(
      input({ auto: true, scanComplete: false, rows: [row(2, 1)], prevPlaying: [1], queued: [] })
    );
    assert.deepEqual(r.finishedNow, []);
    assert.equal(r.playing.includes(1), true);
  });

  it("an emptied game leaves the bench and never re-enters the queue", () => {
    const r = farmTick(
      input({ auto: true, rows: [row(1, 0), row(2, 1), row(3, 1)], queued: [] })
    );
    assert.deepEqual(r.finishedNow, [1]);
    assert.deepEqual(r.playing, [2, 3]);
    assert.deepEqual(r.queue, []);
  });

  it("a finished game is gone for good: not playing, not queued", () => {
    const r = farmTick(
      input({ auto: true, rows: [row(1, 0), row(2, 0), row(3, 1)], prevPlaying: [1, 2, 3] })
    );
    assert.deepEqual(r.playing, [3]);
    assert.deepEqual(r.finishedNow.sort(), [1, 2]);
  });

  it("the bench caps at 32, the rest waits in queue", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i + 1, 2));
    const r = farmTick(
      input({ auto: true, rows, prevPlaying: [1], queued: rows.slice(1, 40).map((x) => x.appid) })
    );
    assert.equal(r.playing.length, FARM_MAX);
    assert.equal(r.playing[0], 1); // the current leader keeps its slot
    assert.deepEqual(r.queue, rows.slice(FARM_MAX).map((x) => x.appid));
  });

  it("dropped games never re-enter even if drops reappear", () => {
    const r = farmTick(
      input({ auto: true, rows: [row(4, 3)], prevPlaying: [], queued: [], dropped: new Set([4]) })
    );
    assert.deepEqual(r.playing, []);
    assert.deepEqual(r.queue, []);
  });

  it("a foil row claiming zero does not evict the normal game", () => {
    const r = farmTick(
      input({ auto: true, rows: [row(1, 0, true), row(1, 2)], prevPlaying: [1], queued: [] })
    );
    assert.deepEqual(r.finishedNow, []);
    assert.deepEqual(r.playing, [1]);
  });

  it("empty bench means done — and the empty library closes the factory", () => {
    const r = farmTick(input({ rows: [], prevPlaying: [], queued: [] }));
    assert.equal(r.done, true); // UI keeps the last honest scan to word this right
  });

  it("nothing playing but an outage-scan means done with empty queue", () => {
    const r = farmTick(
      input({ scanComplete: false, rows: [], prevPlaying: [], queued: [] })
    );
    assert.equal(r.done, true);
    assert.deepEqual(r.queue, []);
  });
});
