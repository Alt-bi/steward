import type { ErrorKind } from "../../steam/net";
import { SteamError } from "../../steam/net";

/**
 * One Russian sentence per way Steam can refuse us.
 *
 * Every feature used to carry its own copy of this switch, and they had already
 * drifted: one explained an HTML answer, another explained an empty history, and
 * the same failure read differently depending on which tab the user was looking
 * at. `extra` is for the one case a feature really does know better than this
 * table what a kind means for it.
 */
const MESSAGES: Record<ErrorKind, string> = {
  not_logged_in: "нужен логин Steam в этой вкладке",
  rate_limited: "Steam упёрся в лимит",
  blocked: "Steam упёрся в лимит",
  not_json: "Steam ответил страницей вместо JSON",
  bad_json: "Steam ответил не тем, что обещал",
  empty: "Steam ничего не отдал",
  network: "сеть оборвалась — ответ не пришёл",
  aborted: "остановлено",
  /** `http` carries the endpoint's own message, which is more useful than ours. */
  http: "",
};

export function describeError(
  err: unknown,
  extra: Partial<Record<ErrorKind, string>> = {}
): string {
  if (err instanceof SteamError) {
    return extra[err.kind] || MESSAGES[err.kind] || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * A write that took more than one step, and how far it got.
 *
 * Repricing is not one call. The lot comes off the market, then goes back on at
 * the new price, and a failure between the two leaves the item in the inventory
 * and off sale — a real change to what the user is selling. That used to be
 * reported as plain «ошибка», word for word the same as a failure that had
 * touched nothing at all.
 */
export type WriteStage =
  /** Nothing has been sent. Our own guards live here. */
  | "before"
  /** The delist is in flight. */
  | "removing"
  /** The delist went through; the lot is off the market. */
  | "relisting";

export interface WriteFailure {
  /** What to put on the row. */
  message: string;
  /** The listing may no longer be on the market. Certain, or merely unknown. */
  stranded: boolean;
  /** Do not start another one. */
  halt: boolean;
}

/**
 * Failures of a write that leave its outcome unknown.
 *
 * `network` is the POST that left and never came back. The other two are Steam
 * answering with something that is not the answer — a logged-out page, an
 * interstitial — which says nothing about whether the write went through. All
 * three are different from Steam saying no, and only the latter leaves the
 * listing provably where it was.
 */
const UNKNOWN_OUTCOME = new Set(["network", "not_json", "bad_json"]);

/**
 * Whether this write's outcome is a guess. True means: do not tell the user it
 * failed, and do not strike the row off the list as done either.
 */
export function outcomeUnknown(err: unknown): boolean {
  return err instanceof SteamError && UNKNOWN_OUTCOME.has(err.kind);
}

/**
 * Whether the reason this one failed is certainly the reason the next one will.
 *
 * Every bulk loop in the extension needs this and two of them had written their
 * own version, both missing `not_logged_in` — so a session that expired part-way
 * through kept firing writes at an endpoint that could no longer accept any of
 * them, one per item, to the end of the list.
 */
export function haltsRun(err: unknown): boolean {
  return err instanceof SteamError && refused(err.kind);
}

/** Steam answered, so nothing is in doubt — only whether the next one will fare better. */
function refused(kind: string | null): boolean {
  return kind === "rate_limited" || kind === "blocked" || kind === "not_logged_in";
}

export function describeRelistFailure(stage: WriteStage, err: unknown): WriteFailure {
  const why = describeError(err);


  /**
   * Both branches below end the run. Why the write failed is not known, and the
   * next lot would be taken off the market before finding out it is the same
   * reason: one item to put back by hand is a mistake, a hundred is the panel
   * clearing the account's market page one call at a time.
   */
  if (stage === "relisting") {
    /**
     * It used to end «— предмет в инвентаре», which nothing had checked. Where
     * the item actually is decides what the owner should do next, so the claim
     * belongs to whoever looked, not to this table.
     */
    return { message: `снят, но НЕ выставлен (${why})`, stranded: true, halt: true };
  }
  if (stage === "removing" && outcomeUnknown(err)) {
    return { message: `неизвестно, снят ли лот — ${why}`, stranded: true, halt: true };
  }

  return {
    message: `ошибка: ${why}`,
    /** Steam answered and refused: the listing is where it was. */
    stranded: false,
    halt: haltsRun(err),
  };
}
