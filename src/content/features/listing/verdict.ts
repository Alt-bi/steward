import type { Cents } from "../../../core/types";
import type { HistoryStats } from "../../../steam/pricehistory";

/**
 * Whether what the market is asking right now is a good price.
 *
 * Compared against the volume-weighted 30-day average rather than the all-time
 * one: an item that halved in price six months ago is not "cheap" today. The
 * 30-day low is reported alongside, because a price above the recent floor is a
 * different situation from a price at it.
 */

export type BuyVerdict = "cheap" | "fair" | "expensive" | "unknown";

export interface PriceJudgement {
  verdict: BuyVerdict;
  /** Current price over the 30-day average; null when unknown. */
  ratio: number | null;
  text: string;
}

/** Below this share of the average, the price is worth calling cheap. */
const CHEAP_BELOW = 0.85;

/** Above this share, it is worth warning about. */
const EXPENSIVE_ABOVE = 1.1;

/** Fewer recorded sales than this and the average is not worth trusting. */
const MIN_VOLUME = 3;

function percent(ratio: number): string {
  const away = Math.round(Math.abs(1 - ratio) * 100);
  return `${away}%`;
}

export function judgePrice(current: Cents | null, stats: HistoryStats): PriceJudgement {
  if (current == null || current < 1) {
    return { verdict: "unknown", ratio: null, text: "нет цены на рынке" };
  }
  const average = stats.average30d;
  if (average == null || average < 1) {
    return { verdict: "unknown", ratio: null, text: "нет истории продаж за месяц" };
  }
  if (stats.volume30d < MIN_VOLUME) {
    return {
      verdict: "unknown",
      ratio: current / average,
      text: `продаж за месяц ${stats.volume30d} — средняя цена ни о чём не говорит`,
    };
  }

  const ratio = current / average;

  if (ratio <= CHEAP_BELOW) {
    const atFloor =
      stats.min30d != null && current <= stats.min30d
        ? ", и это минимум за месяц"
        : "";
    return {
      verdict: "cheap",
      ratio,
      text: `на ${percent(ratio)} ниже средней за месяц${atFloor}`,
    };
  }

  if (ratio >= EXPENSIVE_ABOVE) {
    return { verdict: "expensive", ratio, text: `на ${percent(ratio)} выше средней за месяц` };
  }

  return { verdict: "fair", ratio, text: "около средней за месяц" };
}

/** Rough liquidity: how long one copy tends to take to sell. */
export function describeLiquidity(stats: HistoryStats): string {
  if (stats.volume30d <= 0) return "за месяц не продавалось ни одной";
  const perDay = stats.volume30d / 30;
  if (perDay >= 10) return `продаётся бойко, ~${Math.round(perDay)} шт. в день`;
  if (perDay >= 1) return `~${Math.round(perDay)} шт. в день`;
  const daysPerSale = Math.round(1 / perDay);
  return `редкий товар, примерно одна продажа за ${daysPerSale} дн.`;
}
