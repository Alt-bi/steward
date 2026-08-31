import type { HistoryStats } from "../steam/pricehistory";
import type { Cents } from "./types";

/**
 * Price levels: the reference prices a seller actually thinks in.
 *
 * «Beat the cheapest listing» is one strategy, and a poor one for anything that
 * is not in a hurry: it drags the whole market down a kopeck at a time. The other
 * way to price is against what the item *has been selling for* — the average of
 * the last week, month, or year — and to let the listing wait.
 *
 * Pure, and deliberately separate from both features that use it: an average
 * quietly computed over three sales, or over three weeks of a «year», is a number
 * a user prices against and then wonders why nothing moves. Every level says how
 * much evidence stands behind it.
 */

export type PriceLevel = "market" | "avg7" | "avg30" | "avg365";

export const PRICE_LEVELS: PriceLevel[] = ["market", "avg7", "avg30", "avg365"];

/** Recorded sales below which an average is noise rather than a price. */
export const MIN_LEVEL_VOLUME = 3;

export interface LevelValue {
  level: PriceLevel;
  /** What a buyer would pay at this level, or null when we cannot say. */
  buyer: Cents | null;
  /** Recorded sales behind it. */
  volume: number;
  /** The history reaches at least as far back as the window claims to. */
  covered: boolean;
  /** Why `buyer` is null, when it is. */
  missing: "none" | "no-history" | "no-sales" | "too-short" | "too-few-sales" | "no-price";
}

const WINDOW_DAYS: Record<Exclude<PriceLevel, "market">, number> = {
  avg7: 7,
  avg30: 30,
  avg365: 365,
};

const LABELS: Record<PriceLevel, string> = {
  market: "минимум рынка",
  avg7: "средняя за неделю",
  avg30: "средняя за месяц",
  avg365: "средняя за год",
};

const SHORT: Record<PriceLevel, string> = {
  market: "рынок",
  avg7: "7 дн.",
  avg30: "30 дн.",
  avg365: "год",
};

export function levelLabel(level: PriceLevel): string {
  return LABELS[level] ?? level;
}

export function levelShort(level: PriceLevel): string {
  return SHORT[level] ?? level;
}

export function isAverageLevel(level: PriceLevel): level is Exclude<PriceLevel, "market"> {
  return level !== "market";
}

function averageFor(stats: HistoryStats, level: Exclude<PriceLevel, "market">): Cents | null {
  if (level === "avg7") return stats.average7d;
  if (level === "avg30") return stats.average30d;
  return stats.average365d;
}

function volumeFor(stats: HistoryStats, level: Exclude<PriceLevel, "market">): number {
  if (level === "avg7") return stats.volume7d;
  if (level === "avg30") return stats.volume30d;
  return stats.volume365d;
}

/**
 * What this level is worth, given what the market asks now and what it has been
 * selling for.
 *
 * `marketLow` answers the `market` level; the averages need history. A window
 * longer than the history itself is reported as `too-short` rather than silently
 * answering with everything there is — «the year average» of a three-week-old case
 * is its three-week average, and calling it a year is a lie the user will act on.
 */
export function levelValue(
  level: PriceLevel,
  marketLow: Cents | null,
  stats: HistoryStats | null
): LevelValue {
  if (level === "market") {
    const ok = marketLow != null && marketLow >= 1;
    return {
      level,
      buyer: ok ? marketLow : null,
      volume: 0,
      covered: ok,
      missing: ok ? "none" : "no-price",
    };
  }

  if (!stats || !stats.points) {
    return { level, buyer: null, volume: 0, covered: false, missing: "no-history" };
  }

  const days = WINDOW_DAYS[level];
  const volume = volumeFor(stats, level);
  /** One day of slack: Steam's own series is daily and rarely starts on the dot. */
  const covered = stats.spanDays + 1 >= days;
  if (!covered) {
    return { level, buyer: null, volume, covered, missing: "too-short" };
  }

  const average = averageFor(stats, level);
  if (average == null || average < 1) {
    /**
     * Not «no history»: the series reaches back far enough, there is simply
     * nothing inside this window. An item with twelve years of sales and a quiet
     * week was told it had no history at all — which reads as «Steam has never
     * heard of this», and is the opposite of what a seller should conclude.
     */
    return { level, buyer: null, volume, covered, missing: "no-sales" };
  }
  if (volume < MIN_LEVEL_VOLUME) {
    return { level, buyer: null, volume, covered, missing: "too-few-sales" };
  }
  return { level, buyer: average, volume, covered, missing: "none" };
}

/** All four levels at once, for a panel that shows the ladder. */
export function levelLadder(marketLow: Cents | null, stats: HistoryStats | null): LevelValue[] {
  return PRICE_LEVELS.map((level) => levelValue(level, marketLow, stats));
}

/** Plain words for why a level has no number, ready to put in a row. */
export function describeMissingLevel(value: LevelValue): string {
  const label = levelLabel(value.level);
  switch (value.missing) {
    case "no-price":
      return "нет цены рынка";
    case "no-history":
      return `нет истории продаж — ${label} неизвестна`;
    case "no-sales":
      return `за этот период не продавалось ничего — ${label} не из чего считать`;
    case "too-short":
      return `истории меньше, чем нужно для «${label}»`;
    case "too-few-sales":
      return `продаж всего ${value.volume} — «${label}» ни о чём не говорит`;
    default:
      return "";
  }
}
