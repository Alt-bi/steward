import { classKey, type ClassRef } from "./descriptions";

/**
 * The whole trade-offer inbox, read off the page Steam has already drawn.
 *
 * The single-offer feature answers «is this one offer a scam». This answers the
 * question that comes first: out of thirty offers sitting in the list, which two
 * are worth opening. Nothing here makes a request — the offers, their items and
 * their state are all in the DOM by the time the page has painted.
 *
 * The one thing the page does *not* say is which side of an offer is yours. Steam
 * marks the two blocks by layout, not by meaning, so this module works it out from
 * the avatars and records how sure it is. A feature that got that backwards would
 * call a robbery a bargain, so «I guessed» is carried all the way to the screen
 * rather than hidden.
 */

export type OfferDirection = "incoming" | "outgoing";

/** What the banner says is happening to the offer. */
export type OfferState = "active" | "hold" | "counter" | "closed";

/** How confident the side assignment is, best first. */
export type SideSource = "avatar" | "header" | "layout";

export interface OfferItem extends ClassRef {
  key: string;
  amount: number;
}

export interface TradeOffer {
  offerId: string;
  direction: OfferDirection;
  partnerName: string;
  partnerUrl: string;
  /** What would land in your inventory. */
  gets: OfferItem[];
  /** What would leave it. */
  gives: OfferItem[];
  /** Steam's own banner, verbatim, when there was one. */
  banner: string;
  state: OfferState;
  sideSource: SideSource;
}

const OFFER_ROW_ID = /^tradeofferid_(\d+)$/;
const OFFER_HREF = /\/tradeoffer\/(\d+)/;
const ECONOMY_ITEM = /classinfo\/(\d+)\/(\d+)(?:\/(\d+))?/;
const PROFILE_HREF = /steamcommunity\.com\/(?:profiles|id)\/([^/?#]+)/i;

const HOLD = /hold|held|escrow|удерж|заблокирован/i;
const COUNTER = /counter|встречн/i;
const CLOSED = /declin|cancel|expired|отклон|отмен|истек|истёк/i;

const RECEIVE = /you will receive|вы получите|получите:/i;
const GIVE = /you will (?:give|offer)|вы отдадите|отдадите:|отдаёте:/i;

export function offerIdFrom(id: string | null | undefined, href?: string | null): string | null {
  return OFFER_ROW_ID.exec(String(id ?? ""))?.[1] ?? OFFER_HREF.exec(String(href ?? ""))?.[1] ?? null;
}

/** `classinfo/730/310777117/302028390` — the only thing a tile actually carries. */
export function parseClassRef(economyItem: string | null | undefined): ClassRef | null {
  const m = ECONOMY_ITEM.exec(String(economyItem ?? ""));
  if (!m?.[1] || !m[2]) return null;
  return { appid: Number(m[1]), classid: m[2], instanceid: m[3] ?? "0" };
}

/**
 * A stack label. Anything unreadable is one copy: an offer of a single item read
 * as forty would invent a windfall that is not there.
 */
export function stackAmount(text: string | null | undefined): number {
  const cleaned = String(text ?? "").replace(/[\s\u00a0\u202f]/g, "");
  const digits = /(\d[\d.,]*)/.exec(cleaned)?.[1];
  if (!digits) return 1;
  const n = Number.parseInt(digits.replace(/[.,]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Two profile links pointing at the same person, whatever form Steam wrote them in. */
export function sameProfile(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = PROFILE_HREF.exec(String(a ?? ""))?.[1];
  const right = PROFILE_HREF.exec(String(b ?? ""))?.[1];
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

export function bannerState(banner: string | null | undefined, ctnClass = ""): OfferState {
  const text = String(banner ?? "");
  /** A hold is about items you will still get; a closed offer is over. Closed wins. */
  if (CLOSED.test(text) || /\binactive\b/.test(String(ctnClass))) return "closed";
  if (COUNTER.test(text)) return "counter";
  if (HOLD.test(text)) return "hold";
  return "active";
}

export interface OfferSideParts {
  /** The block's class attribute — `tradeoffer_items primary` and friends. */
  classes?: string | null;
  /** Profile link of whoever owns this side, when the block carries an avatar. */
  avatarHref?: string | null;
  headerText?: string | null;
  items: { economy?: string | null; amountText?: string | null }[];
}

export interface OfferParts {
  id?: string | null;
  offerHref?: string | null;
  partnerName?: string | null;
  partnerUrl?: string | null;
  banner?: string | null;
  ctnClass?: string | null;
  /** True when the offer carries an Accept control — only incoming offers do. */
  hasAccept?: boolean;
  /** Which page we are on, used when the offer itself does not say. */
  direction?: OfferDirection;
  /** Our own steamid, when the page bridge has delivered it. */
  steamId?: string | null;
  sides: OfferSideParts[];
}

type Owner = "yours" | "theirs";

const RANK: Record<SideSource, number> = { avatar: 0, header: 1, layout: 2 };

interface Guess {
  owner: Owner;
  source: SideSource;
}

/**
 * Who owns one block, and on what evidence.
 *
 * The avatar is the only signal that means anything: it is a link to a person.
 * The header text is a translation away from breaking, and `primary`/`secondary`
 * is pure layout — kept last so the answer is never wrong *silently*.
 */
function guessOwner(
  side: OfferSideParts,
  partnerUrl: string,
  steamId: string | null
): Guess | null {
  const avatar = String(side.avatarHref ?? "");
  if (avatar) {
    if (partnerUrl && sameProfile(avatar, partnerUrl)) return { owner: "theirs", source: "avatar" };
    if (steamId && avatar.includes(steamId)) return { owner: "yours", source: "avatar" };
    if (partnerUrl) return { owner: "yours", source: "avatar" };
  }

  const header = String(side.headerText ?? "");
  if (RECEIVE.test(header)) return { owner: "theirs", source: "header" };
  if (GIVE.test(header)) return { owner: "yours", source: "header" };

  const classes = String(side.classes ?? "");
  if (/\bprimary\b/.test(classes)) return { owner: "theirs", source: "layout" };
  if (/\bsecondary\b/.test(classes)) return { owner: "yours", source: "layout" };
  return null;
}

function sideItems(side: OfferSideParts): OfferItem[] {
  const out: OfferItem[] = [];
  for (const tile of side.items ?? []) {
    const ref = parseClassRef(tile.economy);
    if (!ref) continue;
    out.push({ ...ref, key: classKey(ref), amount: stackAmount(tile.amountText) });
  }
  return out;
}

/**
 * One offer, from strings. Split from the DOM walk for the same reason as every
 * other parser here: the rules are worth asserting, and the test environment has
 * no browser to assert them in.
 */
export function parseOffer(parts: OfferParts): TradeOffer | null {
  const offerId = offerIdFrom(parts.id, parts.offerHref);
  if (!offerId) return null;

  const partnerUrl = String(parts.partnerUrl ?? "");
  const steamId = parts.steamId ?? null;
  const sides = parts.sides ?? [];

  /** The most trustworthy read wins, and the other block is simply the other side. */
  let decided: Guess | null = null;
  let decidedIndex = -1;
  for (let i = 0; i < sides.length; i++) {
    const guess = guessOwner(sides[i]!, partnerUrl, steamId);
    if (!guess) continue;
    if (decided === null || RANK[guess.source] < RANK[decided.source]) {
      decided = guess;
      decidedIndex = i;
    }
  }

  const gets: OfferItem[] = [];
  const gives: OfferItem[] = [];

  sides.forEach((side, index) => {
    const items = sideItems(side);
    if (!items.length) return;
    let owner: Owner;
    if (decided) {
      owner =
        index === decidedIndex ? decided.owner : decided.owner === "yours" ? "theirs" : "yours";
    } else {
      /** No evidence at all: first block is theirs, which is how Steam draws it. */
      owner = index === 0 ? "theirs" : "yours";
    }
    (owner === "theirs" ? gets : gives).push(...items);
  });

  const banner = String(parts.banner ?? "").replace(/\s+/g, " ").trim();
  const direction: OfferDirection = parts.hasAccept ? "incoming" : (parts.direction ?? "incoming");

  return {
    offerId,
    direction,
    partnerName: String(parts.partnerName ?? "").trim() || profileLabel(partnerUrl),
    partnerUrl,
    gets,
    gives,
    banner,
    state: bannerState(banner, parts.ctnClass ?? ""),
    sideSource: decided?.source ?? "layout",
  };
}

function profileLabel(url: string): string {
  return PROFILE_HREF.exec(url)?.[1] ?? "неизвестный";
}

/** Copies across a side, stacks counted. */
export function countItems(items: readonly OfferItem[]): number {
  return items.reduce((sum, item) => sum + Math.max(1, item.amount), 0);
}

/** Every distinct class in an offer, for one description lookup each. */
export function offerClassRefs(offer: TradeOffer): ClassRef[] {
  const seen = new Map<string, ClassRef>();
  for (const item of [...offer.gets, ...offer.gives]) {
    if (!seen.has(item.key)) {
      seen.set(item.key, { appid: item.appid, classid: item.classid, instanceid: item.instanceid });
    }
  }
  return [...seen.values()];
}

/* -------------------------------------------------------------------- the DOM */

const OFFER_SELECTOR = 'div[id^="tradeofferid_"]';
const SIDE_SELECTOR = ".tradeoffer_items";
const TILE_SELECTOR = ".trade_item";
const AMOUNT_SELECTOR = ".trade_item_amount, .item_amount, .trade_item_quantity";
const BANNER_SELECTOR = ".tradeoffer_items_banner";
const PARTNER_SELECTOR = ".tradeoffer_partner";
const PROFILE_LINK = 'a[href*="/profiles/"], a[href*="/id/"]';

interface DomNode {
  id?: string;
  className?: string;
  innerText?: string;
  textContent?: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): Iterable<DomNode>;
}

function nodeText(node: DomNode | null): string {
  if (!node) return "";
  return String(node.innerText || node.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
}

function sideParts(block: DomNode): OfferSideParts {
  const items: OfferSideParts["items"] = [];
  for (const tile of block.querySelectorAll(TILE_SELECTOR)) {
    const economy = tile.getAttribute("data-economy-item");
    if (!economy) continue;
    items.push({
      economy,
      amountText: nodeText(tile.querySelector(AMOUNT_SELECTOR)) || nodeText(tile),
    });
  }
  return {
    classes: block.className || block.getAttribute("class") || "",
    avatarHref: block.querySelector(PROFILE_LINK)?.getAttribute("href") ?? null,
    headerText: nodeText(block.querySelector(".tradeoffer_items_header")),
    items,
  };
}

export interface DomContext {
  direction: OfferDirection;
  steamId?: string | null;
}

export function offersFromDom(root: ParentNode | null, ctx: DomContext): TradeOffer[] {
  if (!root) return [];
  /**
   * By id, because Steam hangs child ids off the offer id the same way the market
   * does. A duplicate offer would double every number on the screen.
   */
  const out = new Map<string, TradeOffer>();

  for (const node of (root as unknown as DomNode).querySelectorAll(OFFER_SELECTOR)) {
    const partnerBlock = node.querySelector(PARTNER_SELECTOR);
    const partnerLink = (partnerBlock ?? node).querySelector(PROFILE_LINK);
    const accept = node.querySelector('[href*="AcceptTradeOffer"], [onclick*="AcceptTradeOffer"]');

    const sides: OfferSideParts[] = [];
    for (const block of node.querySelectorAll(SIDE_SELECTOR)) sides.push(sideParts(block));

    const offer = parseOffer({
      id: node.id,
      offerHref: node.querySelector('a[href*="/tradeoffer/"]')?.getAttribute("href") ?? null,
      partnerName: nodeText(partnerLink),
      partnerUrl: partnerLink?.getAttribute("href") ?? null,
      banner: nodeText(node.querySelector(BANNER_SELECTOR)),
      ctnClass: node.querySelector(".tradeoffer_items_ctn")?.className ?? "",
      hasAccept: Boolean(accept),
      direction: ctx.direction,
      steamId: ctx.steamId ?? null,
      sides,
    });

    /** An offer with nothing on either side is a row we failed to read, not an offer. */
    if (!offer || (!offer.gets.length && !offer.gives.length)) continue;
    if (!out.has(offer.offerId)) out.set(offer.offerId, offer);
  }
  return [...out.values()];
}

/** `/tradeoffers/sent/` is the only outgoing list Steam has. */
export function directionFromUrl(url: { pathname: string }): OfferDirection {
  return /\/tradeoffers\/sent/.test(url.pathname) ? "outgoing" : "incoming";
}

const HOST_IDS = ["tradeoffers_module", "mainContents"];

export function offersOnPage(ctx: DomContext): TradeOffer[] {
  if (typeof document === "undefined") return [];
  for (const id of HOST_IDS) {
    const host = document.getElementById(id);
    if (!host) continue;
    const found = offersFromDom(host, ctx);
    if (found.length) return found;
  }
  try {
    return offersFromDom(document.body, ctx);
  } catch {
    /* test stub has no querySelectorAll */
    return [];
  }
}
