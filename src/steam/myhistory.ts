import { sellerForBuyer, type FeeConfig } from "../core/fees";
import { parseMoneyToCents } from "../core/money";
import type { Cents } from "../core/types";
import { fetchJson, type Pacing } from "./net";

/**
 * What the account has actually done on the market, from `/market/myhistory`.
 *
 * Every other reader here answers «what is a thing worth». This one answers the
 * question all of them exist for — what came of it. The endpoint returns the
 * same envelope as `/market/mylistings` (`results_html` + `assets` + `hovers`,
 * measured 2026-09-03), so only the rows are new.
 *
 * Two deliberate refusals, both about not inventing numbers:
 *
 * 1. **Dates are never parsed.** Steam prints them short and localised — «4
 *    сен», `Sep 4` — with no year. Turning that into a timestamp means guessing
 *    a locale and then guessing which December is last December, and a revenue
 *    figure built on a guessed year is worse than no figure. The strings are
 *    carried through verbatim and the window is «the last N records», which
 *    needs nothing decoded to be true.
 * 2. **What kind of event a row is comes from the counterparty, not the sign.**
 *    A row shows `+` when items arrived and `-` when they left, which cannot
 *    separate a sale from a listing being created — both take the item away.
 *    Only a sale and a purchase have a person on the other end, and that person
 *    is a link in the row. So the money questions rest on the one signal that
 *    cannot mean two things, and the rest is labelling.
 */

export type HistoryAction = "sold" | "bought" | "listed" | "cancelled" | "unknown";

export interface HistoryEvent {
  /** `history_row_<listingid>_<eventid>`: one event, not one listing. */
  id: string;
  action: HistoryAction;
  name: string;
  game: string;
  appid: number | null;
  hash: string;
  /** What the row printed, in the terms the market quotes — buyer's money. */
  price: Cents;
  /** Exactly the strings Steam drew, never a parsed date. */
  actedOn: string;
  listedOn: string;
  /**
   * What the cell the whole classification rests on actually says, verbatim.
   *
   * `null` means the row had no such cell at all — a different failure from a
   * cell that is present and names nobody, and the two need telling apart from
   * the outside. Carried so the panel can show what it read instead of only
   * what it concluded: a reader that decides «продано 0» over a hundred rows
   * should be able to produce its evidence.
   */
  who: string | null;
}

interface HistoryResponse {
  success?: boolean | number;
  results_html?: string;
  total_count?: number;
  start?: number;
  pagesize?: number | string;
}

const ROW_SELECTOR = '.market_listing_row[id^="history_row_"], [id^="history_row_"]';
/**
 * The whole id and nothing after it.
 *
 * Measured 2026-09-05: Steam gives the row `history_row_{listing}_{event}` and
 * then gives elements *inside* it ids built on the same stem —
 * `..._name`, `..._price`. Without the `$` every real row was read three times:
 * once correctly and twice as an empty shell that explained nothing, which is
 * exactly what the panel reported — 300 rows read, 200 «не разобрал», and every
 * sum computed over a list two thirds of which was furniture.
 */
const ROW_ID = /^history_row_(\d+)_(\d+)$/;
const MONEY_TOKEN = /[0-9]+(?:[  ]?[0-9]{3})*(?:[.,][0-9]{1,2})?/g;

function nodeText(node: { innerText?: string; textContent?: string | null } | null): string {
  if (!node) return "";
  return String(node.innerText || node.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
}

function one(row: ParentNode, selector: string): string {
  return nodeText(row.querySelector(selector) as never);
}

/** Steam always prints money with decimals; a bare `4` in a history row is a date. */
function moneyIn(text: string): Cents {
  for (const token of text.match(MONEY_TOKEN) ?? []) {
    if (!/[.,]\d{1,2}$/.test(token) && !/(?:[  ]|[.,])\d{3}$/.test(token)) continue;
    const cents = parseMoneyToCents(token);
    if (cents > 0) return cents;
  }
  return 0;
}

function attr(node: unknown, name: string): string {
  return (node as { getAttribute?: (n: string) => string | null } | null)?.getAttribute?.(name) ?? "";
}

/**
 * Whether somebody else was involved.
 *
 * A sale and a purchase name the other side and link to their profile; a
 * listing created or cancelled has nobody to name. This is the whole
 * classification, and it is why «сколько я заработал» does not depend on
 * guessing what `+` means on a row Steam labels in the user's language.
 */
export function hasCounterparty(row: ParentNode): boolean {
  const block = row.querySelector(".market_listing_whoactedwith") as unknown as ParentNode | null;
  if (!block) return false;

  const links = block.querySelectorAll("a");
  for (let i = 0; i < links.length; i += 1) {
    const href = attr(links[i], "href");
    if (href.includes("/profiles/") || href.includes("/id/")) return true;
  }
  /**
   * Three ways Steam draws a person, because it does not always draw all three.
   *
   * The profile link is the plainest, but the cell can also be an avatar with
   * the hover data hung off a `div`, and then the only thing saying «somebody
   * is here» is `data-miniprofile` — an account id — or the avatar itself. A
   * listing or a cancellation has no other side to draw, so none of these can
   * appear on one; missing all three is what makes the row ours alone.
   */
  if (block.querySelector("[data-miniprofile]")) return true;
  if (block.querySelector("img")) return true;
  return false;
}

export function classifyRow(sign: string, counterparty: boolean): HistoryAction {
  const moved = sign.includes("+") ? "in" : sign.includes("-") ? "out" : "";
  if (counterparty) {
    if (moved === "out") return "sold";
    if (moved === "in") return "bought";
    return "unknown";
  }
  if (moved === "in") return "cancelled";
  if (moved === "out") return "listed";
  return "unknown";
}

/** `/market/listings/{appid}/{market_hash_name}` — the only place a row names the hash. */
function itemRef(row: ParentNode): { appid: number | null; hash: string } {
  const href = attr(row.querySelector('a[href*="/market/listings/"]'), "href");
  const m = /\/market\/listings\/(\d+)\/([^/?#]+)/.exec(href);
  if (!m?.[1] || !m[2]) return { appid: null, hash: "" };
  let hash = m[2];
  try {
    hash = decodeURIComponent(hash);
  } catch {
    /* a name that will not decode is still a name */
  }
  return { appid: Number(m[1]), hash };
}

export function historyFromDom(root: ParentNode | null): HistoryEvent[] {
  if (!root) return [];
  const rows = root.querySelectorAll(ROW_SELECTOR);
  const seen = new Set<string>();
  const out: HistoryEvent[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as unknown as ParentNode & { id?: string };
    const id = String(row.id ?? "");
    if (!ROW_ID.test(id) || seen.has(id)) continue;
    seen.add(id);

    const dates = row.querySelectorAll(".market_listing_listed_date");
    const { appid, hash } = itemRef(row);
    const name = one(row, ".market_listing_item_name");
    const whoCell = row.querySelector(".market_listing_whoactedwith");

    out.push({
      id,
      action: classifyRow(one(row, ".market_listing_gainorloss"), hasCounterparty(row)),
      name: name || hash,
      game: one(row, ".market_listing_game_name"),
      appid,
      hash,
      price: moneyIn(one(row, ".market_listing_price")),
      /** Steam prints the acted-on date first and the listed-on date second. */
      actedOn: nodeText(dates[0] as never),
      listedOn: nodeText(dates[1] as never),
      who: whoCell ? nodeText(whoCell as never).slice(0, 120) : null,
    });
  }
  return out;
}

export interface HistoryTotals {
  events: number;
  sold: number;
  bought: number;
  listed: number;
  cancelled: number;
  /** Rows the markup did not explain. Shown, never folded into a total. */
  unknown: number;
  /** What buyers paid us — read off the page, not computed. */
  gross: Cents;
  /** What that leaves after Steam and the publisher, at the standard rate. */
  net: Cents;
  /** What we paid other people. */
  spent: Cents;
  /** Rows that carried no price, so both sums are short by this many. */
  unpriced: number;
  /** The two dates Steam printed at the ends of the range, verbatim. */
  from: string;
  to: string;
  /**
   * The distinct things the counterparty cell said, verbatim, at most four.
   *
   * The panel shows these only when nothing was classified as a sale — which is
   * either true or a sign that this reader is looking at the wrong cell, and
   * those two cannot be told apart from inside.
   */
  whoSaid: string[];
  top: { name: string; count: number; gross: Cents }[];
}

/**
 * The report.
 *
 * `net` is the one figure here that is calculated rather than read, because
 * Steam states what the buyer paid and never what landed in the wallet. It uses
 * the same fee inversion the repricer aims with, at the standard publisher
 * rate — a game that charges something else is off by that difference, so the
 * panel says which number was read and which was worked out.
 */
export function summarizeMarketHistory(
  events: readonly HistoryEvent[],
  fees: FeeConfig,
  publisherFeePercent = 10
): HistoryTotals {
  const totals: HistoryTotals = {
    events: events.length,
    sold: 0,
    bought: 0,
    listed: 0,
    cancelled: 0,
    unknown: 0,
    gross: 0,
    net: 0,
    spent: 0,
    unpriced: 0,
    from: "",
    to: "",
    whoSaid: [],
    top: [],
  };

  const byItem = new Map<string, { name: string; count: number; gross: Cents }>();

  for (const event of events) {
    totals[event.action] += 1;
    if (event.action === "sold") {
      if (event.price > 0) {
        totals.gross += event.price;
        totals.net += sellerForBuyer(event.price, publisherFeePercent, fees);
      } else {
        totals.unpriced += 1;
      }
      const key = event.hash || event.name;
      const row = byItem.get(key) ?? { name: event.name || key, count: 0, gross: 0 };
      row.count += 1;
      row.gross += event.price;
      byItem.set(key, row);
    } else if (event.action === "bought") {
      if (event.price > 0) totals.spent += event.price;
      else totals.unpriced += 1;
    }
  }

  /** Newest first is how Steam serves it, so the ends of the list are the ends of the range. */
  const dated = events.filter((event) => event.actedOn);
  totals.to = dated[0]?.actedOn ?? "";
  totals.from = dated[dated.length - 1]?.actedOn ?? "";

  const said = new Set<string>();
  for (const event of events) {
    said.add(event.who == null ? "(ячейки нет)" : event.who || "(пусто)");
  }
  totals.whoSaid = [...said].slice(0, 4);

  totals.top = [...byItem.values()]
    .sort((a, b) => b.gross - a.gross || b.count - a.count)
    .slice(0, 5);
  return totals;
}

export const HISTORY_PAGE_SIZE = 100;

function parseMarkup(markup: string): ParentNode | null {
  if (!markup || typeof DOMParser === "undefined") return null;
  return new DOMParser().parseFromString(markup, "text/html") as unknown as ParentNode;
}

export function historyPageUrl(start: number, count: number): string {
  return `https://steamcommunity.com/market/myhistory/render/?query=&start=${start}&count=${count}`;
}

/**
 * One page of history. Never automatic — the caller counts the pages out loud
 * first, the way the price-history button does.
 */
export async function fetchHistoryPage(
  start: number,
  count: number,
  pacing: Pacing
): Promise<{ events: HistoryEvent[]; total: number }> {
  const data = await fetchJson<HistoryResponse>(historyPageUrl(start, count), {
    kind: "mylistings",
    ...pacing,
    /** No rows and no count is Steam declining, not an empty history. */
    isEmpty: (payload) => {
      const body = payload as HistoryResponse | null;
      return !body || (!body.results_html && !body.total_count);
    },
  });
  return {
    events: historyFromDom(parseMarkup(String(data.results_html ?? ""))),
    total: Number(data.total_count ?? 0) || 0,
  };
}
