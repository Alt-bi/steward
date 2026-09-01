import "./support/env";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resetEnv, setAcquire, setLocalSettings, setSteam } from "./support/env";
import {
  byTag,
  createElement,
  fire,
  installBridge,
  installDom,
  type DomHandle,
  type FakeBridge,
  type FakeElement,
} from "./support/dom";

import "../src/content/features/farm";
import { allFeatures } from "../src/content/features/registry";
import { DEFAULT_SETTINGS } from "../src/core/settings";

/**
 * The farm tab, actually built.
 *
 * `boot()` wraps every `mount()` in a try/catch, so a feature that throws on
 * mount costs the user the whole tab and costs us one console line nobody
 * reads — it looks exactly like «ничего не работает». Nothing offline covered
 * that until now: the engine had eleven tests and the interface had none.
 */

const farm = () => allFeatures().find((f) => f.id === "farm")!;

const EMPTY_FARM = { running: false, playing: [], names: {}, log: [], leader: "", leaderAt: 0 };

/** Stands in for the shared panel: the section is all the feature touches. */
function fakePanel(): { body: FakeElement; status: string[]; panel: never } {
  const body = createElement("div");
  const status: string[] = [];
  const panel = {
    addSection: () => ({
      id: "farm",
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

describe("the farm tab mounts", () => {
  let dom: DomHandle;

  beforeEach(async () => {
    await resetEnv();
    dom = installDom();
  });

  afterEach(() => {
    dom.restore();
  });

  it("builds without throwing, and arms its timers", async () => {
    const { body, panel } = fakePanel();
    await farm().mount({ panel, settings: DEFAULT_SETTINGS, url: new URL(location.href) });
    await settle();
    assert.equal(body.children.length > 0, true);
    // heartbeat, watchdog — the scan loop only arms once the farm is running.
    assert.equal(dom.intervals.length >= 2, true);
  });

  it("offers exactly the four controls, and no way to exclude a game", async () => {
    const { body, panel } = fakePanel();
    await farm().mount({ panel, settings: DEFAULT_SETTINGS, url: new URL(location.href) });
    await settle();

    const labels = byTag(body, "button").map((b) => b.textContent);
    assert.deepEqual(labels, ["Старт", "Стоп", "Пересчитать", "Забрать себе"]);
    // The queue, the tick-list, the auto switch and the forever-ban «×» are
    // gone for good: each was a way to run a factory that excluded everything.
    assert.equal(byTag(body, "input").length, 0);
    const text = body.textContent;
    for (const dead of ["Отмеченные", "вернуть все", "фармить все игры", "снять"]) {
      assert.equal(text.includes(dead), false, `«${dead}» всё ещё на вкладке`);
    }
  });

  it("ignores a queue and a ban list left in storage by an old build", async () => {
    // Exactly the state the user was stuck in: five games banned forever, the
    // farm running, nothing playing. The new build must not read any of it.
    setLocalSettings({
      stwFarm: {
        running: true,
        playing: [],
        queue: [730, 440],
        dropped: [1, 2, 3, 4, 5],
        auto: false,
        names: {},
        log: [],
        leader: "",
        leaderAt: 0,
      },
    });
    const { body, panel, status } = fakePanel();
    await farm().mount({ panel, settings: DEFAULT_SETTINGS, url: new URL(location.href) });
    await settle();

    const said = status.join(" | ");
    assert.equal(said.includes("×"), false, said);
    assert.equal(said.includes("съел"), false, said);
    assert.equal(body.textContent.includes("вернуть все"), false);
  });
});

describe("«Пересчитать» leaves the panel usable", () => {
  let dom: DomHandle;

  beforeEach(async () => {
    await resetEnv();
    dom = installDom();
    const page =
      '<html><body>' +
      '<div id="badge_gamebadge_730_1_0"><div class="badge_title">CS&nbsp;<span>' +
      '<span class="progress_info_bold">3 card drops remaining</span></div>' +
      '<div class="badge_pagination">Showing 1-1 of 1 badges</div></body></html>';
    setSteam(() => ({ status: 200, body: page }));
  });

  afterEach(() => {
    dom.restore();
  });

  it("re-enables «Старт» after the scan finishes", async () => {
    // The regression: the tick redrew the panel from inside its own try block,
    // while `busy` was still set — and `render` disables «Старт» and
    // «Пересчитать» while busy. `busy` dropped a moment later in `finally` with
    // nothing left to repaint, so both buttons stayed dead and the farm could
    // never be started. Exactly what the user hit.
    const { body, panel, status } = fakePanel();
    await farm().mount({ panel, settings: DEFAULT_SETTINGS, url: new URL(location.href) });
    await settle();

    const button = (label: string): FakeElement =>
      byTag(body, "button").find((b) => b.textContent === label)!;

    assert.equal(button("Старт").disabled, false, "«Старт» должен быть доступен до скана");
    fire(button("Пересчитать"));

    // The scan crosses the fake network and the scheduler; wait for it to land.
    for (let i = 0; i < 200 && status.at(-1)?.includes("Готово к старту") !== true; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.match(status.at(-1) ?? "", /Готово к старту: 1/);
    assert.equal(button("Старт").disabled, false, "«Старт» заблокирован после скана");
    assert.equal(button("Пересчитать").disabled, false, "«Пересчитать» заблокирован после скана");
    assert.equal(body.textContent.includes("CS"), true, "игра не попала в список");
  });
});

describe("a factory that was just switched on", () => {
  let dom: DomHandle;
  let bridge: FakeBridge;

  beforeEach(async () => {
    await resetEnv();
    dom = installDom();
    bridge = installBridge();
    // The badges gate paces real walks to a page every ten seconds; that delay
    // is the thing being worked around here, not the thing under test.
    setAcquire(() => ({ ok: true as const }));
    // Two pages, so the walk cannot finish on the first one — the state the
    // user actually sits in for a minute or two.
    setSteam((url) => {
      const page = /p=(\d+)/.exec(url)?.[1] === "2" ? 2 : 1;
      const appid = page === 1 ? 730 : 440;
      return {
        status: 200,
        body:
          `<div id="badge_gamebadge_${appid}_1_0"><div class="badge_title">Game${appid}&nbsp;<span>` +
          '<span class="progress_info_bold">5 card drops remaining</span></div>' +
          '<div class="badge_pagination">Showing 1-1 of 2 badges</div>',
      };
    });
  });

  afterEach(() => {
    setAcquire(null);
    bridge.restore();
    dom.restore();
  });

  it("says it is starting up instead of crying that the chat claimed nothing", async () => {
    // `running` with an empty bench used to print the red «Крутится, но чат не
    // поставил ни одной игры» the moment «Старт» was pressed, and kept printing
    // it for the whole badge walk. It is not an error until we have looked.
    setLocalSettings({ stwFarm: { ...EMPTY_FARM, running: true } });
    const { panel, status } = fakePanel();
    await farm().mount({ panel, settings: DEFAULT_SETTINGS, url: new URL(location.href) });
    await settle();

    const said = status.join(" | ");
    assert.equal(said.includes("не поставил ни одной игры"), false, said);
    assert.match(said, /Запускаюсь/);
  });

  it("claims the first games off page one, without waiting for the whole walk", async () => {
    // The user's report: «начало фармить только спустя 1-2 минуты». The walk is
    // rate-paced by design — a page every few seconds — so the bench used to
    // stay empty for the length of the whole library. It does not have to wait.
    const { body, panel, status } = fakePanel();
    await farm().mount({ panel, settings: DEFAULT_SETTINGS, url: new URL(location.href) });
    await settle();
    fire(byTag(body, "button").find((b) => b.textContent === "Старт")!);

    for (let i = 0; i < 200 && !bridge.calls.some((c) => c.type === "cm-play/swap"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const swap = bridge.calls.find((c) => c.type === "cm-play/swap");
    assert.ok(swap, "заявка не ушла в чат");
    assert.deepEqual(
      swap.entries?.map((e) => e.appid),
      [730],
      "в чат ушла не та игра — на первой странице только 730"
    );
    // ...and the panel shows it, not an empty list.
    assert.equal(body.textContent.includes("Game730"), true);
    assert.equal(body.textContent.includes("в игре"), true);

    // Let the full walk land before the shim is torn down: page two adds 440,
    // and the rotation must not still be drawing into a restored document.
    for (let i = 0; i < 200 && status.at(-1)?.includes("Фабрика идёт") !== true; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.match(status.at(-1) ?? "", /Фабрика идёт: в игре 2/);

    // Switch it off inside the test: a factory left running holds a pending
    // bridge call, and the suite would sit on its five-second timeout.
    fire(byTag(body, "button").find((b) => b.textContent === "Стоп")!);
    for (let i = 0; i < 100 && !bridge.calls.some((c) => c.type === "cm-play/stop"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(bridge.claimed, [], "заявка не снята");
  });
});
