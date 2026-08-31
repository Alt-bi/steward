import type { ItemKeyed } from "../core/types";
import { allowSteamTraffic } from "./net";
import { resolveHistories, unknownHistories } from "./histories";
import type { ResolveHistoryOptions } from "./histories";
import type { HistoryStats } from "./pricehistory";

/**
 * The load-history ritual, once instead of twice.
 *
 * Both pricers (Inventory and Reprice) fetch sale histories for whatever they
 * just priced, and the ritual around the fetch was copy-pasted between them:
 * warn before a big ask because pricehistory is Steam's slowest door (~6/min),
 * respect the traffic gate, report what came back. Two copies meant two
 * chances to drift; the messages differ per tab, everything else does not.
 */

/** Roughly what the governor allows per minute on the strictest endpoint. */
export const HISTORY_PER_MIN = 6;

/** Past this many unknowns the user is asked to pay for it first. */
export const HISTORY_ASK_ABOVE = 12;

export interface HistoryUi {
  /** Ask before spending; return false to give up. Defaults to window.confirm. */
  ask(missing: number, minutes: number): boolean;
}

export interface HistoryOutcome {
  /**
   * `declined` — the user said no to the cost.
   * `quiet` — the traffic gate still holds; nothing was asked.
   * `blocked` / `aborted` — Steam refused or the user stopped mid-run.
   * `""` — the pass finished.
   */
  stopped: "" | "declined" | "quiet" | "aborted" | "blocked";
  gateMessage: string;
  /** How many of the asked items had no cached answer. */
  missing: number;
  stats: Record<string, HistoryStats | null>;
  requests: number;
  fromCache: number;
}

const NOTHING: HistoryOutcome = {
  stopped: "quiet",
  gateMessage: "",
  missing: 0,
  stats: {},
  requests: 0,
  fromCache: 0,
};

export async function loadHistories(
  items: ItemKeyed[],
  options: ResolveHistoryOptions & { askAbove?: number },
  ui: HistoryUi
): Promise<HistoryOutcome> {
  const missing = await unknownHistories(items);
  const askAbove = options.askAbove ?? HISTORY_ASK_ABOVE;

  /** Everything cached is not traffic: no prompt, no gate, no waiting. */
  if (!missing.length) {
    const cached = await resolveHistories(items, {});
    return { stopped: "", gateMessage: "", missing: 0, stats: cached.stats, requests: cached.requests, fromCache: cached.fromCache };
  }

  if (missing.length > askAbove) {
    const minutes = Math.max(1, Math.ceil(missing.length / HISTORY_PER_MIN));
    if (!ui.ask(missing.length, minutes)) return { ...NOTHING, stopped: "declined" };
  }

  const quiet = await allowSteamTraffic();
  if (quiet) return { ...NOTHING, gateMessage: quiet };

  const result = await resolveHistories(items, options);
  return {
    stopped: result.stopped === "blocked" ? "blocked" : result.stopped === "aborted" ? "aborted" : "",
    gateMessage: "",
    missing: missing.length,
    stats: result.stats,
    requests: result.requests,
    fromCache: result.fromCache,
  };
}

/** The standard confirm text; tabs may pass their own wording via `ui.ask`. */
export function defaultAsk(missing: number, minutes: number): boolean {
  return window.confirm(
    `Истории продаж не хватает у ${missing} предм.` +
      `\n\nЭто ${missing} запрос(ов), примерно ${minutes} мин. ` +
      "Быстрее нельзя: это самый строгий лимит Steam." +
      "\n\nОтветы держатся несколько часов, повтор будет бесплатным. Качаем?"
  );
}
