import "./support/env";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { csvCell, csvDoc } from "../src/core/csv";

/**
 * Every escape here is built from codes: the build pipeline of this repo has
 * eaten raw CR/LF and quote escapes twice before writing a test file.
 */
const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);
const BOM = String.fromCharCode(0xfeff);
const Q = String.fromCharCode(34);

describe("csv survives the names Steam actually sends", () => {
  it("wraps a comma-carrying item name in doubled quotes", () => {
    const cell = csvCell("AK-47 | Redline (Field-Tested), Minimal Wear");
    assert.equal(cell, Q + "AK-47 | Redline (Field-Tested), Minimal Wear" + Q);
  });

  it("doubles a quote inside the text", () => {
    const cell = csvCell("say " + Q + "hello" + Q + ", twice");
    assert.equal(cell, Q + "say " + Q + Q + "hello" + Q + Q + ", twice" + Q);
  });

  it("leaves plain text and numbers bare", () => {
    assert.equal(csvCell("StatTrak"), "StatTrak");
    assert.equal(csvCell(42), "42");
    assert.equal(csvCell(null), "");
  });

  it("opens with a BOM so Excel reads Cyrillic, and joins lines CRLF", () => {
    const doc = csvDoc(["Предмет", "Кол-во"], [["АК-47, Redline", 2]]);
    assert.ok(doc.startsWith(BOM), "BOM missing — Excel would mangle Russian");
    const lines = doc.slice(1).split(CR + NL);
    assert.equal(lines[0], "Предмет,Кол-во");
    assert.equal(lines[1], Q + "АК-47, Redline" + Q + ",2");
    assert.ok(doc.endsWith(CR + NL), "a CSV without a trailing line break confuses Excel");
  });

  it("quotes a cell that tries to smuggle its own row break", () => {
    const cell = csvCell("two" + CR + NL + "lines");
    assert.ok(cell.startsWith(Q) && cell.endsWith(Q));
  });
});
