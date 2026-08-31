import type { Cents } from "../core/types";
import { fetchJson, type Pacing } from "./net";
import { country, currencyId } from "./page-context";

/**
 * `market/pricehistory` answers with every recorded sale for one item: a date, the
 * median price that hour or day, and how many changed hands.
 *
 * Two awkward details, both handled here so nothing downstream has to know:
 * the dates arrive as `"Jul 25 2016 01: +0"`, and the prices are floats in wallet
 * units rather than the integer cents everything else in this codebase uses.
 */

interface PriceHistoryResponse {
  success?: boolean;
  price_prefix?: string;
  price_suffix?: string;
  /** [date, median price, volume as a string] */
  prices?: [string, number, string][] | null;
}

export interface HistoryPoint {
  /** Epoch milliseconds, UTC. */
  t: number;
  price: Cents;
  volume: number;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Steam's own format: `"Jul 25 2016 01: +0"`. The hour is optional in practice and
 * the trailing offset is always `+0`, so it is read as UTC.
 */
export function parseHistoryDate(raw: string): number | null {
  const match = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})(?:\s+(\d{1,2}))?/.exec(String(raw ?? "").trim());
  if (!match) return null;
  const [, monthName, day, year, hour] = match;
  const month = MONTHS[String(monthName).toLowerCase()];
  if (month == null) return null;
  const time = Date.UTC(Number(year), month, Number(day), hour ? Number(hour) : 0);
  return Number.isFinite(time) ? time : null;
}

/** Wallet-unit float to integer cents, without float drift at the boundary. */
export function toCents(value: unknown): Cents {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

export function parsePriceHistory(payload: PriceHistoryResponse): HistoryPoint[] {
  const rows = payload?.prices;
  if (!Array.isArray(rows)) return [];

  const points: HistoryPoint[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const t = parseHistoryDate(row[0]);
    const price = toCents(row[1]);
    if (t == null || price < 1) continue;
    const volume = Number.parseInt(String(row[2] ?? "0"), 10);
    points.push({ t, price, volume: Number.isFinite(volume) ? volume : 0 });
  }
  /** Steam sends these in order, but nothing downstream should depend on that. */
  points.sort((a, b) => a.t - b.t);
  return points;
}

/**
 * The same series as `parsePriceHistory`, from the item page instead of a request.
 *
 * The rewritten page ships its histories as objects with a unix timestamp rather
 * than the legacy `"Jul 25 2016 01: +0"` string, but the prices are wallet-unit
 * floats in both, so `toCents` is shared. This is the cheaper of the two sources
 * by a wide margin: `pricehistory` is the endpoint Steam refuses first, and the
 * page hands over every item of the group at once for nothing.
 */
export function historyFromPage(
  rows: readonly (readonly [number, number, number])[] | null | undefined
): HistoryPoint[] {
  const points: HistoryPoint[] = [];
  for (const row of rows ?? []) {
    const t = row[0] * 1000;
    const price = toCents(row[1]);
    if (!Number.isFinite(t) || price < 1) continue;
    points.push({ t, price, volume: Number.isFinite(row[2]) ? row[2] : 0 });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

export interface HistoryStats {
  points: number;
  /** Most recent recorded sale. */
  last: Cents | null;
  lastAt: number | null;
  /** Averages weighted by how many actually sold. */
  average7d: Cents | null;
  average30d: Cents | null;
  average365d: Cents | null;
  min30d: Cents | null;
  max30d: Cents | null;
  volume7d: number;
  volume30d: number;
  volume365d: number;
  /**
   * How far back the history actually reaches, in days.
   *
   * A case released three weeks ago has a «yearly average» made of three weeks.
   * Presenting that as a year is the kind of number a user prices against and
   * then wonders why nothing sells.
   */
  spanDays: number;
}

function weightedAverage(points: HistoryPoint[]): Cents | null {
  let value = 0;
  let weight = 0;
  for (const point of points) {
    /** A day with no recorded volume still carries its price, at weight one. */
    const w = Math.max(1, point.volume);
    value += point.price * w;
    weight += w;
  }
  return weight ? Math.round(value / weight) : null;
}

const DAY_MS = 86_400_000;

/** Volume-weighted average over the last `days`, or null when nothing sold then. */
export function averageOver(
  points: readonly HistoryPoint[],
  days: number,
  now = Date.now()
): Cents | null {
  return weightedAverage(points.filter((p) => now - p.t <= days * DAY_MS));
}

export function summarizeHistory(points: HistoryPoint[], now = Date.now()): HistoryStats {
  const empty: HistoryStats = {
    points: 0,
    last: null,
    lastAt: null,
    average7d: null,
    average30d: null,
    average365d: null,
    min30d: null,
    max30d: null,
    volume7d: 0,
    volume30d: 0,
    volume365d: 0,
    spanDays: 0,
  };
  if (!points.length) return empty;

  const within = (days: number) => points.filter((p) => now - p.t <= days * DAY_MS);
  const within7 = within(7);
  const within30 = within(30);
  const within365 = within(365);
  const last = points[points.length - 1]!;
  const first = points[0]!;

  return {
    points: points.length,
    last: last.price,
    lastAt: last.t,
    average7d: weightedAverage(within7),
    average30d: weightedAverage(within30),
    average365d: weightedAverage(within365),
    min30d: within30.length ? Math.min(...within30.map((p) => p.price)) : null,
    max30d: within30.length ? Math.max(...within30.map((p) => p.price)) : null,
    volume7d: within7.reduce((sum, p) => sum + p.volume, 0),
    volume30d: within30.reduce((sum, p) => sum + p.volume, 0),
    volume365d: within365.reduce((sum, p) => sum + p.volume, 0),
    /** From the first recorded sale to now, not to the last one: a dead item's
     *  history is old, and that is exactly what the caller needs to know. */
    spanDays: Math.max(0, Math.floor((now - first.t) / DAY_MS)),
  };
}

/**
 * Collapses a long series into at most `buckets` points by averaging within equal
 * time slices. Averaging rather than sampling, so a spike does not vanish
 * depending on where the bucket boundary happens to fall.
 */
export function downsample(points: HistoryPoint[], buckets: number): HistoryPoint[] {
  if (buckets < 1) return [];
  if (points.length <= buckets) return [...points];

  const first = points[0]!.t;
  const last = points[points.length - 1]!.t;
  const span = last - first;
  if (span <= 0) return [points[points.length - 1]!];

  const sums = new Array<{ price: number; volume: number; t: number; n: number } | null>(buckets).fill(
    null
  );

  for (const point of points) {
    const index = Math.min(buckets - 1, Math.floor(((point.t - first) / span) * buckets));
    const slot = sums[index];
    if (slot) {
      slot.price += point.price;
      slot.volume += point.volume;
      slot.t += point.t;
      slot.n += 1;
    } else {
      sums[index] = { price: point.price, volume: point.volume, t: point.t, n: 1 };
    }
  }

  const out: HistoryPoint[] = [];
  for (const slot of sums) {
    if (!slot) continue;
    out.push({
      t: Math.round(slot.t / slot.n),
      price: Math.round(slot.price / slot.n),
      volume: slot.volume,
    });
  }
  return out;
}

export interface SparklineGeometry {
  /** SVG path for the line. */
  line: string;
  /** Closed path under the line, for the fill. */
  area: string;
  min: Cents;
  max: Cents;
}

/**
 * Turns points into SVG geometry. Pure on purpose: the shape of a chart is exactly
 * the kind of thing that silently breaks, and a string is easy to assert on.
 */
export function sparkline(
  points: HistoryPoint[],
  width: number,
  height: number,
  padding = 1
): SparklineGeometry | null {
  if (points.length < 2 || width <= 0 || height <= 0) return null;

  const prices = points.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min;

  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);

  const x = (index: number) => padding + (index / (points.length - 1)) * innerW;
  /** A flat series draws through the middle rather than dividing by zero. */
  const y = (price: Cents) =>
    span === 0 ? padding + innerH / 2 : padding + innerH - ((price - min) / span) * innerH;

  const round = (n: number) => Math.round(n * 10) / 10;
  const coords = points.map((point, index) => `${round(x(index))},${round(y(point.price))}`);

  const line = `M${coords.join("L")}`;
  const area =
    `${line}L${round(x(points.length - 1))},${round(height - padding)}` +
    `L${round(x(0))},${round(height - padding)}Z`;

  return { line, area, min, max };
}

export async function fetchPriceHistory(
  appid: number,
  hash: string,
  pacing: Pacing
): Promise<HistoryPoint[]> {
  const url =
    "https://steamcommunity.com/market/pricehistory/" +
    `?appid=${encodeURIComponent(appid)}` +
    `&currency=${currencyId()}` +
    `&country=${encodeURIComponent(country())}` +
    `&market_hash_name=${encodeURIComponent(hash)}`;

  const data = await fetchJson<PriceHistoryResponse>(url, {
    kind: "history",
    ...pacing,
    /**
     * Measured against the live endpoint, 2026-08-29.
     *
     * A name Steam does not know answers HTTP 500 with
     * `{"success":false,"prices":false}` — unmistakable. A name it does know
     * answers 200 with an array. So `success:false`, or `prices` that is not an
     * array, is Steam declining; an array is an answer whatever its length.
     *
     * Counting an empty array as a refusal cost twice over, both on the endpoint
     * we are rationed hardest on: an item that has genuinely never sold was
     * re-asked on every single scan, because a thrown error is never cached — and
     * four of them in a row opened the breaker and stopped the whole run.
     */
    isEmpty: (d) => {
      const r = d as PriceHistoryResponse;
      return r?.success === false || !Array.isArray(r?.prices);
    },
  });
  return parsePriceHistory(data);
}
