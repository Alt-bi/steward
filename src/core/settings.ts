import { DEFAULT_SELL_SETTINGS, type SellSettings } from "./sell";

export interface Settings {
  /** Pause between remove/relist calls. Steam bans on frequency, not volume. */
  delayMs: number;
  /** How far below the competitor we aim, in cents. */
  undercutCents: number;
  /** Never undercut a listing of our own that already holds the minimum. */
  skipSelfUndercut: boolean;
  /** Reprice at most one of our listings per item per pass. */
  onePerItem: boolean;
  /**
   * How far a single lot may fall in one move, in percent of what it asks now.
   *
   * The guard rail on the one button that cannot be taken back. A book with one
   * cheap stranger in it turns «подрезать на копейку» into «минус шестьдесят
   * процентов», and on a page of a hundred lots that is a decision nobody
   * inspected row by row. 100 means no ceiling.
   */
  maxDropPercent: number;
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
  /**
   * How the inventory feature prices what it lists.
   *
   * Fixed like the rest: the strategy picker, its step and its per-item cap
   * were three controls on the inventory tab, and the tab now lists at the
   * market minimum. Stamped over storage on read, so a strategy chosen by the
   * old picker cannot outlive it.
   */
  sell: SellSettings;
  /**
   * Hard ceiling on a one-click purchase, in cents.
   *
   * A parsing mistake in a price is a mistake that spends real money, so the
   * amount is checked against this before anything is sent. It is a refusal,
   * never a budget: raising it buys nothing, lowering it only ever costs a
   * purchase that has to be made by hand.
   */
  quickBuyMaxCents: number;
  /** Feature id -> enabled. */
  features: Record<string, boolean>;
}

/** Everything the owner is not asked to guess. */
type FixedKey =
  | "delayMs"
  | "undercutCents"
  | "skipSelfUndercut"
  | "onePerItem"
  | "maxDropPercent"
  | "scanConcurrency"
  | "exactCompetitorLow"
  | "priceSource"
  | "priceTtlMinutes"
  | "quickBuyMaxCents";

/**
 * The standard, stated once.
 *
 * These were nine fields and two checkboxes in the popup, and every one of them
 * had exactly one right answer and a range of worse ones. The pause is what
 * keeps the IP off Steam's list; the concurrency is what the governor was
 * measured around; «на копейку ниже» is the entire premise of the tab. A field
 * that can only be set wrong is not a setting, it is a trap with a label.
 *
 * They are stamped over storage on every read rather than merely defaulted, so
 * a value left behind by the old popup — a 8-second pause, a
 * `priceoverview` source — cannot outlive the field that wrote it.
 */
export const FIXED_SETTINGS: Pick<Settings, FixedKey> = {
  delayMs: 2500,
  undercutCents: 1,
  skipSelfUndercut: true,
  onePerItem: true,
  maxDropPercent: 35,
  scanConcurrency: 2,
  exactCompetitorLow: true,
  priceSource: "search",
  priceTtlMinutes: 15,
  quickBuyMaxCents: 50_000,
};

export const DEFAULT_SETTINGS: Settings = {
  ...FIXED_SETTINGS,
  sell: DEFAULT_SELL_SETTINGS,
  features: {},
};

export async function loadSettings(): Promise<Settings> {
  try {
    const items = (await chrome.storage.local.get(DEFAULT_SETTINGS)) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...items,
      ...FIXED_SETTINGS,
      sell: { ...DEFAULT_SETTINGS.sell },
      features: { ...DEFAULT_SETTINGS.features, ...(items.features ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Nothing in the extension writes settings any more — every one of them is
 * stamped from the standard on read. Kept as the one door, so that if a setting
 * ever earns a control again it goes through here rather than through
 * `chrome.storage` scattered across the features.
 */
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}
