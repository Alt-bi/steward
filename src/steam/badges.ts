import { fetchText, type Pacing } from "./net";

/**
 * Which games still owe us card drops.
 *
 * `/my/badges` answered a cheap `ajaxallbadges` fragment until Steam's SSR wave
 * reached the badges pages (verified 2026-08-31: the endpoint now serves the
 * full page for every parameter). So the scanner reads the SSR document the
 * same way `hoverRefs` reads markup — plain text, no DOM — and walks `?p=N`
 * while the footer says there is more.
 *
 * What each row reliably carries:
 * - `id="badge_gamebadge_<appid>_<badge_type>_<n>"` — the appid; the
 *   `/gamecards/<appid>/` anchor is a *sibling* of the stats block, so ids are
 *   the dependable source, not hrefs;
 * - `progress_info_bold` — «4 card drops remaining» / «No card drops
 *   remaining». A row without the span (foil badges) never has drops;
 * - `badge_progress_info` — «3 of 7 cards collected».
 *
 * Foil rows repeat a game with «- Foil Badge» in the title and carry no drop
 * counter; they ride along with `foil` set so the UI can hide or show them.
 */

export interface BadgeRow {
  appid: number;
  name: string;
  /** null for rows Steam gives no drop counter (foils, no-drop licenses). */
  dropsRemaining: number | null;
  cardsCollected: number | null;
  cardsTotal: number | null;
  foil: boolean;
  /** Badge level when the row names one («Level 2 Badge», badge id suffix). */
  level: number;
}

export interface BadgeScan {
  rows: BadgeRow[];
  /** Rows Steam claims exist across all pages ("Showing 1-150 of 296 badges"). */
  totalBadges: number | null;
  /** False when the walk was cut short — never let the UI call a partial scan complete. */
  complete: boolean;
}

const ROW_ID = /id="badge_gamebadge_(\d+)_(\d+)_(\d+)"/;
const DROPS = /progress_info_bold">\s*(?:No card drops remaining|([\d,]+) card drops? remaining)/;
const COLLECTED = /badge_progress_info">\s*([\d,]+) of ([\d,]+) cards? collected/;
const SHOWING = /Showing [\d,-]+ of ([\d,-]+) badges/;

function toInt(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/** Splits the SSR sheet into one text chunk per badge row, in document order. */
function rowChunks(body: string): string[] {
  const marks: { at: number; id: RegExpMatchArray }[] = [];
  const scan = /id="badge_gamebadge_\d+_\d+_\d+"/g;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(body))) marks.push({ at: m.index, id: ROW_ID.exec(m[0])! });
  const chunks: string[] = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1]!.at : body.length;
    chunks.push(body.slice(marks[i]!.at, end));
  }
  return chunks;
}

/** One row's chunk → data, or null when the chunk is not a parseable badge. */
export function badgeRowFrom(chunk: string): BadgeRow | null {
  const id = ROW_ID.exec(chunk);
  if (!id) return null;
  const [, appid, badgeType, suffix] = id;
  const title = /badge_title">\s*([^<]{1,120}?)\s*(?:- Foil Badge)?\s*(?:&nbsp;|<)/.exec(chunk);
  const drops = DROPS.exec(chunk);
  const collected = COLLECTED.exec(chunk);
  const name = (title ? title[1]! : "").replace(/\s+/g, " ").trim();
  if (!name) return null;
  const foil = /- Foil Badge/.test(chunk.slice(0, 3000)) || badgeType === "2";
  return {
    appid: Number(appid),
    name: foil ? name.replace(/- Foil Badge\s*$/i, "").trim() : name,
    dropsRemaining: drops && drops[1] ? toInt(drops[1]!) : drops ? 0 : null,
    cardsCollected: collected ? toInt(collected[1]!) : null,
    cardsTotal: collected ? toInt(collected[2]!) : null,
    foil,
    level: Number(suffix) + 1,
  };
}

/** Parses one whole SSR badges page. */
export function badgesPageFrom(body: string): BadgeRow[] {
  const rows: BadgeRow[] = [];
  for (const chunk of rowChunks(body)) {
    const row = badgeRowFrom(chunk);
    if (row) rows.push(row);
  }
  return rows;
}

export function totalBadgesFrom(body: string): number | null {
  const m = SHOWING.exec(body);
  return m ? toInt(m[1]!) : null;
}

/**
 * Where the walk is right now.
 *
 * Reported twice per page — once before the fetch, once after it parsed —
 * because the badges gate paces this to a few pages a minute: a caller that
 * only hears about finished pages shows a frozen panel for ten seconds at a
 * time, which is indistinguishable from a hang.
 */
export interface BadgeScanProgress {
  /** 1-based page. */
  page: number;
  /** Badge rows read so far, across all pages. */
  rows: number;
  /** What Steam says the shelf holds; known once page 1 has been read. */
  total: number | null;
  /** False while this page is still in flight (queued behind the rate gate). */
  read: boolean;
}

export interface BadgeScanOptions extends Pacing {
  /** Hard page ceiling; a farm account with absurd libraries stops here. */
  maxPages?: number;
  onProgress?: (progress: BadgeScanProgress) => void;
}

const FIRST_PAGE = "https://steamcommunity.com/my/badges/?l=english&p=1";

/**
 * Walks the badge pages. Rows repeat the same game across badge levels and
 * foil variants — kept as separate rows on purpose, the UI groups by appid.
 */
export async function scanBadges(opts: BadgeScanOptions): Promise<BadgeScan> {
  const maxPages = opts.maxPages ?? 20;
  const rows: BadgeRow[] = [];
  let total: number | null = null;

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? FIRST_PAGE : FIRST_PAGE.replace("p=1", `p=${page}`);
    opts.onProgress?.({ page, rows: rows.length, total, read: false });
    const body = await fetchText(url, { kind: "badges", ...opts });
    const pageRows = badgesPageFrom(body);
    if (page === 1) total = totalBadgesFrom(body);
    rows.push(...pageRows);
    opts.onProgress?.({ page, rows: rows.length, total, read: true });
    if (!pageRows.length) {
      /**
       * A page that parsed to nothing ends the walk — but it is only a
       * COMPLETE walk when we already read rows, or when Steam itself says the
       * shelf is empty («Showing 0 of 0 badges»).
       *
       * The difference is the whole factory. Markup that moved under us parses
       * to zero rows too, and calling that complete tells the rotation engine
       * that every game in the bench finished at once: it evicts them all,
       * marks them finished forever, and closes the factory with «дропов нигде
       * не осталось». One changed class name would have retired a farm that
       * still owed hundreds of cards.
       */
      return { rows, totalBadges: total, complete: rows.length > 0 || total === 0 };
    }
    if (total !== null && rows.length >= total) {
      return { rows, totalBadges: total, complete: true };
    }
  }
  return { rows, totalBadges: total, complete: false };
}

/** Games that still owe drops — the only rows farming can act on. */
export function farmableRows(scan: BadgeScan): BadgeRow[] {
  return scan.rows.filter((r) => !r.foil && r.dropsRemaining !== null && r.dropsRemaining > 0);
}

/**
 * What dropped between two scans: appid -> how many fewer drops Steam counts
 * now. The badges page is the only ledger that matters, and this diff is how
 * the panel proves the farming is working without asking Steam for anything.
 */
export function dropsDelta(
  before: Map<number, number | null>,
  now: readonly BadgeRow[]
): Map<number, number> {
  const out = new Map<number, number>();
  for (const row of now) {
    const was = before.get(row.appid);
    const is = row.dropsRemaining;
    if (was === null || was === undefined || is === null) continue;
    if (is < was) out.set(row.appid, was - is);
  }
  return out;
}
