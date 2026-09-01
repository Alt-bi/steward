import { levelLabel, PRICE_LEVELS, type PriceLevel } from "../../../core/levels";
import { send } from "../../../core/messaging";
import { loadFlag, loadPref, savePref } from "../../../core/prefs";
import { formatCents } from "../../../core/money";
import { csvDoc, downloadCsv } from "../../../core/csv";
import { noneDropped, pickAll, pickNone, togglePick, type Picks } from "../../../core/picks";
import { loadSettings, type Settings } from "../../../core/settings";
import type { Cents, ItemKeyed, Listing, RepricePlan } from "../../../core/types";
import { needsConfirmation, removeListing, sellItem } from "../../../steam/actions";
import { scanCompetitors } from "../../../steam/listings";
import { forgetGroup, knownGroup, learnGroups } from "../../../steam/grouping";
import { learnGroupForItem } from "../../../steam/search";
import { fetchMyListings } from "../../../steam/mylistings";
import { allowSteamTraffic, sleep, SteamError, type WaitReason } from "../../../steam/net";
import { currencyId, feeConfig, sessionId, waitForPage } from "../../../steam/page-context";
import { loadHistories } from "../../../steam/history-load";
import { fetchMarketLows, priceCacheKey } from "../../../steam/prices";
import type { HistoryStats } from "../../../steam/pricehistory";
import { el, field, type StatusKind } from "../../ui/panel";
import { describeError, describeRelistFailure, type WriteStage } from "../../ui/errors";
import { register, type FeatureContext } from "../registry";
import {
  cancellablePlans,
  DEFAULT_LISTING_FILTERS,
  isMovable,
  listingTotals,
  movablePlans,
  shownIds,
  viewPlans,
  type ListingFilters,
  type ListingSortKey,
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
 * Apps whose book answers only to the internal group id, not to
 * `market_hash_name`. Going to search for the id costs one request per item,
 * so the detour is paid for where the wall is proven and not anywhere else —
 * TF2, Steam items and community goods answer by hash name directly and would
 * only burn budget on a detour they never need.
 */
const GROUP_ID_APPS = new Set<number>([730]);

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

/** Above this many unknown histories the run is confirmed with its cost first. */
const ASK_ABOVE = 12;

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
  /** Items Steam stopped us before pricing. */
  unresolved: ItemKeyed[];
  plans: RepricePlan[];
  /** What we are aiming at: the cheapest competitor, or a historical average. */
  level: PriceLevel;
  /** Group key -> what that item has been selling for. Empty until asked for. */
  stats: Record<string, HistoryStats | null>;
  /** Listings the user unticked. Everything scanned starts ticked. */
  dropped: Picks;
  filters: ListingFilters;
  sort: ListingSortKey;
}

function money(cents: Cents | null | undefined): string {
  return formatCents(cents, currencyId());
}

interface RowHooks {
  picked: boolean;
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
  prices.title = plan.ourSeller
    ? `покупатель платит ${money(plan.ourBuyer)}, тебе ${money(plan.ourSeller)}`
    : `покупатель платит ${money(plan.ourBuyer)}`;

  const why = el("div", "stw-why", plan.resultMessage ?? plan.reason);
  if (plan.ourSeller > 0 && plan.action === "reprice") {
    why.textContent = `${plan.resultMessage ?? plan.reason} · тебе сейчас ${money(plan.ourSeller)}`;
  }

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
    unresolved: [],
    plans: [],
    level: "market",
    stats: {},
    dropped: noneDropped(),
    filters: { ...DEFAULT_LISTING_FILTERS },
    sort: "drop",
  };

  const stats = el("div", "stw-stats");
  const statNodes: Record<string, HTMLElement> = {};
  const statLabels: Record<string, HTMLElement> = {};
  for (const [key, label, tone] of [
    ["total", "лотов", ""],
    ["over", "оверпрайс", "warn"],
    ["unsure", "не проверено", "warn"],
    ["skip", "пропуск", ""],
  ] as const) {
    const box = el("div", "stw-stat");
    if (tone) box.dataset.tone = tone;
    const n = el("div", "stw-stat-n", "0");
    const l = el("div", "stw-stat-l", label);
    box.append(n, l);
    statNodes[key] = n;
    statLabels[key] = l;
    stats.appendChild(box);
  }

  const filterRow = el("div", "stw-controls");
  const queryInput = document.createElement("input");
  queryInput.type = "search";
  queryInput.className = "stw-input";
  queryInput.placeholder = "поиск по названию";
  queryInput.title = "Ищет и по названию, и по market_hash_name — там живёт износ";

  const sortSelect = document.createElement("select");
  sortSelect.className = "stw-select";
  for (const [value, label] of [
    ["drop", "сильнее двигаем"],
    ["price", "дороже лот"],
    ["name", "по названию"],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sortSelect.appendChild(option);
  }
  filterRow.append(
    field("Фильтр", queryInput, "Ищет и по названию, и по market_hash_name — там живёт износ"),
    field("Сортировка", sortSelect)
  );

  const levelRow = el("div", "stw-controls");
  const levelSelect = document.createElement("select");
  levelSelect.className = "stw-select";
  levelSelect.title =
    "Куда ставить цену. «Минимум рынка» подрезает чужой лот; средние — это цена, " +
    "по которой предмет реально продавался, и лот может уехать вверх.";
  for (const level of PRICE_LEVELS) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = levelLabel(level);
    levelSelect.appendChild(option);
  }
  const historyBtn = el("button", "stw-btn stw-btn-thin", "История продаж");
  historyBtn.type = "button";
  historyBtn.title =
    "Спрашивает у Steam, по каким ценам предмет продавался. Самый медленный запрос — " +
    "около 6 в минуту — но ответ живёт часами.";
  const csvBtn = el("button", "stw-btn stw-btn-thin", "CSV");
  csvBtn.type = "button";
  csvBtn.title =
    "Сохранить отфильтрованный список таблицей: что стоит, за сколько, почему и что делать. Открывается в Excel.";
  csvBtn.addEventListener("click", () => exportCsv());

  levelRow.append(field("Цена", levelSelect, levelSelect.title), historyBtn, csvBtn);

  const movableLabel = el("label", "stw-toggle");
  movableLabel.title = "Оставить только те лоты, которые план собирается переставить";
  const movableOnly = document.createElement("input");
  movableOnly.type = "checkbox";
  movableOnly.className = "stw-check";
  movableLabel.append(movableOnly, document.createTextNode(" только оверпрайс"));

  const pickAllBtn = el("button", "stw-btn stw-btn-thin", "Все");
  pickAllBtn.type = "button";
  pickAllBtn.title = "Отметить всё, что сейчас показано";
  const pickNoneBtn = el("button", "stw-btn stw-btn-thin", "Ничего");
  pickNoneBtn.type = "button";
  pickNoneBtn.title = "Снять отметку со всего, что сейчас показано";

  const toggleRow = el("div", "stw-controls stw-toggles");
  toggleRow.append(movableLabel, pickAllBtn, pickNoneBtn);

  const shownLine = el("div", "stw-hint", "");

  const actions = el("div", "stw-actions");
  const scanBtn = el("button", "stw-btn stw-btn-primary", "Сканировать лоты");
  scanBtn.type = "button";
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
  actions.append(scanBtn, applyBtn, cancelBtn, stopBtn);

  /** Only appears when a run stopped with items left, so it never adds noise. */
  const resumeRow = el("div", "stw-actions stw-resume");
  const resumeBtn = el("button", "stw-btn stw-btn-primary", "Догрузить цены");
  resumeBtn.type = "button";
  resumeRow.appendChild(resumeBtn);
  resumeRow.hidden = true;

  const rows = el("div", "stw-rows");
  section.body.append(stats, filterRow, levelRow, toggleRow, shownLine, actions, resumeRow, rows);

  /**
   * The pause is an annotation on whatever we are doing, not a replacement for it.
   * Overwriting the whole line made a running scan look like a hang.
   */
  let phase = "";
  let phaseKind: StatusKind = "";
  let pauseUntil = 0;
  let pauseReason: WaitReason = "budget";

  function render(): void {
    const left = pauseUntil - Date.now();
    if (left <= 0) {
      section.setStatus(phase, phaseKind);
      return;
    }
    const secs = Math.ceil(left / 1000);
    const note = pauseReason === "cooldown" ? `лимит Steam ${secs}с` : `бюджет запросов ${secs}с`;
    section.setStatus(`${phase} · ${note}`, pauseReason === "cooldown" ? "warn" : phaseKind);
  }

  function status(text: string, kind: StatusKind = ""): void {
    phase = text;
    phaseKind = kind;
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

  /** Rebuilds the plan from what we already know. Never sends a request. */
  function replan(): void {
    state.plans = buildPlans(state.groups, state.lows, state.settings, feeConfig(), {
      level: state.level,
      stats: state.stats,
    });
    renderRows();
    renderStats();
  }

  /** The rows on screen: the filter and the sort decide, nothing else. */
  function currentViews(): RepricePlan[] {
    return viewPlans(state.plans, state.filters, state.sort);
  }

  /**
   * The filtered plan as a spreadsheet. This is the sheet the user asked the
   * scan to produce: verdict, price, reason — not a raw dump.
   */
  function exportCsv(): void {
    const views = currentViews();
    if (!views.length) {
      status("Экспортировать нечего — сначала «Сканировать лоты».", "warn");
      return;
    }
    const rows = views.map((plan) => [
      plan.name,
      plan.hash,
      plan.amount,
      money(plan.ourBuyer),
      money(plan.competitorBuyer),
      money(plan.targetBuyer),
      plan.action === "reprice" ? "переставить" : "пропуск",
      plan.reason,
    ]);
    downloadCsv(
      `steward-reprice-${new Date().toISOString().slice(0, 10)}.csv`,
      csvDoc(
        ["Предмет", "market_hash_name", "Кол-во", "Наша цена", "Чужой мин", "Цель", "Действие", "Почему"],
        rows
      )
    );
    status(`CSV: ${views.length} лотов выгружено.`, "ok");
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

    /** «Overpriced» is only the word for it when we are chasing the competitor. */
    statLabels.over!.textContent = state.level === "market" ? "оверпрайс" : "к переносу";

    const todo = pendingReprices().length;
    applyBtn.textContent = todo ? `Переставить ${todo}` : "Переставить";
    applyBtn.disabled = state.busy || todo === 0;

    const views = currentViews();
    const totals = listingTotals(views, state.dropped);
    cancelBtn.textContent = totals.picked ? `Снять ${totals.picked}` : "Снять";
    cancelBtn.disabled = state.busy || totals.picked === 0;

    shownLine.textContent = state.plans.length
      ? `Показано ${totals.shown} из ${state.plans.length} · отмечено ${totals.picked} · на витрине ${money(totals.value)}`
      : "";
  }

  function rowFor(plan: RepricePlan): HTMLElement {
    return planRow(plan, {
      picked: !state.dropped.has(plan.listingId),
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
        el("div", "stw-empty", "Нажми «Сканировать лоты» — возьму все активные лоты аккаунта, не только те, что Steam нарисовал на странице.")
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
        /** A learned internal name, when Steam stopped answering this hash directly. */
        let known = await knownGroup(group.appid, group.hash);
        /**
         * Nothing learned yet and this app is the one that hides behind group
         * ids — go ask the only endpoint that hands them out. Search answers
         * even when it settles no price, and once learned the id persists, so
         * the wall is paid for once per item, not once per scan.
         */
        if (!known && GROUP_ID_APPS.has(group.appid) && !state.abort) {
          status(`Учу внутренний id · ${group.name}`, "work");
          requests += 1;
          const learned = await learnGroupForItem(
            { key: group.key, appid: group.appid, hash: group.hash, name: group.name },
            pacing
          );
          if (learned) {
            known = learned;
            learnGroups(group.appid, new Map([[group.hash, learned]]));
          }
        }
        /** Already proven unanswerable for this app; the request would come back empty. */
        if (unnamedApps.has(group.appid) && !known) {
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
            known ?? undefined,
            /**
             * Only here can an empty book honestly mean «wrong name»: this app
             * hides its items behind group ids and we have not learned one yet.
             * Everywhere else our own lot is in that book by definition, so a
             * book of zero is Steam refusing and must not be filed as a fact.
             */
            { nameMayBeWrong: GROUP_ID_APPS.has(group.appid) && !known }
          );
          if (scan.unnamed) {
            /**
             * The name Steam no longer answers to. When we carried a learned
             * group id, it went stale — forget it so the item is not skipped
             * on the strength of a fact that stopped working.
             */
            if (known) forgetGroup(group.hash);
            unnamedApps.add(group.appid);
            hitUnnamed.add(group.appid);
          }
          /**
           * The book spoke — even to say it holds nothing for this name — so the
           * endpoint is alive and every markup page before it was noise.
           */
          bookLiveness.sawAnswer();
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
            for (const group of state.groups.values()) {
              const known = state.lows.get(group.key);
              if (known && !needsExactCheck(known)) continue;
              state.lows.set(group.key, competitorFromMarketLow(group, state.marketLows[group.key] ?? null));
            }
          }
        }
      }
    }

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
          `${todo ? `, к переносу: ${todo}` : ""}. ${spent}`,
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
    const aim =
      state.level === "market"
        ? "поставить ниже чужого минимума"
        : `перенести на уровень «${levelLabel(state.level)}»`;
    const verdict = todo
      ? `${todo} лот(ов) можно ${aim}.`
      : unsure
        ? "Среди проверенных двигать нечего."
        : "Проверил все лоты: двигать нечего.";
    const gap = unsure ? ` Не проверено ${unsure} из ${totalItems} — конкурента там не видел.` : "";
    const ours = state.ownershipComplete
      ? ""
      : " Свои лоты знаю не полностью, поэтому на равной цене ничего не двигаю.";
    /** A level target is useless without histories, and the scan does not fetch them. */
    const noHistory =
      state.level === "market"
        ? 0
        : [...state.groups.values()].filter((g) => state.stats[g.key] == null).length;
    const history = noHistory
      ? ` Для уровня «${levelLabel(state.level)}» не хватает истории у ${noHistory} предм. — нажми «История продаж».`
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

    status(
      `${verdict}${gap}${history}${naming}${ours} Все лоты аккаунта уже в списке — «Сканировать лоты» обновит цены. ${spent}`,
      todo || unsure ? "warn" : "ok"
    );
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
       * One read, one path: Steam's own endpoint, paged by Steam's own count.
       *
       * There used to be a cheaper first reader — scrape the rows already drawn
       * on the page, spare the network. It died with the old market: the page
       * either draws twenty rows out of seven hundred or answers the whole URL
       * with JSON. Either way the table is a fraction of the account, and a
       * reprice that quietly covers a twentieth of it is worse than a slow one.
       * The rows, the asset behind each, and the complete set of our listing
       * ids all come from the same answer now — and they come complete.
       */
      status("Читаю свои лоты…", "work");
      const mine = await fetchMyListings(0, pacing, (seen, total) => {
        status(`Читаю свои лоты ${seen} из ${total}…`, "work");
      });
      const listings = mine.listings ?? [];
      for (const id of mine.ids) state.ourIds.add(id);
      state.ownershipComplete = mine.complete;

      state.listings = listings;
      renderStats();

      if (!listings.length) {
        status("Steam отвечает: активных лотов у аккаунта нет — сканировать нечего.", "err");
        setBusy(false);
        return;
      }

      state.groups = groupListings(listings);
      const uniques = uniqueItems();

      status(
        `Лотов ${listings.length}, уникальных ${uniques.length}. ` +
          "Свои цены взял из ответа Steam — спрашиваю только чужие…",
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

  /**
   * Fetches what these items have been selling for.
   *
   * Separate from the scan and never automatic. This is the slowest endpoint
   * Steam has, and the honest way to spend six requests a minute of somebody's IP
   * budget is to say how many and how long, and then let them decide.
   */
  async function loadHistory(): Promise<void> {
    if (state.busy) return;
    if (!state.groups.size) {
      status("Сначала «Сканировать лоты» — историю качаю только для отсканированных лотов.", "warn");
      return;
    }

    const items = uniqueItems();
    state.abort = false;
    setBusy(true);

    try {
      const outcome = await loadHistories(items, {
        ...pacing,
        askAbove: ASK_ABOVE,
        onProgress: (done, total, label) => status(`История ${done}/${total} · ${label}`, "work"),
      }, {
        /** This tab warns about the hour-long pricehistory ban — its own wording. */
        ask: (missing, minutes) => window.confirm(
          `История продаж есть не для всех: не хватает ${missing} предм.\n\n` +
            `Это ${missing} запрос(ов) к Steam, примерно ${minutes} мин. ` +
            "Это самый медленный запрос — быстрее нельзя, иначе Steam выдаёт бан на часы.\n\n" +
            "Ответы сохраняются на несколько часов, второй раз будет бесплатно. Качаем?"
        ),
      });

      if (outcome.stopped === "declined") return;
      if (outcome.stopped === "quiet") {
        status(outcome.gateMessage, "warn");
        return;
      }

      Object.assign(state.stats, outcome.stats);
      replan();

      const known = Object.values(state.stats).filter((s) => s != null).length;
      const spent = `Запросов ${outcome.requests}${outcome.fromCache ? `, из кэша ${outcome.fromCache}` : ""}.`;
      if (outcome.missing === 0) {
        status(`История уже есть по всем ${items.length} предметам — запросов не было.`, "ok");
      } else if (outcome.stopped === "blocked") {
        status(
          `Steam отказал: история есть у ${known} из ${items.length}. ` +
            `Не повторяй сразу — бан на pricehistory самый длинный. ${spent}`,
          "warn"
        );
      } else if (outcome.stopped === "aborted") {
        status(`Остановлено: история есть у ${known} из ${items.length}. ${spent}`, "");
      } else {
        status(
          `История есть у ${known} из ${items.length}. Теперь можно выбрать уровень цены. ${spent}`,
          "ok"
        );
      }
    } catch (err) {
      status(`История: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
  }

  async function apply(): Promise<void> {
    if (state.busy) return;
    const todo = pendingReprices();
    if (!todo.length) return;

    const aim =
      state.level === "market"
        ? "ниже чужого минимума"
        : `на уровень «${levelLabel(state.level)}»`;
    const confirmed = window.confirm(
      `Снять ${todo.length} лот(ов) и выставить ${aim}?\n\n` +
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
    /** The one lot, if any, left off the market with nothing put back. */
    let stranded: RepricePlan | null = null;

    for (let i = 0; i < todo.length; i++) {
      if (state.abort) break;
      const plan = todo[i]!;
      status(`Переставляю ${i + 1}/${todo.length}: ${plan.name}`, "work");

      /** Which part of the write we are in: the relist failing is not the same event. */
      let stage: WriteStage = "before";
      try {
        if (!plan.assetid) throw new SteamError("http", "нет assetid — нельзя выставить снова");
        stage = "removing";
        await removeListing(plan.listingId, pacing);
        stage = "relisting";
        await sleep(delay);
        const result = await sellItem(plan, pacing);
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
        if (failure.stranded) stranded = plan;
        if (failure.halt) halted = true;
      }

      patchRow(plan);
      renderStats();
      if (halted) break;
    }

    if (stranded) {
      status(
        `Остановился на «${stranded.name}»: ${stranded.resultMessage}. ` +
          `Проверь этот лот на маркете и в инвентаре — переставлено до него ${ok} из ${todo.length}. ` +
          "Дальше не иду: причина не выяснена, а каждый следующий шаг сначала снимает лот.",
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

  sortSelect.addEventListener("change", () => {
    state.sort = sortSelect.value as ListingSortKey;
    void savePref("reprice.sort", state.sort);
    renderRows();
  });

  movableOnly.addEventListener("change", () => {
    state.filters.onlyMovable = movableOnly.checked;
    void savePref("reprice.onlyMovable", movableOnly.checked);
    renderRows();
    renderStats();
  });

  /** The bulk buttons act on what the filter shows — that is what filtering is for. */
  pickAllBtn.addEventListener("click", () => {
    pickAll(shownIds(currentViews()), state.dropped);
    renderRows();
    renderStats();
  });

  pickNoneBtn.addEventListener("click", () => {
    pickNone(shownIds(currentViews()), state.dropped);
    renderRows();
    renderStats();
  });

  levelSelect.addEventListener("change", () => {
    state.level = levelSelect.value as PriceLevel;
    void savePref("reprice.level", state.level);
    replan();
    if (state.level === "market") {
      status("Цель: подрезать самый дешёвый чужой лот.", "");
      return;
    }
    const missing = state.groups.size
      ? [...state.groups.values()].filter((g) => state.stats[g.key] == null).length
      : 0;
    status(
      missing
        ? `Цель: «${levelLabel(state.level)}». Истории нет у ${missing} предм. — нажми «История продаж».`
        : `Цель: «${levelLabel(state.level)}». Лоты поедут к этой цене, в том числе вверх.`,
      missing ? "warn" : ""
    );
  });

  historyBtn.addEventListener("click", () => void loadHistory());

  cancelBtn.addEventListener("click", () => void cancelPicked());

  scanBtn.addEventListener("click", () => void scan());
  resumeBtn.addEventListener("click", () => void resume());
  applyBtn.addEventListener("click", () => void apply());
  stopBtn.addEventListener("click", () => {
    state.abort = true;
    status("Останавливаю…", "warn");
  });

  /**
   * Choices the user made last time. Restored before the first paint so the panel
   * never flashes the default and then jumps — and never quietly plans against a
   * level the dropdown is not showing.
   */
  state.level = await loadPref("reprice.level", PRICE_LEVELS, "market");
  state.sort = await loadPref("reprice.sort", ["drop", "price", "name"] as const, "drop");
  state.filters.onlyMovable = await loadFlag("reprice.onlyMovable", false);
  levelSelect.value = state.level;
  sortSelect.value = state.sort;
  movableOnly.checked = state.filters.onlyMovable;

  /** Esc stops a run. A long scan is the one thing a user wants to abort in a hurry. */
  section.body.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.busy) return;
    event.preventDefault();
    state.abort = true;
    status("Останавливаю…", "warn");
  });

  status("Нажми «Сканировать лоты» — возьму все активные лоты аккаунта.");
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
