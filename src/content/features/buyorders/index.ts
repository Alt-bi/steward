import { formatCents } from "../../../core/money";
import { noneDropped, pickAll, pickNone, togglePick, type Picks } from "../../../core/picks";
import { loadSettings, type Settings } from "../../../core/settings";
import type { Cents } from "../../../core/types";
import { cancelBuyOrder } from "../../../steam/actions";
import { buyOrdersOnPage, type MyBuyOrder } from "../../../steam/buyorders";
import { allowSteamTraffic, sleep, SteamError, type WaitReason } from "../../../steam/net";
import { currencyId, refreshPage, sessionId, waitForPage } from "../../../steam/page-context";
import { fetchMarketLows } from "../../../steam/prices";
import { describeError, haltsRun, outcomeUnknown } from "../../ui/errors";
import { el, type StatusKind } from "../../ui/panel";
import { register, type FeatureContext } from "../registry";
import {
  cancellableOrders,
  DEFAULT_ORDER_FILTERS,
  orderItems,
  orderTotals,
  shownOrderIds,
  viewOrders,
  type OrderFilters,
  type OrderSortKey,
  type OrderView,
} from "./view";

/**
 * Standing buy orders: what they are holding, how far they are from the market,
 * and a way to take them down in bulk.
 *
 * The list itself costs nothing — Steam has already drawn every order on this
 * page. Only «Оценить» spends requests, and only for the items actually shown.
 */

interface State {
  busy: boolean;
  abort: boolean;
  settings: Settings;
  orders: MyBuyOrder[];
  /** Whether the page has been read at all — an empty list means two different things. */
  scanned: boolean;
  lows: Record<string, Cents | null>;
  dropped: Picks;
  filters: OrderFilters;
  sort: OrderSortKey;
}

function money(cents: Cents | null | undefined): string {
  return formatCents(cents, currencyId());
}

interface RowHooks {
  picked: boolean;
  onToggle: () => void;
}

function orderRow(view: OrderView, hooks: RowHooks): HTMLElement {
  const { order } = view;
  const row = el("div", "stw-row");
  row.dataset.id = order.buyOrderId;
  /**
   * An order at or above the cheapest listing should have filled already; that is
   * worth a colour, because it usually means the order is on a different item than
   * the user thinks.
   */
  row.dataset.kind = view.gap != null && view.gap >= 0 ? "warn" : "";

  const name = el("label", "stw-name");
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "stw-check";
  check.checked = hooks.picked;
  check.addEventListener("change", hooks.onToggle);
  name.append(check, document.createTextNode(` ${order.name}`));
  name.title = order.hash || order.name;

  const prices = el("div", "stw-prices");
  prices.append(
    el("span", "stw-our", money(order.unitBuyer)),
    el("span", "stw-arrow", "→"),
    view.low == null
      ? el("span", "stw-tgt stw-muted", "—")
      : el("span", "stw-tgt", money(view.low))
  );
  prices.title =
    view.low == null
      ? "минимум рынка не запрашивали"
      : `моя заявка ${money(order.unitBuyer)}, дешевле всего на рынке ${money(view.low)}`;

  const parts = [`${order.quantity} шт · заморожено ${money(view.money)}`];
  if (view.gap != null) {
    parts.push(
      view.gap >= 0
        ? `заявка не ниже рынка на ${money(view.gap)} — почему-то не сработала`
        : `до рынка ${money(-view.gap)}`
    );
  }
  const why = el("div", "stw-why", parts.join(" · "));

  row.append(name, prices, why);
  return row;
}

async function mount(ctx: FeatureContext): Promise<void> {
  const section = ctx.panel.addSection("buyorders", "Заявки");

  const state: State = {
    busy: false,
    abort: false,
    settings: ctx.settings,
    orders: [],
    scanned: false,
    lows: {},
    dropped: noneDropped(),
    filters: { ...DEFAULT_ORDER_FILTERS },
    sort: "money",
  };

  const stats = el("div", "stw-stats");
  const statNodes: Record<string, HTMLElement> = {};
  for (const [key, label, tone] of [
    ["orders", "заявок", ""],
    ["items", "предметов", ""],
    ["money", "заморожено", "warn"],
  ] as const) {
    const box = el("div", "stw-stat");
    if (tone) box.dataset.tone = tone;
    const n = el("div", "stw-stat-n", "0");
    box.append(n, el("div", "stw-stat-l", label));
    statNodes[key] = n;
    stats.appendChild(box);
  }

  const filterRow = el("div", "stw-controls");
  const queryInput = document.createElement("input");
  queryInput.type = "search";
  queryInput.className = "stw-input";
  queryInput.placeholder = "поиск по названию";
  queryInput.title = "Ищет и по названию, и по market_hash_name";

  const sortSelect = document.createElement("select");
  sortSelect.className = "stw-select";
  for (const [value, label] of [
    ["money", "больше заморожено"],
    ["price", "дороже за штуку"],
    ["name", "по названию"],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sortSelect.appendChild(option);
  }
  filterRow.append(queryInput, sortSelect);

  const aboveLabel = el("label", "stw-toggle");
  aboveLabel.title = "Заявки не ниже минимума рынка — их Steam должен был исполнить";
  const aboveOnly = document.createElement("input");
  aboveOnly.type = "checkbox";
  aboveOnly.className = "stw-check";
  aboveLabel.append(aboveOnly, document.createTextNode(" не ниже рынка"));

  const pickAllBtn = el("button", "stw-btn stw-btn-thin", "Все");
  pickAllBtn.type = "button";
  pickAllBtn.title = "Отметить всё, что сейчас показано";
  const pickNoneBtn = el("button", "stw-btn stw-btn-thin", "Ничего");
  pickNoneBtn.type = "button";
  pickNoneBtn.title = "Снять отметку со всего, что сейчас показано";

  const toggleRow = el("div", "stw-controls stw-toggles");
  toggleRow.append(aboveLabel, pickAllBtn, pickNoneBtn);

  const shownLine = el("div", "stw-hint", "");

  const actions = el("div", "stw-actions");
  const scanBtn = el("button", "stw-btn stw-btn-primary", "Прочитать заявки");
  scanBtn.type = "button";
  const priceBtn = el("button", "stw-btn", "Оценить");
  priceBtn.type = "button";
  priceBtn.title = "Спросить у рынка минимальную цену по показанным предметам";
  priceBtn.disabled = true;
  const cancelBtn = el("button", "stw-btn stw-btn-danger", "Отменить");
  cancelBtn.type = "button";
  cancelBtn.title = "Отменить отмеченные заявки — деньги вернутся в кошелёк";
  cancelBtn.disabled = true;
  const stopBtn = el("button", "stw-btn", "Стоп");
  stopBtn.type = "button";
  stopBtn.disabled = true;
  actions.append(scanBtn, priceBtn, cancelBtn, stopBtn);

  const rows = el("div", "stw-rows");
  section.body.append(stats, filterRow, toggleRow, shownLine, actions, rows);

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

  function currentViews(): OrderView[] {
    return viewOrders(state.orders, state.lows, state.filters, state.sort);
  }

  function renderStats(): void {
    const views = currentViews();
    const totals = orderTotals(views, state.dropped);
    statNodes.orders!.textContent = String(totals.orders);
    statNodes.items!.textContent = String(totals.items);
    statNodes.money!.textContent = money(totals.money);

    cancelBtn.textContent = totals.picked ? `Отменить ${totals.picked}` : "Отменить";
    cancelBtn.disabled = state.busy || totals.picked === 0;
    priceBtn.disabled = state.busy || orderItems(views).length === 0;

    shownLine.textContent = state.orders.length
      ? `Показано ${totals.orders} из ${state.orders.length} · отмечено ${totals.picked}`
      : "";
  }

  function rowFor(view: OrderView): HTMLElement {
    return orderRow(view, {
      picked: !state.dropped.has(view.order.buyOrderId),
      onToggle: () => {
        togglePick(view.order.buyOrderId, state.dropped);
        renderStats();
      },
    });
  }

  function renderRows(): void {
    rows.replaceChildren();
    if (!state.orders.length) {
      rows.appendChild(
        el(
          "div",
          "stw-empty",
          state.scanned
            ? "Активных заявок не осталось."
            : "Заявок на этой странице не видно. Открой Market → My listings: беру то, что Steam уже нарисовал, страницы не обхожу."
        )
      );
      return;
    }
    const views = currentViews();
    if (!views.length) {
      rows.appendChild(el("div", "stw-empty", "Под фильтр ничего не попало."));
      return;
    }
    for (const view of views) rows.appendChild(rowFor(view));
  }

  function setBusy(busy: boolean): void {
    state.busy = busy;
    scanBtn.disabled = busy;
    stopBtn.disabled = !busy;
    renderStats();
  }

  async function scan(): Promise<void> {
    if (state.busy) return;
    state.abort = false;
    setBusy(true);
    try {
      await waitForPage();
      await refreshPage();
      state.orders = buyOrdersOnPage();
      state.scanned = true;
      state.dropped = noneDropped();
      state.lows = {};
      renderRows();
      renderStats();
      const totals = orderTotals(currentViews(), state.dropped);
      status(
        state.orders.length
          ? `Заявок ${state.orders.length}, в них заморожено ${money(totals.money)}. Запросов не потрачено.`
          : "Заявок на странице нет.",
        state.orders.length ? "ok" : ""
      );
    } catch (err) {
      status(`Заявки: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
  }

  /** Asks the market what the shown items actually cost right now. */
  async function priceShown(): Promise<void> {
    if (state.busy) return;
    const items = orderItems(currentViews());
    if (!items.length) return;

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
      const result = await fetchMarketLows(items, {
        ...pacing,
        concurrency: state.settings.scanConcurrency,
        source: state.settings.priceSource,
        ttlMs: state.settings.priceTtlMinutes * 60_000,
        onProgress: (done, total, label) => status(`Цены ${done}/${total} · ${label}`, "work"),
      });
      Object.assign(state.lows, result.lows);
      renderRows();
      renderStats();

      const priced = items.filter((item) => state.lows[item.key] != null).length;
      const above = currentViews().filter((view) => view.gap != null && view.gap >= 0).length;
      const cached = result.fromCache ? `, из кэша ${result.fromCache}` : "";
      const spent = `Запросов ${result.requests}${cached}.`;

      if (result.stopped === "blocked") {
        status(`Steam отказал на ${priced} из ${items.length}. ${spent}`, "warn");
        return;
      }
      if (result.stopped === "aborted") {
        status(`Остановлено на ${priced} из ${items.length}. ${spent}`, "");
        return;
      }
      status(
        (above
          ? `${above} заявок стоят не ниже рынка — обычно это другой износ или другая игра. `
          : "Все заявки ниже рынка — ждут продавца. ") + `Цены есть у ${priced} из ${items.length}. ${spent}`,
        above ? "warn" : "ok"
      );
    } catch (err) {
      status(`Оценка: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Cancels the ticked orders.
   *
   * Money comes back to the wallet, so this is not destructive in the way a sale
   * is — but it is still the user's money moving, and a mistyped filter could take
   * down a whole page of orders. Hence the count, the sum, and the confirmation.
   */
  async function cancelPicked(): Promise<void> {
    if (state.busy) return;
    const todo = cancellableOrders(currentViews(), state.dropped);
    if (!todo.length) return;

    if (!sessionId()) {
      status("Не вижу sessionid — зайди в Steam в этой вкладке.", "err");
      return;
    }

    const held = todo.reduce((sum, order) => sum + order.unitBuyer * order.quantity, 0);
    const confirmed = window.confirm(
      `Отменить ${todo.length} заявок(у) и вернуть ${money(held)} в кошелёк?\n\n` +
        "Место в очереди по цене потеряется — заявку придётся создавать заново."
    );
    if (!confirmed) return;

    state.abort = false;
    setBusy(true);
    state.settings = await loadSettings();
    const delay = Math.max(1500, state.settings.delayMs);

    let ok = 0;
    let failed = 0;
    let halted = false;
    let lastError = "";
    const done = new Set<string>();

    for (let i = 0; i < todo.length; i++) {
      if (state.abort) break;
      const order = todo[i]!;
      status(`Отменяю ${i + 1}/${todo.length}: ${order.name}`, "work");
      try {
        await cancelBuyOrder(order.buyOrderId, pacing);
        done.add(order.buyOrderId);
        ok += 1;
        await sleep(delay);
      } catch (err) {
        failed += 1;
        /**
         * An unreadable reply is not a refusal: the order may well be gone and
         * the money already back. The row stays, because striking it off would
         * claim we know, and the run goes on — orders are cancelled one by one
         * and nothing about the next one depends on this one.
         */
        lastError = outcomeUnknown(err)
          ? `неизвестно, отменена ли заявка — ${describeError(err)}`
          : describeError(err);
        /** Same rule as everywhere else: the first refusal from Steam ends the run. */
        if (haltsRun(err)) halted = true;
      }
      if (halted) break;
    }

    /** A cancelled order is gone from Steam; keeping its row would be a lie. */
    if (done.size) {
      state.orders = state.orders.filter((order) => !done.has(order.buyOrderId));
      for (const id of done) state.dropped.delete(id);
    }
    renderRows();
    renderStats();

    if (halted) {
      status(
        `Steam остановил отмену на ${ok} из ${todo.length}. Не продолжаю — бан от повторных запросов только удлиняется.`,
        "warn"
      );
    } else {
      const parts = [`Отменено: ${ok}`];
      if (failed) parts.push(`${failed} ошибок`);
      if (state.abort) parts.push("остановлено");
      if (lastError) parts.push(`последняя: ${lastError}`);
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
    state.sort = sortSelect.value as OrderSortKey;
    renderRows();
  });

  aboveOnly.addEventListener("change", () => {
    state.filters.onlyAboveMarket = aboveOnly.checked;
    renderRows();
    renderStats();
  });

  pickAllBtn.addEventListener("click", () => {
    pickAll(shownOrderIds(currentViews()), state.dropped);
    renderRows();
    renderStats();
  });

  pickNoneBtn.addEventListener("click", () => {
    pickNone(shownOrderIds(currentViews()), state.dropped);
    renderRows();
    renderStats();
  });

  scanBtn.addEventListener("click", () => void scan());
  priceBtn.addEventListener("click", () => void priceShown());
  cancelBtn.addEventListener("click", () => void cancelPicked());
  stopBtn.addEventListener("click", () => {
    state.abort = true;
    status("Останавливаю…", "warn");
  });

  status("Открой Market → My listings и нажми «Прочитать заявки» — это без запросов.");
  renderRows();
  renderStats();
}

register({
  id: "buyorders",
  title: "Заявки",
  /** Buy orders live on the market home page, next to My listings. */
  matches: (url) => /^\/market\/?$/.test(url.pathname),
  mount,
});
