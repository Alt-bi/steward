import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buyerPrice, DEFAULT_FEES, feesFromWallet, sellerForBuyer } from "../src/core/fees";

const fees = DEFAULT_FEES;

describe("fee arithmetic", () => {
  it("charges the Steam minimum on cheap items", () => {
    /** 5% of 10 kopecks rounds below the 1-kopeck floor, so the floor applies. */
    assert.equal(buyerPrice(10, 0.1, fees), 10 + 1 + 1);
  });

  it("charges both percentages on expensive items", () => {
    assert.equal(buyerPrice(10000, 0.1, fees), 10000 + 500 + 1000);
  });

  it("returns zero for a non-price", () => {
    assert.equal(buyerPrice(0, 0.1, fees), 0);
    assert.equal(buyerPrice(-5, 0.1, fees), 0);
  });

  it("is monotonic, which is what makes the inverse a binary search", () => {
    let previous = -1;
    for (let seller = 1; seller <= 5000; seller++) {
      const buyer = buyerPrice(seller, 0.1, fees);
      assert.ok(buyer > previous, `not increasing at ${seller}`);
      previous = buyer;
    }
  });
});

describe("sellerForBuyer", () => {
  it("never overshoots the ceiling and is always the largest that fits", () => {
    for (let target = 1; target <= 4000; target++) {
      const seller = sellerForBuyer(target, 0.1, fees);
      if (seller === 0) continue;
      assert.ok(buyerPrice(seller, 0.1, fees) <= target, `overshoot at ${target}`);
      assert.ok(buyerPrice(seller + 1, 0.1, fees) > target, `not maximal at ${target}`);
    }
  });

  it("gives up rather than inventing a price below the Steam floor", () => {
    assert.equal(sellerForBuyer(0, 0.1, fees), 0);
    assert.equal(sellerForBuyer(2, 0.1, fees), 0);
  });

  it("handles a game with no publisher fee", () => {
    const seller = sellerForBuyer(1000, 0, fees);
    assert.ok(seller > 0);
    assert.ok(buyerPrice(seller, 0, fees) <= 1000);
  });
});

describe("feesFromWallet", () => {
  it("takes the wallet numbers when Steam supplies them", () => {
    const parsed = feesFromWallet({
      wallet_fee_percent: "0.05",
      wallet_fee_minimum: "1",
      wallet_fee_base: "0",
      wallet_publisher_fee_percent_default: "0.10",
    });
    assert.equal(parsed.steamPercent, 0.05);
    assert.equal(parsed.steamMinimum, 1);
  });

  it("falls back to defaults for a missing or broken wallet", () => {
    assert.deepEqual(feesFromWallet(null), DEFAULT_FEES);
    const broken = feesFromWallet({ wallet_fee_percent: "nonsense" });
    assert.equal(broken.steamPercent, DEFAULT_FEES.steamPercent);
  });
});
