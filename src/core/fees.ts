import type { Cents, WalletInfo } from "./types";

/**
 * Steam takes two cuts off the seller's asking price: its own wallet fee and the
 * publisher fee of the game. The buyer pays the sum. All figures are integer cents.
 */
export interface FeeConfig {
  steamPercent: number;
  /**
   * The floor under *each* fee, not just Steam’s own.
   *
   * Measured 2026-09-03 on a RUB wallet, where it is 87: a card listed at the
   * market floor shows «2,61 руб. (0,87 руб.)», and 87 + 87 + 87 is the only
   * arithmetic that reaches it. Steam’s own `CalculateFeeAmount` floors the
   * publisher cut at the same number as its own, and every one of the ten lots
   * on that page agrees with that formula and only that one.
   */
  steamMinimum: Cents;
  steamBase: Cents;
  publisherPercentDefault: number;
  /**
   * Least the seller may receive. A price below it is not a cheap listing, it is
   * a listing Steam will not accept — and finding that out after `removelisting`
   * means the lot is off the market with nothing to put back.
   */
  marketMinimum: Cents;
}

export const DEFAULT_FEES: FeeConfig = {
  steamPercent: 0.05,
  steamMinimum: 1,
  steamBase: 0,
  publisherPercentDefault: 0.1,
  marketMinimum: 1,
};

export function feesFromWallet(wallet: WalletInfo | null | undefined): FeeConfig {
  if (!wallet) return { ...DEFAULT_FEES };
  const num = (v: unknown, fallback: number) => {
    const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    steamPercent: num(wallet.wallet_fee_percent, DEFAULT_FEES.steamPercent) || DEFAULT_FEES.steamPercent,
    steamMinimum: Math.round(num(wallet.wallet_fee_minimum, DEFAULT_FEES.steamMinimum)),
    steamBase: Math.round(num(wallet.wallet_fee_base, DEFAULT_FEES.steamBase)),
    publisherPercentDefault:
      num(wallet.wallet_publisher_fee_percent_default, DEFAULT_FEES.publisherPercentDefault) ||
      DEFAULT_FEES.publisherPercentDefault,
    marketMinimum: Math.round(num(wallet.wallet_market_minimum, DEFAULT_FEES.marketMinimum)) || DEFAULT_FEES.marketMinimum,
  };
}

/** What the buyer pays when the seller wants to receive `sellerCents`. */
export function buyerPrice(sellerCents: Cents, publisherFeePercent: number, fees: FeeConfig): Cents {
  const receive = Math.trunc(sellerCents) || 0;
  if (receive <= 0) return 0;
  const pub = Number.isFinite(publisherFeePercent) ? publisherFeePercent : fees.publisherPercentDefault;
  const steamFee = Math.floor(Math.max(receive * fees.steamPercent, fees.steamMinimum) + fees.steamBase);
  /**
   * The same floor as Steam’s own cut — not 1. On a RUB wallet that is the
   * difference between 1,82 and 2,61 on every card sitting at the market floor,
   * and half a page of a card account sits exactly there.
   */
  const pubFee = pub > 0 ? Math.floor(Math.max(receive * pub, fees.steamMinimum)) : 0;
  return receive + steamFee + pubFee;
}

/** Cheapest a lot can legally be offered at: the market floor, plus its fees. */
export function minBuyerPrice(publisherFeePercent: number, fees: FeeConfig): Cents {
  return buyerPrice(Math.max(1, fees.marketMinimum), publisherFeePercent, fees);
}

/**
 * Largest seller-receive amount whose buyer price stays at or below `targetBuyer`.
 * `buyerPrice` is monotonic in `sellerCents`, so a binary search is exact — no need
 * for the iterative correction loop Steam's own market.js uses.
 */
export function sellerForBuyer(targetBuyer: Cents, publisherFeePercent: number, fees: FeeConfig): Cents {
  const target = Math.trunc(targetBuyer) || 0;
  if (target <= 0) return 0;
  /**
   * Never search below the market floor. Without this the search happily lands
   * on a seller amount Steam refuses — and because the floored fees then apply,
   * the price it reports is *higher* than the one asked for: on a RUB wallet a
   * target of 2,60 came back as a listing at 3,32.
   */
  let lo = Math.max(1, fees.marketMinimum);
  let hi = target;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (buyerPrice(mid, publisherFeePercent, fees) <= target) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
