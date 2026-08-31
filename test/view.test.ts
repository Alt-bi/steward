import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  emptySelection,
  groupPick,
  matchesQuery,
  pickedAssetIds,
  selectableKeys,
  sellableCount,
  toggleAsset,
  toggleGroup,
  viewGroups,
  viewTotals,
  type ViewFilters,
} from "../src/content/features/inventory/view";
import type { InventoryGroup, InventoryItem } from "../src/steam/inventory";

function item(assetid: string, marketable = true, amount = 1): InventoryItem {
  return {
    appid: 730,
    contextid: "2",
    assetid,
    amount,
    name: "x",
    hash: "x",
    type: "",
    iconUrl: "",
    marketable,
    tradable: true,
  };
}

function group(name: string, items: InventoryItem[], hash = name): InventoryGroup {
  return {
    key: `730\t${hash}`,
    appid: 730,
    hash,
    name,
    iconUrl: "",
    items,
    count: items.reduce((n, i) => n + i.amount, 0),
  };
}

const redline = group("AK-47 | Redline", [item("1"), item("2")], "AK-47 | Redline (Field-Tested)");
const chroma = group("Chroma Case", [item("3", true, 10)]);
const souvenir = group("Souvenir Sticker", [item("4", false)]);

function table(...groups: InventoryGroup[]): Map<string, InventoryGroup> {
  return new Map(groups.map((g) => [g.key, g]));
}

const lows: Record<string, number | null> = {
  [redline.key]: 5000,
  [chroma.key]: 900,
  [souvenir.key]: null,
};

function filters(overrides: Partial<ViewFilters> = {}): ViewFilters {
  return { query: "", onlyMarketable: false, onlyPriced: false, ...overrides };
}

describe("matchesQuery", () => {
  it("ignores case and repeated spacing", () => {
    assert.equal(matchesQuery(redline, "  ak-47   |  REDLINE "), true);
  });

  it("searches the hash too, which is where the wear lives", () => {
    assert.equal(matchesQuery(redline, "field-tested"), true);
    assert.equal(matchesQuery(chroma, "field-tested"), false);
  });

  it("an empty query matches everything", () => {
    assert.equal(matchesQuery(souvenir, ""), true);
    assert.equal(matchesQuery(souvenir, "   "), true);
  });
});

describe("sellableCount", () => {
  it("counts stack amounts, not rows", () => {
    assert.equal(sellableCount(chroma), 10);
  });

  it("leaves out what the market will not take", () => {
    assert.equal(sellableCount(group("mixed", [item("1"), item("2", false, 4)])), 1);
    assert.equal(sellableCount(souvenir), 0);
  });
});

describe("viewGroups", () => {
  it("sorts by what the stack is worth, most valuable first", () => {
    const views = viewGroups(table(chroma, redline), lows);
    assert.deepEqual(
      views.map((v) => v.group.name),
      ["AK-47 | Redline", "Chroma Case"]
    );
    assert.equal(views[0]!.value, 10000, "two copies at 50.00");
    assert.equal(views[1]!.value, 9000, "ten copies at 9.00");
  });

  it("keeps an unpriced stack last instead of reading it as free", () => {
    /** The bug this guards: value 0 for "unknown" buries a stack that is merely unmeasured. */
    const views = viewGroups(table(souvenir, chroma), lows);
    assert.deepEqual(
      views.map((v) => v.group.name),
      ["Chroma Case", "Souvenir Sticker"]
    );
    assert.equal(views[1]!.low, null);
    assert.equal(views[1]!.value, 0);
  });

  it("sorts by unit price when asked, which is a different order", () => {
    const views = viewGroups(table(chroma, redline), lows, filters(), "price");
    assert.deepEqual(
      views.map((v) => v.low),
      [5000, 900]
    );
  });

  it("sorts by how many copies there are", () => {
    const views = viewGroups(table(redline, chroma), lows, filters(), "count");
    assert.deepEqual(
      views.map((v) => v.group.count),
      [10, 2]
    );
  });

  it("sorts by name without pushing unpriced stacks around", () => {
    const views = viewGroups(table(souvenir, chroma, redline), lows, filters(), "name");
    assert.deepEqual(
      views.map((v) => v.group.name),
      ["AK-47 | Redline", "Chroma Case", "Souvenir Sticker"]
    );
  });

  it("filters by query", () => {
    const views = viewGroups(table(redline, chroma, souvenir), lows, filters({ query: "case" }));
    assert.deepEqual(
      views.map((v) => v.group.name),
      ["Chroma Case"]
    );
  });

  it("hides what the market will not take", () => {
    const views = viewGroups(
      table(redline, souvenir),
      lows,
      filters({ onlyMarketable: true })
    );
    assert.deepEqual(
      views.map((v) => v.group.name),
      ["AK-47 | Redline"]
    );
  });

  it("hides what we could not price", () => {
    const views = viewGroups(table(redline, souvenir), lows, filters({ onlyPriced: true }));
    assert.equal(views.length, 1);
    assert.equal(views[0]!.group.name, "AK-47 | Redline");
  });

  it("returns nothing rather than everything when the query matches nothing", () => {
    assert.deepEqual(viewGroups(table(redline), lows, filters({ query: "karambit" })), []);
  });
});

describe("viewTotals", () => {
  it("adds up the rows on screen, not the whole inventory", () => {
    const shown = viewGroups(table(redline, chroma, souvenir), lows, filters({ query: "case" }));
    assert.deepEqual(viewTotals(shown), { groups: 1, items: 10, value: 9000, unpriced: 0 });
  });

  it("counts unpriced stacks without inventing a value for them", () => {
    const totals = viewTotals(viewGroups(table(redline, souvenir), lows));
    assert.equal(totals.unpriced, 1);
    assert.equal(totals.value, 10000);
    assert.equal(totals.items, 3);
  });
});

describe("selectableKeys", () => {
  it("offers only stacks that can actually be listed", () => {
    const keys = selectableKeys(viewGroups(table(redline, chroma, souvenir), lows));
    assert.deepEqual(keys, [redline.key, chroma.key]);
  });

  it("is empty when nothing is priced", () => {
    assert.deepEqual(selectableKeys(viewGroups(table(souvenir), lows)), []);
  });
});

describe("selection", () => {
  const stack = group("Chroma Case", [item("1"), item("2"), item("3", false)], "Chroma Case");

  it("starts with everything priced and marketable picked", () => {
    const sel = emptySelection();
    assert.equal(groupPick(stack, sel), "all");
    assert.deepEqual([...pickedAssetIds(table(stack), { [stack.key]: 900 }, sel)], ["1", "2"]);
  });

  it("never picks a copy the market will not take", () => {
    const picked = pickedAssetIds(table(stack), { [stack.key]: 900 }, emptySelection());
    assert.equal(picked.has("3"), false, "unmarketable copies are not a choice");
  });

  it("never picks a stack without a price", () => {
    assert.deepEqual([...pickedAssetIds(table(stack), { [stack.key]: null }, emptySelection())], []);
  });

  it("drops the whole stack when a full one is toggled", () => {
    const sel = emptySelection();
    toggleGroup(stack, sel);
    assert.equal(groupPick(stack, sel), "none");
    assert.deepEqual([...pickedAssetIds(table(stack), { [stack.key]: 900 }, sel)], []);
  });

  it("takes the whole stack back when a partly picked one is toggled", () => {
    const sel = emptySelection();
    toggleAsset(stack, "1", sel);
    assert.equal(groupPick(stack, sel), "some");
    toggleGroup(stack, sel);
    assert.equal(groupPick(stack, sel), "all");
  });

  it("toggles one copy without touching its neighbours", () => {
    const sel = emptySelection();
    toggleAsset(stack, "2", sel);
    assert.deepEqual([...pickedAssetIds(table(stack), { [stack.key]: 900 }, sel)], ["1"]);
    toggleAsset(stack, "2", sel);
    assert.deepEqual([...pickedAssetIds(table(stack), { [stack.key]: 900 }, sel)], ["1", "2"]);
  });

  it("reads a click on a dropped stack as «this copy only»", () => {
    /** Otherwise the click would silently bring back every copy of the stack. */
    const sel = emptySelection();
    toggleGroup(stack, sel);
    toggleAsset(stack, "2", sel);
    assert.equal(groupPick(stack, sel), "some");
    assert.deepEqual([...pickedAssetIds(table(stack), { [stack.key]: 900 }, sel)], ["2"]);
  });

  it("calls a stack with nothing marketable unpicked, not half-picked", () => {
    const dead = group("Souvenir", [item("9", false)], "Souvenir");
    assert.equal(groupPick(dead, emptySelection()), "none");
  });

  it("keeps a dropped stack dropped when more prices arrive", () => {
    /** The reason selection stores exclusions: a second pricing wave must not re-tick. */
    const later = group("Glove Case", [item("7"), item("8")], "Glove Case");
    const sel = emptySelection();
    toggleGroup(stack, sel);
    const picked = pickedAssetIds(table(stack, later), { [stack.key]: 900, [later.key]: 700 }, sel);
    assert.deepEqual([...picked], ["7", "8"], "the new stack is picked, the dropped one is not");
  });
});
