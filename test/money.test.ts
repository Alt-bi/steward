import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatCents, parseMoneyToCents } from "../src/core/money";

describe("parseMoneyToCents", () => {
  it("reads the Russian format, whose suffix carries its own dot", () => {
    /** The regression that inflated every RUB price a hundredfold. */
    assert.equal(parseMoneyToCents("1 234,56 pуб."), 123456);
    assert.equal(parseMoneyToCents("11,50 pуб."), 1150);
    assert.equal(parseMoneyToCents("0,03 pуб."), 3);
  });

  it("reads dot-decimal and comma-grouped formats", () => {
    assert.equal(parseMoneyToCents("$1,234.56"), 123456);
    assert.equal(parseMoneyToCents("1.234,56 €"), 123456);
    assert.equal(parseMoneyToCents("12,34"), 1234);
    assert.equal(parseMoneyToCents("12.34"), 1234);
  });

  it("treats a trailing group of three as thousands, not decimals", () => {
    assert.equal(parseMoneyToCents("1 234 pуб."), 123400);
    assert.equal(parseMoneyToCents("1.234"), 123400);
  });

  it("handles a single decimal digit", () => {
    assert.equal(parseMoneyToCents("5,5"), 550);
  });

  it("returns zero for anything without digits", () => {
    assert.equal(parseMoneyToCents(""), 0);
    assert.equal(parseMoneyToCents("-"), 0);
    assert.equal(parseMoneyToCents(null), 0);
    assert.equal(parseMoneyToCents(undefined), 0);
    assert.equal(parseMoneyToCents("pуб."), 0);
  });

  it("never loses a kopeck to float arithmetic", () => {
    for (let cents = 1; cents <= 3000; cents++) {
      const text = `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")} pуб.`;
      assert.equal(parseMoneyToCents(text), cents, `round trip failed at ${cents}`);
    }
  });
});

describe("formatCents", () => {
  it("puts the symbol where the locale wants it", () => {
    assert.equal(formatCents(123456, 1), "$1234.56");
    assert.ok(formatCents(123456, 5).startsWith("1234,56"));
    assert.ok(formatCents(123456, 5).endsWith("₽"));
  });

  it("shows a dash rather than a fake zero for an unknown price", () => {
    assert.equal(formatCents(null, 5), "—");
    assert.equal(formatCents(undefined, 5), "—");
  });
});
