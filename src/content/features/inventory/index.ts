import { formatCents } from "../../../core/money";
import { csvDoc, downloadCsv } from "../../../core/csv";
import { loadSettings, saveSettings, type Settings } from "../../../core/settings";
import { clampSellSettings, type SellStrategy } from "../../../core/sell";
import type { Cents, ItemKeyed } from "../../../core/types";
import { needsConfirmation, sellItem } from "../../../steam/actions";
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
import { defaultAsk, loadHistories } from "../../../steam/history-load";
import type { HistoryStats } from "../../../steam/pricehistory";
import { needsHistory } from "../../../core/sell";
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
  stats: Record<string, HistoryStats | null>;
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
    stats: {},
    unresolved: [],
    plans: [],
    selection: emptySelection(),
    filters: { ...DEFAULT_FILTERS },
    sort: "value",
    items: [],
    wears: new Map(),
  };

  const stats = el("div", "stw-stats");
  const statNodes: Record<string, HTMLElement> = {};
  for (const [key, label, tone] of [
    ["items", "предметов", ""],
    ["value", "на сумму", "warn"],
    ["sell", "к продаже", ""],
  ] as const) {
    const box = el("div", "stw-stat");
    if (tone) box.dataset.tone = tone;
    const n = el("div", "stw-stat-n", "0");
    box.append(n, el("div", "stw-stat-l", label));
    statNodes[key] = n;
    stats.appendChild(box);
  }

  /** Which game to read. Populated from the page, not from the URL fragment. */
  const gameRow = el("div", "stw-controls");
  const gameSelect = document.createElement("select");
  gameSelect.className = "stw-select";
  gameRow.appendChild(gameSelect);

  /** Strategy lives in the panel because it is changed per pass, not once. */
  const controls = el("div", "stw-controls");
  const strategySelect = document.createElement("select");
  strategySelect.className = "stw-select";
  for (const [value, label] of [
    ["match", "по минимуму рынка"],
    ["undercut", "ниже минимума"],
    ["markup", "выше минимума"],
    ["avg7", "по средней за неделю"],
    ["avg30", "по средней за месяц"],
    ["avg365", "по средней за год"],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    strategySelect.appendChild(option);
  }

  const amountInput = document.createElement("input");
  amountInput.type = "number";
  amountInput.className = "stw-num";
  amountInput.min = "1";
  amountInput.title = "Насколько ниже (коп.) или выше (%)";

  const perItemInput = document.createElement("input");
  perItemInput.type = "number";
  perItemInput.className = "stw-num";
  perItemInput.min = "1";
  perItemInput.max = "100";
  perItemInput.title = "Сколько штук одного предмета за проход";

  /**
   * The average strategies need the sale history, which is the slowest thing Steam
   * serves. It is a separate button on purpose: nothing here starts a five-minute
   * run because a dropdown changed.
   */
  const historyBtn = el("button", "stw-btn stw-btn-thin", "История продаж");
  historyBtn.type = "button";
  historyBtn.title =
    "Нужна для «по средней». Самый медленный запрос Steam — около 6 в минуту, " +
    "зато ответ живёт часами.";

    const csvBtn = el("button", "stw-btn stw-btn-thin", "CSV");
  csvBtn.type = "button";
  csvBtn.title =
    "Сохранить то, что видно, таблицей: предмет, кол-во, цена, износ. Открывается в Excel.";
  csvBtn.addEventListener("click", () => exportCsv());

  controls.append(strategySelect, amountInput, perItemInput, historyBtn, csvBtn);

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

  const sortSelect = document.createElement("select");
  sortSelect.className = "stw-select";
  for (const [value, label] of [
    ["value", "дороже стопкой"],
    ["price", "дороже за штуку"],
    ["count", "больше штук"],
    ["name", "по названию"],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sortSelect.appendChild(option);
  }
  filterRow.append(queryInput, sortSelect);

  function checkbox(text: string, title: string): { label: HTMLElement; input: HTMLInputElement } {
    const label = el("label", "stw-toggle");
    label.title = title;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "stw-check";
    label.append(input, document.createTextNode(` ${text}`));
    return { label, input };
  }

  const marketableOnly = checkbox("продаваемые", "Скрыть то, что маркет не примет");
  const pricedOnly = checkbox("с ценой", "Скрыть то, чему не нашлась цена");

  const pickAllBtn = el("button", "stw-btn stw-btn-thin", "Все");
  pickAllBtn.type = "button";
  pickAllBtn.title = "Отметить всё, что сейчас показано";
  const pickNoneBtn = el("button", "stw-btn stw-btn-thin", "Ничего");
  pickNoneBtn.type = "button";
  pickNoneBtn.title = "Снять отметку со всего, что сейчас показано";

  const toggleRow = el("div", "stw-controls stw-toggles");
  toggleRow.append(marketableOnly.label, pricedOnly.label, pickAllBtn, pickNoneBtn);

  const hint = el(
    "div",
    "stw-hint",
    "Ctrl+клик по плитке в инвентаре — снять или вернуть одну копию"
  );

  const actions = el("div", "stw-actions");
  const scanBtn = el("button", "stw-btn stw-btn-primary", "Оценить страницу");
  scanBtn.type = "button";
  const sellBtn = el("button", "stw-btn stw-btn-go", "Выставить");
  sellBtn.type = "button";
  sellBtn.disabled = true;
  const stopBtn = el("button", "stw-btn", "Стоп");
  stopBtn.type = "button";
  stopBtn.disabled = true;
  actions.append(scanBtn, sellBtn, stopBtn);

  const resumeRow = el("div", "stw-actions stw-resume");
  const resumeBtn = el("button", "stw-btn stw-btn-primary", "Догрузить цены");
  resumeBtn.type = "button";
  resumeRow.appendChild(resumeBtn);
  resumeRow.hidden = true;

  const rows = el("div", "stw-rows");
  section.body.append(stats, gameRow, controls, filterRow, toggleRow, hint, actions, resumeRow, rows);

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

  let choices: InventoryChoice[] = [];

  function choiceValue(choice: InventoryChoice): string {
    return `${choice.appid}_${choice.contextid}`;
  }

  /** Keeps the picker in step with the page, preserving what the user selected. */
  function fillGames(): void {
    const previous = gameSelect.value;
    choices = contextsFromPage(appContexts());
    gameSelect.replaceChildren();

    if (!choices.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "игры не видны — обнови страницу";
      gameSelect.appendChild(option);
      gameSelect.disabled = true;
      return;
    }

    gameSelect.disabled = false;
    for (const choice of choices) {
      const option = document.createElement("option");
      option.value = choiceValue(choice);
      option.textContent = `${choice.label} · ${choice.count}`;
      gameSelect.appendChild(option);
    }

    /**
     * Whatever the user is actually looking at wins over our own default. The
     * fragment is sometimes `#730_2` and sometimes just `#227300`, so both the
     * full form and the appid alone are honoured.
     */
    const fromHash = targetFromHash(location.hash, "x");
    const appidOnly = appidFromHash(location.hash);
    const byAppid = appidOnly ? choices.find((c) => c.appid === appidOnly) : undefined;

    const wanted =
      (previous && choices.some((c) => choiceValue(c) === previous) && previous) ||
      (fromHash && `${fromHash.appid}_${fromHash.contextid}`) ||
      (byAppid && choiceValue(byAppid)) ||
      choiceValue(choices[0]!);
    if (choices.some((c) => choiceValue(c) === wanted)) gameSelect.value = wanted;
  }

  function selectedChoice(): InventoryChoice | null {
    return choices.find((c) => choiceValue(c) === gameSelect.value) ?? choices[0] ?? null;
  }

  function fillControls(): void {
    strategySelect.value = state.settings.sell.strategy;
    amountInput.value = String(
      state.settings.sell.strategy === "markup"
        ? state.settings.sell.markupPercent
        : state.settings.sell.undercutCents
    );
    amountInput.disabled = state.settings.sell.strategy !== "undercut" && state.settings.sell.strategy !== "markup";
    historyBtn.hidden = !needsHistory(state.settings.sell.strategy);
    perItemInput.value = String(state.settings.sell.maxPerItem);
  }

  function pendingSells(): SellPlan[] {
    return state.plans.filter((p) => p.action === "sell" && p.result !== "ok");
  }

  function pickedInGroup(group: InventoryGroup): number {
    const picked = pickedAssets();
    return group.items.filter((item) => picked.has(item.assetid)).length;
  }

  function currentViews(): GroupView[] {
    return viewGroups(state.groups, state.lows, state.filters, state.sort);
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
  }

  function groupRow(view: GroupView): HTMLElement {
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

    const prices = el("div", "stw-prices");
    prices.append(
      el("span", "stw-our", `×${group.count}`),
      el("span", "stw-arrow", "·"),
      low == null
        ? el("span", "stw-tgt stw-muted", "—")
        : el("span", "stw-tgt", money(view.value))
    );

    const picked = sellable ? pickedInGroup(group) : 0;
    const wear = wearOf(group);
    const why =
      low == null
        ? "цена не получена"
        : `${money(low)} за штуку` +
          (view.sellable < group.count ? ` · продаётся ${view.sellable} из ${group.count}` : "") +
          (pick === "some" ? ` · выбрано ${picked} из ${view.sellable}` : "") +
          (wear ? ` · ${wear}` : "");

    /** One stack, one click, without disturbing the rest of the selection. */
    const quick = el("button", "stw-btn stw-btn-thin", "продать");
    quick.type = "button";
    quick.disabled = state.busy || !sellable;
    quick.title = "Выставить только этот предмет";
    quick.addEventListener("click", () => void quickSell(group));

    const whyRow = el("div", "stw-whyrow");
    whyRow.append(el("div", "stw-why", why), quick);

    row.append(label, prices, whyRow);
    return row;
  }

  /**
   * What the user can see, as a spreadsheet — the filter and sort already ran,
   * the export is the table, not the raw scan.
   */
  function exportCsv(): void {
    const views = currentViews();
    if (!views.length) {
      status("Экспортировать нечего — сначала «Сканировать».", "warn");
      return;
    }
    const rows = views.map((view) => [
      view.group.name,
      view.group.hash,
      view.group.count,
      money(view.low),
      money(view.value),
      wearOf(view.group),
    ]);
    downloadCsv(
      `steward-inventory-${new Date().toISOString().slice(0, 10)}.csv`,
      csvDoc(["Предмет", "market_hash_name", "Копий", "Низ рынка", "Стек стоит", "Wear"], rows)
    );
    status(`CSV: ${views.length} строк выгружено.`, "ok");
  }

  function renderRows(): void {
    rows.replaceChildren();
    if (!state.groups.size) {
      rows.appendChild(
        el("div", "stw-empty", "Оценю предметы, которые Steam уже нарисовал в сетке. Перелистни инвентарь и нажми снова, чтобы взять следующие.")
      );
      return;
    }
    const views = currentViews();
    if (!views.length) {
      rows.appendChild(el("div", "stw-empty", "Под фильтр ничего не подошло."));
      return;
    }
    for (const view of views) rows.appendChild(groupRow(view));
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
      stats: state.stats,
      onlyAssets: pickedAssets(),
    });
    renderRows();
    renderStats();
    repaintBadges();
    const todo = pendingSells();
    if (todo.length) {
      status(
        `${todo.length} к выставлению, получим ${money(plannedProceeds(todo))} за вычетом комиссии.`,
        "warn"
      );
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
        `Steam отказал. Оценено ${totals.priced} из ${state.groups.size} на ${money(totals.total)}. ` +
          `Не жми «Догрузить», пока маркет в этой вкладке сам не открывается — бан от повторных запросов растягивается до часов. ${spent}`,
        "warn"
      );
      return;
    }
    if (result.stopped === "aborted") {
      status(`Остановлено. Оценено ${totals.priced} из ${state.groups.size}. ${spent}`, "");
      return;
    }
    status(
      `На экране на ${money(totals.total)}` +
        (totals.unpriced ? `, без цены ${totals.unpriced}` : "") +
        `. Перелистни сетку и оцени снова, чтобы взять следующие. ${spent}`,
      "ok"
    );
  }

  /**
   * Fetches what the shown items have been selling for.
   *
   * Explicit, and priced out loud before it starts: `pricehistory` runs about six
   * a minute, so a hundred stacks is a quarter of an hour of somebody's IP budget.
   */
  async function loadHistory(): Promise<void> {
    if (state.busy) return;
    if (!state.groups.size) {
      status("Сначала «Оценить» — историю качаю только для того, что уже на экране.", "warn");
      return;
    }

    const items: ItemKeyed[] = [...state.groups.values()]
      .filter((group) => state.lows[group.key] != null)
      .map((group) => ({ key: group.key, appid: group.appid, hash: group.hash, name: group.name }));
    if (!items.length) {
      status("Нет ни одной оценённой позиции — сначала цены, потом история.", "warn");
      return;
    }

    state.abort = false;
    setBusy(true);

    const outcome = await loadHistories(items, {
      ...pacing,
      onProgress: (done, total, label) => status(`История ${done}/${total} · ${label}`, "work"),
    }, { ask: defaultAsk });

    if (outcome.stopped === "declined") {
      setBusy(false);
      return;
    }
    if (outcome.stopped === "quiet") {
      status(outcome.gateMessage, "warn");
      setBusy(false);
      return;
    }

    try {
      Object.assign(state.stats, outcome.stats);
      replan();
      const known = items.filter((i) => state.stats[i.key] != null).length;
      const spent = `Запросов ${outcome.requests}${outcome.fromCache ? `, из кэша ${outcome.fromCache}` : ""}.`;
      if (outcome.stopped === "blocked") {
        status(`Steam отказал: история есть у ${known} из ${items.length}. Не повторяй сразу. ${spent}`, "warn");
      } else {
        status(`История есть у ${known} из ${items.length}. ${spent}`, "ok");
      }
    } catch (err) {
      status(`История: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
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
    fillControls();
    await waitForPage();

    if (!sessionId()) {
      status("Не вижу sessionid — зайди в Steam в этой вкладке.", "err");
      setBusy(false);
      return;
    }

    const owner = ownerFromUrl(location.pathname, steamId() ?? "");

    fillGames();

    try {
      await refreshPage();
      const tiles = visibleTileRefs(document);
      if (!tiles.length) {
        status(
          "Steam ещё не нарисовал сетку. Подожди загрузку инвентаря и нажми снова — беру только то, что на экране.",
          "err"
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
        status("Плитки вижу, названий нет. Обнови вкладку инвентаря и попробуй снова.", "err");
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
    const confirmed = window.confirm(
      `Выставить ${todo.length} предмет(ов) на продажу?\n\n` +
        `Получим примерно ${money(proceeds)} за вычетом комиссии.\n` +
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
      stats: state.stats,
      onlyKeys: new Set([group.key]),
      onlyAssets: chosen.size ? chosen : sellable,
    });
    const todo = fresh.filter((plan) => plan.action === "sell");
    if (!todo.length) {
      status(`«${group.name}» выставлять нечем: ${fresh[0]?.reason ?? "нет цены"}.`, "warn");
      return;
    }

    const confirmed = window.confirm(
      `Выставить «${group.name}» — ${todo.length} шт. по ${money(todo[0]!.targetBuyer)}?\n\n` +
        `Получим примерно ${money(plannedProceeds(todo))} за вычетом комиссии.\n` +
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
        const result = await sellItem(plan, pacing);
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
        `Steam остановил продажи на ${ok} из ${todo.length}. Не продолжаю — бан от повторных запросов только удлиняется.`,
        "warn"
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

  async function saveStrategy(): Promise<void> {
    const strategy = strategySelect.value as SellStrategy;
    const amount = Number.parseInt(amountInput.value, 10);
    const perItem = Number.parseInt(perItemInput.value, 10);
    const patch = clampSellSettings({
      strategy,
      ...(strategy === "markup" ? { markupPercent: amount } : { undercutCents: amount }),
      maxPerItem: perItem,
    });
    state.settings = { ...state.settings, sell: { ...state.settings.sell, ...patch, strategy } };
    await saveSettings({ sell: state.settings.sell });
    fillControls();
    if (state.groups.size) replan();
  }

  strategySelect.addEventListener("change", () => void saveStrategy());
  historyBtn.addEventListener("click", () => void loadHistory());
  amountInput.addEventListener("change", () => void saveStrategy());
  perItemInput.addEventListener("change", () => void saveStrategy());

  queryInput.addEventListener("input", () => {
    state.filters = { ...state.filters, query: queryInput.value };
    renderRows();
    renderStats();
  });

  sortSelect.addEventListener("change", () => {
    state.sort = sortSelect.value as SortKey;
    renderRows();
  });

  marketableOnly.input.addEventListener("change", () => {
    state.filters = { ...state.filters, onlyMarketable: marketableOnly.input.checked };
    renderRows();
    renderStats();
  });

  pricedOnly.input.addEventListener("change", () => {
    state.filters = { ...state.filters, onlyPriced: pricedOnly.input.checked };
    renderRows();
    renderStats();
  });

  /** The bulk buttons act on what the filter shows — that is what filtering is for. */
  pickAllBtn.addEventListener("click", () => {
    for (const view of currentViews()) {
      if (view.low == null || view.sellable < 1) continue;
      if (groupPick(view.group, state.selection) !== "all") toggleGroup(view.group, state.selection);
    }
    replan();
  });

  pickNoneBtn.addEventListener("click", () => {
    for (const view of currentViews()) {
      if (groupPick(view.group, state.selection) === "none") continue;
      state.selection.groups.add(view.group.key);
    }
    replan();
  });

  scanBtn.addEventListener("click", () => void scan());
  resumeBtn.addEventListener("click", () => void resume());
  sellBtn.addEventListener("click", () => void sell());
  stopBtn.addEventListener("click", () => {
    state.abort = true;
    status("Останавливаю…", "warn");
  });

  /** The table arrives with the page, so refresh the picker when it lands. */
  requestPageInfo();
  window.setTimeout(fillGames, 600);
  window.addEventListener("hashchange", fillGames);
  gameSelect.addEventListener("change", () => {
    status(`Выбрано: ${selectedChoice()?.label ?? "—"}. Нажми «Оценить страницу».`);
  });

  fillGames();
  fillControls();
  status("Открой нужную страницу инвентаря в Steam и нажми «Оценить страницу».");
  renderRows();
  renderStats();
}

register({
  id: "inventory",
  title: "Инвентарь",
  matches: (url) => /\/inventory(\/|$)/.test(url.pathname),
  mount,
});
