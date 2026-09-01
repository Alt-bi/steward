import "./support/env";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { resetEnv, setSteam } from "./support/env";

import {
  badgeRowFrom,
  badgesPageFrom,
  dropsDelta,
  farmableRows,
  scanBadges,
  totalBadgesFrom,
} from "../src/steam/badges";

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

describe("dropsDelta — the farming receipt", () => {
  const chunk = (appid: number, drops: number) =>
    `id="badge_gamebadge_${appid}_1_0"><div class="badge_title">G${appid}&nbsp;<span>` +
    `<span class="progress_info_bold">${drops} card drops remaining</span>`;
  const row = (appid: number, drops: number) => badgeRowFrom(chunk(appid, drops))!;

  it("counts a drop that landed", () => {
    const d = dropsDelta(new Map([[440, 4]]), [row(440, 2)]);
    assert.equal(d.get(440), 2);
  });

  it("keeps quiet when nothing changed or the game fell off the list", () => {
    const before = new Map([[440, 2], [730, 1]]);
    assert.equal(dropsDelta(before, [row(440, 2)]).size, 0);
  });

  it("never calls a growing counter a drop", () => {
    assert.equal(dropsDelta(new Map([[440, 1]]), [row(440, 3)]).size, 0);
  });
});

describe("scanBadges — when is a walk actually complete", () => {
  beforeEach(async () => {
    await resetEnv();
  });

  const page = (rowsHtml: string, showing: string) =>
    `<html><body>${rowsHtml}<div class="badge_pagination">${showing}</div></body></html>`;
  const badge = (appid: number, drops: number) =>
    `<div id="badge_gamebadge_${appid}_1_0"><div class="badge_title">G${appid}&nbsp;<span>` +
    `<span class="progress_info_bold">${drops} card drops remaining</span></div>`;

  it("a page that parsed to nothing is NOT a complete scan", async () => {
    // Steam moved the markup (or served a wall). Zero rows read as a complete
    // scan told the rotation engine every game had finished at once — the
    // factory retired itself and banned every game from ever coming back.
    setSteam(() => ({ status: 200, body: "<html><body>nothing we recognise</body></html>" }));
    const scan = await scanBadges({ maxPages: 3 });
    assert.deepEqual(scan.rows, []);
    assert.equal(scan.complete, false);
  });

  it("a shelf Steam itself calls empty IS complete", async () => {
    setSteam(() => ({ status: 200, body: page("", "Showing 0-0 of 0 badges") }));
    const scan = await scanBadges({ maxPages: 3 });
    assert.equal(scan.totalBadges, 0);
    assert.equal(scan.complete, true);
  });

  it("a short final page still completes the walk", async () => {
    setSteam((url) =>
      url.includes("p=1")
        ? { status: 200, body: page(badge(730, 2) + badge(440, 1), "Showing 1-2 of 9 badges") }
        : { status: 200, body: page("", "Showing 1-2 of 9 badges") }
    );
    const scan = await scanBadges({ maxPages: 3 });
    assert.equal(scan.rows.length, 2);
    assert.equal(scan.complete, true);
  });

  it("the page ceiling is still an incomplete walk", async () => {
    setSteam(() => ({ status: 200, body: page(badge(730, 2), "Showing 1-1 of 900 badges") }));
    const scan = await scanBadges({ maxPages: 2 });
    assert.equal(scan.complete, false);
  });
});
