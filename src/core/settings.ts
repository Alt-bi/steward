import { clampSellSettings, DEFAULT_SELL_SETTINGS, type SellSettings } from "./sell";

export interface Settings {
  /** Pause between remove/relist calls. Steam bans on frequency, not volume. */
  delayMs: number;
  /** How far below the competitor we aim, in cents. */
  undercutCents: number;
  /** Never undercut a listing of our own that already holds the minimum. */
  skipSelfUndercut: boolean;
  /** Reprice at most one of our listings per item per pass. */
  onePerItem: boolean;
  /** Parallel price lookups. The background scheduler still paces them. */
  scanConcurrency: number;
  /** Resolve the true competitor minimum via listings/render, not priceoverview. */
  exactCompetitorLow: boolean;
  /**
   * Where market minimums come from. `search` batches families of items through the
   * endpoint the market UI uses; `priceoverview` is the metered one-at-a-time API.
   */
  priceSource: "search" | "priceoverview";
  /** How long a fetched price stays good. Longer means fewer requests on a re-scan. */
  priceTtlMinutes: number;
  /** How the inventory feature prices what it lists. */
  sell: SellSettings;
  /**
   * Hard ceiling on a one-click purchase, in cents.
   *
   * A parsing mistake in a price is a mistake that spends real money, so the
   * amount is checked against this before anything is sent. Set it to what you
   * are willing to lose to a bug, not to what you are willing to spend.
   */
  quickBuyMaxCents: number;
  /** Feature id -> enabled. */
  features: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: Settings = {
  delayMs: 1600,
  undercutCents: 1,
  skipSelfUndercut: true,
  onePerItem: true,
  scanConcurrency: 4,
  exactCompetitorLow: true,
  priceSource: "search",
  priceTtlMinutes: 15,
  sell: DEFAULT_SELL_SETTINGS,
  quickBuyMaxCents: 50_000,
  features: {},
};

export async function loadSettings(): Promise<Settings> {
  try {
    const items = (await chrome.storage.local.get(DEFAULT_SETTINGS)) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...items,
      sell: { ...DEFAULT_SETTINGS.sell, ...(items.sell ?? {}) },
      features: { ...DEFAULT_SETTINGS.features, ...(items.features ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

export function clampSettings(s: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = { ...s };
  if (out.delayMs != null) out.delayMs = Math.min(8000, Math.max(900, Math.trunc(out.delayMs) || 1600));
  if (out.undercutCents != null) out.undercutCents = Math.min(500, Math.max(1, Math.trunc(out.undercutCents) || 1));
  if (out.scanConcurrency != null) {
    out.scanConcurrency = Math.min(8, Math.max(1, Math.trunc(out.scanConcurrency) || 4));
  }
  if (out.priceTtlMinutes != null) {
    out.priceTtlMinutes = Math.min(1440, Math.max(1, Math.trunc(out.priceTtlMinutes) || 15));
  }
  if (out.quickBuyMaxCents != null) {
    out.quickBuyMaxCents = Math.min(10_000_000, Math.max(0, Math.trunc(out.quickBuyMaxCents) || 0));
  }
  if (out.sell) out.sell = { ...DEFAULT_SELL_SETTINGS, ...out.sell, ...clampSellSettings(out.sell) };
  return out;
}
