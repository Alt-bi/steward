/** Integer minor units of the wallet currency (kopecks, cents…). */
export type Cents = number;

export interface WalletInfo {
  wallet_currency?: number | string;
  wallet_country?: string;
  wallet_fee_percent?: number | string;
  wallet_fee_minimum?: number | string;
  wallet_fee_base?: number | string;
  wallet_publisher_fee_percent_default?: number | string;
}

/** Values that only exist on `window` of the Steam page, delivered by the MAIN-world bridge. */
export interface PageContext {
  sessionid: string | null;
  steamid: string | null;
  wallet: WalletInfo | null;
  language: string;
  country: string | null;
  assets: SteamAssetIndex | null;
  /** `g_rgAppContextData` — which games have items, and in which contexts. */
  appContexts: AppContextData | null;
}

export type AppContextData = Record<string, RawAppContext | undefined>;

export interface RawAppContext {
  appid?: number | string;
  name?: string;
  asset_count?: number;
  rgContexts?: Record<string, { id?: string; name?: string; asset_count?: number } | undefined>;
}

export type SteamAssetIndex = Record<
  string,
  Record<string, Record<string, SteamAsset | undefined> | undefined> | undefined
>;

export interface SteamAsset {
  appid?: number;
  contextid?: string;
  id?: string;
  amount?: string | number;
  market_hash_name?: string;
  market_name?: string;
  name?: string;
  commodity?: number;
}

/** One of our own active market listings. */
export interface Listing {
  listingId: string;
  appid: number;
  contextid: string;
  assetid: string;
  amount: number;
  /** Display name. */
  name: string;
  /** market_hash_name — the key every price endpoint wants. */
  hash: string;
  /** What a buyer pays for our listing, fees included. */
  ourBuyer: Cents;
  /** What we receive if it sells. */
  ourSeller: Cents;
  publisherFeePercent: number;
}

export type PlanAction = "reprice" | "skip";
export type PlanResult = "ok" | "fail";

export interface RepricePlan {
  listingId: string;
  name: string;
  hash: string;
  appid: number;
  contextid: string;
  assetid: string;
  amount: number;
  ourBuyer: Cents;
  /** Cheapest listing on the market that is not ours, when we could establish it. */
  competitorBuyer: Cents | null;
  targetBuyer: Cents | null;
  targetSeller: Cents | null;
  publisherFeePercent: number;
  action: PlanAction;
  reason: string;
  result?: PlanResult;
  resultMessage?: string;
}

/** Group of our listings sharing one market_hash_name. */
export interface ItemKeyed {
  key: string;
  appid: number;
  hash: string;
  name: string;
}
