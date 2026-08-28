import { formatCents } from "../../../core/money";
import { loadSettings, saveSettings, type Settings } from "../../../core/settings";
import { clampSellSettings, type SellStrategy } from "../../../core/sell";
import type { Cents, ItemKeyed } from "../../../core/types";
import { needsConfirmation, sellItem } from "../../../steam/actions";
import {
  appidFromHash,
  contextsFromPage,
  groupInventory,
  inventoryValue,
  loadInventory,
  ownerFromUrl,
  targetFromHash,
  type InventoryChoice,
  type InventoryGroup,
  type InventoryItem,
} from "../../../steam/inventory";
import { sleep, SteamError, type WaitReason } from "../../../steam/net";
import {
  appContexts,
  currencyId,
  feeConfig,
  requestPageInfo,
  sessionId,
  steamId,
  waitForPage,
} from "../../../steam/page-context";
import { fetchMarketLows } from "../../../steam/prices";
import { el, type StatusKind } from "../../ui/panel";
import { register, type FeatureContext } from "../registry";
import { badgeDataFrom, clearBadges, paintBadges, watchForRepaint } from "./badges";
import { buildSellPlans, plannedProceeds, type SellPlan } from "./plan";

/**
 * Prices what you own, totals it up, and lists it — the feature people actually
 * install these extensions for. The panel is the primary surface rather than
 * badges glued onto Steam's item tiles, so it keeps working when Steam reshuffles
 * its markup.
 */

interface State {
  busy: boolean;
  abort: boolean;
  settings: Settings;
  groups: Map<string, InventoryGroup>;
  lows: Record<string, Cents | null>;
  unresolved: ItemKeyed[];
  plans: SellPlan[];
  /** Groups the user ticked. Empty means everything priced. */
  chosen: Set<string>;
  /** Flat item list, kept for painting badges onto Steam tiles. */
  items: InventoryItem[];
}

function money(cents: Cents | null | undefined): string {
  return formatCents(cents, currencyId());
}

function describeError(err: unknown): string {
  if (err instanceof SteamError) {
    switch (err.kind) {
      case "not_logged_in":
        return "нужен логин Steam в этой вкладке";
      case "rate_limited":
      case "blocked":
        return "Steam упёрся в лимит";
      case "not_json":
        return "Steam ответил страницей вместо JSON";
      case "aborted":
        return "остановлено";
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
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
    chosen: new Set(),
    items: [],
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

  controls.append(strategySelect, amountInput, perItemInput);

  const actions = el("div", "stw-actions");
  const scanBtn = el("button", "stw-btn stw-btn-primary", "Оценить инвентарь");
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
  section.body.append(stats, gameRow, controls, actions, resumeRow, rows);

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
    amountInput.disabled = state.settings.sell.strategy === "match";
    perItemInput.value = String(state.settings.sell.maxPerItem);
  }

  function pendingSells(): SellPlan[] {
    return state.plans.filter((p) => p.action === "sell" && p.result !== "ok");
  }

  function renderStats(): void {
    const totals = inventoryValue(state.groups, state.lows);
    let count = 0;
    for (const group of state.groups.values()) count += group.count;

    statNodes.items!.textContent = String(count);
    statNodes.value!.textContent = money(totals.total);
    statNodes.sell!.textContent = String(pendingSells().length);

    const todo = pendingSells().length;
    sellBtn.textContent = todo ? `Выставить ${todo}` : "Выставить";
    sellBtn.disabled = state.busy || todo === 0;
  }

  function groupRow(group: InventoryGroup): HTMLElement {
    const row = el("div", "stw-row stw-row-pick");
    row.dataset.key = group.key;

    const low = state.lows[group.key] ?? null;
    const picked = state.chosen.size === 0 || state.chosen.has(group.key);
    row.dataset.kind = low == null ? "" : picked ? "reprice" : "";

    const label = el("label", "stw-name");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "stw-check";
    check.checked = picked;
    check.disabled = low == null;
    check.addEventListener("change", () => {
      /** First manual tick turns "everything" into an explicit selection. */
      if (state.chosen.size === 0) {
        for (const g of state.groups.values()) {
          if (state.lows[g.key] != null) state.chosen.add(g.key);
        }
      }
      if (check.checked) state.chosen.add(group.key);
      else state.chosen.delete(group.key);
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
        : el("span", "stw-tgt", money(low * group.count))
    );

    const why =
      low == null
        ? "цена не получена"
        : `${money(low)} за штуку${group.items.some((i) => !i.marketable) ? " · часть не продаётся" : ""}`;

    row.append(label, prices, el("div", "stw-why", why));
    return row;
  }

  function renderRows(): void {
    rows.replaceChildren();
    if (!state.groups.size) {
      rows.appendChild(el("div", "stw-empty", "Выбери игру и нажми «Оценить инвентарь»."));
      return;
    }
    /** Most valuable first: that is the order a seller cares about. */
    const ordered = [...state.groups.values()].sort((a, b) => {
      const av = (state.lows[a.key] ?? 0) * a.count;
      const bv = (state.lows[b.key] ?? 0) * b.count;
      return bv - av;
    });
    for (const group of ordered) rows.appendChild(groupRow(group));
  }

  function setBusy(busy: boolean): void {
    state.busy = busy;
    scanBtn.disabled = busy;
    resumeBtn.disabled = busy;
    stopBtn.disabled = !busy;
    sellBtn.disabled = busy || pendingSells().length === 0;
  }

  let stopWatching: (() => void) | null = null;

  /**
   * Steam paginates the inventory client-side, so a repaint has to follow its
   * re-renders rather than run once.
   */
  function repaintBadges(): void {
    if (!state.items.length) return;
    const data = badgeDataFrom(state.items, state.lows, (cents) =>
      cents == null ? "—" : money(cents)
    );
    paintBadges(document.body, data);
  }

  function startBadges(): void {
    repaintBadges();
    if (!stopWatching) stopWatching = watchForRepaint(document.body, repaintBadges);
  }

  function replan(): void {
    state.plans = buildSellPlans({
      groups: state.groups,
      lows: state.lows,
      settings: state.settings.sell,
      fees: feeConfig(),
      onlyKeys: state.chosen.size ? state.chosen : undefined,
    });
    renderRows();
    renderStats();
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
        `Steam притормозил. Оценено ${totals.priced} из ${state.groups.size} на ${money(totals.total)}. ` +
          `Остальное — «Догрузить цены» через минуту. ${spent}`,
        "warn"
      );
      return;
    }
    if (result.stopped === "aborted") {
      status(`Остановлено. Оценено ${totals.priced} из ${state.groups.size}. ${spent}`, "");
      return;
    }
    status(
      `Инвентарь на ${money(totals.total)}` +
        (totals.unpriced ? `, без цены ${totals.unpriced}` : "") +
        `. ${spent}`,
      "ok"
    );
  }

  async function scan(): Promise<void> {
    if (state.busy) return;
    state.abort = false;
    state.groups = new Map();
    state.lows = {};
    state.unresolved = [];
    state.plans = [];
    state.chosen = new Set();
    state.items = [];
    clearBadges(document.body);
    resumeRow.hidden = true;
    setBusy(true);
    renderRows();
    renderStats();

    state.settings = await loadSettings();
    fillControls();
    await waitForPage();

    if (!sessionId()) {
      status("Не вижу sessionid — зайди в Steam в этой вкладке.", "err");
      setBusy(false);
      return;
    }

    const owner = ownerFromUrl(location.pathname, steamId() ?? "");
    if (!owner) {
      status("Не понял, чей это инвентарь. Открой свой инвентарь в Steam.", "err");
      setBusy(false);
      return;
    }

    fillGames();
    const choice = selectedChoice();
    const fromHash = targetFromHash(location.hash, owner.steamid);
    const target = choice
      ? { steamid: owner.steamid, appid: choice.appid, contextid: choice.contextid }
      : fromHash;

    if (!target) {
      status(
        "Не вижу список игр. Открой инвентарь заново — Steam отдаёт его после загрузки страницы.",
        "err"
      );
      setBusy(false);
      return;
    }

    try {
      const whose = owner.assumed ? "свой инвентарь" : `инвентарь ${owner.steamid}`;
      status(`Читаю ${whose}: ${choice?.label ?? `${target.appid}/${target.contextid}`}…`, "work");
      const { items, truncated, total } = await loadInventory(target, {
        ...pacing,
        onProgress: (loaded, count) => status(`Предметов: ${loaded} / ${count}`, "work"),
      });

      if (!items.length) {
        status(`Инвентарь пуст или закрыт (Steam total=${total}).`, "err");
        setBusy(false);
        return;
      }

      state.items = items;
      state.groups = groupInventory(items);
      const uniques: ItemKeyed[] = [...state.groups.values()].map((g) => ({
        key: g.key,
        appid: g.appid,
        hash: g.hash,
        name: g.name,
      }));

      status(
        `Предметов ${items.length}, уникальных ${uniques.length}${truncated ? " (обрезано)" : ""} — качаю цены…`,
        "work"
      );
      await priceGroups(uniques);
    } catch (err) {
      status(`Инвентарь: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
  }

  async function resume(): Promise<void> {
    if (state.busy || !state.unresolved.length) return;
    state.abort = false;
    setBusy(true);
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

    state.abort = false;
    setBusy(true);
    state.settings = await loadSettings();
    const delay = Math.max(900, state.settings.delayMs);

    let ok = 0;
    let failed = 0;
    let guard = 0;

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
        plan.resultMessage = `ошибка: ${describeError(err)}`;
        failed += 1;
        if (err instanceof SteamError && (err.kind === "rate_limited" || err.kind === "blocked")) {
          await sleep(8000);
        }
      }
      renderStats();
      await sleep(delay);
    }

    const parts = [`Готово: ${ok} ок`];
    if (failed) parts.push(`${failed} ошибок`);
    if (guard) parts.push(`подтверди ${guard} в Steam Guard`);
    if (state.abort) parts.push("остановлено");
    status(parts.join(" · "), failed ? "warn" : "ok");
    setBusy(false);
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
  amountInput.addEventListener("change", () => void saveStrategy());
  perItemInput.addEventListener("change", () => void saveStrategy());

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
    status(`Выбрано: ${selectedChoice()?.label ?? "—"}. Нажми «Оценить инвентарь».`);
  });

  fillGames();
  fillControls();
  status("Выбери игру и нажми «Оценить инвентарь».");
  renderRows();
  renderStats();
}

register({
  id: "inventory",
  title: "Инвентарь",
  matches: (url) => /\/inventory(\/|$)/.test(url.pathname),
  mount,
});
