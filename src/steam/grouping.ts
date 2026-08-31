import { send, type GroupEntry } from "../core/messaging";

/**
 * The listing book refuses to answer some apps when asked by `market_hash_name` —
 * appid 730 for one. It answers when asked by the item's internal group id, the
 * string the item page itself sends as `strItemName`. Those names are learned
 * wherever they surface for free (search answers, item pages) and asked back
 * before the exact scan spends a request on a name Steam no longer knows.
 */

export interface GroupFact {
  hash: string;
  appid: number;
  groupId: string;
}

/** The learned group id for one item, or null when we never learned one. */
export async function knownGroup(appid: number, hash: string): Promise<string | null> {
  try {
    const { hits } = await send("naming/get", { keys: [hash] });
    const hit = hits?.[hash];
    return typeof hit === "string" ? hit : null;
  } catch {
    return null;
  }
}

/**
 * Remember group ids learned as a by-product of other requests. Fire-and-forget:
 * losing a fact costs one wasted request later, and nothing here may slow down
 * or fail the run that learned it.
 */
export function learnGroups(appid: number, facts: ReadonlyMap<string, string>): void {
  const entries: GroupEntry[] = [];
  facts.forEach((groupId, hash) => {
    if (hash && groupId && groupId !== hash) entries.push({ hash, appid, groupId });
  });
  if (!entries.length) return;
  void send("naming/set", { entries }).catch(() => undefined);
}

/** The stored name stopped working; drop it so we stop trusting it. */
export function forgetGroup(hash: string): void {
  void send("naming/drop", { keys: [hash] }).catch(() => undefined);
}