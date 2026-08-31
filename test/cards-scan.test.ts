import "./support/env";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { badgeRowFrom, badgesPageFrom, farmableRows, totalBadgesFrom } from "../src/steam/badges";

/**
 * The badges page, as the rewritten community actually serves it.
 * Captured 2026-08-31 from a live account (redacted: no profile names,
 * steamIDs, or avatars survive the capture). Re-capture with the browser —
 * do not hand-edit.
 */

function fixture(): string {
  return readFileSync(join(process.cwd(), "test", "fixtures", "badges-page1.html"), "utf8");
}

const body = fixture();
const rows = badgesPageFrom(body);

describe("badges page, as served", () => {
  it("carries the footer total the walk needs", () => {
    assert.equal(totalBadgesFrom(body), 296);
  });

  it("parses every badge the sheet holds", () => {
    assert.equal(rows.length, 147);
    assert.ok(rows.every((r) => Number.isInteger(r.appid) && r.appid > 0));
  });

  it("reads appid, drops, and collected out of one known row", () => {
    const conflict = rows.find((r) => r.name === "ConflictCraft");
    assert.ok(conflict);
    assert.equal(conflict.appid, 495570);
    assert.equal(conflict.dropsRemaining, 0);
    assert.equal(conflict.cardsCollected, 3);
    assert.equal(conflict.cardsTotal, 7);
    assert.equal(conflict.foil, false);
  });

  it("keeps foil rows aside instead of double-counting drops", () => {
    const foils = rows.filter((r) => r.foil);
    assert.equal(foils.length, 1);
    assert.equal(foils[0]!.name, "Leap Up no jutsu");
    assert.equal(foils[0]!.dropsRemaining, null);
  });

  it("finds the games that still owe drops, and nothing else", () => {
    const farmable = farmableRows({ rows, totalBadges: 296, complete: true });
    assert.equal(farmable.length, 20);
    assert.ok(farmable.every((r) => (r.dropsRemaining ?? 0) > 0));
    const hyposphere = farmable.find((r) => r.name === "Hyposphere");
    assert.ok(hyposphere);
    assert.equal(hyposphere.dropsRemaining, 6);
  });

  it("does not confuse the singular row with a missing counter", () => {
    /** «1 card drop remaining» (singular) is a real one, not a parsing miss. */
    const singular = rows.filter((r) => r.dropsRemaining === 1);
    assert.equal(singular.length, 3);
  });
});

describe("badgeRowFrom, on hand-built markup", () => {
  const chunk = (appid: number, title: string, drops: string | null, suffix = "0") =>
    `id="badge_gamebadge_${appid}_1_${suffix}">` +
    `<div class="badge_title">${title}&nbsp;<span class="badge_view_details">` +
    (drops ? `<span class="progress_info_bold">${drops}</span>` : "") +
    `<div class="badge_progress_info"> 2 of 5 cards collected </div>`;

  it("counts a real drop number", () => {
    const row = badgeRowFrom(chunk(730, "Counter-Strike 2", "3 card drops remaining"));
    assert.ok(row);
    assert.equal(row.dropsRemaining, 3);
    assert.equal(row.name, "Counter-Strike 2");
  });

  it("counts «No card drops remaining» as zero, not absent", () => {
    const row = badgeRowFrom(chunk(730, "CS", "No card drops remaining"));
    assert.ok(row);
    assert.equal(row.dropsRemaining, 0);
  });

  it("marks a foil title as foil and strips the suffix", () => {
    const row = badgeRowFrom(chunk(730, "CS\t\t- Foil Badge", null));
    assert.ok(row);
    assert.equal(row.foil, true);
    assert.equal(row.name, "CS");
    assert.equal(row.dropsRemaining, null);
  });

  it("survives a thousands separator", () => {
    const row = badgeRowFrom(chunk(730, "Big", "1,0 card drops remaining"));
    assert.ok(row);
    assert.equal(row.dropsRemaining, 10);
  });

  it("knows the badge level from the id suffix", () => {
    const row = badgeRowFrom(chunk(730, "CS", "No card drops remaining", "2"));
    assert.ok(row);
    assert.equal(row.level, 3);
  });
});
