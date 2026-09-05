import "./support/env";

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { resetEnv } from "./support/env";
import {
  byTag,
  createElement,
  installDom,
  walk,
  type DomHandle,
  type FakeElement,
} from "./support/dom";

import "../src/content/features/inventory";
import { allFeatures } from "../src/content/features/registry";
import { deepestCut, runTimeMs } from "../src/content/features/inventory";
import { humanMinutes } from "../src/core/duration";
import type { SellPlan } from "../src/content/features/inventory/plan";
import { DEFAULT_SETTINGS } from "../src/core/settings";

/** Stands in for the shared panel: the section is all the feature touches. */
function fakePanel(): { body: FakeElement; status: string[]; panel: never } {
  const body = createElement("div");
  const status: string[] = [];
  const panel = {
    addSection: () => ({
      id: "inventory",
      body,
      setStatus: (text: string) => status.push(text),
      show: () => {},
    }),
  };
  return { body, status, panel: panel as never };
}

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const inventory = () => allFeatures().find((f) => f.id === "inventory")!;

/**
 * The controls the tab used to carry, and what replaced them.
 *
 * Seven stacked rows stood between opening the tab and seeing an item: a game
 * picker, five strategy controls, a search box with a sort box, two checkboxes
 * with two bulk buttons, a hint, and three equal buttons that wrapped their own
 * labels. Most of it answered questions nobody had asked twice.
 */
describe("the inventory tab, after the controls were thinned out", () => {
  let dom: DomHandle;

  /**
   * The document is installed for the whole file rather than per test.
   *
   * Mounting arms `window.setTimeout(fillGames, 600)`, and that timer is real —
   * `installDom` stubs `setInterval` and leaves `setTimeout` alone, because the
   * polling loops in every other suite depend on it. Pulling the document out
   * from under a pending `fillGames` turns a passing test into an uncaught
   * «document.createElement is not a function», so the tab keeps its document
   * until the timer has had its turn.
   */
  before(() => {
    dom = installDom("https://steamcommunity.com/id/someone/inventory");
  });

  beforeEach(async () => {
    await resetEnv();
  });

  after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    dom.restore();
  });

  it("has dropped the controls that duplicated each other", async () => {
    const { body, panel } = fakePanel();
    await inventory().mount({
      panel,
      settings: DEFAULT_SETTINGS,
      url: new URL("https://steamcommunity.com/id/someone/inventory"),
    });
    await settle();

    const text = body.textContent ?? "";
    /**
     * «продаваемые» and «с ценой» hid the same rows twice, and the «к продаже»
     * counter now names that set and filters by it. CSV and the five-way sort
     * went the way of their twins on the market tab.
     */
    /** «Фильтр» went too: a caption over a box that reads «поиск по названию». */
    for (const dead of [
      "продаваемые",
      "с ценой",
      "CSV",
      "Сортировка",
      "Игра",
      "Стратегия",
      "Шаг",
      "Штук",
      "Фильтр",
    ]) {
      assert.equal(text.includes(dead), false, `«${dead}» всё ещё на вкладке: ${text}`);
    }
    const labels = byTag(body, "button").map((b) => b.textContent);
    for (const dead of ["Все", "Ничего"]) {
      assert.equal(labels.includes(dead), false, `кнопка «${dead}» всё ещё есть: ${labels.join(" | ")}`);
    }
  });

  /**
   * The picker was decoration that lied. `scan()` reads `visibleTileRefs` — the
   * tiles Steam has actually drawn — and resolves any nameless ones through the
   * contexts those very tiles name. The chosen «Игра» reached exactly one line
   * of code: a status message saying what had been chosen.
   */
  it("scans the drawn page, with nothing to choose beforehand", async () => {
    const { body, panel } = fakePanel();
    await inventory().mount({
      panel,
      settings: DEFAULT_SETTINGS,
      url: new URL("https://steamcommunity.com/id/someone/inventory"),
    });
    await settle();

    assert.equal(byTag(body, "select").length, 0, "выбирать перед сканом больше нечего");
    assert.equal(byTag(body, "input").filter((n) => n.type === "number").length, 0);
  });

  it("gives the scan the width and puts the rest under it", async () => {
    const { body, panel } = fakePanel();
    await inventory().mount({
      panel,
      settings: DEFAULT_SETTINGS,
      url: new URL("https://steamcommunity.com/id/someone/inventory"),
    });
    await settle();

    const main = walk(body).find((n) => n.className === "stw-actions stw-actions-main");
    const rest = walk(body).find((n) => n.className === "stw-actions stw-actions-rest");
    assert.ok(main && rest, "ряды кнопок должны быть разделены");
    assert.deepEqual(byTag(main!, "button").map((b) => b.textContent), ["Оценить страницу"]);
    assert.deepEqual(byTag(rest!, "button").map((b) => b.textContent), ["Выставить", "Стоп"]);
  });

  it("counts «к продаже» as a button, because pressing it is the filter", async () => {
    const { body, panel } = fakePanel();
    await inventory().mount({
      panel,
      settings: DEFAULT_SETTINGS,
      url: new URL("https://steamcommunity.com/id/someone/inventory"),
    });
    await settle();

    const stats = walk(body).find((n) => n.className === "stw-stats");
    assert.ok(stats, "счётчики должны быть на месте");
    assert.equal(byTag(stats!, "button").length, 3, "все три счётчика — кнопки");
  });
});

/**
 * What a run costs, said before it starts.
 *
 * One paced `sellitem` per copy at eight writes a minute, plus the pause after
 * each: two hundred copies is half an hour of the panel holding the tab, and
 * the only place that used to be visible was the progress line once it was too
 * late to answer differently.
 */
describe("naming the cost of a listing run", () => {
  it("prices a batch by its writes and its pauses", () => {
    /** 7,5 с of budget plus a 2,5 с pause, ten seconds a copy. */
    assert.equal(runTimeMs(1, 2500), 10_000);
    assert.equal(runTimeMs(6, 2500), 60_000);
  });

  it("says it in the unit a person would use", () => {
    /** Under a minute and a half, seconds are what a person is actually feeling. */
    assert.equal(humanMinutes(30_000), "30 с");
    assert.equal(humanMinutes(runTimeMs(1, 2500)), "10 с");
    assert.equal(humanMinutes(runTimeMs(200, 2500)), "33 мин");
    assert.equal(humanMinutes(runTimeMs(400, 2500)), "1 ч 7 мин");
  });
});

/**
 * The worst price in the batch.
 *
 * «Ниже минимума» and «по средней за год» can both land well under what the
 * market is asking today, and on a list of two hundred that row is the one
 * nobody scrolled to. The question names it instead.
 */
describe("the deepest concession in a batch", () => {
  function plan(over: Partial<SellPlan>): SellPlan {
    return {
      assetid: "1",
      appid: 753,
      contextid: "6",
      amount: 1,
      name: "Card",
      hash: "Card",
      marketLow: 10_000,
      targetBuyer: 10_000,
      targetSeller: 8_700,
      action: "sell",
      reason: "",
      ...over,
    };
  }

  it("names the biggest gap under the market, in percent", () => {
    const worst = deepestCut([
      plan({ targetBuyer: 9_900 }),
      plan({ targetBuyer: 6_600 }),
      plan({ targetBuyer: 9_500 }),
    ]);
    assert.equal(worst, 34);
  });

  it("ignores rows that are not being listed, and prices above the market", () => {
    assert.equal(deepestCut([plan({ action: "skip", targetBuyer: 1 })]), 0);
    assert.equal(deepestCut([plan({ targetBuyer: 12_000 })]), 0);
    assert.equal(deepestCut([plan({ marketLow: null, targetBuyer: 1 })]), 0);
  });
});
