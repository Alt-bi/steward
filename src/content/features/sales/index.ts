import { formatCents } from "../../../core/money";
import type { Cents } from "../../../core/types";
import {
  fetchHistoryPage,
  summarizeMarketHistory,
  HISTORY_PAGE_SIZE,
  type HistoryEvent,
  type HistoryTotals,
} from "../../../steam/myhistory";
import { allowSteamTraffic, SteamError, type WaitReason } from "../../../steam/net";
import { currencyId, feeConfig, requestPageInfo, waitForPage } from "../../../steam/page-context";
import { el, type StatusKind } from "../../ui/panel";
import { describeError } from "../../ui/errors";
import { register, type FeatureContext } from "../registry";

/**
 * What came of all of it.
 *
 * Seven tabs answer «what is this worth» and «what should it cost»; none of
 * them answered the question those exist to serve. The account already knows —
 * `/market/myhistory` is the ledger — and nothing in the extension had ever
 * opened it.
 *
 * One page is one request, a hundred events, and it is a button rather than a
 * scan: history is the sort of thing a person reads on purpose, and the same
 * budget pays for the repricer.
 */

const PAGE = HISTORY_PAGE_SIZE;

interface State {
  busy: boolean;
  abort: boolean;
  events: HistoryEvent[];
  total: number;
  /** Only sales, only purchases, or everything. Pressing a counter is the filter. */
  only: "" | "sold" | "bought";
}

function money(cents: Cents | null | undefined): string {
  return formatCents(cents, currencyId());
}

async function mount(ctx: FeatureContext): Promise<void> {
  const section = ctx.panel.addSection("sales", "Продажи");

  const state: State = { busy: false, abort: false, events: [], total: 0, only: "" };

  const stats = el("div", "stw-stats");
  const statNodes: Record<string, HTMLElement> = {};
  const statButtons: Record<string, HTMLButtonElement> = {};
  for (const [key, label, tone] of [
    ["sold", "продано", "go"],
    ["gross", "выручка", ""],
    ["net", "на руки", "go"],
    ["spent", "потрачено", "warn"],
  ] as const) {
    const box = el("button", "stw-stat") as HTMLButtonElement;
    box.type = "button";
    if (tone) box.dataset.tone = tone;
    const n = el("div", "stw-stat-n", "0");
    const l = el("div", "stw-stat-l", label);
    box.append(n, l);
    statNodes[key] = n;
    statButtons[key] = box;
    stats.appendChild(box);
  }
  statButtons.gross!.classList.add("stw-stat-money");
  statButtons.net!.classList.add("stw-stat-money");
  statButtons.spent!.classList.add("stw-stat-money");

  /**
   * Two of the four counters are also the filter, and the other two are sums —
   * there is no list of «выручка», so those stay numbers and say so by not
   * reacting.
   */
  statButtons.sold!.title = "Показать только продажи";
  statButtons.sold!.addEventListener("click", () => {
    state.only = state.only === "sold" ? "" : "sold";
    render();
  });
  statButtons.spent!.title = "Показать только покупки";
  statButtons.spent!.addEventListener("click", () => {
    state.only = state.only === "bought" ? "" : "bought";
    render();
  });
  statButtons.gross!.disabled = true;
  statButtons.net!.disabled = true;

  const actions = el("div", "stw-actions stw-actions-main");
  const readBtn = el("button", "stw-btn stw-btn-primary", "Прочитать историю");
  readBtn.type = "button";
  actions.append(readBtn);

  const actionsRest = el("div", "stw-actions stw-actions-rest");
  const moreBtn = el("button", "stw-btn", `Ещё ${PAGE}`);
  moreBtn.type = "button";
  moreBtn.hidden = true;
  const stopBtn = el("button", "stw-btn", "Стоп");
  stopBtn.type = "button";
  stopBtn.hidden = true;
  actionsRest.append(moreBtn, stopBtn);

  const top = el("div", "stw-rows");
  const rows = el("div", "stw-rows");
  section.body.append(stats, actions, actionsRest, top, rows);

  let phase = "";
  let phaseKind: StatusKind = "";
  let phaseDetail = "";
  let pauseUntil = 0;
  let pauseReason: WaitReason = "budget";

  function paint(): void {
    const left = pauseUntil - Date.now();
    if (left <= 0) {
      section.setStatus(phase, phaseKind, phaseDetail);
      return;
    }
    const secs = Math.ceil(left / 1000);
    const note = pauseReason === "cooldown" ? `лимит Steam ${secs}с` : `бюджет запросов ${secs}с`;
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
    paint();
  }

  const pacing = {
    abort: () => state.abort,
    onWait: (msLeft: number, reason: WaitReason) => {
      pauseUntil = Date.now() + msLeft;
      pauseReason = reason;
      paint();
    },
  };

  function totals(): HistoryTotals {
    return summarizeMarketHistory(state.events, feeConfig());
  }

  function shown(): HistoryEvent[] {
    if (!state.only) return state.events;
    return state.events.filter((event) => event.action === state.only);
  }

  const WORDS: Record<HistoryEvent["action"], string> = {
    sold: "продано",
    bought: "куплено",
    listed: "выставлено",
    cancelled: "снято",
    unknown: "не разобрал",
  };

  function eventRow(event: HistoryEvent): HTMLElement {
    const row = el("div", "stw-row");
    row.dataset.tone = event.action === "sold" ? "go" : event.action === "bought" ? "warn" : "";

    const label = el("div", "stw-name", event.name || "без названия");
    label.title = event.hash || event.name;

    const prices = el("div", "stw-prices");
    const amount = el("span", "stw-tgt", event.price > 0 ? money(event.price) : "—");
    /** Money that did not move is not a price, and must not be coloured like one. */
    if (event.action !== "sold") amount.classList.add("stw-muted");
    prices.append(amount);

    const said = [WORDS[event.action]];
    if (event.actedOn) said.push(event.actedOn);
    if (event.game) said.push(event.game);
    const why = said.join(" · ");
    const whyLine = el("div", "stw-why", why);
    whyLine.title = why;
    const whyRow = el("div", "stw-whyrow");
    whyRow.append(whyLine);

    row.append(label, prices, whyRow);
    return row;
  }

  function renderTop(sums: HistoryTotals): void {
    top.replaceChildren();
    if (!sums.top.length) return;
    /**
     * Five lines, and only when there is something to rank. A «топ товаров» over
     * three sales is a chart of a coincidence.
     */
    if (sums.sold < 5) return;
    top.appendChild(el("div", "stw-hint", "Больше всего принесли"));
    for (const item of sums.top) {
      const line = el("div", "stw-row");
      const prices = el("div", "stw-prices");
      prices.append(el("span", "stw-tgt", money(item.gross)));
      const why = el("div", "stw-whyrow");
      why.append(el("div", "stw-why", `${item.count} шт`));
      line.append(el("div", "stw-name", item.name), prices, why);
      top.appendChild(line);
    }
  }

  function render(): void {
    const sums = totals();
    statNodes.sold!.textContent = String(sums.sold);
    statNodes.gross!.textContent = money(sums.gross);
    statNodes.net!.textContent = money(sums.net);
    statNodes.spent!.textContent = money(sums.spent);

    statButtons.sold!.setAttribute("aria-pressed", String(state.only === "sold"));
    statButtons.spent!.setAttribute("aria-pressed", String(state.only === "bought"));

    renderTop(sums);

    rows.replaceChildren();
    if (!state.events.length) {
      rows.appendChild(
        el("div", "stw-empty", "Нажми «Прочитать историю» — покажу, чем кончились твои лоты.")
      );
      return;
    }
    const list = shown();
    if (!list.length) {
      rows.appendChild(el("div", "stw-empty", "Под фильтр ничего не попало."));
      return;
    }
    /**
     * Two lists live one under the other — what earned the most, and what
     * happened. Without a header on the second they read as one list whose
     * rows inexplicably change what they say halfway down.
     */
    if (sums.top.length && sums.sold >= 5) rows.appendChild(el("div", "stw-hint", "Что происходило"));
    for (const event of list) rows.appendChild(eventRow(event));
  }

  /**
   * Nobody on the other side of anything.
   *
   * A sale and a listing both take the item away; only a sale has a person on
   * the other end, so that person is the whole classification. When not one row
   * out of a hundred names one, «продано 0» is either the truth about a quiet
   * account or a reader looking at the wrong cell — and nothing inside the
   * reader can tell those apart. So it stops asserting and shows its evidence.
   */
  function blind(sums: HistoryTotals): boolean {
    return state.events.length > 0 && sums.sold === 0 && sums.bought === 0;
  }

  /** The sentence the counters cannot say: what the numbers rest on. */
  function summaryDetail(sums: HistoryTotals): string {
    const said = [
      sums.from && sums.to ? `Записи с ${sums.from} по ${sums.to}.` : "",
      `Прочитано ${state.events.length} из ${state.total || state.events.length}.`,
      "«Выручка» — то, что заплатили покупатели, прямо со страницы; «на руки» — она же минус комиссия Steam и издателя по стандартной ставке.",
      sums.unpriced ? `Без цены ${sums.unpriced} — на столько суммы занижены.` : "",
      sums.unknown ? `Строк, которые не разобрал: ${sums.unknown}.` : "",
      sums.listed || sums.cancelled
        ? `Ещё в истории: выставлено ${sums.listed}, снято ${sums.cancelled}.`
        : "",
      blind(sums)
        ? "Продажу от выставления отличает только человек на той стороне — предмет уносят обе. " +
          `Ни в одной из ${state.events.length} записей его не видно, так что либо продаж и правда ` +
          "не было, либо я смотрю не в ту ячейку. Вот что в ней написано: " +
          sums.whoSaid.map((text) => `«${text}»`).join(", ") +
          "."
        : "",
    ];
    return said.filter(Boolean).join(" ");
  }

  function setBusy(busy: boolean): void {
    state.busy = busy;
    readBtn.disabled = busy;
    moreBtn.disabled = busy;
    stopBtn.hidden = !busy;
    moreBtn.hidden = busy || state.events.length === 0 || state.events.length >= state.total;
  }

  async function read(more: boolean): Promise<void> {
    if (state.busy) return;
    state.abort = false;
    setBusy(true);
    status(more ? "Читаю дальше…" : "Читаю историю…", "work");

    const quiet = await allowSteamTraffic();
    if (quiet) {
      status(quiet, "warn");
      setBusy(false);
      return;
    }

    await waitForPage();
    if (!more) state.events = [];

    try {
      const page = await fetchHistoryPage(state.events.length, PAGE, pacing);
      state.total = page.total || state.total;
      /** Steam can repeat a row across pages when something sells mid-walk. */
      const seen = new Set(state.events.map((event) => event.id));
      for (const event of page.events) if (!seen.has(event.id)) state.events.push(event);

      const sums = totals();
      if (!state.events.length) {
        status("В истории пусто", "ok", "Steam ответил, но записей за этот период нет.");
      } else if (blind(sums)) {
        status(
          `Продано 0 — но второй стороны нет ни в одной из ${state.events.length} записей`,
          "warn",
          summaryDetail(sums)
        );
      } else {
        status(
          `Продано ${sums.sold} на ${money(sums.gross)} · на руки ${money(sums.net)}`,
          "ok",
          summaryDetail(sums)
        );
      }
    } catch (err) {
      if (err instanceof SteamError && err.kind === "aborted") status("Остановлено", "warn");
      else status(`История: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
      render();
    }
  }

  readBtn.addEventListener("click", () => void read(false));
  moreBtn.addEventListener("click", () => void read(true));
  stopBtn.addEventListener("click", () => {
    state.abort = true;
    status("Останавливаю…", "warn");
  });

  requestPageInfo();
  status("Одна страница истории — один запрос и сто записей");
  render();
}

register({
  id: "sales",
  title: "Продажи",
  /** The market home page, never an item page — same door as «Мои лоты». */
  matches: (url) =>
    url.pathname.startsWith("/market") && !/\/market\/listings\/\d+\//.test(url.pathname),
  mount,
});
