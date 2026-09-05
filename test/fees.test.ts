import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buyerPrice, DEFAULT_FEES, feesFromWallet, minBuyerPrice, sellerForBuyer } from "../src/core/fees";

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

/**
 * The RUB wallet, as it answered on 2026-09-03, and the ten lots it priced.
 *
 * This is here because the arithmetic was wrong for five of those ten and the
 * mistake was invisible: the publisher cut was floored at 1 kopeck instead of
 * at the wallet’s own minimum, so every card sitting on the market floor was
 * read as 1,82 ₽ when Steam shows 2,61 ₽ — and the reprice it computed from
 * that would have listed the lot *higher* while reporting a cut.
 */
describe("a RUB wallet, measured", () => {
  const rub = feesFromWallet({
    wallet_currency: 5,
    wallet_fee_percent: "0.05",
    wallet_fee_minimum: "87",
    wallet_fee_base: "0",
    wallet_market_minimum: "87",
    wallet_publisher_fee_percent_default: "0.10",
  });

  it("reads the floor Steam refuses to go below", () => {
    assert.equal(rub.steamMinimum, 87);
    assert.equal(rub.marketMinimum, 87);
  });

  it("prices the market floor at 2,61, the way the page shows it", () => {
    assert.equal(buyerPrice(87, 0.1, rub), 261, "87 + 87 + 87, both cuts floored");
    assert.equal(minBuyerPrice(0.1, rub), 261);
  });

  it("prices the lots above the floor exactly as the page shows them", () => {
    /** Every one of these was read off /market on the day. */
    for (const [seller, buyer] of [
      [7068, 8127],
      [2429, 2792],
      [7598, 8736],
      [53845, 61921],
      [7863, 9042],
    ] as const) {
      assert.equal(buyerPrice(seller, 0.1, rub), buyer, `${seller} -> ${buyer}`);
    }
  });

  it("refuses to invent a price under the floor instead of quietly raising it", () => {
    /**
     * The old search answered 158 here: a listing Steam prices at 3,32 in
     * answer to «поставь 2,60». Refusing is the only honest answer.
     */
    assert.equal(sellerForBuyer(260, 0.1, rub), 0);
    assert.equal(sellerForBuyer(261, 0.1, rub), 87);
  });
});
