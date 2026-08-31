/**
 * What the user has *unticked* in a list where everything starts ticked.
 *
 * Stored as the exclusions, never as the picked ids. Rows in this extension
 * arrive in waves — a scan finds listings, a second pass prices them — and a
 * positive list would either miss the new rows or quietly re-tick the ones that
 * were deliberately dropped. The inventory selection learned this the hard way and
 * keeps a richer version of the same rule; this is the plain one, for lists whose
 * rows are identified by a single id.
 */
export type Picks = Set<string>;

export function noneDropped(): Picks {
  return new Set();
}

export function isPicked(id: string, dropped: Picks): boolean {
  return !dropped.has(id);
}

export function togglePick(id: string, dropped: Picks): void {
  if (dropped.has(id)) dropped.delete(id);
  else dropped.add(id);
}

/** Ticks every id given — used by the «Все» button, which acts on what is shown. */
export function pickAll(ids: Iterable<string>, dropped: Picks): void {
  for (const id of ids) dropped.delete(id);
}

export function pickNone(ids: Iterable<string>, dropped: Picks): void {
  for (const id of ids) dropped.add(id);
}

export function countPicked(ids: Iterable<string>, dropped: Picks): number {
  let n = 0;
  for (const id of ids) {
    if (!dropped.has(id)) n += 1;
  }
  return n;
}

/** The rows still ticked, in the order they were given. */
export function pickedRows<T>(
  rows: readonly T[],
  idOf: (row: T) => string,
  dropped: Picks
): T[] {
  return rows.filter((row) => !dropped.has(idOf(row)));
}
