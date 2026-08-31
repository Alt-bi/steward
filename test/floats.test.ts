import "./support/env";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDynProperties, wearChip } from "../src/steam/floats";

describe("parseDynProperties", () => {
  it("keeps wear, seed and pattern under the asset's own id", () => {
    const map = parseDynProperties({
      success: 1,
      asset_properties: {
        "0": {
          assetid: "111",
          asset_properties: [
            { propertyid: 1, int_value: "962", name: "Pattern Template" },
            { propertyid: 2, float_value: "0.380850464105606079", name: "Wear Rating" },
            { propertyid: 6, string_value: "ABCDEF", name: "Item Certificate" },
          ],
        },
      },
    });
    assert.deepEqual(map.get("111"), { float: 0.380850464105606079, seed: null, pattern: 962 });
  });

  it("skips a copy without wear — a case has no float, and that is not a failure", () => {
    const map = parseDynProperties({
      asset_properties: {
        "0": { assetid: "222", asset_properties: [{ propertyid: 1, int_value: "3", name: "Pattern Template" }] },
      },
    });
    assert.equal(map.size, 0);
  });
});

describe("wearChip", () => {
  const w = (float: number) => ({ float, seed: null, pattern: null });

  it("one number when every copy of the stack carries the same wear", () => {
    assert.equal(wearChip([w(0.24), w(0.24)]), "float 0.24");
  });

  it("a range when they differ, to three decimals", () => {
    assert.equal(wearChip([w(0.15), w(0.3808504)]), "float 0.15–0.381");
  });

  it("nothing at all when there is nothing to say", () => {
    assert.equal(wearChip([]), null);
  });
});
