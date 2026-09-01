import type { BadgeRow } from "../../../steam/badges";

/** Steam's ClientGamesPlayed carries up to this many games per frame. */
export const FARM_MAX = 32;

export interface FarmTickInput {
  /** Latest badge scan. Drives every drop count — we never trust a cached one. */
  rows: readonly BadgeRow[];
  /** False while pagination hiccuped: a missing row proves nothing then. */
  scanComplete: boolean;
  prevPlaying: readonly number[];
  max?: number;
}

export interface FarmTickResult {
  /** New claimed set. Swap the chat only when it differs from the wire. */
  playing: number[];
  /** Games that finished right now — the scan says they owe nothing. */
  finishedNow: number[];
  /** Still owed, but the bench is full; they ride in as slots free up. */
  waiting: number[];
  /** Nothing left to play. */
  done: boolean;
}

interface ScanTruth {
  owed: Set<number>;
  seen: Set<number>;
  /** Farmable appids in first-appearance order. */
  order: number[];
}

function truthOf(rows: readonly BadgeRow[]): ScanTruth {
  const owed = new Set<number>();
  const seen = new Set<number>();
  const order: number[] = [];
  for (const r of rows) {
    // Foils are not farmed: Steam counts normal drops into the badge, and a
    // foil row claiming zero must never evict the normal game from the farm.
    if (r.foil) continue;
    if (!seen.has(r.appid)) {
      seen.add(r.appid);
      order.push(r.appid);
    }
    if (r.dropsRemaining !== null && r.dropsRemaining > 0) owed.add(r.appid);
  }
  return { owed, seen, order };
}

/**
 * Does the chat socket need to be told a new set?
 *
 * `claimed` is what the socket says it carries — `null` when the bridge did
 * not answer, and then the only safe answer is yes: an unanswered bridge is
 * an unclaimed account, and skipping the push is how a factory farms nothing
 * while reporting that it farms. Order does not matter to Steam, so a
 * reordered bench is not a change.
 */
export function claimChanged(next: readonly number[], claimed: readonly number[] | null): boolean {
  if (claimed === null) return true;
  if (next.length !== claimed.length) return true;
  const a = [...next].sort((x, y) => x - y);
  const b = [...claimed].sort((x, y) => x - y);
  return a.some((v, i) => v !== b[i]);
}

/**
 * One tick of the factory: who plays now, who just finished.
 *
 * There is one rule and no modes: **every game the scan says still owes cards
 * gets farmed**, bench first, up to `max`. The queue, the tick-list and the
 * forever-ban list are gone — they were three ways for the user to end up with
 * a running factory that had quietly excluded every game it could farm.
 *
 * A game counts as finished only when the evidence is good: a badge row that
 * exists and says zero, or a row that vanished from a COMPLETE scan. Absence
 * during a partial scan proves nothing — evicting on pagination noise would
 * quietly pull working games out of the claim. Games currently playing survive
 * a scan that lost them for the same reason.
 */
export function farmTick(input: FarmTickInput): FarmTickResult {
  const max = input.max ?? FARM_MAX;
  const truth = truthOf(input.rows);

  const finishedNow = input.prevPlaying.filter((a) => {
    if (truth.owed.has(a)) return false;
    return truth.seen.has(a) || input.scanComplete;
  });
  const finished = new Set(finishedNow);

  // The bench keeps its seats: a game already claimed stays claimed, so a
  // routine rescan never reshuffles the whole set for nothing.
  const bench: number[] = [];
  const taken = new Set<number>();
  for (const appid of input.prevPlaying) {
    if (finished.has(appid) || taken.has(appid)) continue;
    taken.add(appid);
    bench.push(appid);
  }
  for (const appid of truth.order) {
    if (!truth.owed.has(appid) || taken.has(appid)) continue;
    taken.add(appid);
    bench.push(appid);
  }

  const playing = bench.slice(0, max);
  const waiting = bench.slice(max);
  return { playing, finishedNow, waiting, done: playing.length === 0 };
}
