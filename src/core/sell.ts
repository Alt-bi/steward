import { describeMissingLevel, levelLabel, levelValue, type PriceLevel } from "./levels";
import type { HistoryStats } from "../steam/pricehistory";
import type { Cents } from "./types";

/**
 * How the inventory feature prices what it lists.
 *
 * These live in `core` rather than beside the planner because settings are shared
 * with the popup, and `core` must never import from a feature.
 *
 * `match` sits exactly on the current minimum, `undercut` steps below it to sell
 * first, `markup` asks above it to wait for a better buyer. The three `avg`
 * strategies ignore today's cheapest lot and ask what the item has actually been
 * selling for — which is how a listing ends up *above* the current market on
 * purpose, waiting instead of racing to the bottom.
 */
export type SellStrategy = "match" | "undercut" | "markup" | "avg7" | "avg30" | "avg365";

/** The price level a strategy is built on, when it is built on one. */
export function strategyLevel(strategy: SellStrategy): PriceLevel {
  if (strategy === "avg7" || strategy === "avg30" || strategy === "avg365") return strategy;
  return "market";
}

export function needsHistory(strategy: SellStrategy): boolean {
  return strategyLevel(strategy) !== "market";
}

export interface SellSettings {
  strategy: SellStrategy;
  undercutCents: Cents;
  markupPercent: number;
  /** Refuse to list anything cheaper than this, to avoid dumping junk. */
  minBuyerCents: Cents;
  /** How many copies of one item to list in a single pass. */
  maxPerItem: number;
}

/**
 * The standard for listing, and the whole of it — these stopped being controls.
 *
 * «По минимуму рынка» is the one strategy that needs nothing but the price we
 * already fetched: the undercut strategies need a step nobody can pick well,
 * and the averages need `pricehistory`, six requests a minute, for an answer
 * about a week that has already happened. `undercutCents` and `markupPercent`
 * are kept because the strategies that read them are still in the planner and
 * still tested; nothing on screen can select them.
 *
 * `maxPerItem` stays a guard rail rather than a preference: a stack of two
 * hundred is two hundred paced writes, and twenty is where a pass is still a
 * pass rather than an afternoon.
 */
export const DEFAULT_SELL_SETTINGS: SellSettings = {
  strategy: "match",
  undercutCents: 1,
  markupPercent: 10,
  minBuyerCents: 0,
  maxPerItem: 20,
};

export interface StrategyTarget {
  /** Buyer price before fee rounding; null when the strategy has nothing to go on. */
  buyer: Cents | null;
  /** Why not, when null. */
  reason: string;
  /** The average was below what the market asks, so we held at the market. */
  clamped: boolean;
}

/**
 * The buyer price the strategy asks for, before fee rounding.
 *
 * An average below today's cheapest lot is clamped up to it: selling under the
 * market is a discount nobody is asking us for, and a strategy quietly doing it
 * because last month was cheaper would dump a whole inventory.
 */
export function strategyTarget(
  marketLow: Cents,
  settings: SellSettings,
  stats: HistoryStats | null = null
): StrategyTarget {
  const level = strategyLevel(settings.strategy);
  if (level !== "market") {
    const value = levelValue(level, marketLow, stats);
    if (value.buyer == null) {
      return { buyer: null, reason: describeMissingLevel(value), clamped: false };
    }
    const clamped = value.buyer < marketLow;
    return {
      buyer: clamped ? marketLow : value.buyer,
      reason: clamped ? `«${levelLabel(level)}» ниже рынка — ставлю по минимуму` : levelLabel(level),
      clamped,
    };
  }

  return { buyer: targetForStrategy(marketLow, settings), reason: describeStrategy(settings), clamped: false };
}

/** The classic market-relative target. Kept as the primitive the rest builds on. */
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
    case "avg7":
    case "avg30":
    case "avg365":
      return levelLabel(settings.strategy);
    case "match":
    default:
      return "по минимуму рынка";
  }
}
