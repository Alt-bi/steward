import {
  confusableCharacters,
  hasInvisibleCharacters,
  hasMixedScripts,
  nameSimilarity,
} from "../../../core/text";
import type { Cents } from "../../../core/types";

/**
 * What a trade offer is actually worth, and what is wrong with it.
 *
 * Every check here is arithmetic or string comparison over the two item lists, so
 * the whole thing is testable without a browser. The DOM side only has to hand
 * over the items.
 */

export interface TradeItem {
  appid: number;
  contextid: string;
  assetid: string;
  /** What the page shows. */
  name: string;
  /** market_hash_name, when the page knows it. */
  hash: string;
  amount: number;
  marketable: boolean;
  tradable: boolean;
}

export type WarningLevel = "info" | "warn" | "danger";

export interface TradeWarning {
  level: WarningLevel;
  code:
    | "hidden-characters"
    | "mixed-scripts"
    | "lookalike"
    | "not-marketable"
    | "not-tradable"
    | "imbalance"
    | "incomplete-prices"
    | "empty-side";
  text: string;
  /** The item the warning is about, when it is about one item. */
  assetid?: string;
}

export interface TradeSide {
  items: TradeItem[];
  /** Sum of known prices only. */
  total: Cents;
  priced: number;
  unpriced: number;
  count: number;
}

export interface TradeAnalysis {
  yours: TradeSide;
  theirs: TradeSide;
  /** Positive when they offer more than you give. */
  delta: Cents;
  warnings: TradeWarning[];
  /** Highest level present, for the headline. */
  verdict: WarningLevel | "ok";
}

export interface AnalyzeInput {
  yours: TradeItem[];
  theirs: TradeItem[];
  /** `{appid}\t{hash}` -> lowest buyer price. */
  lows: Record<string, Cents | null>;
  /** Fraction of the larger side that a gap must exceed to be called out. */
  imbalanceThreshold?: number;
  /** How alike two names must read before it counts as a substitution. */
  lookalikeThreshold?: number;
  /** Value ratio below which a lookalike is a substitution rather than a duplicate. */
  lookalikeValueRatio?: number;
}

const DEFAULTS = {
  imbalanceThreshold: 0.2,
  lookalikeThreshold: 0.86,
  lookalikeValueRatio: 0.5,
};

export function itemKey(item: Pick<TradeItem, "appid" | "hash">): string {
  return `${item.appid}\t${item.hash}`;
}

function priceOf(item: TradeItem, lows: Record<string, Cents | null>): Cents | null {
  const low = lows[itemKey(item)];
  return low == null ? null : low * Math.max(1, item.amount);
}

function summarize(items: TradeItem[], lows: Record<string, Cents | null>): TradeSide {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  let count = 0;
  for (const item of items) {
    count += Math.max(1, item.amount);
    const value = priceOf(item, lows);
    if (value == null) unpriced += 1;
    else {
      priced += 1;
      total += value;
    }
  }
  return { items, total, priced, unpriced, count };
}

function money(cents: Cents): string {
  return (cents / 100).toFixed(2);
}

/**
 * Names that read the same but are not the same item.
 *
 * Compared against what *you* are giving: the scam is offering something that
 * looks like the valuable thing you expect. A near-identical name with a much
 * lower price is the signal.
 */
function lookalikeWarnings(input: AnalyzeInput, tuning: typeof DEFAULTS): TradeWarning[] {
  const warnings: TradeWarning[] = [];
  const { lows } = input;

  for (const theirs of input.theirs) {
    for (const yours of input.yours) {
      /** Literally the same item is a normal trade, not a substitution. */
      if (itemKey(theirs) === itemKey(yours)) continue;

      const similarity = nameSimilarity(theirs.name, yours.name);
      if (similarity < tuning.lookalikeThreshold) continue;

      const theirValue = priceOf(theirs, lows);
      const yourValue = priceOf(yours, lows);
      if (theirValue == null || yourValue == null || yourValue <= 0) {
        warnings.push({
          level: "warn",
          code: "lookalike",
          assetid: theirs.assetid,
          text: `«${theirs.name}» читается почти как «${yours.name}», но цену сверить не удалось`,
        });
        continue;
      }

      if (theirValue / yourValue < tuning.lookalikeValueRatio) {
        warnings.push({
          level: "danger",
          code: "lookalike",
          assetid: theirs.assetid,
          text:
            `«${theirs.name}» читается почти как «${yours.name}», ` +
            `но стоит ${money(theirValue)} против ${money(yourValue)} — похоже на подмену`,
        });
      }
    }
  }
  return warnings;
}

/** Names carrying characters that are not what they appear to be. */
function nameWarnings(items: TradeItem[], side: string): TradeWarning[] {
  const warnings: TradeWarning[] = [];
  for (const item of items) {
    if (hasInvisibleCharacters(item.name)) {
      warnings.push({
        level: "danger",
        code: "hidden-characters",
        assetid: item.assetid,
        text: `${side} «${item.name}» — в названии невидимые символы`,
      });
    }
    if (hasMixedScripts(item.name)) {
      const chars = confusableCharacters(item.name);
      warnings.push({
        level: "danger",
        code: "mixed-scripts",
        assetid: item.assetid,
        text:
          `${side} «${item.name}» — буквы из другого алфавита` +
          (chars.length ? ` (${chars.join(" ")})` : ""),
      });
    }
  }
  return warnings;
}

export function analyzeTrade(input: AnalyzeInput): TradeAnalysis {
  const tuning = {
    imbalanceThreshold: input.imbalanceThreshold ?? DEFAULTS.imbalanceThreshold,
    lookalikeThreshold: input.lookalikeThreshold ?? DEFAULTS.lookalikeThreshold,
    lookalikeValueRatio: input.lookalikeValueRatio ?? DEFAULTS.lookalikeValueRatio,
  };

  const yours = summarize(input.yours, input.lows);
  const theirs = summarize(input.theirs, input.lows);
  const warnings: TradeWarning[] = [];

  warnings.push(...nameWarnings(input.theirs, "Они дают:"));
  warnings.push(...lookalikeWarnings(input, tuning));

  for (const item of input.theirs) {
    if (!item.marketable) {
      warnings.push({
        level: "warn",
        code: "not-marketable",
        assetid: item.assetid,
        text: `«${item.name}» нельзя продать на маркете — деньгами это не станет`,
      });
    }
    if (!item.tradable) {
      warnings.push({
        level: "warn",
        code: "not-tradable",
        assetid: item.assetid,
        text: `«${item.name}» нельзя передать дальше`,
      });
    }
  }

  /** A one-sided offer is not a scam by itself, but it should be stated plainly. */
  if (!input.theirs.length && input.yours.length) {
    warnings.push({
      level: "danger",
      code: "empty-side",
      text: "Взамен не предлагают ничего — это подарок с твоей стороны",
    });
  } else if (!input.yours.length && input.theirs.length) {
    warnings.push({
      level: "info",
      code: "empty-side",
      text: "От тебя ничего не просят — это подарок в твою сторону",
    });
  }

  const delta = theirs.total - yours.total;
  const largest = Math.max(yours.total, theirs.total);
  if (largest > 0 && Math.abs(delta) / largest > tuning.imbalanceThreshold) {
    const losing = delta < 0;
    warnings.push({
      level: losing ? "danger" : "info",
      code: "imbalance",
      text: losing
        ? `Ты отдаёшь на ${money(-delta)} больше, чем получаешь`
        : `Ты получаешь на ${money(delta)} больше, чем отдаёшь`,
    });
  }

  const unpriced = yours.unpriced + theirs.unpriced;
  if (unpriced) {
    warnings.push({
      level: "warn",
      code: "incomplete-prices",
      text: `Цены неизвестны у ${unpriced} позиц. — суммы неполные`,
    });
  }

  const levels = new Set(warnings.map((w) => w.level));
  const verdict: TradeAnalysis["verdict"] = levels.has("danger")
    ? "danger"
    : levels.has("warn")
      ? "warn"
      : levels.has("info")
        ? "info"
        : "ok";

  /** Worst first: the reader must not have to scroll to find the danger. */
  const order: Record<WarningLevel, number> = { danger: 0, warn: 1, info: 2 };
  warnings.sort((a, b) => order[a.level] - order[b.level]);

  return { yours, theirs, delta, warnings, verdict };
}
