import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createElement, type FakeElement } from "./support/dom";
import {
  activeTargets,
  inventoriesOnPage,
  ownerFromPage,
  type PageInventory,
} from "../src/steam/inventory";

/**
 * Which game is open, and whose it is.
 *
 * «Оценить всё» used to ask the URL fragment and nothing else, so a freshly
 * opened inventory — Steam writes `#730_2` only once a game has been *clicked* —
 * was told to «сначала выбери игру», with that game drawn on the screen behind
 * the panel. The page states both facts in the id of every grid it draws.
 */

const ME = "76561198000000001";

function container(id: string, hidden = false): FakeElement {
  const node = createElement("div");
  node.className = "inventory_ctn";
  node.id = id;
  if (hidden) node.setAttribute("style", "display: none;");
  return node;
}

function page(...nodes: FakeElement[]): FakeElement {
  const root = createElement("div");
  root.append(...nodes);
  return root;
}

describe("reading the grids Steam drew", () => {
  it("takes the owner, the game and the context out of the container id", () => {
    const drawn = inventoriesOnPage(page(container(`inventory_${ME}_730_2`)) as never);
    assert.deepEqual(drawn, [{ steamid: ME, appid: 730, contextid: "2", shown: true }]);
  });

  /** Steam keeps every loaded game in the document and hides all but one. */
  it("marks the hidden ones as not on screen", () => {
    const drawn = inventoriesOnPage(
      page(
        container(`inventory_${ME}_440_2`, true),
        container(`inventory_${ME}_730_2`)
      ) as never
    );
    assert.deepEqual(
      drawn.map((inv) => [inv.appid, inv.shown]),
      [[440, false], [730, true]]
    );
  });

  it("ignores anything that only starts with the same word", () => {
    const stray = createElement("div");
    stray.id = "inventory_pagecontrols";
    assert.deepEqual(inventoriesOnPage(page(stray) as never), []);
  });

  it("says nothing rather than guessing when the containers disagree", () => {
    const drawn = inventoriesOnPage(
      page(container(`inventory_${ME}_730_2`), container("inventory_76561198000000009_440_2")) as never
    );
    assert.equal(ownerFromPage(drawn), null);
    assert.equal(ownerFromPage([]), null);
  });

  it("names the owner when every grid on the page agrees", () => {
    const drawn = inventoriesOnPage(
      page(container(`inventory_${ME}_730_2`), container(`inventory_${ME}_440_2`, true)) as never
    );
    assert.equal(ownerFromPage(drawn), ME);
  });
});

describe("the game «Оценить всё» will read", () => {
  const base = { hash: "", steamid: ME, drawn: [], tiles: [], contexts: [] };

  it("obeys the fragment when the user has picked a game", () => {
    assert.deepEqual(activeTargets({ ...base, hash: "#730_2" }), [
      { steamid: ME, appid: 730, contextid: "2" },
    ]);
  });

  /** The bug this fixes: no fragment, a full grid, and a refusal to read it. */
  it("reads the drawn grid when the fragment is empty", () => {
    const drawn: PageInventory[] = [
      { steamid: ME, appid: 440, contextid: "2", shown: false },
      { steamid: ME, appid: 730, contextid: "2", shown: true },
    ];
    assert.deepEqual(activeTargets({ ...base, drawn }), [
      { steamid: ME, appid: 730, contextid: "2" },
    ]);
  });

  it("falls back to the tiles on screen when no grid names itself", () => {
    assert.deepEqual(
      activeTargets({ ...base, tiles: [{ appid: 570, contextid: "2", assetid: "1" }] }),
      [{ steamid: ME, appid: 570, contextid: "2" }]
    );
  });

  /**
   * `#730` with no context is a fragment Steam writes too, and on its own it
   * cannot address an inventory — the page table can finish the sentence.
   */
  it("completes a game-only fragment from the page's own context table", () => {
    assert.deepEqual(
      activeTargets({
        ...base,
        hash: "#730",
        contexts: [
          { appid: 440, contextid: "2", label: "TF2", count: 9 },
          { appid: 730, contextid: "2", label: "CS2", count: 3 },
        ],
      }),
      [{ steamid: ME, appid: 730, contextid: "2" }]
    );
  });

  /** One game, several inventories: CS2 draws the backpack and the storage units. */
  it("returns every context of the chosen game, the open one first", () => {
    const drawn: PageInventory[] = [
      { steamid: ME, appid: 730, contextid: "16", shown: false },
      { steamid: ME, appid: 730, contextid: "2", shown: true },
    ];
    assert.deepEqual(
      activeTargets({ ...base, drawn }).map((t) => t.contextid),
      ["2", "16"]
    );
  });

  it("never mixes another game into the run", () => {
    const drawn: PageInventory[] = [
      { steamid: ME, appid: 730, contextid: "2", shown: true },
      { steamid: ME, appid: 440, contextid: "2", shown: false },
    ];
    assert.deepEqual(
      activeTargets({ ...base, hash: "#730_2", drawn }).map((t) => t.appid),
      [730]
    );
  });

  it("asks for nothing when the page has not said anything yet", () => {
    assert.deepEqual(activeTargets(base), []);
    assert.deepEqual(activeTargets({ ...base, steamid: "", hash: "#730_2" }), []);
  });
});
