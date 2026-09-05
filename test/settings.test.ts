import "./support/env";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { resetEnv, setLocalSettings } from "./support/env";
import { DEFAULT_SETTINGS, FIXED_SETTINGS, loadSettings } from "../src/core/settings";
import { DEFAULT_SELL_SETTINGS } from "../src/core/sell";

/**
 * The settings that stopped being settings.
 *
 * They are stamped over storage on every read rather than merely defaulted, and
 * the difference is the whole point: an eight-second pause, a `priceoverview`
 * source, a selling strategy — each was written by a control that no longer
 * exists, and a value that outlives its control is a setting nobody can find
 * and nobody can change.
 */
describe("a standard that storage cannot outvote", () => {
  beforeEach(async () => {
    await resetEnv();
  });

  it("ignores what the old popup fields left behind", async () => {
    setLocalSettings({
      delayMs: 8000,
      undercutCents: 250,
      maxDropPercent: 100,
      scanConcurrency: 4,
      priceSource: "priceoverview",
      priceTtlMinutes: 1440,
      quickBuyMaxCents: 10_000_000,
      exactCompetitorLow: false,
      onePerItem: false,
      skipSelfUndercut: false,
    });

    const settings = await loadSettings();
    for (const [key, value] of Object.entries(FIXED_SETTINGS)) {
      assert.deepEqual(
        settings[key as keyof typeof FIXED_SETTINGS],
        value,
        `«${key}» всё ещё читается из хранилища`
      );
    }
  });

  it("ignores the strategy the inventory picker used to write", async () => {
    setLocalSettings({
      sell: { strategy: "avg365", undercutCents: 12, markupPercent: 90, maxPerItem: 1, minBuyerCents: 500 },
    });

    const settings = await loadSettings();
    assert.deepEqual(settings.sell, DEFAULT_SELL_SETTINGS);
    /** «По минимуму рынка» — the one strategy that needs nothing we have not fetched. */
    assert.equal(settings.sell.strategy, "match");
  });

  it("still carries the things that are not settings", async () => {
    setLocalSettings({ features: { reprice: false } });
    const settings = await loadSettings();
    assert.equal(settings.features.reprice, false, "выключенная вкладка — не настройка цены");
  });

  it("states the standard once, in the defaults", async () => {
    const settings = await loadSettings();
    assert.deepEqual(settings.sell, DEFAULT_SETTINGS.sell);
    assert.equal(settings.delayMs, DEFAULT_SETTINGS.delayMs);
  });
});
