import type { Cents } from "./types";

/**
 * How the inventory feature prices what it lists.
 *
 * These live in `core` rather than beside the planner because settings are shared
 * with the popup, and `core` must never import from a feature.
 *
 * `match` sits exactly on the current minimum, `undercut` steps below it to sell
 * first, `markup` asks above it to wait for a better buyer.
 */
export type SellStrategy = "match" | "undercut" | "markup";

export interface SellSettings {
  strategy: SellStrategy;
  undercutCents: Cents;
  markupPercent: number;
  /** Refuse to list anything cheaper than this, to avoid dumping junk. */
  minBuyerCents: Cents;
  /** How many copies of one item to list in a single pass. */
  maxPerItem: number;
}

export const DEFAULT_SELL_SETTINGS: SellSettings = {
  strategy: "match",
  undercutCents: 1,
  markupPercent: 10,
  minBuyerCents: 0,
  maxPerItem: 5,
};

export function clampSellSettings(s: Partial<SellSettings>): Partial<SellSettings> {
  const out: Partial<SellSettings> = { ...s };
  if (out.undercutCents != null) {
    out.undercutCents = Math.min(500, Math.max(1, Math.trunc(out.undercutCents) || 1));
  }
  if (out.markupPercent != null) {
    out.markupPercent = Math.min(500, Math.max(-90, Math.trunc(out.markupPercent) || 0));
  }
  if (out.minBuyerCents != null) {
    out.minBuyerCents = Math.max(0, Math.trunc(out.minBuyerCents) || 0);
  }
  if (out.maxPerItem != null) {
    out.maxPerItem = Math.min(100, Math.max(1, Math.trunc(out.maxPerItem) || 1));
  }
  return out;
}

/** The buyer price the strategy asks for, before fee rounding. */
export function targetForStrategy(marketLow: Cents, settings: SellSettings): Cents {
  switch (settings.strategy) {
    case "undercut":
      return marketLow - Math.max(1, settings.undercutCents);
    case "markup":
      return Math.round(marketLow * (1 + settings.markupPercent / 100));
    case "match":
    default:
      return marketLow;
  }
}

export function describeStrategy(settings: SellSettings): string {
  switch (settings.strategy) {
    case "undercut":
      return `ниже минимума на ${settings.undercutCents} коп.`;
    case "markup":
      return `выше минимума на ${settings.markupPercent}%`;
    case "match":
    default:
      return "по минимуму рынка";
  }
}
