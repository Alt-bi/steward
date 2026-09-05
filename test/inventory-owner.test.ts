import "./support/env";

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { postFromPage, resetEnv } from "./support/env";
import { byTag, createElement, installDom, walk, type DomHandle, type FakeElement } from "./support/dom";

import "../src/content/features/inventory";
import { allFeatures } from "../src/content/features/registry";
import { DEFAULT_SETTINGS } from "../src/core/settings";

/**
 * The tab mounts on any `/inventory`, and a friend's backpack is one.
 *
 * Everything it offers to *read* is fine there — what a stranger's items are
 * worth is a real question. Everything it offers to *write* is not: `sellitem`
 * goes out with our session against asset ids read off their page, Steam
 * refuses it, and the refusal reads as our bug. The panel used to draw a green
 * «Выставить» over someone else's inventory and wait to be pressed.
 */

const VIEWER = "76561198000000001";
const STRANGER = "76561198000000009";

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
 * What is actually on screen.
 *
 * A hidden row hides its buttons, so «is this button reachable» cannot be asked
 * of the button alone — the first version of this helper looked only at the
 * button's own `hidden` and would have called a control inside a hidden row
 * live. It descends and stops at anything hidden, which is what the browser
 * does with `display: none`.
 */
function reachable(node: FakeElement): FakeElement[] {
  if (node.hidden) return [];
  const out: FakeElement[] = [node];
  for (const child of node.children) {
    if (child.nodeType === 1) out.push(...reachable(child as FakeElement));
  }
  return out;
}

/** Buttons that are drawn and not hidden — the ones a user can actually reach. */
function liveButtons(body: FakeElement): string[] {
  return reachable(body)
    .filter((node) => node.tagName === "BUTTON")
    .map((b) => String(b.textContent ?? ""));
}

/**
 * The words on screen.
 *
 * Leaf elements only: `textContent` on a container repeats everything under it,
 * hidden rows included, so asking the panel root what it says would answer «yes»
 * to every possible question — the first version of this helper did exactly
 * that, and its «this text is absent» assertions could not fail.
 */
function shownText(body: FakeElement): string {
  return reachable(body)
    .filter((node) => node.children.every((child) => child.nodeType !== 1))
    .map((node) => String(node.textContent ?? ""))
    .join(" ");
}

async function mountOn(url: string): Promise<{ body: FakeElement; status: string[] }> {
  const { body, panel, status } = fakePanel();
  await inventory().mount({ panel, settings: DEFAULT_SETTINGS, url: new URL(url) });
  await settle();
  return { body, status };
}

describe("whose backpack is on screen", () => {
  let dom: DomHandle;

  before(() => {
    dom = installDom(`https://steamcommunity.com/profiles/${STRANGER}/inventory`);
  });

  beforeEach(async () => {
    await resetEnv();
  });

  after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    dom.restore();
  });

  it("offers nothing to press on someone else's inventory", async () => {
    postFromPage({ source: "steward-page", sessionid: "s", steamid: VIEWER });
    const { body } = await mountOn(`https://steamcommunity.com/profiles/${STRANGER}/inventory`);

    assert.equal(
      liveButtons(body).some((label) => label.startsWith("Выставить")),
      false,
      `«Выставить» на чужой странице: ${liveButtons(body).join(" | ")}`
    );
    assert.match(shownText(body), /чужой инвентарь/i, "и панель говорит, почему кнопки нет");
  });

  it("still prices it — reading a stranger's items is a fair question", async () => {
    postFromPage({ source: "steward-page", sessionid: "s", steamid: VIEWER });
    const { body } = await mountOn(`https://steamcommunity.com/profiles/${STRANGER}/inventory`);

    assert.equal(liveButtons(body).includes("Оценить страницу"), true);
  });

  /**
   * The page names its owner outright, so a vanity URL is no longer a blind
   * spot: `g_rgProfileData.steamid` is what tells our own `/id/name/inventory`
   * apart from a friend's.
   *
   * Asked of the warning rather than of «Выставить», because that button is not
   * on screen before a scan on anybody's page — the accusation is what must not
   * appear over our own backpack.
   */
  it("believes the page over the URL", async () => {
    postFromPage({
      source: "steward-page",
      sessionid: "s",
      steamid: VIEWER,
      profileSteamid: VIEWER,
    });
    const { body } = await mountOn(`https://steamcommunity.com/profiles/${STRANGER}/inventory`);

    assert.doesNotMatch(
      shownText(body),
      /чужой инвентарь|Не могу подтвердить/i,
      "страница сказала, что владелец — мы; URL тут не судья"
    );
    assert.match(shownText(body), /Ctrl\+клик/i, "и подсказка про плитки на месте");
  });
});

/**
 * The second statement of ownership, and the reason there are two.
 *
 * `g_rgProfileData` is a global the profile header defines, and a page can
 * finish loading its grid without it. When that happens on a vanity URL the URL
 * says nothing either, and the tab used to fall back to «не могу подтвердить» —
 * on the owner's own backpack, with the write controls gone. Steam names the
 * owner a second time in the id of every grid it draws.
 */
describe("the owner named by the drawn grid", () => {
  let dom: DomHandle;

  /**
   * A stranger's vanity URL with no profile global — the case where the URL
   * knows nothing, `g_rgProfileData` never came, and the grid is the only thing
   * on the page that says whose items these are. Asserted in this direction
   * because it is the one that can do harm: without the grid the panel says
   * nothing at all and the first paint looks exactly like our own backpack.
   */
  before(() => {
    const grid = createElement("div");
    grid.className = "inventory_ctn";
    grid.id = `inventory_${STRANGER}_730_2`;
    dom = installDom("https://steamcommunity.com/id/vanity/inventory", { byId: { grid } });
  });

  beforeEach(async () => {
    await resetEnv();
  });

  after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    dom.restore();
  });

  it("knows a stranger's backpack from a vanity URL the moment it is drawn", async () => {
    /** `profileSteamid: null` is the case: the page loaded without the global. */
    postFromPage({
      source: "steward-page",
      sessionid: "s",
      steamid: VIEWER,
      profileSteamid: null,
    });
    const { body } = await mountOn("https://steamcommunity.com/id/vanity/inventory");

    assert.match(shownText(body), /чужой инвентарь/i);
    assert.equal(
      shownText(body).includes("Ctrl+клик"),
      false,
      "и подсказка про выбор плиток тоже ни к чему"
    );
  });
});
