import type { Cents } from "../core/types";
import { fetchJson, type Pacing } from "./net";
import { country, currencyId } from "./page-context";

/**
 * The public listing page for one item. Unlike `priceoverview` this returns the
 * individual listings keyed by listing id — and since we already know our own
 * listing ids from `mylistings`, that is enough to find the cheapest listing
 * that genuinely belongs to somebody else.
 */

interface RenderListing {
  listingid?: string;
  price?: number | string;
  fee?: number | string;
  converted_price?: number | string;
  converted_fee?: number | string;
}

interface RenderResponse {
  success?: boolean;
  total_count?: number;
  listinginfo?: Record<string, RenderListing>;
}

export interface MarketListing {
  listingId: string;
  /** What the buyer pays in total. */
  buyer: Cents;
  /** The seller's share, which `buylisting` calls the subtotal. */
  price: Cents;
  /** Steam plus publisher fees, which `buylisting` wants separately. */
  fee: Cents;
}

function toInt(v: unknown): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

export async function fetchCheapestListings(
  appid: number,
  hash: string,
  pacing: Pacing,
  count = 10
): Promise<MarketListing[]> {
  const url =
    `https://steamcommunity.com/market/listings/${encodeURIComponent(appid)}/` +
    `${encodeURIComponent(hash)}/render/` +
    `?query=&start=0&count=${count}&country=${encodeURIComponent(country())}` +
    `&language=english&currency=${currencyId()}`;

  const data = await fetchJson<RenderResponse>(url, {
    kind: "listings",
    ...pacing,
    isEmpty: (d) => (d as RenderResponse)?.success === false,
  });

  const info = data.listinginfo ?? {};
  const out: MarketListing[] = [];
  for (const [id, row] of Object.entries(info)) {
    const price = toInt(row.converted_price ?? row.price);
    const fee = toInt(row.converted_fee ?? row.fee);
    if (price <= 0) continue;
    out.push({ listingId: String(row.listingid ?? id), buyer: price + fee, price, fee });
  }
  out.sort((a, b) => a.buyer - b.buyer);
  return out;
}

/**
 * Cheapest listing that is not one of `ourListingIds`. `null` means every listing
 * on the first page is ours, or the page told us nothing.
 */
export async function fetchCompetitorLow(
  appid: number,
  hash: string,
  ourListingIds: ReadonlySet<string>,
  pacing: Pacing
): Promise<Cents | null> {
  const listings = await fetchCheapestListings(appid, hash, pacing);
  for (const listing of listings) {
    if (!ourListingIds.has(listing.listingId)) return listing.buyer;
  }
  return null;
}
