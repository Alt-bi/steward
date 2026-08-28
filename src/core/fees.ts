import type { Cents, WalletInfo } from "./types";

/**
 * Steam takes two cuts off the seller's asking price: its own wallet fee and the
 * publisher fee of the game. The buyer pays the sum. All figures are integer cents.
 */
export interface FeeConfig {
  steamPercent: number;
  steamMinimum: Cents;
  steamBase: Cents;
  publisherPercentDefault: number;
}

export const DEFAULT_FEES: FeeConfig = {
  steamPercent: 0.05,
  steamMinimum: 1,
  steamBase: 0,
  publisherPercentDefault: 0.1,
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
  };
}

/** What the buyer pays when the seller wants to receive `sellerCents`. */
export function buyerPrice(sellerCents: Cents, publisherFeePercent: number, fees: FeeConfig): Cents {
  const receive = Math.trunc(sellerCents) || 0;
  if (receive <= 0) return 0;
  const pub = Number.isFinite(publisherFeePercent) ? publisherFeePercent : fees.publisherPercentDefault;
  const steamFee = Math.floor(Math.max(receive * fees.steamPercent, fees.steamMinimum) + fees.steamBase);
  const pubFee = pub > 0 ? Math.floor(Math.max(receive * pub, 1)) : 0;
  return receive + steamFee + pubFee;
}

/**
 * Largest seller-receive amount whose buyer price stays at or below `targetBuyer`.
 * `buyerPrice` is monotonic in `sellerCents`, so a binary search is exact — no need
 * for the iterative correction loop Steam's own market.js uses.
 */
export function sellerForBuyer(targetBuyer: Cents, publisherFeePercent: number, fees: FeeConfig): Cents {
  const target = Math.trunc(targetBuyer) || 0;
  if (target <= 0) return 0;
  let lo = 1;
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
