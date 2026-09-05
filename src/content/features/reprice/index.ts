import { send } from "../../../core/messaging";
import { formatCents } from "../../../core/money";
import { noneDropped, togglePick, type Picks } from "../../../core/picks";
import { loadSettings, type Settings } from "../../../core/settings";
import type { Cents, ItemKeyed, Listing, RepricePlan } from "../../../core/types";
import { needsConfirmation, removeListing, sellItemWhenReady } from "../../../steam/actions";
import { rescanOwnership, scanCompetitors, type CompetitorScan } from "../../../steam/listings";
import {
  applyAssetRefs,
  fetchAssetRefsFor,
  fetchMyListings,
  fetchOurLotsForItem,
  listingsOnPage,
} from "../../../steam/mylistings";
import { loadInventory, pickReturnedAsset } from "../../../steam/inventory";
import { allowSteamTraffic, sleep, SteamError, type WaitReason } from "../../../steam/net";
import { currencyId, feeConfig, sessionId, steamId, waitForPage } from "../../../steam/page-context";
import { fetchMarketLows, priceCacheKey } from "../../../steam/prices";
import { el, type StatusKind } from "../../ui/panel";
import { humanMinutes } from "../../../core/duration";
import { describeError, describeRelistFailure, type WriteStage } from "../../ui/errors";
import { register, type FeatureContext } from "../registry";
import {
  cancellablePlans,
  DEFAULT_LISTING_FILTERS,
  isMovable,
  listingTotals,
  movablePlans,
  viewPlans,
  type ListingFilters,
  type ListingOnly,
} from "./view";
import {
  buildPlans,
  BookLiveness,
  competitorFromMarketLow,
  competitorFromScan,
  groupListings,
  needsExactCheck,
  type CompetitorLow,
  type ItemGroup,
} from "./plan";

/** Listing pages opened in parallel when the market minimum turned out to be ours. */
const EXACT_CONCURRENCY = 2;

/**
 * Whether the listing book is answering at all.
 *
 * Module-level so the answer outlives one run — but a *judgment*, not a
 * verdict: one markup page is weather, two in a row is a pattern, and the
 * next scan re-asks from zero. See `BookLiveness` in plan.ts for what this
 * codebase got wrong by making the old flag permanent.
 */
const bookLiveness = new BookLiveness();

/**
 * Apps whose items Steam will not answer to by market_hash_name.
 *
 * Counter-Strike moved every item onto a group id — a skin, and a plain case
 * too — and the book asked for by hash there comes back empty rather than
 * refused. Our own lot is in that book by definition, so an empty one for an
 * item we are selling is proof about the name, not about the market.
 *
 * Module-level for the same reason as the flag above: it is a fact about the
 * app, and paying one request per item to rediscover it on every scan is exactly
 * the budget the prices needed.
 */
const unnamedApps = new Set<number>();

/**
 * How long the account-wide read of our own listings stays usable.
 *
 * It costs seven paced requests on a 669-lot account and only goes stale when a
 * lot is sold, cancelled or repriced — ours drop it outright, and this covers
 * the ones another tab made without telling us.
 */
const OUR_LOTS_TTL_MS = 5 * 60_000;

interface State {
  busy: boolean;
  abort: boolean;
  settings: Settings;
  listings: Listing[];
  groups: Map<string, ItemGroup>;
  /** Every listing id we know to be ours — the page's rows plus what Steam listed. */
  ourIds: Set<string>;
  /** Steam named all of our listings, so an id outside `ourIds` is somebody else's. */
  ownershipComplete: boolean;
  /** Everything we have learned so far, kept across a continue. */
  marketLows: Record<string, Cents | null>;
  lows: Map<string, CompetitorLow>;
  /**
   * The listing book each item answered with, kept whole.
   *
   * Learning afterwards that the cheapest lot was ours has to be answerable
   * without asking Steam a second time.
   */
  books: Map<string, CompetitorScan>;
  /** Items Steam stopped us before pricing. */
  unresolved: ItemKeyed[];
  plans: RepricePlan[];
  /** Listings the user unticked. Everything scanned starts ticked. */
  dropped: Picks;
  filters: ListingFilters;
}

function money(cents: Cents | null | undefined): string {
  return formatCents(cents, currencyId());
}

/**
 * How long a batch of reprices takes, in milliseconds.
 *
 * Each lot costs two paced writes — `removelisting` and `sellitem` — plus the
 * two pauses the run puts around them. The write budget is eight a minute, so
 * the writes alone are fifteen seconds a lot before anything is waited for.
 */
const WRITES_PER_LOT = 2;
const WRITE_BUDGET_PER_MIN = 8;

export function runTimeMs(lots: number, delayMs: number): number {
  return lots * (WRITES_PER_LOT * (60_000 / WRITE_BUDGET_PER_MIN) + 2 * Math.max(0, delayMs));
}

/** «40 с», «22 мин», «1 ч 5 мин» — whichever the number actually is. */

/** How far a move takes the price down, in whole percent. Null when it does not move. */
function dropPercent(plan: RepricePlan): number | null {
  if (plan.action !== "reprice" || plan.targetBuyer == null || plan.ourBuyer < 1) return null;
  const cut = plan.ourBuyer - plan.targetBuyer;
  if (cut <= 0) return null;
  return Math.round((cut / plan.ourBuyer) * 100);
}

interface RowHooks {
  picked: boolean;
  /** Past the ceiling: shown, explained, and left for the owner to decide. */
  deep: boolean;
  onToggle: () => void;
}

function planRow(plan: RepricePlan, hooks: RowHooks): HTMLElement {
  const row = el("div", "stw-row");
  row.dataset.id = plan.listingId;
  row.dataset.kind = plan.result ?? (plan.unverified ? "unsure" : plan.action);

  const name = el("label", "stw-name");
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "stw-check";
  check.checked = hooks.picked;
  /** A listing already handled this run is history, not a choice. */
  check.disabled = plan.result === "ok";
  check.addEventListener("change", hooks.onToggle);
  name.append(check, document.createTextNode(` ${plan.name}`));
  name.title = plan.hash;

  const prices = el("div", "stw-prices");
  prices.append(
    el("span", "stw-our", money(plan.ourBuyer)),
    el("span", "stw-arrow", "→"),
    plan.action === "reprice"
      ? el("span", "stw-tgt", money(plan.targetBuyer))
      : el("span", "stw-tgt stw-muted", money(plan.competitorBuyer))
  );
  /**
   * How deep the move is, as a number rather than as the length of an arrow.
   *
   * Two rows reading «111,87 → 76,70» and «109,39 → 100,79» look identical at a
   * glance and are not: one is a third of the price, the other is eight percent.
   * That difference is the whole decision, so it is written down.
   */
  const depth = dropPercent(plan);
  if (depth != null) {
    const chip = el("span", "stw-drop", `−${depth}%`);
    chip.dataset.deep = depth >= 30 ? "hard" : depth >= 12 ? "some" : "easy";
    prices.appendChild(chip);
  }
  prices.title = plan.ourSeller
    ? `покупатель платит ${money(plan.ourBuyer)}, тебе ${money(plan.ourSeller)}`
    : `покупатель платит ${money(plan.ourBuyer)}`;

  /**
   * One clamped line, so the order of what goes in it is the whole design.
   *
   * What needs a decision comes first, because that is the half that survives
   * the ellipsis. «Оверпрайс» is dropped outright: the amber border and the
   * percentage next to the price have already said it, and repeating it on
   * every row pushed the useful half off the end. What is left is the money
   * after the move — «тебе сейчас» answered a question nobody was asking.
   */
  const why = el("div", "stw-why");
  if (plan.resultMessage) {
    why.textContent = plan.resultMessage;
  } else {
    if (hooks.deep) row.dataset.deep = "true";
    const said = plan.reason === "оверпрайс" ? "" : plan.reason;
    const earns =
      plan.action === "reprice" && plan.targetSeller != null
        ? `тебе будет ${money(plan.targetSeller)}`
        : "";
    why.textContent =
      [hooks.deep ? "не отмечен: сдвиг глубже порога" : "", said, earns]
        .filter(Boolean)
        .join(" · ") || plan.reason;
  }
  /** The line is clamped to one row, so the whole of it lives on hover. */
  why.title = why.textContent ?? "";

  row.append(name, prices, why);
  return row;
}

/** The failure message that came back most often, for the summary line. */
function commonFailure(plans: RepricePlan[]): string | null {
  const tally = new Map<string, number>();
  for (const plan of plans) {
    if (plan.result !== "fail" || !plan.resultMessage) continue;
    tally.set(plan.resultMessage, (tally.get(plan.resultMessage) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [message, count] of tally) {
    if (count > bestCount) {
      best = message;
      bestCount = count;
    }
  }
  return best;
}

async function mount(ctx: FeatureContext): Promise<void> {
  const section = ctx.panel.addSection("reprice", "Репрайс");

  const state: State = {
    busy: false,
    abort: false,
    settings: ctx.settings,
    listings: [],
    groups: new Map(),
    ourIds: new Set(),
    ownershipComplete: false,
    marketLows: {},
    lows: new Map(),
    books: new Map(),
    unresolved: [],
    plans: [],
    dropped: noneDropped(),
    filters: { ...DEFAULT_LISTING_FILTERS },
  };

  /**
   * Which items we have already asked about ownership, and what they answered.
   *
   * Lives here rather than at module scope so it lasts exactly as long as the
   * panel it answers for: a rescan reuses it, while a fresh page, or a fresh
   * mount, starts from nothing. Cleared whenever we change what we hold.
   */
  let ourLots = new Map<string, { at: number; ids: Set<string>; low: Cents | null }>();
  /**
   * The whole account, once a walk has read it.
   *
   * A walk answers every item we hold — and it used to keep the handful in
   * `need` and throw the other six hundred away. Page two of the market then
   * paid the same seven requests over again for lots that had been in hand a
   * minute earlier. Kept whole, one walk answers every item on every page until
   * what we hold changes.
   */
  let accountLots: { at: number; ids: Set<string>; low: Map<string, Cents> } | null = null;
  /** Called after anything that changes what we hold. */
  const forgetOurLots = (): void => {
    ourLots = new Map();
    accountLots = null;
  };

  const stats = el("div", "stw-stats");
  const statNodes: Record<string, HTMLElement> = {};
  const statLabels: Record<string, HTMLElement> = {};
  const statButtons: Record<string, HTMLButtonElement> = {};
  for (const [key, label, tone] of [
    ["total", "лотов", ""],
    ["over", "оверпрайс", "warn"],
    ["unsure", "не проверено", "warn"],
    ["skip", "пропуск", ""],
  ] as const) {
    const box = el("button", "stw-stat");
    box.type = "button";
    if (tone) box.dataset.tone = tone;
    const n = el("div", "stw-stat-n", "0");
    const l = el("div", "stw-stat-l", label);
    box.append(n, l);
    statNodes[key] = n;
    statLabels[key] = l;
    statButtons[key] = box;
    /**
     * «Лотов» is the whole list, so it is the way back rather than a fourth
     * subset. Everything else narrows to what its own number counts.
     */
    const bucket: ListingOnly = key === "total" ? "" : (key as ListingOnly);
    box.addEventListener("click", () => {
      state.filters.only = state.filters.only === bucket ? "" : bucket;
      renderRows();
      renderStats();
    });
    stats.appendChild(box);
  }

  const filterRow = el("div", "stw-controls");
  const queryInput = document.createElement("input");
  queryInput.type = "search";
  queryInput.className = "stw-input";
  queryInput.placeholder = "поиск по названию";
  queryInput.title = "Ищет и по названию, и по market_hash_name — там живёт износ";

  filterRow.appendChild(queryInput);

  const shownLine = el("div", "stw-hint", "");

  /**
   * One button leads; the rest follow under it.
   *
   * Four equal buttons in a 450-px panel wrapped every label onto two lines,
   * and a row of broken labels reads as a broken panel. Scanning is where every
   * run starts, so it gets the width.
   */
  const actions = el("div", "stw-actions stw-actions-main");
  const scanBtn = el("button", "stw-btn stw-btn-primary", "Сканировать лоты");
  scanBtn.type = "button";
  actions.append(scanBtn);

  const actionsRest = el("div", "stw-actions stw-actions-rest");
  const applyBtn = el("button", "stw-btn stw-btn-go", "Переставить");
  applyBtn.type = "button";
  applyBtn.disabled = true;
  const cancelBtn = el("button", "stw-btn stw-btn-danger", "Снять");
  cancelBtn.type = "button";
  cancelBtn.title = "Снять отмеченные лоты с продажи — предметы вернутся в инвентарь";
  cancelBtn.disabled = true;
  const stopBtn = el("button", "stw-btn", "Стоп");
  stopBtn.type = "button";
  stopBtn.disabled = true;
  actionsRest.append(applyBtn, cancelBtn, stopBtn);

  /** Only appears when a run stopped with items left, so it never adds noise. */
  const resumeRow = el("div", "stw-actions stw-resume");
  const resumeBtn = el("button", "stw-btn stw-btn-primary", "Догрузить цены");
  resumeBtn.type = "button";
  resumeRow.appendChild(resumeBtn);
  resumeRow.hidden = true;

  const rows = el("div", "stw-rows");
  section.body.append(stats, filterRow, shownLine, actions, actionsRest, resumeRow, rows);

  /**
   * The pause is an annotation on whatever we are doing, not a replacement for it.
   * Overwriting the whole line made a running scan look like a hang.
   */
  let phase = "";
  let phaseKind: StatusKind = "";
  let phaseDetail = "";
  /** Deep moves the last plan left unticked, for the summary to mention. */
  let deepUnticked = 0;
  const deepSeen = new Set<string>();
  let pauseUntil = 0;
  let pauseReason: WaitReason = "budget";

  function render(): void {
    const left = pauseUntil - Date.now();
    if (left <= 0) {
      section.setStatus(phase, phaseKind, phaseDetail);
      return;
    }
    const secs = Math.ceil(left / 1000);
    const note = pauseReason === "cooldown" ? `лимит Steam ${secs}с` : `бюджет запросов ${secs}с`;
    /**
     * Edge freezes background tabs, and a frozen pause never wakes up. A scan
     * that looks hung for an hour is usually a sleeping tab, not a hung scan —
     * the status has to say so, because the alternative reading is "broken".
     */
    const asleep = document.hidden ? " · вкладка уснула, верни её на экран" : "";
    section.setStatus(
      `${phase} · ${note}${asleep}`,
      pauseReason === "cooldown" ? "warn" : phaseKind,
      phaseDetail
    );
  }

  function status(text: string, kind: StatusKind = "", detail = ""): void {
    phase = text;
    phaseKind = kind;
    phaseDetail = detail;
    pauseUntil = 0;
    render();
  }

  const pacing = {
    abort: () => state.abort,
    onWait: (msLeft: number, reason: WaitReason) => {
      pauseUntil = Date.now() + msLeft;
      pauseReason = reason;
      render();
    },
  };

  /** How long Steam wants us to wait, in words, when it has told us. */
  async function cooldownNote(): Promise<string> {
    try {
      const stats = await send("net/stats", {});
      const secs = Math.ceil(stats.cooldownMsLeft / 1000);
      if (secs > 0) {
        return secs > 90
          ? `Пауза ${Math.ceil(secs / 60)} мин.`
          : `Пауза ${secs} с.`;
      }
    } catch {
      /* no worker, no number — the advice still stands */
    }
    return "Подожди, пока маркет в этой вкладке начнёт открываться сам.";
  }

  /**
   * Our cheapest lot of one item, asked of that item’s own page.
   *
   * The scan is scoped to the page on purpose, but the *decision* is not: a
   * market minimum below the cheapest lot on this page may be our own lot on
   * another page, and stepping under it is bidding against ourselves.
   *
   * This used to be answered by walking `/market/mylistings` end to end — seven
   * paced requests and three megabytes on a 669-lot account, to learn the ten
   * listing ids that mattered, and it ran on almost every scan. The item’s own
   * page states our lots of that item outright, so the question is now asked
   * where it is answered: once per item, and only for items where the answer
   * would change what we do.
   */
  function wouldMoveOn(group: ItemGroup, low: CompetitorLow): boolean {
    /**
     * Would knowing settle anything? A lot that is already cheaper, alone in
     * its book, or sitting on the market floor is not going to move whoever
     * owns the minimum — and asking about it is a request spent on nothing.
     */
    const settled = new Map([[group.key, { ...low, theirs: true }]]);
    const optimistic = buildPlans(
      new Map([[group.key, group]]),
      settled,
      state.settings,
      feeConfig()
    );
    return optimistic.some((plan) => plan.action === "reprice");
  }

  /** Folds one item’s answer into everything that depends on it. */
  function applyOurLotsFor(group: ItemGroup, answer: { ids: Set<string>; low: Cents | null }): void {
    for (const id of answer.ids) state.ourIds.add(id);
    group.ourLowAnywhere = answer.low != null ? Math.min(answer.low, group.ourLow) : group.ourLow;

    const known = state.lows.get(group.key);
    if (!known) return;
    const book = state.books.get(group.key);
    if (book) {
      /** The rows are still here: this is a recount, not a second request. */
      state.lows.set(group.key, competitorFromScan(rescanOwnership(book, state.ourIds), true));
      return;
    }
    state.lows.set(
      group.key,
      competitorFromMarketLow(group, state.marketLows[group.key] ?? known.marketLow ?? null)
    );
  }

  /**
   * Settles ownership for the items where a lot would otherwise be moved
   * against a minimum nobody has attributed — and for no others.
   *
   * A partial answer is not used at all: half a page proves nothing about which
   * lot is holding the minimum, so `fetchOurLotsForItem` reports `ok: false`
   * rather than a smaller truth, and the planner keeps refusing.
   */
  /**
   * What the whole account would cost, in requests, as the page itself states it.
   *
   * `/market/mylistings` serves 100 lots per answer and no more — measured, the
   * `count` parameter is ignored past that — so a 669-lot account is seven
   * requests whatever we do.
   */
  function walkCost(): number {
    const stated = document.getElementById("tabContentsMyActiveMarketListings_total");
    const total = Number.parseInt(String(stated?.textContent ?? "").replace(/\D+/g, ""), 10);
    /** No number on the page: assume the walk is the eight requests it usually is. */
    if (!Number.isFinite(total) || total <= 0) return 8;
    return Math.max(1, Math.ceil(total / 100));
  }

  /** The whole account in one pass, when that is genuinely the shorter road. */
  async function walkWholeAccount(need: readonly ItemGroup[]): Promise<void> {
    const note = `Читаю свои лоты — один проход вместо ${need.length} запросов`;
    status(`${note}…`, "work");
    const mine = await fetchMyListings(0, pacing, (seen, total) =>
      status(`${note}: ${seen}/${total}…`, "work")
    );
    for (const id of mine.ids) state.ourIds.add(id);
    /** Anything short of the whole account leaves the question open. */
    if (!mine.complete) return;
    state.ownershipComplete = true;

    const low = new Map<string, Cents>();
    for (const lot of mine.listings ?? []) {
      if (lot.ourBuyer < 1) continue;
      const key = `${lot.appid}	${lot.hash}`;
      const seen = low.get(key);
      if (seen == null || lot.ourBuyer < seen) low.set(key, lot.ourBuyer);
    }
    accountLots = { at: Date.now(), ids: mine.ids, low };
    answerFromAccount(accountLots);
  }

  /** Folds a whole-account answer into every item on the page, without asking again. */
  function answerFromAccount(whole: { ids: Set<string>; low: Map<string, Cents> }): void {
    for (const id of whole.ids) state.ourIds.add(id);
    state.ownershipComplete = true;
    for (const group of state.groups.values()) {
      applyOurLotsFor(group, { ids: whole.ids, low: whole.low.get(group.key) ?? null });
    }
  }

  async function learnOurLots(): Promise<void> {
    if (state.abort || state.ownershipComplete) return;
    /** A walk this fresh has already answered every item we hold — page or not. */
    if (accountLots && Date.now() - accountLots.at < OUR_LOTS_TTL_MS) {
      answerFromAccount(accountLots);
      return;
    }
    const need: ItemGroup[] = [];
    for (const group of state.groups.values()) {
      const low = state.lows.get(group.key);
      if (!(low?.buyer != null && low.theirs === false)) continue;
      if (!wouldMoveOn(group, low)) continue;
      const fresh = ourLots.get(group.key);
      if (fresh && Date.now() - fresh.at < OUR_LOTS_TTL_MS) {
        applyOurLotsFor(group, fresh);
        continue;
      }
      need.push(group);
    }
    if (!need.length) return;

    /**
     * Per item is the cheap answer only while there are few items to ask about.
     * A page of a hundred lots can leave sixty-seven of them unattributed, and
     * sixty-seven requests is ten times what reading the entire account costs.
     * So the two roads are priced against each other and the shorter one wins —
     * measured on the page in front of us, not assumed.
     */
    if (need.length > walkCost()) {
      try {
        await walkWholeAccount(need);
      } catch {
        /* Unknown stays unknown; the planner refuses rather than guesses. */
      }
      return;
    }

    const note = "Проверяю, не наш ли лот держит минимум";
    let done = 0;
    for (const group of need) {
      if (state.abort) break;
      done += 1;
      status(`${note} ${done}/${need.length}: ${group.name}…`, "work");
      const mine = await fetchOurLotsForItem(group.appid, group.hash, group.ourListingIds, pacing);
      if (!mine.ok) continue;
      ourLots.set(group.key, { at: Date.now(), ids: mine.ids, low: mine.low });
      applyOurLotsFor(group, mine);
    }
  }

  /**
   * Deep moves come back unticked, and say so.
   *
   * The guard rail on the one button that cannot be taken back. Undercutting by
   * a kopeck is a small idea, but the number it lands on is whatever the
   * cheapest stranger asks — one thin book turns it into «минус 56%», and
   * sixty-seven of those go out on a single click that nobody read row by row.
   *
   * Refusing them outright was the first attempt and it was worse: a lot the
   * plan will not touch and will not explain is a lot the owner never learns
   * about. Unticking shows the row, shows the number, and leaves the decision
   * where it belongs — one click away, not hidden behind a setting.
   */
  function untickDeepMoves(): number {
    const ceiling = state.settings.maxDropPercent;
    if (ceiling >= 100) return 0;
    let deep = 0;
    for (const plan of state.plans) {
      const cut = dropPercent(plan);
      if (cut == null || cut <= ceiling) continue;
      deep += 1;
      /** Unticked once. Ticking it back is the owner overruling us, not a bug to fix. */
      if (deepSeen.has(plan.listingId)) continue;
      deepSeen.add(plan.listingId);
      state.dropped.add(plan.listingId);
    }
    return deep;
  }

  /** Rebuilds the plan from what we already know. Never sends a request. */
  function replan(): void {
    state.plans = buildPlans(state.groups, state.lows, state.settings, feeConfig());
    deepUnticked = untickDeepMoves();
    renderRows();
    renderStats();
  }

  /** The rows on screen: the search box decides, nothing else. */
  function currentViews(): RepricePlan[] {
    return viewPlans(state.plans, state.filters);
  }

  /** Overpriced, still live, still ticked — exactly what «Переставить» will move. */
  function pendingReprices(): RepricePlan[] {
    return movablePlans(state.plans, state.dropped);
  }

  function renderStats(): void {
    const over = state.plans.filter(isMovable).length;
    /** Split out of «пропуск»: a lot nobody looked at is not a lot that is fine. */
    const unsure = state.plans.filter((plan) => plan.unverified).length;
    statNodes.total!.textContent = String(state.listings.length);
    statNodes.over!.textContent = String(over);
    statNodes.unsure!.textContent = String(unsure);
    statNodes.skip!.textContent = String(Math.max(0, state.plans.length - over - unsure));
    for (const [key, button] of Object.entries(statButtons)) {
      const bucket = key === "total" ? "" : key;
      button.setAttribute("aria-pressed", String(state.filters.only === bucket));
      /** Nothing to narrow to is not a control, it is a dead end. */
      button.disabled = state.plans.length === 0;
    }

    /** «Overpriced» is only the word for it when we are chasing the competitor. */
    statLabels.over!.textContent = "оверпрайс";

    const todo = pendingReprices().length;
    applyBtn.textContent = todo ? `Переставить ${todo}` : "Переставить";
    applyBtn.disabled = state.busy || todo === 0;

    const views = currentViews();
    const totals = listingTotals(views, state.dropped);
    cancelBtn.textContent = totals.picked ? `Снять ${totals.picked}` : "Снять";
    cancelBtn.disabled = state.busy || totals.picked === 0;

    /** «Показано A из B» is worth a line only when a filter is hiding something. */
    shownLine.textContent = state.plans.length
      ? `Отмечено ${totals.picked} · на витрине ${money(totals.value)}` +
        (totals.shown < state.plans.length ? ` · показано ${totals.shown} из ${state.plans.length}` : "")
      : "";
  }

  function rowFor(plan: RepricePlan): HTMLElement {
    const cut = dropPercent(plan);
    return planRow(plan, {
      picked: !state.dropped.has(plan.listingId),
      deep: cut != null && state.settings.maxDropPercent < 100 && cut > state.settings.maxDropPercent,
      onToggle: () => {
        togglePick(plan.listingId, state.dropped);
        renderStats();
      },
    });
  }

  function renderRows(): void {
    rows.replaceChildren();
    if (!state.plans.length) {
      rows.appendChild(
        el("div", "stw-empty", "Нажми «Сканировать лоты» — посчитаю то, что Steam показал на этой странице.")
      );
      return;
    }
    const views = currentViews();
    if (!views.length) {
      rows.appendChild(el("div", "stw-empty", "Под фильтр ничего не попало."));
      return;
    }
    for (const plan of views) rows.appendChild(rowFor(plan));
  }

  function patchRow(plan: RepricePlan): void {
    const node = rows.querySelector(`.stw-row[data-id="${plan.listingId}"]`);
    node?.replaceWith(rowFor(plan));
  }

  function setBusy(busy: boolean): void {
    state.busy = busy;
    scanBtn.disabled = busy;
    resumeBtn.disabled = busy;
    stopBtn.disabled = !busy;
    renderStats();
  }

  /**
   * Reads the listing book for the items the cheap passes could not settle.
   *
   * One request each, and it answers everything at once: the market minimum, the
   * cheapest lot that is not ours, and whether anybody is down there with us. That
   * is why the scan no longer buys a `priceoverview` hint first — the hint cost the
   * same single request and could not tell «we hold the minimum» from «Steam is
   * quoting us an hour-old minimum that used to be ours».
   */
  /**
   * Why the exact-competitor pass stopped early. `gone` is not a refusal: it is
   * Steam answering with a page instead of the listing book, which no amount of
   * waiting fixes.
   */
  type ExactStop = "blocked" | "aborted" | "gone" | "lying" | null;

  async function resolveExactLows(
    unsettled: ItemGroup[]
  ): Promise<{ stop: ExactStop; requests: number; unnamed: number[] }> {
    /** Learned once already; asking again would only spend the budget to confirm. */
    if (bookLiveness.dead()) return { stop: "gone", requests: 0, unnamed: [] };

    const ttlMs = state.settings.priceTtlMinutes * 60_000;
    /** The book hands us a fresher market minimum than priceoverview would have. */
    const fresh: { key: string; cents: number; ttlMs: number }[] = [];
    let next = 0;
    let done = 0;
    let requests = 0;
    let stop: ExactStop = null;
    /** Books of zero about items we hold — Steam's soft refusal, counted. */
    let emptyBooks = 0;
    /** Apps this run ran into the naming wall on, for the summary line. */
    const hitUnnamed = new Set<number>();

    async function worker(): Promise<void> {
      for (;;) {
        if (stop) return;
        if (state.abort) {
          stop = "aborted";
          return;
        }
        const group = unsettled[next++];
        if (!group) return;
        /**
         * No group-id detour any more. It existed because the action endpoint
         * would only answer to Counter-Strike's internal ids, and it cost a
         * search request per item to learn one. `/render/` answers by
         * `market_hash_name` for every app — measured on a wear variant, 1201
         * listings deep — so the wall it was built for is not there.
         */
        if (unnamedApps.has(group.appid)) {
          hitUnnamed.add(group.appid);
          continue;
        }
        try {
          requests += 1;
          const scan = await scanCompetitors(
            group.appid,
            group.hash,
            state.ourIds,
            pacing,
            group.ourListingIds.size,
            /**
             * We are selling this item, so our own lot is in that book by
             * definition and a book of zero cannot be an answer. There is no
             * second story left to tell here: measured 2026-09-03, `/render/`
             * answers every app by `market_hash_name`, wear variants included,
             * so an empty book is Steam refusing and nothing else.
             */
            { nameMayBeWrong: false }
          );
          if (scan.unnamed) {
            unnamedApps.add(group.appid);
            hitUnnamed.add(group.appid);
          }
          /**
           * The book spoke — even to say it holds nothing for this name — so the
           * endpoint is alive and every markup page before it was noise.
           */
          bookLiveness.sawAnswer();
          state.books.set(group.key, scan);
          state.lows.set(group.key, competitorFromScan(scan, state.ownershipComplete));
          if (scan.marketLow != null) {
            state.marketLows[group.key] = scan.marketLow;
            fresh.push({ key: priceCacheKey(group), cents: scan.marketLow, ttlMs });
          }
        } catch (err) {
          if (err instanceof SteamError && err.kind === "blocked") {
            stop = "blocked";
            return;
          }
          if (err instanceof SteamError && err.kind === "aborted") {
            stop = "aborted";
            return;
          }
          if (err instanceof SteamError && err.kind === "not_logged_in") throw err;
          if (err instanceof SteamError && err.kind === "empty") {
            /**
             * Steam answered «nobody is selling» about an item we are ourselves
             * selling. That is the first stage of its throttle, and the second
             * is the market homepage as markup — so the same two-strike rule
             * applies, and for the same reason: one is weather, two in a row is
             * a pattern, and continuing at this pace is what earns the markup.
             */
            emptyBooks += 1;
            if (emptyBooks >= 2) {
              stop = "lying";
              return;
            }
            continue;
          }
          if (err instanceof SteamError && err.kind === "not_json") {
            /**
             * Markup where JSON belongs. One of these is weather — a proxy
             * interstitial, a sorry-page in a shape the classifier missed. Only a
             * second one with nothing answered in between is a pattern, and only
             * the pattern stops the run; the items after a lone markup page get
             * their own request instead of inheriting its verdict. The page's own
             * title travels with the verdict — «web page instead of JSON» names a
             * symptom, the title names the cause, and only the cause tells the
             * user whether to wait, log in again, or solve a captcha.
             */
            bookLiveness.sawMarkup(err.note);
            if (bookLiveness.dead()) {
              stop = "gone";
              return;
            }
            continue;
          }
        }
        done += 1;
        status(`Смотрю чужие лоты ${done}/${unsettled.length} · ${group.name}`, "work");
      }
    }

    const size = Math.max(1, Math.min(EXACT_CONCURRENCY, unsettled.length));
    try {
      await Promise.all(Array.from({ length: size }, () => worker()));
    } finally {
      if (fresh.length) {
        await send("cache/set", { entries: fresh }).catch(() => undefined);
      }
    }
    return { stop, requests, unnamed: [...hitUnnamed] };
  }

  /**
   * Items whose verdict nobody has actually checked against the market.
   *
   * Dearest first, because a run that Steam cuts short should have settled the
   * listings worth money rather than whichever ones the page happened to draw
   * first.
   */
  function unsettledGroups(): ItemGroup[] {
    return [...state.groups.values()]
      .filter((g) => needsExactCheck(state.lows.get(g.key)))
      .sort(
        (a, b) =>
          Math.max(...b.listings.map((l) => l.ourBuyer), 0) -
          Math.max(...a.listings.map((l) => l.ourBuyer), 0)
      );
  }

  /**
   * Prices the given items, folds the answers into what we already knew, and
   * replans. Used by both the initial scan and the continue button.
   *
   * Our own prices never appear here: they came off the page, for free. The only
   * thing worth a request is what somebody else is asking.
   */
  async function priceAndPlan(toFetch: ItemKeyed[]): Promise<void> {
    const exact = state.settings.exactCompetitorLow;
    /**
     * In exact mode nothing but the cache runs before the listing book.
     *
     * The book always answers: one request, one item settled. `search` only
     * *sometimes* answers — it settles an item when a competitor happens to sit
     * below us, and returns nothing when it cannot match the name. Spending a
     * scarce IP budget on the optional pass first is backwards, and it showed:
     * five search requests, zero items settled, and Steam cut the scan off before
     * the book pass ever ran. The request that always answers goes first.
     */
    /**
     * …unless the book is the thing that is refusing.
     *
     * Exact mode makes the price pass cache-only because the book answers
     * better and cheaper. When the book is standing in its cooldown, that
     * reasoning inverts: skipping the priced pass leaves a run that makes no
     * requests at all, changes nothing, and reports «посчитано по рыночному
     * минимуму: 0 из 10» having computed no minimum whatsoever. That is the
     * «ничего не работает» the user hit — and the cure is the ordinary path
     * every SIH-shaped tool uses, which was sitting right here switched off.
     */
    const bookRefusing = exact && bookLiveness.dead();
    const cacheOnly = exact && !bookRefusing;

    const result = await fetchMarketLows(toFetch, {
      ...pacing,
      concurrency: state.settings.scanConcurrency,
      source: state.settings.priceSource,
      ttlMs: state.settings.priceTtlMinutes * 60_000,
      cacheOnly,
      fallbackToOverview: !exact || bookRefusing,
      onProgress: (done, total, label) => status(`Цены ${done}/${total} · ${label}`, "work"),
    });

    Object.assign(state.marketLows, result.lows);
    state.unresolved = result.unresolved;

    for (const group of state.groups.values()) {
      const known = state.lows.get(group.key);
      /** An answer read off the listing book outranks anything inferred from a low. */
      if (known && !needsExactCheck(known)) continue;
      state.lows.set(group.key, competitorFromMarketLow(group, state.marketLows[group.key] ?? null));
    }

    let exactStop: ExactStop = null;
    let exactRequests = 0;
    let unnamedAppIds: number[] = [];
    /**
     * How the rescue pass ended, which is the fact that matters when it fails.
     *
     * «Посчитано по рыночному минимуму: 0 из 10» under a sentence about the
     * listing book names the wrong endpoint: the book stopping is survivable —
     * that is what the rescue is for — but if `search` and `priceoverview`
     * stopped as well, then nothing is answering, and a user who is told to
     * blame the book goes and rescans it.
     */
    let rescueStop: "blocked" | "aborted" | null = null;
    /** Zero here with a stop above means it never got to ask at all. */
    let rescueRequests = 0;
    if (exact && !result.stopped) {
      /** Both «the minimum looks like ours» and «no price at all» are unchecked. */
      const unsettled = unsettledGroups();
      if (unsettled.length) {
        status(`Читаю чужие лоты по ${unsettled.length} предметам…`, "work");
        const book = await resolveExactLows(unsettled);
        exactStop = book.stop;
        exactRequests = book.requests;
        unnamedAppIds = book.unnamed;

        /**
         * The book refused — but the market minimum is a different endpoint,
         * and it was never asked, because exact mode had held the price pass
         * to the cache. Ask it now for whatever is still unpriced, so the run
         * ends with the answer it already claims in its own status line.
         */
        if (exactStop === "gone" || exactStop === "lying") {
          const unpriced = unsettled.filter((g) => state.marketLows[g.key] == null);
          if (unpriced.length) {
            status(`Книга лотов отказывает — беру рыночный минимум по ${unpriced.length} предм.…`, "work");
            const rescue = await fetchMarketLows(unpriced, {
              ...pacing,
              concurrency: state.settings.scanConcurrency,
              source: state.settings.priceSource,
              ttlMs: state.settings.priceTtlMinutes * 60_000,
              fallbackToOverview: true,
              onProgress: (done, total, label) => status(`Цены ${done}/${total} · ${label}`, "work"),
            });
            Object.assign(state.marketLows, rescue.lows);
            state.unresolved = rescue.unresolved;
            exactRequests += rescue.requests;
            rescueStop = rescue.stopped;
            rescueRequests = rescue.requests;
            for (const group of state.groups.values()) {
              const known = state.lows.get(group.key);
              if (known && !needsExactCheck(known)) continue;
              state.lows.set(group.key, competitorFromMarketLow(group, state.marketLows[group.key] ?? null));
            }
          }
        }
      }
    }

    await learnOurLots();

    /** «Догрузить» is about what is still unknown, and the book may have answered it. */
    const stillOpen = new Set(unsettledGroups().map((g) => g.key));
    state.unresolved = state.unresolved.filter((item) => stillOpen.has(item.key));

    replan();

    const stopped = result.stopped ?? exactStop;
    const todo = pendingReprices().length;
    const totalItems = state.groups.size;
    const unsure = stillOpen.size;
    const checked = totalItems - unsure;

    resumeRow.hidden = state.unresolved.length === 0;
    resumeBtn.textContent = `Догрузить цены (${state.unresolved.length})`;

    const cached = result.fromCache ? `, из кэша ${result.fromCache}` : "";
    /** The listing book is most of the bill now; leaving it out would flatter us. */
    const spent = `Запросов ${result.requests + exactRequests}${cached}.`;

    if (stopped === "blocked") {
      /** «Wait» is only advice if it says how long. The scheduler knows. */
      const pause = await cooldownNote();
      status(
        `Steam отказал: проверено ${checked} из ${totalItems} предметов. ` +
          `Что успели — посчитано${todo ? `, к переносу: ${todo}` : ""}. ` +
          `${pause} Повторные запросы во время отказа только удлиняют его. ${spent}`,
        "warn"
      );
      return;
    }
    if (stopped === "gone") {
      /**
       * Deliberately not «Steam отказал» and no longer «больше не отдаёт»: nothing
       * died — Steam answered twice with a web page where JSON belongs. The page
       * usually carries its own title, and that title is the diagnosis: a
       * marketsorry means wait, «Sign in» means the session is the problem, a
       * robot check means a human has to click. Without it we are guessing.
       */
      const seen = bookLiveness.lastMarkup ? ` Пришлась страница: «${bookLiveness.lastMarkup}».` : "";
      /**
       * Named separately, because it is not about the book at all — and the two
       * shapes of it need different words. Asked and refused means Steam is
       * refusing broadly. Not asked at all means our own governor closed the
       * network, which is a bug in us, not a refusal by Steam; it is what
       * «посчитано по рыночному минимуму: 0 из 10» used to be hiding.
       */
      const alsoDead =
        rescueStop === "blocked"
          ? rescueRequests > 0
            ? ` Рыночный минимум Steam тоже перестал отвечать — отказывает не только книга лотов. ${await cooldownNote()}`
            : ` Рыночный минимум я даже не спросил: сеть была уже закрыта. ${await cooldownNote()}`
          : "";
      const left = Math.ceil(bookLiveness.waitMs() / 1000);
      /**
       * Two different situations wore one sentence before, and the mismatch was
       * the report: «Steam дважды прислал…» over «Запросов 0». Either it just
       * happened, or it happened a while ago and the verdict is still standing —
       * and in the second case the only useful fact is how long is left of it.
       */
      const when = exactRequests
        ? `Steam дважды прислал веб-страницу вместо данных книги лотов — точную проверку конкурентов на этом не делаю.${seen}`
        : `Книга лотов отказывала пару минут назад, поэтому в этот раз я её не трогал` +
          `${left > 0 ? ` — попробую снова через ${left} с` : ""}.${seen}`;
      status(
        `${when} Посчитано по рыночному минимуму: ${checked} из ${totalItems}` +
          `${todo ? `, к переносу: ${todo}` : ""}.${alsoDead} ${spent}`,
        "warn"
      );
      return;
    }
    if (stopped === "lying") {
      const pause = await cooldownNote();
      status(
        `Steam дважды ответил «лотов нет» про предметы, которые сам же и продаёт, — это троттлинг, ` +
          `а не отсутствие конкурентов, поэтому точную проверку я остановил. ` +
          `Посчитано по рыночному минимуму: ${checked} из ${totalItems}` +
          `${todo ? `, к переносу: ${todo}` : ""}. ${pause} ${spent}`,
        "warn"
      );
      return;
    }
    if (stopped === "aborted") {
      status(`Остановлено: проверено ${checked} из ${totalItems}. ${spent}`, "");
      return;
    }

    /**
     * «Оверпрайса нет» is only true when everything was actually looked at. Saying
     * it over a pile of unchecked items is the bug this line used to have.
     */
    const verdict = todo
      ? `К переносу ${todo} из ${totalItems} предм.`
      : unsure
        ? `Среди проверенных двигать нечего · ${checked} из ${totalItems}`
        : `Двигать нечего · проверено ${checked} из ${totalItems}`;
    const gap = unsure ? ` Не проверено ${unsure} из ${totalItems} — конкурента там не видел.` : "";
    /**
     * Only when a lot actually stayed unattributed. Ownership is settled per
     * item now, so «знаю не полностью» is a statement about the items in front
     * of us, not a standing disclaimer about the account.
     */
    const unattributed = [...state.lows.values()].filter(
      (low) => low.buyer != null && low.theirs === false
    ).length;
    const ours = unattributed
      ? ` Про ${unattributed} предм. не выяснил, чей лот держит минимум — такой не подрезаю.`
      : "";
    /**
     * Named outright rather than folded into «не проверено»: nothing is wrong with
     * the connection, the budget or the account, and no amount of waiting or
     * rescanning will settle these — so saying so is the only useful answer.
     */
    const naming = unnamedAppIds.length
      ? ` Steam не отдаёт книгу лотов по названию предмета для прил. ${unnamedAppIds.join(", ")} — ` +
        "там каждый предмет живёт под id группы. Такие лоты считаны по рыночному минимуму. " +
        "Открой страницу такого предмета — Steward выучит id группы и точность вернётся."
      : "";

    /**
     * The answer first, on its own line, in the words someone would say out
     * loud. Everything that qualifies it is true and worth keeping — and it is
     * four lines long, which is how the sentence that matters ends up buried.
     */
    const notes = [
      deepUnticked
        ? `${deepUnticked} лот(ов) двигать пришлось бы глубже ${state.settings.maxDropPercent}% — ` +
          "такие я не отметил. Посмотри их и отметь сам, если это правда нужно."
        : "",
      gap.trim(),
      naming.trim(),
      ours.trim(),
      "Считаю только лоты этой страницы — перелистни и сканируй снова.",
      spent,
    ].filter(Boolean);
    status(verdict, todo || unsure ? "warn" : "ok", notes.join(" "));
  }

  async function scan(): Promise<void> {
    if (state.busy) return;
    state.abort = false;
    /** Pressing the button again is asking the question again; the old verdict expires. */
    bookLiveness.restart();
    state.listings = [];
    state.groups = new Map();
    state.ourIds = new Set();
    state.ownershipComplete = false;
    state.marketLows = {};
    state.lows = new Map();
    state.unresolved = [];
    state.plans = [];
    /** Histories outlive a rescan: they are hours-fresh and cost the most. */
    state.dropped = noneDropped();
    deepSeen.clear();
    deepUnticked = 0;
    resumeRow.hidden = true;
    setBusy(true);
    renderRows();
    renderStats();

    const quiet = await allowSteamTraffic();
    if (quiet) {
      status(quiet, "warn");
      setBusy(false);
      return;
    }

    state.settings = await loadSettings();
    await waitForPage();

    if (!sessionId()) {
      status("Не вижу sessionid — зайди в Steam в этой вкладке.", "err");
      setBusy(false);
      return;
    }

    try {
      /**
       * Only the page Steam is showing. Whatever the account owner chose as the
       * page size is the scope of this scan; the rest of the account is not read,
       * not priced, not touched.
       */
      status("Читаю лоты на странице…", "work");
      const listings = listingsOnPage();
      /**
       * The page names the asset behind almost every row itself — the hover
       * script it drew, or the cancel button's own arguments — and that costs
       * nothing. A row it did not name is asked about, because a lot whose asset
       * we cannot name can come off the market and not go back; the lookup stops
       * the moment those rows are answered, so it is a lookup and not a licence
       * to widen the scan.
       */
      const blind = listings.filter((l) => !l.assetid).map((l) => l.listingId);
      if (blind.length) {
        try {
          status(`Не вижу предмет у ${blind.length} лот. — спрашиваю Steam…`, "work");
          const found = await fetchAssetRefsFor(blind, pacing, (got, want) =>
            status(`Ищу предметы для ${want} лот. — нашёл ${got}…`, "work")
          );
          applyAssetRefs(listings, found.refs);
          for (const id of found.ids) state.ourIds.add(id);
          state.ownershipComplete = found.complete;
        } catch {
          /**
           * A row whose asset we cannot name gets refused by the planner rather
           * than repriced — it could come off the market and not go back.
           */
          state.ownershipComplete = false;
        }
      }
      for (const listing of listings) state.ourIds.add(listing.listingId);
      /** Said once, here, because the planner refuses these lots row by row. */
      const stillBlind = listings.filter((l) => !l.assetid).length;

      state.listings = listings;
      renderStats();

      if (!listings.length) {
        status(
        "На странице нет выставленных лотов",
        "warn",
        "Выбери на самой странице «Показывать по …» и сканируй снова."
      );
        setBusy(false);
        return;
      }

      state.groups = groupListings(listings);
      const uniques = uniqueItems();

      status(
        `Лотов ${listings.length}, уникальных ${uniques.length}. ` +
          (stillBlind ? `Без assetid ${stillBlind} — их не трогаю. ` : "") +
          "Свои цены взял со страницы — спрашиваю только чужие…",
        "work"
      );
      await priceAndPlan(uniques);
    } catch (err) {
      status(`Скан: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
  }

  async function resume(): Promise<void> {
    if (state.busy || !state.unresolved.length) return;
    state.abort = false;
    setBusy(true);
    const quiet = await allowSteamTraffic();
    if (quiet) {
      status(quiet, "warn");
      setBusy(false);
      return;
    }
    state.settings = await loadSettings();
    try {
      status(`Догружаю ${state.unresolved.length} цен…`, "work");
      await priceAndPlan(state.unresolved);
    } catch (err) {
      status(`Догрузка: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
  }

  /** Unique items on the page, most valuable first — the order a scan should die in. */
  function uniqueItems(): ItemKeyed[] {
    return [...state.groups.values()]
      .map((g) => ({
        key: g.key,
        appid: g.appid,
        hash: g.hash,
        name: g.name,
        worth: Math.max(...g.listings.map((l) => l.ourBuyer), 0),
      }))
      .sort((a, b) => b.worth - a.worth)
      .map(({ worth: _worth, ...item }) => item);
  }

  async function apply(): Promise<void> {
    if (state.busy) return;
    const todo = pendingReprices();
    if (!todo.length) return;

    /**
     * What the click actually commits to, before it is clicked.
     *
     * Sixty-seven lots is not «a click»: it is half an hour of paced writes that
     * takes every one of them off the market on the way, and the deepest move in
     * the batch is the one nobody scrolled down to see. Both belong in the
     * question rather than in the status line afterwards.
     */
    let deepest: RepricePlan | null = null;
    let worstCut = 0;
    for (const plan of todo) {
      const cut = dropPercent(plan) ?? 0;
      if (cut > worstCut) {
        worstCut = cut;
        deepest = plan;
      }
    }
    const confirmed = window.confirm(
      `Снять ${todo.length} лот(ов) и выставить ниже чужого минимума?\n\n` +
        `Это примерно ${humanMinutes(runTimeMs(todo.length, state.settings.delayMs))} работы — ` +
        `вкладку лучше не закрывать.\n` +
        (deepest ? `Самый глубокий сдвиг: −${worstCut}% (${deepest.name}).\n` : "") +
        "После этого продажи надо подтвердить в Steam Guard."
    );
    if (!confirmed) return;

    state.abort = false;
    setBusy(true);
    state.settings = await loadSettings();
    const delay = Math.max(1500, state.settings.delayMs);

    let ok = 0;
    let failed = 0;
    let guard = 0;
    let halted = false;
    /**
     * Copies this run has already put back, so two lots of the same card do not
     * both try to re-list the one item the inventory handed back.
     */
    const claimed = new Set<string>();

    /**
     * Where the item is now.
     *
     * A cancelled lot comes back under a new assetid, so the id the row named is
     * spent the moment `removelisting` returns. Asking the inventory is not a
     * fallback here, it is the normal path — and it is asked *before* the first
     * `sellitem` rather than after it fails, because it always would.
     */
    const whereItWent = async (plan: RepricePlan): Promise<string | null> => {
      const owner = steamId();
      if (!owner) return null;
      try {
        const inv = await loadInventory(
          { steamid: owner, appid: plan.appid, contextid: plan.contextid },
          { abort: () => state.abort, onWait: pacing.onWait }
        );
        const found = pickReturnedAsset(inv.items, plan.hash, claimed);
        if (found) claimed.add(found);
        return found;
      } catch {
        /** No answer is «keep waiting», never «give up on the lot». */
        return null;
      }
    };
    /**
     * Where a stranded lot actually is, checked rather than assumed.
     *
     * The report said «предмет в инвентаре» without ever looking — a guess in
     * the one place the owner most needs a fact, because the two possible
     * states call for opposite actions. One inventory read at the end of a
     * failed run settles it.
     */
    const lookFor = async (plan: RepricePlan, assetid: string): Promise<string> => {
      const owner = steamId();
      if (!owner) return "не вижу steamid — проверь инвентарь сам";
      try {
        const inv = await loadInventory(
          { steamid: owner, appid: plan.appid, contextid: plan.contextid },
          { abort: () => state.abort, onWait: pacing.onWait }
        );
        const item = inv.items.find((one) => one.assetid === assetid);
        if (item?.marketable) return "предмет лежит в инвентаре — ничего не потеряно";
        if (item) return "предмет в инвентаре, но Торговая площадка его сейчас не принимает";
        return "предмета с этим id в инвентаре нет — проверь витрину, лот мог всё-таки встать";
      } catch {
        return "проверить инвентарь не вышло — посмотри сам";
      }
    };

    /** The one lot, if any, left off the market with nothing put back. */
    let stranded: RepricePlan | null = null;
    /** The asset that last relist aimed at, which is what to look for. */
    let strandedAsset = "";

    for (let i = 0; i < todo.length; i++) {
      if (state.abort) break;
      const plan = todo[i]!;
      status(`Переставляю ${i + 1}/${todo.length}: ${plan.name}`, "work");

      /** Which part of the write we are in: the relist failing is not the same event. */
      let stage: WriteStage = "before";
      /** The asset the relist aimed at, so a failure knows what to go looking for. */
      let aimedAt = plan.assetid ?? "";
      try {
        if (!plan.assetid) throw new SteamError("http", "нет assetid — нельзя выставить снова");
        stage = "removing";
        await removeListing(plan.listingId, pacing);
        forgetOurLots();
        stage = "relisting";
        await sleep(delay);
        /**
         * Asking again is the fix, not a workaround: the hand-back between
         * remove and sell takes seconds, and the first sellitem often lands
         * before it. Each try paces itself; the run never waits blind.
         */
        const moved = await whereItWent(plan);
        const order = moved ? { ...plan, assetid: moved } : plan;
        aimedAt = order.assetid;
        const result = await sellItemWhenReady(order, pacing, {
          onRetry: (n, why) =>
            status(
              `Переставляю ${i + 1}/${todo.length}: ${plan.name} — ` +
                (why === "shrug"
                  ? `Steam отказал и не сказал почему, жду и пробую снова (${n})`
                  : `предмет ещё возвращается в инвентарь, пробую снова (${n})`),
              "work"
            ),
          relocate: async () => {
            const fresh = await whereItWent(plan);
            if (fresh) aimedAt = fresh;
            return fresh;
          },
        });
        plan.result = "ok";
        if (needsConfirmation(result)) {
          plan.resultMessage = "ожидает Steam Guard";
          guard += 1;
        } else {
          plan.resultMessage = `выставлен ${money(plan.targetBuyer)}`;
        }
        ok += 1;
        await sleep(delay);
      } catch (err) {
        const failure = describeRelistFailure(stage, err);
        plan.result = "fail";
        plan.resultMessage = failure.message;
        failed += 1;
        if (failure.stranded) {
          stranded = plan;
          strandedAsset = aimedAt;
        }
        if (failure.halt) halted = true;
      }

      patchRow(plan);
      renderStats();
      if (halted) break;
    }

    if (stranded) {
      status(`Проверяю, где предмет «${stranded.name}»…`, "work");
      const where = strandedAsset
        ? await lookFor(stranded, strandedAsset)
        : "проверить нечего — лот не назвал предмет";
      status(
        `Остановился на «${stranded.name}»: ${stranded.resultMessage}. ${where}. ` +
          `Переставлено до него ${ok} из ${todo.length}. ` +
          "Дальше не иду: каждый следующий шаг сначала снимает лот, а причина отказа не названа.",
        "err"
      );
    } else if (halted) {
      status(
        `Steam остановил перестановку на ${ok} из ${todo.length}. Не продолжаю — бан от повторных запросов только удлиняется.`,
        "warn"
      );
    } else {
      const parts = [`Готово: ${ok} ок`];
      if (failed) parts.push(`${failed} ошибок`);
      if (guard) parts.push(`подтверди ${guard} в Steam Guard`);
      if (state.abort) parts.push("остановлено");
      /** A count of failures is not a diagnosis; name the one that happened most. */
      const common = commonFailure(todo);
      if (common) parts.push(`чаще всего: ${common}`);
      status(parts.join(" · "), failed ? "warn" : "ok");
    }
    setBusy(false);
  }

  /**
   * Takes the ticked listings off the market.
   *
   * Not part of repricing and deliberately separate from it: this one only
   * cancels. The items come back to the inventory, so it is undoable in the sense
   * that matters, but the queue position and the listed-on date are gone — which
   * is why it asks first and names the money involved.
   */
  async function cancelPicked(): Promise<void> {
    if (state.busy) return;
    const todo = cancellablePlans(currentViews(), state.dropped);
    if (!todo.length) return;

    const worth = todo.reduce((sum, plan) => sum + plan.ourBuyer, 0);
    const confirmed = window.confirm(
      `Снять с продажи ${todo.length} лот(ов) на ${money(worth)}?\n\n` +
        "Предметы вернутся в инвентарь. Место в очереди и дата выставления потеряются, " +
        "выставлять заново придётся вручную или через «Инвентарь»."
    );
    if (!confirmed) return;

    state.abort = false;
    setBusy(true);
    state.settings = await loadSettings();
    const delay = Math.max(1500, state.settings.delayMs);

    let ok = 0;
    let failed = 0;
    let halted = false;

    for (let i = 0; i < todo.length; i++) {
      if (state.abort) break;
      const plan = todo[i]!;
      status(`Снимаю ${i + 1}/${todo.length}: ${plan.name}`, "work");
      try {
        await removeListing(plan.listingId, pacing);
        /** What we hold just changed; the cached account is history. */
        forgetOurLots();
        plan.result = "ok";
        plan.resultMessage = "снят — предмет в инвентаре";
        ok += 1;
        await sleep(delay);
      } catch (err) {
        /** A cancel is one call, so it never strands a lot the way repricing can —
         *  but a POST that never came back leaves the same open question, and the
         *  rule about when to stop is the same rule. */
        const failure = describeRelistFailure("removing", err);
        plan.result = "fail";
        plan.resultMessage = failure.message;
        failed += 1;
        if (failure.halt) halted = true;
      }
      patchRow(plan);
      renderStats();
      if (halted) break;
    }

    if (halted) {
      status(
        `Steam остановил снятие на ${ok} из ${todo.length}. Не продолжаю — бан от повторных запросов только удлиняется.`,
        "warn"
      );
    } else {
      const parts = [`Снято: ${ok}`];
      if (failed) parts.push(`${failed} ошибок`);
      if (state.abort) parts.push("остановлено");
      const common = commonFailure(todo);
      if (common) parts.push(`чаще всего: ${common}`);
      status(parts.join(" · "), failed ? "warn" : "ok");
    }
    setBusy(false);
  }

  queryInput.addEventListener("input", () => {
    state.filters.query = queryInput.value;
    renderRows();
    renderStats();
  });


  cancelBtn.addEventListener("click", () => void cancelPicked());

  scanBtn.addEventListener("click", () => void scan());
  resumeBtn.addEventListener("click", () => void resume());
  applyBtn.addEventListener("click", () => void apply());
  stopBtn.addEventListener("click", () => {
    state.abort = true;
    status("Останавливаю…", "warn");
  });


  /** Esc stops a run. A long scan is the one thing a user wants to abort in a hurry. */
  section.body.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.busy) return;
    event.preventDefault();
    state.abort = true;
    status("Останавливаю…", "warn");
  });

  status(
    "Нажми «Сканировать лоты» — читаю лоты этой страницы и сравниваю с самым дешёвым чужим лотом."
  );
  renderRows();
  renderStats();
}

register({
  id: "reprice",
  title: "Репрайс",
  /** Everywhere on the market except a single item page, which has its own tab. */
  matches: (url) =>
    url.pathname.startsWith("/market") && !/\/market\/listings\/\d+\//.test(url.pathname),
  mount,
});
