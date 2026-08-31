import { fetchJsonRetry, type Pacing } from "./net";

/**
 * Wear and paint seed for real owned copies (CS:GO and friends).
 *
 * Steam keeps these off the inventory payload entirely — they are dynamic
 * per-asset properties. The endpoint the inventory page itself calls answers
 * for EVERY copy in the context no matter which assetid sits in the path, so
 * one request decorates a whole screen of tiles. SIH does not know this and
 * queues one round-trip per item through its own server instead.
 *
 * The path form `itemdynproperties/{assetid}` was verified against the live
 * site (2026-08): a bare or comma list either 404s or trips the duplicate-
 * action guard. The first real assetid is the safe shape.
 */

interface RawProperty {
  propertyid?: number;
  name?: string;
  float_value?: string;
  int_value?: string;
  string_value?: string;
}

interface RawAssetProperties {
  assetid?: string;
  asset_properties?: RawProperty[];
}

interface DynPropertiesResponse {
  success?: number | boolean;
  asset_properties?: Record<string, RawAssetProperties>;
}

export interface WearInfo {
  /** 0..1 — the Wear Rating Steam shows on inspect. */
  float: number;
  /** Paint Seed when Steam reported one. */
  seed: number | null;
  /** Pattern Template when Steam reported one. */
  pattern: number | null;
}

export interface WearTarget {
  steamid: string;
  appid: number;
  contextid: string;
}

/**
 * One copy in the path is enough — the answer comes back for the whole
 * context. `l=english` keeps the property names matchable.
 */
export function dynPropsUrl(target: WearTarget, assetid: string): string {
  return (
    "https://steamcommunity.com/inventory/" +
    `${target.steamid}/${target.appid}/${target.contextid}/` +
    `itemdynproperties/${encodeURIComponent(assetid)}/?l=english`
  );
}

/** Names speak, ids are hints: «Wear Rating», «Pattern Template», «Paint Seed». */
function propertyKind(prop: RawProperty): "float" | "seed" | "pattern" | null {
  const name = String(prop.name ?? "");
  if (/wear rating/i.test(name) || prop.propertyid === 2) return "float";
  if (/pattern template/i.test(name) || prop.propertyid === 1) return "pattern";
  if (/paint seed/i.test(name)) return "seed";
  return null;
}

function toNumber(value: string | undefined): number | null {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Joins the sparse `asset_properties` map into a plain assetid lookup. A copy
 * with no wear at all (a case, a sticker) simply does not appear — absence is
 * an answer, not a failure, so nothing here throws for it.
 */
export function parseDynProperties(payload: DynPropertiesResponse): Map<string, WearInfo> {
  const out = new Map<string, WearInfo>();
  const bucket = payload.asset_properties ?? {};
  for (const entry of Object.values(bucket)) {
    const assetid = String(entry?.assetid ?? "");
    const props = entry?.asset_properties;
    if (!assetid || !Array.isArray(props)) continue;

    let float: number | null = null;
    let seed: number | null = null;
    let pattern: number | null = null;
    for (const prop of props) {
      const kind = propertyKind(prop);
      if (kind === "float") float = toNumber(prop.float_value);
      else if (kind === "seed") seed = toNumber(prop.int_value);
      else if (kind === "pattern") pattern = toNumber(prop.int_value);
    }
    /** Wear is the point of the call; without it the copy is not decorated. */
    if (float == null) continue;
    out.set(assetid, { float, seed, pattern });
  }
  return out;
}

export async function fetchWear(
  target: WearTarget,
  assetid: string,
  pacing: Pacing
): Promise<Map<string, WearInfo>> {
  const data = await fetchJsonRetry<DynPropertiesResponse>(dynPropsUrl(target, assetid), {
    /** Same weight as reading the inventory itself: same page, same trust. */
    kind: "inventory",
    abort: pacing.abort,
    onWait: pacing.onWait,
  });
  return parseDynProperties(data);
}

/**
 * What one row can honestly say about a stack: all copies carry the same wear
 * → one number; otherwise the range. Steam prints four decimals; the chip uses
 * three, which is finer than any trading conversation needs.
 */
export function wearChip(wears: readonly WearInfo[]): string | null {
  if (!wears.length) return null;
  const fmt = (n: number) => n.toFixed(3).replace(/0$/, "").replace(/0$/, "");
  const min = Math.min(...wears.map((w) => w.float));
  const max = Math.max(...wears.map((w) => w.float));
  if (min === max) return `float ${fmt(min)}`;
  return `float ${fmt(min)}–${fmt(max)}`;
}
