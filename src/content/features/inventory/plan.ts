import { buyerPrice, sellerForBuyer, type FeeConfig } from "../../../core/fees";
import { strategyTarget, type SellSettings } from "../../../core/sell";
import type { Cents } from "../../../core/types";
import type { InventoryGroup, InventoryItem } from "../../../steam/inventory";
import type { HistoryStats } from "../../../steam/pricehistory";

/**
 * Turns "I want to sell this inventory" into concrete `sellitem` orders.
 *
 * Every target is computed as a buyer price and then inverted through the fees, so
 * the number shown to the user is the number a buyer actually pays.
 */

export interface SellPlan {
  assetid: string;
  appid: number;
  contextid: string;
  amount: number;
  name: string;
  hash: string;
  marketLow: Cents | null;
  targetBuyer: Cents | null;
  targetSeller: Cents | null;
  action: "sell" | "skip";
  reason: string;
  result?: "ok" | "fail";
  resultMessage?: string;
}

function skip(item: InventoryItem, marketLow: Cents | null, reason: string): SellPlan {
  return {
    assetid: item.assetid,
    appid: item.appid,
    contextid: item.contextid,
    amount: item.amount,
    name: item.name,
    hash: item.hash,
    marketLow,
    targetBuyer: null,
    targetSeller: null,
    action: "skip",
    reason,
  };
}

export interface BuildSellPlansInput {
  groups: Map<string, InventoryGroup>;
  lows: Record<string, Cents | null>;
  settings: SellSettings;
  fees: FeeConfig;
  /** Publisher cut per game; 10% unless we know better. */
  publisherFeePercent?: (appid: number) => number;
  /** Only these groups, when the user picked a subset. */
  onlyKeys?: ReadonlySet<string>;
  /**
   * Only these copies. Tiles are picked one at a time, and a stack of ten where
   * three are ticked must list those three — not the first three.
   */
  onlyAssets?: ReadonlySet<string>;
  /** Group key -> what the item has been selling for. Only the `avg` strategies need it. */
  stats?: Record<string, HistoryStats | null>;
}

export function buildSellPlans(input: BuildSellPlansInput): SellPlan[] {
  const { groups, lows, settings, fees } = input;
  const publisherFee = input.publisherFeePercent ?? (() => 0.1);
  const plans: SellPlan[] = [];

  for (const group of groups.values()) {
    if (input.onlyKeys && !input.onlyKeys.has(group.key)) continue;

    const marketLow = lows[group.key] ?? null;
    const pub = publisherFee(group.appid);

    /** Stable order, so a second pass lists the same copies as the first. */
    const ordered = [...group.items].sort((a, b) => a.assetid.localeCompare(b.assetid));
    let listed = 0;

    for (const item of ordered) {
      if (input.onlyAssets && !input.onlyAssets.has(item.assetid)) {
        plans.push(skip(item, marketLow, "снят с выбора"));
        continue;
      }
      if (!item.marketable) {
        plans.push(skip(item, marketLow, "не продаётся на маркете"));
        continue;
      }
      if (marketLow == null) {
        plans.push(skip(item, marketLow, "нет цены рынка"));
        continue;
      }
      if (listed >= Math.max(1, settings.maxPerItem)) {
        plans.push(skip(item, marketLow, `хватит ${settings.maxPerItem} шт. за проход`));
        continue;
      }

      const target = strategyTarget(marketLow, settings, input.stats?.[group.key] ?? null);
      if (target.buyer == null) {
        plans.push(skip(item, marketLow, target.reason));
        continue;
      }
      if (target.buyer < 1) {
        plans.push(skip(item, marketLow, "нельзя ниже минимума Steam"));
        continue;
      }

      const targetSeller = sellerForBuyer(target.buyer, pub, fees);
      if (targetSeller < 1) {
        plans.push(skip(item, marketLow, "не собралась цена продавца"));
        continue;
      }

      const targetBuyer = buyerPrice(targetSeller, pub, fees);
      if (settings.minBuyerCents > 0 && targetBuyer < settings.minBuyerCents) {
        plans.push(skip(item, marketLow, "дешевле порога"));
        continue;
      }

      listed += 1;
      plans.push({
        ...skip(item, marketLow, target.reason),
        action: "sell",
        targetBuyer,
        targetSeller,
      });
    }
  }

  return plans;
}

/** What we would receive if every planned listing sold. */
export function plannedProceeds(plans: SellPlan[]): Cents {
  let total = 0;
  for (const plan of plans) {
    if (plan.action === "sell" && plan.targetSeller != null) total += plan.targetSeller;
  }
  return total;
}
