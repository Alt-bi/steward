import "./support/env";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resetEnv } from "./support/env";
import { byTag, createElement, installDom, walk, type DomHandle, type FakeElement } from "./support/dom";

import "../src/content/features/reprice";
import "../src/content/features/inventory";
import "../src/content/features/offers";
import "../src/content/features/trade";
import "../src/content/features/listing";
import "../src/content/features/cards";
import "../src/content/features/farm";
import { activeFeatures, allFeatures } from "../src/content/features/registry";
import { DEFAULT_SETTINGS } from "../src/core/settings";

/**
 * Every tab, built.
 *
 * `boot()` wraps each `mount()` in a try/catch, so a feature that throws costs
 * the user that whole tab and costs us one console line nobody reads. It looks
 * exactly like «ничего не работает», and it is invisible to every other test
 * here, because everything else tests the parsers underneath the interface.
 *
 * This is deliberately shallow — mounts, draws something, offers controls that
 * are not all dead. Behaviour belongs in each feature's own test.
 */

/** The pages each feature claims, in the form the content script sees them. */
const PAGES: Record<string, string> = {
  reprice: "https://steamcommunity.com/market/",
  inventory: "https://steamcommunity.com/id/user/inventory/",
  offers: "https://steamcommunity.com/id/user/tradeoffers/",
  trade: "https://steamcommunity.com/tradeoffer/new/?partner=1",
  listing: "https://steamcommunity.com/market/listings/730/Fracture%20Case",
  cards: "https://steamcommunity.com/id/user/badges/",
  farm: "https://steamcommunity.com/chat/",
};

/** Stands in for the shared panel: the section is all a feature touches. */
function fakePanel(): { body: FakeElement; status: string[]; panel: never } {
  const body = createElement("div");
  const status: string[] = [];
  const panel = {
    addSection: () => ({
      id: "x",
      body,
      setStatus: (text: string) => status.push(text),
      show: () => {},
    }),
  };
  return { body, status, panel: panel as never };
}

async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("every feature mounts on the page it claims", () => {
  let dom: DomHandle;

  afterEach(() => {
    dom?.restore();
  });

  for (const feature of allFeatures()) {
    it(`«${feature.title}» builds without throwing`, async () => {
      await resetEnv();
      const url = PAGES[feature.id];
      assert.ok(url, `нет страницы для фичи ${feature.id} — допиши PAGES`);
      dom = installDom(url);

      const { body, panel } = fakePanel();
      await feature.mount({ panel, settings: DEFAULT_SETTINGS, url: new URL(url) });
      await settle();

      assert.equal(body.children.length > 0, true, "вкладка пустая");
      // A tab whose every button is disabled from the first paint is a dead
      // tab: there is nothing the user can press to get it going.
      const buttons = byTag(body, "button");
      if (buttons.length) {
        assert.equal(
          buttons.some((b) => !b.disabled && !b.hidden),
          true,
          "все кнопки вкладки заблокированы сразу после монтирования"
        );
      }
    });
  }

  it("claims the page it says it claims", () => {
    for (const feature of allFeatures()) {
      const url = new URL(PAGES[feature.id]!);
      assert.equal(feature.matches(url), true, `${feature.id} не сработала на ${url.pathname}`);
    }
  });

  it("puts exactly the market tabs on the market front page", () => {
    const url = new URL("https://steamcommunity.com/market/");
    const ids = activeFeatures(url, DEFAULT_SETTINGS).map((f) => f.id);
    assert.deepEqual(ids, ["reprice"]);
  });

  it("leaves the item page to the listing tab alone", () => {
    // `reprice` deliberately steps aside here: the item page has its own tab,
    // and two panels arguing about one item is how the old build looked.
    const url = new URL("https://steamcommunity.com/market/listings/730/Fracture%20Case");
    const ids = activeFeatures(url, DEFAULT_SETTINGS).map((f) => f.id);
    assert.deepEqual(ids, ["listing"]);
  });

});

/** A quick structural read of one tab, used while auditing the design. */
export function outline(body: FakeElement): string[] {
  return walk(body).map((n) => `${n.tagName.toLowerCase()}.${n.className}`);
}
