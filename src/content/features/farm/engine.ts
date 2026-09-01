import type { BadgeRow } from "../../../steam/badges";

/** Steam's ClientGamesPlayed carries up to this many games per frame. */
export const FARM_MAX = 32;

export interface FarmTickInput {
  /** Latest badge scan. Drives every drop count — we never trust a cached one. */
  rows: readonly BadgeRow[];
  /** False while pagination hiccuped: a missing row proves nothing then. */
  scanComplete: boolean;
  prevPlaying: readonly number[];
  /** User-pinned games, ahead of everything else; order is the user's. */
  queued: readonly number[];
  /** Games the user explicitly removed — they never come back on their own. */
  dropped: ReadonlySet<number>;
  /** Farm everything the scan says is farmable, not just the pinned queue. */
  auto: boolean;
  max?: number;
}

export interface FarmTickResult {
  /** New claimed set. Swap the chat only when it differs from prevPlaying. */
  playing: number[];
  /** Games that finished right now — the scan says they owe nothing. */
  finishedNow: number[];
  /** The queue going forward; finished and dropped games are gone. */
  queue: number[];
  /** Nothing plays and nothing waits. */
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

/** Appids that still owe at least one drop, in scan order. */
export function farmableOrder(rows: readonly BadgeRow[]): number[] {
  const t = truthOf(rows);
  return t.order.filter((a) => t.owed.has(a));
}

/**
 * One tick of the factory: who plays now, who just finished.
 *
 * A game counts as finished only when the evidence is good: a badge row that
 * exists and says zero, or a row that vanished from a COMPLETE scan. Absence
 * during a partial scan proves nothing — evicting on pagination noise would
 * quietly pull working games out of the claim.
 *
 * Games currently playing survive into the new queue even when the scan lost
 * them (auto mode, partial scan): dropping a live game because one page
 * timed out is the exact bug the user would experience as "the farm stopped
 * for no reason".
 */
export function farmTick(input: FarmTickInput): FarmTickResult {
  const max = input.max ?? FARM_MAX;
  const truth = truthOf(input.rows);

  const finishedNow = input.prevPlaying.filter((a) => {
    if (truth.owed.has(a)) return false;
    return truth.seen.has(a) || input.scanComplete;
  });
  const finished = new Set(finishedNow);

  const carry = input.prevPlaying.filter((a) => !finished.has(a));
  const merged = [...carry, ...input.queued, ...(input.auto ? truth.order.filter((a) => truth.owed.has(a)) : [])];

  const queue: number[] = [];
  const inQueue = new Set<number>();
  for (const a of merged) {
    if (inQueue.has(a) || input.dropped.has(a) || finished.has(a)) continue;
    inQueue.add(a);
    queue.push(a);
  }

  const playing = input.prevPlaying.filter((a) => inQueue.has(a));
  for (const a of queue) {
    if (playing.length >= max) break;
    if (!playing.includes(a)) playing.push(a);
  }

  // The returned queue means "still waiting for a slot" — games the bench
  // just took are no longer waiting, and re-listing them would make the UI
  // double-count every promotion.
  const waiting = queue.filter((a) => !playing.includes(a));
  return { playing, finishedNow, queue: waiting, done: playing.length === 0 };
}
