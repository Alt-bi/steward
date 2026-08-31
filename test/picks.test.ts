import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  countPicked,
  isPicked,
  noneDropped,
  pickAll,
  pickedRows,
  pickNone,
  togglePick,
} from "../src/core/picks";

describe("picks", () => {
  it("starts with everything ticked", () => {
    const dropped = noneDropped();
    assert.equal(isPicked("1", dropped), true);
    assert.equal(countPicked(["1", "2", "3"], dropped), 3);
  });

  it("toggles one row without touching its neighbours", () => {
    const dropped = noneDropped();
    togglePick("2", dropped);
    assert.deepEqual([isPicked("1", dropped), isPicked("2", dropped)], [true, false]);
    togglePick("2", dropped);
    assert.equal(isPicked("2", dropped), true);
  });

  it("keeps a row dropped when new rows appear", () => {
    /** The reason this is an exclusion set: a second scan must not re-tick. */
    const dropped = noneDropped();
    togglePick("2", dropped);
    assert.equal(countPicked(["1", "2", "3", "4", "5"], dropped), 4);
  });

  it("bulk buttons touch only the ids they are given", () => {
    const dropped = noneDropped();
    pickNone(["1", "2"], dropped);
    assert.equal(countPicked(["1", "2", "3"], dropped), 1, "the unshown row is untouched");
    pickAll(["1"], dropped);
    assert.deepEqual([isPicked("1", dropped), isPicked("2", dropped)], [true, false]);
  });

  it("returns the ticked rows in the order given", () => {
    const dropped = noneDropped();
    togglePick("b", dropped);
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    assert.deepEqual(
      pickedRows(rows, (row) => row.id, dropped),
      [{ id: "a" }, { id: "c" }]
    );
  });
});
