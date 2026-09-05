import { formatCents } from "../../../core/money";
import { humanMinutes } from "../../../core/duration";
import { loadSettings, type Settings } from "../../../core/settings";
import type { Cents, ItemKeyed } from "../../../core/types";
import { needsConfirmation, sellItemWhenReady } from "../../../steam/actions";
import {
  appidFromHash,
  contextsFromPage,
  groupInventory,
  groupTilesByContext,
  inventoryValue,
  itemsFromTiles,
  itemsFromVisible,
  loadInventory,
  marketableGroups,
  mergeItemsByAsset,
  ownerFromUrl,
  pickVisibleItems,
  targetFromHash,
  type InventoryChoice,
  type InventoryGroup,
  type InventoryItem,
  type TileRef,
} from "../../../steam/inventory";
import { allowSteamTraffic, sleep, SteamError, type WaitReason } from "../../../steam/net";
import {
  appContexts,
  assetIndex,
  currencyId,
  feeConfig,
  refreshPage,
  requestPageInfo,
  sessionId,
  steamId,
  visibleInventory,
  waitForPage,
} from "../../../steam/page-context";
import { fetchMarketLows } from "../../../steam/prices";
import { fetchWear, wearChip, type WearInfo } from "../../../steam/floats";
import { el, type StatusKind } from "../../ui/panel";
import { describeError, haltsRun, outcomeUnknown } from "../../ui/errors";
import { register, type FeatureContext } from "../registry";
import {
  badgeDataFrom,
  clearBadges,
  paintBadges,
  visibleTileRefs,
  watchForRepaint,
  watchTilePicks,
} from "./badges";
import { buildSellPlans, plannedProceeds, type SellPlan } from "./plan";
import {
  DEFAULT_FILTERS,
  emptySelection,
  groupPick,
  pickedAssetIds,
  toggleAsset,
  toggleGroup,
  viewGroups,
  viewTotals,
  type GroupView,
  type Selection,
  type SortKey,
  type ViewFilters,
} from "./view";

/**
 * Prices what you own, totals it up, and lists it — the feature people actually
 * install these extensions for. The panel is the primary surface rather than
 * badges glued onto Steam's item tiles, so it keeps working when Steam reshuffles
 * its markup.
 */

/** Steam keeps wear on real copies for this app only, so nothing else pays for it. */
const WEAR_APPID = 730;

interface State {
  busy: boolean;
  abort: boolean;
  settings: Settings;
  groups: Map<string, InventoryGroup>;
  lows: Record<string, Cents | null>;
  /** Group key -> what the item has been selling for. Only «по средней» needs it. */
  unresolved: ItemKeyed[];
  plans: SellPlan[];
  /**
   * What the user unticked — whole stacks in the panel, single copies on the
   * tiles. Selection is "everything priced except these", so a later «Догрузить
   * цены» adds the newly priced stacks without quietly re-ticking what was
   * deliberately dropped.
   */
  selection: Selection;
  filters: ViewFilters;
  sort: SortKey;
  /** Flat item list, kept for painting badges onto Steam tiles. */
  items: InventoryItem[];
  /**
   * Wear per assetid, cached for the life of the page — an asset never changes
   * its float, so a re-scan is free. Only the owner's own page can have it.
   */
  wears: Map<string, WearInfo>;
}

/**
 * How long a batch of listings takes, in milliseconds.
 *
 * One paced `sellitem` per copy against a budget of eight writes a minute, plus
 * the pause the run puts after each. Two hundred copies is not «a moment»; it is
 * most of an hour, and that number belongs in the question rather than in the
 * scroll bar afterwards.
 */
const WRITE_BUDGET_PER_MIN = 8;

export function runTimeMs(copies: number, delayMs = 2500): number {
  return copies * (60_000 / WRITE_BUDGET_PER_MIN + Math.max(0, delayMs));
}


/** The worst price in a batch, as a percentage under the market minimum. */
export function deepestCut(plans: readonly SellPlan[]): number {
  let worst = 0;
  for (const plan of plans) {
    if (plan.action !== "sell" || plan.targetBuyer == null) continue;
    const low = plan.marketLow;
    if (low == null || low < 1 || plan.targetBuyer >= low) continue;
    worst = Math.max(worst, Math.round(((low - plan.targetBuyer) / low) * 100));
  }
  return worst;
}

function money(cents: Cents | null | undefined): string {
  return formatCents(cents, currencyId());
}

async function mount(ctx: FeatureContext): Promise<void> {
  const section = ctx.panel.addSection("inventory", "Инвентарь");

  const state: State = {
    busy: false,
    abort: false,
    settings: ctx.settings,
    groups: new Map(),
    lows: {},
    unresolved: [],
    plans: [],
    selection: emptySelection(),
    filters: { ...DEFAULT_FILTERS },
    sort: "value",
    items: [],
    wears: new Map(),
  };

  /**
   * The counters, and the one of them that is also a filter.
   *
   * «продаваемые» and «с ценой» were two checkboxes hiding the same thing twice:
   * rows the market will not take and rows we could not price are both rows that
   * cannot be listed. That is what «к продаже» counts, so pressing the counter
   * is the filter — a row of controls removed and nothing lost.
   */
  const stats = el("div", "stw-stats");
  const statNodes: Record<string, HTMLElement> = {};
  const statButtons: Record<string, HTMLButtonElement> = {};
  for (const [key, label, tone] of [
    ["items", "предметов", ""],
    ["value", "на сумму", "warn"],
    ["sell", "к продаже", "go"],
  ] as const) {
    const box = el("button", "stw-stat") as HTMLButtonElement;
    box.type = "button";
    if (tone) box.dataset.tone = tone;
    if (key === "value") box.classList.add("stw-stat-money");
    const n = el("div", "stw-stat-n", "0");
    box.append(n, el("div", "stw-stat-l", label));
    statNodes[key] = n;
    statButtons[key] = box;
    stats.appendChild(box);
  }

  /** Only the rows that can actually be listed, or everything. */
  function onlySellable(): boolean {
    return state.filters.onlyMarketable && state.filters.onlyPriced;
  }
  statButtons.sell!.title = "Показать только то, что можно выставить";
  statButtons.sell!.addEventListener("click", () => {
    const on = !onlySellable();
    state.filters = { ...state.filters, onlyMarketable: on, onlyPriced: on };
    renderRows();
    renderStats();
  });
  statButtons.items!.title = "Показать всё, что нашлось на странице";
  statButtons.items!.addEventListener("click", () => {
    state.filters = { ...state.filters, onlyMarketable: false, onlyPriced: false };
    renderRows();
    renderStats();
  });
  statButtons.value!.disabled = true;

  /**
   * Filtering and sorting are what turn a page of two hundred stacks into a
   * decision. Nothing here touches the network: it re-reads what is already priced.
   */
  const filterRow = el("div", "stw-controls");
  const queryInput = document.createElement("input");
  queryInput.type = "search";
  queryInput.className = "stw-input";
  queryInput.placeholder = "поиск по названию";
  queryInput.title = "Ищет и по названию, и по market_hash_name — там живёт износ";

  /**
   * One order, and it is the one a seller wants: the stack worth the most on
   * top, the unpriced at the bottom. Five ways to sort a list is five ways to
   * be looking at the wrong end of it.
   *
   * The box carries no label: «Фильтр» over a field whose placeholder already
   * reads «поиск по названию» is a caption for a photograph of itself.
   */
  filterRow.appendChild(queryInput);

  const hint = el("div", "stw-hint", "Ctrl+клик по плитке — снять или вернуть одну копию");

  /** Scanning is where every pass starts, so it gets the width. */
  const actions = el("div", "stw-actions stw-actions-main");
  const scanBtn = el("button", "stw-btn stw-btn-primary", "Оценить страницу");
  scanBtn.type = "button";
  actions.append(scanBtn);

  const actionsRest = el("div", "stw-actions stw-actions-rest");
  const sellBtn = el("button", "stw-btn stw-btn-go", "Выставить");
  sellBtn.type = "button";
  sellBtn.disabled = true;
  const stopBtn = el("button", "stw-btn", "Стоп");
  stopBtn.type = "button";
  stopBtn.disabled = true;
  actionsRest.append(sellBtn, stopBtn);

  const resumeRow = el("div", "stw-actions stw-resume");
  const resumeBtn = el("button", "stw-btn stw-btn-primary", "Догрузить цены");
  resumeBtn.type = "button";
  resumeRow.appendChild(resumeBtn);
  resumeRow.hidden = true;

  const rows = el("div", "stw-rows");
  section.body.append(stats, filterRow, hint, actions, actionsRest, resumeRow, rows);

  let phase = "";
  let phaseKind: StatusKind = "";
  /**
   * The caveats, folded away under «подробнее».
   *
   * A finished scan has one answer and three footnotes — how many requests it
   * spent, what to do about the unpriced, what to press next. Printed as one
   * paragraph they bury the answer, which is the only line most passes need.
   */
  let phaseDetail = "";
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
    section.setStatus(
      `${phase} · ${note}`,
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

  function pendingSells(): SellPlan[] {
    return state.plans.filter((p) => p.action === "sell" && p.result !== "ok");
  }

  function pickedInGroup(group: InventoryGroup): number {
    const picked = pickedAssets();
    return group.items.filter((item) => picked.has(item.assetid)).length;
  }

  function currentViews(): GroupView[] {
    return viewGroups(state.groups, state.lows, state.filters, state.sort, (assetid) => {
      const wear = state.wears.get(assetid);
      return wear ? wear.float : null;
    });
  }

  /** Every copy that is priced, marketable and still ticked. */
  function pickedAssets(): Set<string> {
    return pickedAssetIds(state.groups, state.lows, state.selection);
  }

  function sellableAssets(group: InventoryGroup): Set<string> {
    return new Set(group.items.filter((item) => item.marketable).map((item) => item.assetid));
  }

  function renderStats(): void {
    /** The boxes describe what is on screen, so a filter changes them too. */
    const totals = viewTotals(currentViews());

    statNodes.items!.textContent = String(totals.items);
    statNodes.value!.textContent = money(totals.value);
    statNodes.sell!.textContent = String(pendingSells().length);

    const todo = pendingSells().length;
    sellBtn.textContent = todo ? `Выставить ${todo}` : "Выставить";
    sellBtn.disabled = state.busy || todo === 0;

    const only = onlySellable();
    statButtons.sell!.setAttribute("aria-pressed", String(only));
    statButtons.items!.setAttribute("aria-pressed", String(!only));
  }

  /**
   * What this pass will actually do with one stack.
   *
   * Built once per render rather than searched per row: the plan list is one
   * entry per copy, so a page of two hundred stacks would otherwise scan it two
   * hundred times over.
   */
  interface GroupOrder {
    /** Copies this pass would list. */
    count: number;
    /** What one copy would be listed at — the price a buyer pays. */
    buyer: Cents | null;
    /** What lands in the wallet for all of them, fees already taken. */
    take: Cents;
    /** Why nothing is planned, in the planner's own words. */
    reason: string;
  }

  function ordersByGroup(): Map<string, GroupOrder> {
    const out = new Map<string, GroupOrder>();
    for (const plan of state.plans) {
      const key = `${plan.appid}	${plan.hash}`;
      const seen = out.get(key) ?? { count: 0, buyer: null, take: 0, reason: "" };
      if (plan.action === "sell" && plan.result !== "ok") {
        seen.count += 1;
        if (seen.buyer == null) seen.buyer = plan.targetBuyer;
        if (plan.targetSeller != null) seen.take += plan.targetSeller;
      } else if (!seen.reason && plan.action === "skip") {
        seen.reason = plan.reason;
      }
      out.set(key, seen);
    }
    return out;
  }

  function groupRow(view: GroupView, order: GroupOrder): HTMLElement {
    const { group, low } = view;
    const row = el("div", "stw-row stw-row-pick");
    row.dataset.key = group.key;

    const sellable = low != null && view.sellable > 0;
    const pick = sellable ? groupPick(group, state.selection) : "none";
    row.dataset.kind = pick === "none" ? "" : "reprice";

    const label = el("label", "stw-name");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "stw-check";
    check.checked = pick !== "none";
    /** Half-ticked is a real state here: some copies of the stack are picked. */
    check.indeterminate = pick === "some";
    check.disabled = !sellable;
    check.addEventListener("change", () => {
      toggleGroup(group, state.selection);
      replan();
    });
    label.append(check, document.createTextNode(` ${group.name}`));
    label.title = group.hash;

    /**
     * The two numbers a seller is deciding between, in the column where the
     * reprice tab puts them: what the market asks, and what we would ask.
     *
     * It used to read «×12 · 1 234,56» — the count and what the stack is worth
     * at market. Neither is the decision. The stack's worth is already in the
     * counter above, while the price this pass will list at was computed, used,
     * and never shown: with «ниже минимума» or «по средней за год» it can sit
     * well under the market low, and that gap was invisible until the confirm
     * dialog. Now it is a number, and a coloured one past twelve percent.
     */
    const prices = el("div", "stw-prices");
    if (low == null) {
      prices.append(el("span", "stw-tgt stw-muted", "—"));
    } else if (order.buyer === low) {
      /**
       * «По минимуму рынка» usually lands exactly on the minimum, and an arrow
       * between two identical numbers asks the reader to compare them. The fee
       * round-trip does move it by a kopeck sometimes — that is when the arrow
       * has something to say, and only then does it appear.
       */
      prices.append(el("span", "stw-tgt", money(order.buyer)));
    } else if (order.buyer != null) {
      prices.append(
        el("span", "stw-our", money(low)),
        el("span", "stw-arrow", "→"),
        el("span", "stw-tgt", money(order.buyer))
      );
      const cut = low > 0 && order.buyer < low ? Math.round(((low - order.buyer) / low) * 100) : 0;
      if (cut > 0) {
        const chip = el("span", "stw-drop", `−${cut}%`);
        chip.dataset.deep = cut >= 30 ? "hard" : cut >= 12 ? "some" : "easy";
        prices.appendChild(chip);
      }
    } else {
      prices.append(el("span", "stw-tgt stw-muted", money(low)));
    }
    prices.title =
      low == null
        ? "цена не получена"
        : `${group.count} шт · по рынку стопка стоит ${money(view.value)}`;

    const picked = sellable ? pickedInGroup(group) : 0;
    const wear = wearOf(group);
    /**
     * One clamped line, so what goes first is the whole design: the money that
     * arrives if this sells. «Получим за вычетом комиссии» lived only in the
     * confirm dialog, which is the last place a decision can still be changed
     * and the worst place to learn a new number.
     */
    const said: string[] = [];
    if (low == null) {
      said.push("цена не получена");
    } else if (order.count > 0) {
      said.push(`${order.count} шт · тебе будет ${money(order.take)}`);
      if (order.count < view.sellable) said.push(`из ${view.sellable} продаваемых`);
    } else {
      said.push(order.reason || "выставлять нечего");
    }
    if (view.sellable < group.count) said.push(`продаётся ${view.sellable} из ${group.count}`);
    if (pick === "some" && order.count === 0) said.push(`выбрано ${picked} из ${view.sellable}`);
    if (wear) said.push(wear);
    const why = said.join(" · ");

    /** One stack, one click, without disturbing the rest of the selection. */
    const quick = el("button", "stw-btn stw-btn-thin", "продать");
    quick.type = "button";
    quick.disabled = state.busy || !sellable;
    quick.title = "Выставить только этот предмет";
    quick.addEventListener("click", () => void quickSell(group));

    const whyLine = el("div", "stw-why", why);
    whyLine.title = why;
    const whyRow = el("div", "stw-whyrow");
    whyRow.append(whyLine, quick);

    row.append(label, prices, whyRow);
    return row;
  }

  function renderRows(): void {
    rows.replaceChildren();
    if (!state.groups.size) {
      rows.appendChild(
        el("div", "stw-empty", "Нажми «Оценить страницу» — посчитаю то, что Steam уже нарисовал в сетке.")
      );
      return;
    }
    const views = currentViews();
    if (!views.length) {
      rows.appendChild(el("div", "stw-empty", "Под фильтр ничего не подошло."));
      return;
    }
    const orders = ordersByGroup();
    const nothing: GroupOrder = { count: 0, buyer: null, take: 0, reason: "" };
    for (const view of views) {
      rows.appendChild(groupRow(view, orders.get(view.group.key) ?? nothing));
    }
  }

  function setBusy(busy: boolean): void {
    state.busy = busy;
    scanBtn.disabled = busy;
    resumeBtn.disabled = busy;
    stopBtn.disabled = !busy;
    sellBtn.disabled = busy || pendingSells().length === 0;
  }

  let stopWatching: (() => void) | null = null;
  let stopPicking: (() => void) | null = null;

  /**
   * Wear spread across one stack, e.g. `float 0.15–0.38`. Empty when Steam
   * did not answer or the stack holds no wearable copies — a stack without
   * wear is normal and stays quiet.
   */
  function wearOf(group: InventoryGroup): string {
    if (!state.wears.size) return "";
    const wears: WearInfo[] = [];
    for (const item of group.items) {
      const wear = state.wears.get(item.assetid);
      if (wear) wears.push(wear);
    }
    return wearChip(wears) ?? "";
  }

  /**
   * Steam paginates the inventory client-side, so a repaint has to follow its
   * re-renders rather than run once.
   */
  function repaintBadges(): void {
    if (!state.items.length) return;
    const picked = pickedAssets();
    const data = badgeDataFrom(state.items, state.lows, (cents) =>
      cents == null ? "—" : money(cents)
    );
    data.picked = (assetid) => picked.has(assetid);
    if (state.wears.size) {
      const wearByAsset = new Map<string, string>();
      for (const [assetid, wear] of state.wears) {
        const chip = wearChip([wear]);
        if (chip) wearByAsset.set(assetid, chip);
      }
      data.wearByAsset = wearByAsset;
    }
    paintBadges(document.body, data);
  }

  /** Ctrl+click on a tile picks that one copy, without going through the list. */
  function onTilePick(ref: TileRef): void {
    const item = state.items.find(
      (candidate) => candidate.appid === ref.appid && candidate.assetid === ref.assetid
    );
    const group = item ? state.groups.get(`${item.appid}\t${item.hash}`) : undefined;
    if (!item || !group) {
      status("Эта плитка не в оценённой выборке — нажми «Оценить страницу».", "warn");
      return;
    }
    if (!item.marketable) {
      status(`«${group.name}» маркет не примет.`, "warn");
      return;
    }
    if (state.lows[group.key] == null) {
      status(`«${group.name}» без цены — выставлять нечего.`, "warn");
      return;
    }
    toggleAsset(group, ref.assetid, state.selection);
    replan();
  }

  function startBadges(): void {
    repaintBadges();
    if (!stopWatching) stopWatching = watchForRepaint(document.body, repaintBadges);
    if (!stopPicking) stopPicking = watchTilePicks(document.body, onTilePick);
  }

  function replan(): void {
    state.plans = buildSellPlans({
      groups: state.groups,
      lows: state.lows,
      settings: state.settings.sell,
      fees: feeConfig(),
      onlyAssets: pickedAssets(),
    });
    renderRows();
    renderStats();
    repaintBadges();
    const todo = pendingSells();
    if (todo.length) {
      /** A plan that came out as asked is not a warning; amber was crying wolf. */
      status(`К выставлению ${todo.length} · тебе будет ${money(plannedProceeds(todo))}`, "ok");
    }
  }

  async function priceGroups(toFetch: ItemKeyed[]): Promise<void> {
    const result = await fetchMarketLows(toFetch, {
      ...pacing,
      concurrency: state.settings.scanConcurrency,
      source: state.settings.priceSource,
      ttlMs: state.settings.priceTtlMinutes * 60_000,
      onProgress: (done, total, label) => status(`Цены ${done}/${total} · ${label}`, "work"),
    });

    Object.assign(state.lows, result.lows);
    state.unresolved = result.unresolved;
    startBadges();
    resumeRow.hidden = state.unresolved.length === 0;
    resumeBtn.textContent = `Догрузить цены (${state.unresolved.length})`;

    replan();

    const totals = inventoryValue(state.groups, state.lows);
    const spent = `Запросов ${result.requests}${result.fromCache ? `, из кэша ${result.fromCache}` : ""}.`;

    if (result.stopped === "blocked") {
      status(
        `Steam отказал · оценено ${totals.priced} из ${state.groups.size} на ${money(totals.total)}`,
        "warn",
        "Не жми «Догрузить цены», пока маркет в этой вкладке сам не открывается: " +
          `бан от повторных запросов растягивается до часов. ${spent}`
      );
      return;
    }
    if (result.stopped === "aborted") {
      status(`Остановлено · оценено ${totals.priced} из ${state.groups.size}`, "", spent);
      return;
    }
    status(
      `На экране на ${money(totals.total)}` +
        (totals.unpriced ? ` · без цены ${totals.unpriced}` : ""),
      "ok",
      `Перелистни сетку и оцени снова, чтобы взять следующие предметы. ${spent}`
    );
  }

  async function scan(): Promise<void> {
    if (state.busy) return;
    state.abort = false;
    state.groups = new Map();
    state.lows = {};
    state.unresolved = [];
    state.plans = [];
    state.selection = emptySelection();
    state.items = [];
    clearBadges(document.body);
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

    const owner = ownerFromUrl(location.pathname, steamId() ?? "");

    try {
      await refreshPage();
      const tiles = visibleTileRefs(document);
      if (!tiles.length) {
        status(
          "Steam ещё не нарисовал сетку",
          "err",
          "Дождись загрузки инвентаря и нажми снова — беру только то, что на экране."
        );
        setBusy(false);
        return;
      }

      let items = mergeItemsByAsset(itemsFromVisible(visibleInventory()), itemsFromTiles(tiles, assetIndex()));

      const have = new Set(items.map((i) => `${i.appid}_${i.contextid}_${i.assetid}`));
      const missing = tiles.filter((t) => !have.has(`${t.appid}_${t.contextid}_${t.assetid}`));
      if (missing.length && owner) {
        status(`На экране ${tiles.length}, без имени ${missing.length} — дочитываю инвентарь…`, "work");
        /** CS2 shows contexts 2 and 16 on one page; reading only the first leaves the rest nameless. */
        for (const context of groupTilesByContext(missing)) {
          try {
            const loaded = await loadInventory(
              { steamid: owner.steamid, appid: context.appid, contextid: context.contextid },
              {
                ...pacing,
                onProgress: (loadedCount, count) => status(`Предметов: ${loadedCount} / ${count}`, "work"),
              }
            );
            items = mergeItemsByAsset(items, pickVisibleItems(loaded.items, context.tiles));
          } catch (err) {
            if (err instanceof SteamError && (err.kind === "aborted" || err.kind === "blocked")) throw err;
          }
        }
      }

      if (!items.length) {
        status("Плитки вижу, названий нет — обнови вкладку и попробуй снова", "err");
        setBusy(false);
        return;
      }

      state.items = items;
      state.groups = groupInventory(items);
      const { toPrice, skipped } = marketableGroups(state.groups);

      status(
        `На экране ${items.length}, уникальных ${state.groups.size}` +
          (skipped ? `, без рынка ${skipped}` : "") +
          " — качаю цены…",
        "work"
      );
      await priceGroups(toPrice);
      await loadWears(owner);
    } catch (err) {
      status(`Инвентарь: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Wear for CS copies on screen. One request per context covers every asset
   * Steam owns in it, so this is decoration that costs almost nothing — and it
   * is only asked on a page that is provably the owner's own, because a float
   * is only ever worth reading about a copy that could be listed.
   */
  async function loadWears(owner: { steamid: string; assumed: boolean } | null): Promise<void> {
    const viewer = steamId();
    if (!owner || !viewer || owner.steamid !== viewer) return;
    const fresh = state.items.filter(
      (item) => item.appid === WEAR_APPID && !state.wears.has(item.assetid)
    );
    if (!fresh.length) return;

    const contexts = new Map<string, typeof fresh>();
    for (const item of fresh) {
      const key = `${item.appid}_${item.contextid}`;
      const list = contexts.get(key) ?? [];
      list.push(item);
      contexts.set(key, list);
    }

    for (const list of contexts.values()) {
      const first = list[0];
      if (!first) continue;
      try {
        const found = await fetchWear(
          { steamid: viewer, appid: first.appid, contextid: first.contextid },
          first.assetid,
          pacing
        );
        for (const [assetid, wear] of found) state.wears.set(assetid, wear);
      } catch (err) {
        if (err instanceof SteamError && (err.kind === "aborted" || err.kind === "blocked")) throw err;
        /** Wear decorates; it never fails the scan over itself. */
      }
    }
    renderRows();
    repaintBadges();
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
      await priceGroups(state.unresolved);
    } catch (err) {
      status(`Догрузка: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
  }

  async function sell(): Promise<void> {
    if (state.busy) return;
    const todo = pendingSells();
    if (!todo.length) return;

    const proceeds = plannedProceeds(todo);
    /**
     * The two things a list of two hundred hides from the person pressing
     * the button: how long they are committing to, and the worst price in
     * the batch. Both were discoverable only by scrolling, which is the
     * same as hidden.
     */
    const deepest = deepestCut(todo);
    const confirmed = window.confirm(
      `Выставить ${todo.length} предмет(ов) на продажу?

` +
        `Тебе будет ${money(proceeds)} — это уже за вычетом комиссии.
` +
        `Примерно ${humanMinutes(runTimeMs(todo.length))} работы.
` +
        (deepest > 0 ? `Самая большая уступка рынку в партии — ${deepest}%.
` : "") +
        "Каждую продажу надо подтвердить в Steam Guard."
    );
    if (!confirmed) return;
    state.settings = await loadSettings();
    await runSell(todo);
  }

  /**
   * Lists one stack on its own, whatever is ticked elsewhere. Its plans are merged
   * back into the panel's set, so a copy that has just been listed cannot be
   * offered again by «Выставить» — Steam would refuse it, and the row would lie.
   */
  async function quickSell(group: InventoryGroup): Promise<void> {
    if (state.busy) return;
    if (state.lows[group.key] == null) return;

    state.settings = await loadSettings();
    /** Copies picked on the tiles win; if none are, the click means the whole stack. */
    const sellable = sellableAssets(group);
    const picked = pickedAssets();
    const chosen = new Set([...sellable].filter((assetid) => picked.has(assetid)));
    const fresh = buildSellPlans({
      groups: state.groups,
      lows: state.lows,
      settings: state.settings.sell,
      fees: feeConfig(),
      onlyKeys: new Set([group.key]),
      onlyAssets: chosen.size ? chosen : sellable,
    });
    const todo = fresh.filter((plan) => plan.action === "sell");
    if (!todo.length) {
      status(`«${group.name}» выставлять нечем: ${fresh[0]?.reason ?? "нет цены"}.`, "warn");
      return;
    }

    const deepest = deepestCut(todo);
    const confirmed = window.confirm(
      `Выставить «${group.name}» — ${todo.length} шт. по ${money(todo[0]!.targetBuyer)}?

` +
        `Тебе будет ${money(plannedProceeds(todo))} — это уже за вычетом комиссии.
` +
        (deepest > 0 ? `Это на ${deepest}% ниже минимума рынка.
` : "") +
        "Каждую продажу надо подтвердить в Steam Guard."
    );
    if (!confirmed) return;

    const others = state.plans.filter((plan) => `${plan.appid}\t${plan.hash}` !== group.key);
    state.plans = [...others, ...fresh];
    await runSell(todo);
  }

  async function runSell(todo: SellPlan[]): Promise<void> {
    state.abort = false;
    setBusy(true);
    renderRows();
    const delay = Math.max(1500, state.settings.delayMs);

    let ok = 0;
    let failed = 0;
    let guard = 0;
    let halted = false;

    for (let i = 0; i < todo.length; i++) {
      if (state.abort) break;
      const plan = todo[i]!;
      status(`Выставляю ${i + 1}/${todo.length}: ${plan.name}`, "work");
      try {
        /**
         * One try at the item itself — nothing was delisted here, so «предмет
         * не в инвентаре» is a verdict rather than a hand-back still in
         * progress — but Steam's unexplained refusal is sat out, exactly as on
         * the market tab. Without it one shrug turned a listed copy into a
         * failed row and the seller never learned why.
         */
        const result = await sellItemWhenReady(plan, pacing, {
          attempts: 1,
          onRetry: (n) =>
            status(
              `Выставляю ${i + 1}/${todo.length}: ${plan.name} — Steam отказал и не сказал почему, жду и пробую снова (${n})`,
              "work"
            ),
        });
        plan.result = "ok";
        if (needsConfirmation(result)) {
          plan.resultMessage = "ожидает Steam Guard";
          guard += 1;
        } else {
          plan.resultMessage = `выставлен ${money(plan.targetBuyer)}`;
        }
        ok += 1;
      } catch (err) {
        plan.result = "fail";
        /**
         * A `sellitem` whose reply never arrived may have gone through. Saying
         * «ошибка» about it sends the user looking for an item in the inventory
         * that is in fact on the market.
         */
        plan.resultMessage = outcomeUnknown(err)
          ? `неизвестно, выставлен ли лот — ${describeError(err)}`
          : `ошибка: ${describeError(err)}`;
        failed += 1;
        if (haltsRun(err)) halted = true;
      }
      renderStats();
      if (halted) break;
      await sleep(delay);
    }

    if (halted) {
      status(
        `Steam остановил продажи на ${ok} из ${todo.length}`,
        "warn",
        "Дальше не иду: бан от повторных запросов только удлиняется."
      );
    } else {
      const parts = [`Готово: ${ok} ок`];
      if (failed) parts.push(`${failed} ошибок`);
      if (guard) parts.push(`подтверди ${guard} в Steam Guard`);
      if (state.abort) parts.push("остановлено");
      status(parts.join(" · "), failed ? "warn" : "ok");
    }
    setBusy(false);
    renderRows();
  }

  queryInput.addEventListener("input", () => {
    state.filters = { ...state.filters, query: queryInput.value };
    renderRows();
    renderStats();
  });

  scanBtn.addEventListener("click", () => void scan());
  resumeBtn.addEventListener("click", () => void resume());
  sellBtn.addEventListener("click", () => void sell());
  stopBtn.addEventListener("click", () => {
    state.abort = true;
    status("Останавливаю…", "warn");
  });

  /** The wallet and the session still arrive with the page, so ask for them. */
  requestPageInfo();

  status("Открой страницу инвентаря и нажми «Оценить страницу»");
  renderRows();
  renderStats();
}

register({
  id: "inventory",
  title: "Инвентарь",
  matches: (url) => /\/inventory(\/|$)/.test(url.pathname),
  mount,
});
