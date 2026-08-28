import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  confusableCharacters,
  editDistance,
  foldName,
  hasInvisibleCharacters,
  hasMixedScripts,
  nameSimilarity,
} from "../src/core/text";

const ZERO_WIDTH = "​";
const SOFT_HYPHEN = "­";

describe("hasInvisibleCharacters", () => {
  it("finds a zero-width space hiding in a name", () => {
    assert.equal(hasInvisibleCharacters(`Chroma${ZERO_WIDTH} Case`), true);
  });

  it("finds a soft hyphen", () => {
    assert.equal(hasInvisibleCharacters(`Chroma${SOFT_HYPHEN}Case`), true);
  });

  it("leaves ordinary names alone", () => {
    assert.equal(hasInvisibleCharacters("AK-47 | Redline (Field-Tested)"), false);
    assert.equal(hasInvisibleCharacters("★ Karambit | Doppler"), false);
    assert.equal(hasInvisibleCharacters(""), false);
  });

  it("is not confused by repeated calls, having no shared regex state", () => {
    const name = `a${ZERO_WIDTH}b`;
    assert.equal(hasInvisibleCharacters(name), true);
    assert.equal(hasInvisibleCharacters(name), true, "a lastIndex bug would make this false");
  });
});

describe("hasMixedScripts", () => {
  it("catches a Cyrillic letter inside a Latin name", () => {
    /** "Chrom" + Cyrillic а + " Case" reads identically to the real item. */
    assert.equal(hasMixedScripts("Chromа Case"), true);
  });

  it("catches Greek lookalikes", () => {
    assert.equal(hasMixedScripts("Chromα Case"), true);
  });

  it("accepts a wholly Latin name", () => {
    assert.equal(hasMixedScripts("Chroma Case"), false);
  });

  it("accepts a wholly Cyrillic name, which is not a disguise", () => {
    assert.equal(hasMixedScripts("Ящик"), false);
  });
});

describe("confusableCharacters", () => {
  it("reports which characters are the impostors", () => {
    assert.deepEqual(confusableCharacters("Chromа Cаse"), ["а"]);
  });

  it("reports nothing for a clean name", () => {
    assert.deepEqual(confusableCharacters("Chroma Case"), []);
  });
});

describe("foldName", () => {
  it("maps lookalikes onto Latin so a disguise folds to the original", () => {
    assert.equal(foldName("Chromа Cаse"), foldName("Chroma Case"));
  });

  it("strips invisibles, punctuation and case", () => {
    assert.equal(
      foldName(`  AK-47 | REDLINE${ZERO_WIDTH} (Field-Tested)  `),
      "ak 47 redline field tested"
    );
  });

  it("collapses doubled spacing", () => {
    assert.equal(foldName("Chroma    Case"), foldName("Chroma Case"));
  });

  it("survives empty and non-string input", () => {
    assert.equal(foldName(""), "");
    assert.equal(foldName(undefined as unknown as string), "");
  });
});

describe("editDistance", () => {
  it("measures ordinary edits", () => {
    assert.equal(editDistance("case", "case"), 0);
    assert.equal(editDistance("case", "cases"), 1);
    assert.equal(editDistance("case", "cose"), 1);
    assert.equal(editDistance("kitten", "sitting"), 3);
  });

  it("abandons past the bound instead of doing the whole matrix", () => {
    assert.ok(editDistance("a".repeat(50), "b".repeat(50), 3) > 3);
    assert.ok(editDistance("short", "a much longer string entirely", 4) > 4);
  });

  it("is symmetric", () => {
    assert.equal(editDistance("chroma", "chrome"), editDistance("chrome", "chroma"));
  });
});

describe("nameSimilarity", () => {
  it("rates a homoglyph disguise as identical, which is the whole point", () => {
    assert.equal(nameSimilarity("Chromа Case", "Chroma Case"), 1);
  });

  it("rates a one-character swap as very close", () => {
    const score = nameSimilarity("Chroma Case", "Chrome Case");
    assert.ok(score > 0.85, `expected a near match, got ${score}`);
  });

  it("separates genuinely different items", () => {
    assert.ok(nameSimilarity("Chroma Case", "Gamma Case") < 0.86);
    assert.equal(nameSimilarity("AK-47 | Redline", "Sticker | Team Liquid"), 0);
  });

  it("does not call a container the same as its key", () => {
    const score = nameSimilarity("Mann Co. Supply Crate", "Mann Co. Supply Crate Key");
    assert.ok(score < 0.9, `these are different items, got ${score}`);
  });

  it("treats two empty names as identical and one empty as unrelated", () => {
    assert.equal(nameSimilarity("", ""), 1);
    assert.equal(nameSimilarity("Case", ""), 0);
  });
});
