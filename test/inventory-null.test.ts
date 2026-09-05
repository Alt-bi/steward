import "./support/env";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { calls, jsonReply, resetEnv, setSteam } from "./support/env";
import { loadInventory, mergeInventory } from "../src/steam/inventory";

/**
 * The context Steam will not open.
 *
 * Measured 2026-09-05 on a live account: `/inventory/{id}/753/1` — the gift
 * shelf, which `g_rgAppContextData` lists with a count like any other — answers
 * with a bare `null`. Reading `total_inventory_count` off that threw
 * «Cannot read properties of null», and because «Оценить всё» now reads every
 * context of the open game as a set, the one shelf holding nothing worth having
 * killed the whole run.
 */

const target = { steamid: "76561198000000001", appid: 753, contextid: "1" };

describe("an inventory Steam answers with nothing", () => {
  beforeEach(async () => {
    await resetEnv();
  });

  it("joins nothing out of nothing instead of throwing", () => {
    assert.deepEqual(mergeInventory(null), []);
    assert.deepEqual(mergeInventory(undefined), []);
  });

  it("reads it as an empty shelf, not as a failed run", async () => {
    setSteam(() => ({ status: 200, body: "null" }));
    const loaded = await loadInventory(target, {});
    assert.deepEqual(loaded.items, []);
    assert.equal(loaded.truncated, false, "пустая полка — не обрезанная");
  });

  /** And it stops there: a null page has no `last_assetid` to walk on. */
  it("asks once and does not walk a page that was never sent", async () => {
    setSteam(() => ({ status: 200, body: "null" }));
    await loadInventory(target, {});
    assert.equal(calls.filter((url) => url.includes("/inventory/")).length, 1);
  });

  it("still reads a shelf that does answer", async () => {
    setSteam(() =>
      jsonReply({
        success: 1,
        total_inventory_count: 1,
        assets: [{ appid: 753, contextid: "6", assetid: "1", classid: "9", instanceid: "0", amount: "1" }],
        descriptions: [
          { appid: 753, classid: "9", instanceid: "0", market_hash_name: "Skeleton", marketable: 1 },
        ],
      })
    );
    const loaded = await loadInventory({ ...target, contextid: "6" }, {});
    assert.deepEqual(
      loaded.items.map((item) => item.hash),
      ["Skeleton"]
    );
  });
});
