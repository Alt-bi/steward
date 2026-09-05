import { formatCents } from "../../../core/money";
import { loadSettings, type Settings } from "../../../core/settings";
import type { Cents } from "../../../core/types";
import { resolveItemClasses, unknownClasses } from "../../../steam/descriptions";
import { allowSteamTraffic, type WaitReason } from "../../../steam/net";
import { currencyId, refreshPage, steamId, waitForPage } from "../../../steam/page-context";
import { fetchMarketLows } from "../../../steam/prices";
import { directionFromUrl, offersOnPage, type TradeOffer } from "../../../steam/tradeoffers";
import { describeError } from "../../ui/errors";
import { el, type StatusKind } from "../../ui/panel";
import { register, type FeatureContext } from "../registry";
import {
  DEFAULT_OFFER_FILTERS,
  offerTotals,
  shownClassRefs,
  shownPriceItems,
  viewOffers,
  type ClassMap,
  type LowMap,
  type OfferFilters,
  type OfferView,
} from "./view";

/**
 * The trade-offer inbox, all of it at once.
 *
 * The per-offer feature answers «is this offer a scam» after you have opened it.
 * Thirty offers is thirty openings, and the one that matters is rarely the first —
 * so this reads the whole list off the page, and on request puts a number on each.
 *
 * It never accepts or declines anything. An offer moves items out of an account
 * for good, the side detection here is a heuristic, and a button that acts on a
 * heuristic in bulk is how a mistake becomes irreversible. Every row is a link to
 * the offer; the decision stays where it belongs.
 */

interface State {
  busy: boolean;
  abort: boolean;
  settings: Settings;
  offers: TradeOffer[];
  scanned: boolean;
  classes: ClassMap;
  lows: LowMap;
  filters: OfferFilters;
}

/** Beyond this many unknown items, the cost is worth saying out loud first. */
const ASK_ABOVE = 40;

function money(cents: Cents | null | undefined): string {
  return formatCents(cents, currencyId());
}

const STATE_TEXT: Record<TradeOffer["state"], string> = {
  active: "",
  hold: "заморозка",
  counter: "встречное предложение",
  closed: "закрыт",
};

function offerRow(view: OfferView): HTMLElement {
  const { offer, value } = view;
  const row = el("div", "stw-row");
  row.dataset.id = offer.offerId;
  row.dataset.kind = view.level === "ok" ? "" : view.level;

  const name = el("div", "stw-name");
  const link = document.createElement("a");
  link.className = "stw-link";
  link.href = `https://steamcommunity.com/tradeoffer/${offer.offerId}/`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = offer.partnerName;
  link.title = `Открыть обмен #${offer.offerId}`;
  name.append(link);
  if (STATE_TEXT[offer.state]) {
    name.append(el("span", "stw-tag", ` · ${STATE_TEXT[offer.state]}`));
  }

  const prices = el("div", "stw-prices");
  prices.append(
    el("span", "stw-our", money(value.give.total)),
    el("span", "stw-arrow", "→"),
    el("span", value.get.priced ? "stw-tgt" : "stw-tgt stw-muted", money(value.get.total))
  );
  prices.title = value.complete
    ? "обе стороны оценены полностью"
    : "часть предметов без цены — суммы неполные";

  const summary = el(
    "div",
    "stw-why",
    `отдаёшь ${value.give.count} предм. · получаешь ${value.get.count} предм. · ` +
      (value.delta >= 0 ? `+${money(value.delta)}` : `−${money(-value.delta)}`) +
      (value.complete ? "" : " (не всё оценено)")
  );

  row.append(name, prices, summary);
  for (const flag of view.flags) {
    const line = el("div", "stw-why stw-flag", flag.text);
    line.dataset.level = flag.level;
    row.appendChild(line);
  }
  return row;
}

async function mount(ctx: FeatureContext): Promise<void> {
  const section = ctx.panel.addSection("offers", "Обмены");

  const state: State = {
    busy: false,
    abort: false,
    settings: ctx.settings,
    offers: [],
    scanned: false,
    classes: {},
    lows: {},
    filters: { ...DEFAULT_OFFER_FILTERS },
  };

  /**
   * The counters, and the two of them that are also the filters.
   *
   * «Только живые» and «только с замечаниями» were two tick-boxes naming the
   * same subsets the numbers above them were already counting. Pressing the
   * number is the filter, so a whole control row is gone and nothing with it.
   */
  const stats = el("div", "stw-stats");
  const statNodes: Record<string, HTMLElement> = {};
  const statButtons: Record<string, HTMLButtonElement> = {};
  for (const [key, label, tone] of [
    ["offers", "обменов", ""],
    ["delta", "баланс", ""],
    ["risky", "тревожных", "warn"],
  ] as const) {
    const box = el("button", "stw-stat") as HTMLButtonElement;
    box.type = "button";
    if (tone) box.dataset.tone = tone;
    if (key === "delta") box.classList.add("stw-stat-money");
    const n = el("div", "stw-stat-n", "0");
    box.append(n, el("div", "stw-stat-l", label));
    statNodes[key] = n;
    statButtons[key] = box;
    stats.appendChild(box);
  }

  statButtons.offers!.title = "Показать всё, включая закрытые обмены";
  statButtons.offers!.addEventListener("click", () => {
    state.filters = { ...state.filters, onlyOpen: !state.filters.onlyOpen, onlyFlagged: false };
    redraw();
  });
  statButtons.risky!.title = "Показать только обмены с пометками";
  statButtons.risky!.addEventListener("click", () => {
    state.filters = { ...state.filters, onlyFlagged: !state.filters.onlyFlagged };
    redraw();
  });
  statButtons.delta!.disabled = true;

  const filterRow = el("div", "stw-controls");
  const queryInput = document.createElement("input");
  queryInput.type = "search";
  queryInput.className = "stw-input";
  queryInput.placeholder = "поиск по нику, номеру, предмету";
  queryInput.title = "Названия предметов появятся в поиске после «Узнать цены»";
  filterRow.appendChild(queryInput);

  const shownLine = el("div", "stw-hint", "");

  /** Reading the page is where every pass starts, so it gets the width. */
  const actions = el("div", "stw-actions stw-actions-main");
  const scanBtn = el("button", "stw-btn stw-btn-primary", "Прочитать обмены");
  scanBtn.type = "button";
  actions.append(scanBtn);

  const actionsRest = el("div", "stw-actions stw-actions-rest");
  const priceBtn = el("button", "stw-btn stw-btn-go", "Узнать цены");
  priceBtn.type = "button";
  priceBtn.title = "Спросить Steam, что это за предметы и сколько они стоят";
  priceBtn.disabled = true;
  const stopBtn = el("button", "stw-btn", "Стоп");
  stopBtn.type = "button";
  stopBtn.disabled = true;
  actionsRest.append(priceBtn, stopBtn);

  const rows = el("div", "stw-rows");
  section.body.append(stats, filterRow, shownLine, actions, actionsRest, rows);

  let phase = "";
  let phaseKind: StatusKind = "";
  /** What qualifies the answer, folded away under «подробнее». */
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

  function currentViews(): OfferView[] {
    /**
     * Risk first, always. The other three orders sorted the same rows by the
     * things the rows already say out loud; this one is the reason the tab
     * exists — what could go wrong is at the top.
     */
    return viewOffers(state.offers, state.classes, state.lows, state.filters, "risk");
  }

  /** Everything on screen is a view of one list, so it is redrawn as one. */
  function redraw(): void {
    renderRows();
    renderStats();
  }

  function renderStats(): void {
    const views = currentViews();
    const totals = offerTotals(views);
    statNodes.offers!.textContent = String(totals.offers);
    statNodes.delta!.textContent =
      (totals.delta >= 0 ? "+" : "−") + money(Math.abs(totals.delta));
    statNodes.risky!.textContent = String(totals.risky);

    priceBtn.disabled = state.busy || shownClassRefs(views).length === 0;

    statButtons.offers!.setAttribute("aria-pressed", String(!state.filters.onlyOpen));
    statButtons.risky!.setAttribute("aria-pressed", String(state.filters.onlyFlagged));

    shownLine.textContent = state.offers.length
      ? `Отдаёшь ${totals.gives} предм., получаешь ${totals.gets}` +
        (totals.offers < state.offers.length ? ` · показано ${totals.offers} из ${state.offers.length}` : "")
      : "";
  }

  function renderRows(): void {
    rows.replaceChildren();
    if (!state.offers.length) {
      rows.appendChild(
        el(
          "div",
          "stw-empty",
          state.scanned
            ? "Обменов на этой странице нет."
            : "Нажми «Прочитать обмены» — беру то, что Steam уже нарисовал."
        )
      );
      return;
    }
    const views = currentViews();
    if (!views.length) {
      rows.appendChild(el("div", "stw-empty", "Под фильтр ничего не попало."));
      return;
    }
    for (const view of views) rows.appendChild(offerRow(view));
  }

  function setBusy(busy: boolean): void {
    state.busy = busy;
    scanBtn.disabled = busy;
    stopBtn.disabled = !busy;
    renderStats();
  }

  /**
   * `asked` separates the button from the read that happens on mount. Finding
   * nothing a beat after the page loaded usually means Steam has not finished
   * drawing, so the panel keeps telling the user which button to press instead of
   * announcing an empty inbox that may not be empty.
   */
  function scan(asked: boolean): void {
    if (state.busy) return;
    const direction = directionFromUrl(ctx.url);
    state.offers = offersOnPage({ direction, steamId: steamId() });
    state.scanned = asked || state.offers.length > 0;
    renderRows();
    renderStats();

    if (!state.offers.length) {
      status(
        asked
          ? "Обменов на странице не видно."
          : "Жду, пока Steam дорисует список",
        ""
      );
      return;
    }
    const guessed = state.offers.filter((offer) => offer.sideSource === "layout").length;
    status(
      `Обменов ${state.offers.length} · цены ещё не спрашивал`,
      guessed ? "warn" : "ok",
      (guessed ? `У ${guessed} не понял по аватарам, где чья сторона. ` : "") +
        "Запросов не потрачено — нажми «Узнать цены»."
    );
  }

  /**
   * Two passes: what the items are, then what they cost.
   *
   * The first is the expensive one, and the only one in the extension that asks
   * Steam about something the page did not say — the offers list draws items as
   * pictures. Answers are kept forever, so a second inbox costs almost nothing.
   */
  async function priceShown(): Promise<void> {
    if (state.busy) return;
    const refs = shownClassRefs(currentViews());
    if (!refs.length) return;

    const unknown = await unknownClasses(refs);
    if (unknown.length > ASK_ABOVE) {
      const minutes = Math.max(1, Math.ceil(unknown.length / 20));
      const go = window.confirm(
        `Незнакомых предметов: ${unknown.length}. Про каждый надо спросить Steam один раз — ` +
          `это ${unknown.length} запросов, примерно ${minutes} мин.\n\n` +
          "Ответы сохраняются навсегда, второй раз про них спрашивать не придётся. Продолжить?"
      );
      if (!go) return;
    }

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
      status(`Смотрю, что это за предметы: 0/${refs.length}`, "work");
      const found = await resolveItemClasses(refs, {
        ...pacing,
        concurrency: state.settings.scanConcurrency,
        onProgress: (done, total) => status(`Предметы ${done}/${total}`, "work"),
      });
      Object.assign(state.classes, found.classes);
      renderRows();
      renderStats();

      if (found.stopped === "aborted") {
        status(`Остановлено: узнали ${found.fromCache + found.requests} из ${refs.length}.`, "");
        setBusy(false);
        return;
      }

      const items = shownPriceItems(currentViews(), state.classes);
      if (!items.length) {
        status("Steam не назвал ни одного предмета — оценивать нечего.", "warn");
        setBusy(false);
        return;
      }

      const prices = await fetchMarketLows(items, {
        ...pacing,
        concurrency: state.settings.scanConcurrency,
        source: state.settings.priceSource,
        ttlMs: state.settings.priceTtlMinutes * 60_000,
        onProgress: (done, total, label) => status(`Цены ${done}/${total} · ${label}`, "work"),
      });
      Object.assign(state.lows, prices.lows);
      renderRows();
      renderStats();

      const totals = offerTotals(currentViews());
      const spent = `Запросов: ${found.requests} на предметы, ${prices.requests} на цены.`;
      const unresolved = found.unresolved.length;
      const tail = unresolved ? ` Про ${unresolved} предм. Steam не ответил.` : "";

      if (found.stopped === "blocked" || prices.stopped === "blocked") {
        status("Steam остановил оценку — суммы неполные", "warn", `${spent}${tail}`);
        return;
      }
      if (prices.stopped === "aborted") {
        status("Остановлено", "", `${spent}${tail}`);
        return;
      }
      status(
        totals.risky
          ? `Тревожных обменов ${totals.risky} — читай пометки в строках`
          : "Ничего опасного не вижу",
        totals.risky ? "warn" : "ok",
        `${spent}${tail}`
      );
    } catch (err) {
      status(`Оценка: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
  }

  queryInput.addEventListener("input", () => {
    state.filters = { ...state.filters, query: queryInput.value };
    redraw();
  });

  scanBtn.addEventListener("click", () => scan(true));
  priceBtn.addEventListener("click", () => void priceShown());
  stopBtn.addEventListener("click", () => {
    state.abort = true;
    status("Останавливаю…", "warn");
  });

  /** The page has to have painted before there is anything to read. */
  await waitForPage();
  await refreshPage();
  scan(false);
}

register({
  id: "offers",
  title: "Обмены",
  /** The inbox lives under a profile: `/id/name/tradeoffers/`, sent or received. */
  matches: (url) => /\/tradeoffers(\/|$)/.test(url.pathname),
  mount,
});
