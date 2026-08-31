import type { PlainOrderBook } from "../../../page/ssr";
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

/**
 * The demand side, in one line.
 *
 * Everything else the panel says is about sellers: what the cheapest lot asks,
 * what the item has been going for. None of it answers the question a holder
 * actually has — «if I want out today, what will I get» — and the page has the
 * answer sitting in it for free. The highest standing buy order is a price that
 * pays out the moment a lot is listed at it.
 *
 * The spread is given as money and as a share, because neither alone means
 * anything: measured live, 0,18 ₽ between the sides is nothing on a 15 000 ₽
 * rifle and a fifth of a cheap sticker.
 */
export function describeDemand(
  book: PlainOrderBook | null | undefined,
  money: (cents: Cents | null) => string
): string {
  if (!book) return "";
  const counts = `заявок ${book.buyOrders} против ${book.sellOrders} лотов`;
  if (book.maxBuy == null) return `никто не выставил заявку на покупку · ${counts}`;

  const head = `покупают по ${money(book.maxBuy)}`;
  if (book.minSell == null || book.minSell <= book.maxBuy) {
    return `${head} — столько же, сколько просят продавцы · ${counts}`;
  }

  const spread = book.minSell - book.maxBuy;
  const share = (spread / book.minSell) * 100;
  const rounded = Math.round(share * 10) / 10;
  const pct = rounded < 0.1 ? "<0,1%" : `${String(rounded).replace(".", ",")}%`;
  return `${head}, продают по ${money(book.minSell)} · разница ${money(spread)} (${pct}) · ${counts}`;
}

/**
 * What stands where the lot rows would be, when there are none.
 *
 * Three different situations used to share one sentence — «Нажми «Посмотреть
 * цену».» — including the one where the user had just pressed it. On a grouped
 * page that is the normal outcome, not an edge: measured on the live Redline
 * page, all twenty rows Steam ships are Battle-Scarred and Well-Worn while the
 * page itself is focused on Minimal Wear, so the panel had the price, the
 * average, the verdict and the chart, and under them told the reader to press
 * the button again.
 */
export function describeNoListings(checked: boolean, marketLow: Cents | null): string {
  if (!checked) return "Нажми «Посмотреть цену».";
  if (marketLow != null) {
    return "Отдельных лотов этого предмета страница не прислала — только цену по нему.";
  }
  return "Лотов на продажу не нашлось.";
}
