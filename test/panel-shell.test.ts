import "./support/env";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { byTag, installDom, walk, type DomHandle, type FakeElement } from "./support/dom";

import { Panel } from "../src/content/ui/panel";

/**
 * The shell around every tab: the header, the tab bar, and the status line.
 *
 * It is the one piece of the interface no feature owns, which is exactly why it
 * drifted — the subtitle spent months printing the same words as the tab bar
 * underneath it, and nothing failed when it did.
 */

/** The window bits the panel touches. The fake document does not carry them. */
function installWindow(): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { window: g.window, localStorage: g.localStorage, ro: g.ResizeObserver };
  g.window = {
    innerWidth: 1280,
    innerHeight: 900,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  g.localStorage = {
    getItem: () => null,
    setItem: () => {},
  };
  g.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
  return () => {
    g.window = saved.window;
    g.localStorage = saved.localStorage;
    g.ResizeObserver = saved.ro;
  };
}

function find(root: FakeElement, className: string): FakeElement | undefined {
  return walk(root).find((node) => node.classList.contains(className));
}

describe("the panel shell", () => {
  let dom: DomHandle;
  let restoreWindow: () => void;

  before(() => {
    dom = installDom("https://steamcommunity.com/market/");
    restoreWindow = installWindow();
  });

  after(() => {
    restoreWindow();
    dom.restore();
  });

  it("writes the version as a footnote to the name, not as a second heading", () => {
    const panel = new Panel();
    const title = find(panel.root as unknown as FakeElement, "stw-title")!;
    const version = find(panel.root as unknown as FakeElement, "stw-ver")!;

    assert.equal(title.textContent, "Steward0.0-test");
    assert.equal(version.textContent, "0.0-test");
    assert.equal(version.tagName, "SPAN");
  });

  /**
   * The subtitle used to be built from the feature list — «инвентарь · предмет»
   * over a tab bar reading «Инвентарь» and «Предмет». Two lines, one fact.
   */
  it("names the section only while there is no tab bar to name it", () => {
    const panel = new Panel();
    const root = panel.root as unknown as FakeElement;
    const sub = find(root, "stw-sub")!;

    panel.addSection("inventory", "Инвентарь");
    assert.equal(sub.textContent, "Инвентарь", "одна вкладка — подпись называет её");

    panel.addSection("listing", "Предмет");
    assert.equal(sub.textContent, "", "появились вкладки — подпись повторять их не должна");
  });

  it("keeps the first section open when a second one mounts", () => {
    const panel = new Panel();
    const first = panel.addSection("inventory", "Инвентарь");
    panel.addSection("listing", "Предмет");

    const root = panel.root as unknown as FakeElement;
    const sections = walk(root).filter((node) => node.dataset.section);
    assert.deepEqual(
      sections.map((node) => node.hidden),
      [false, true]
    );
    assert.equal(first.id, "inventory");
  });

  it("says which way the fold goes", () => {
    const panel = new Panel();
    const root = panel.root as unknown as FakeElement;
    const collapse = byTag(root, "button").find((b) => b.classList.contains("stw-iconbtn"))!;

    const click = (): void => collapse.listeners.get("click")?.forEach((fn) => fn({}));

    click();
    assert.equal(collapse.textContent, "+");
    assert.equal(collapse.title, "Развернуть");
    click();
    assert.equal(collapse.textContent, "–");
    assert.equal(collapse.title, "Свернуть");
  });

  /**
   * The caveats live behind «подробнее». A new answer is a new question, so the
   * fold must never carry the previous run's notes into it, open or closed.
   */
  it("offers «подробнее» only for an answer that has caveats", () => {
    const panel = new Panel();
    const section = panel.addSection("inventory", "Инвентарь");
    const root = panel.root as unknown as FakeElement;
    const more = find(root, "stw-status-more")!;
    const detail = find(root, "stw-status-detail")!;

    section.setStatus("На экране на 1 200,00 ₽", "ok", "Запросов 12.");
    assert.equal(more.hidden, false);
    assert.equal(detail.textContent, "Запросов 12.");

    more.open = true;
    section.setStatus("Останавливаю…", "warn");
    assert.equal(more.hidden, true, "сноски без сносок остаться не должны");
    assert.equal(more.open, false, "вчерашние заметки не открываются над новым ответом");
  });
});
