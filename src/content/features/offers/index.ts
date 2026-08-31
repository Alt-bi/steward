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
  type OfferSortKey,
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
  sort: OfferSortKey;
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
    sort: "risk",
  };

  const stats = el("div", "stw-stats");
  const statNodes: Record<string, HTMLElement> = {};
  for (const [key, label, tone] of [
    ["offers", "обменов", ""],
    ["delta", "баланс", ""],
    ["risky", "тревожных", "warn"],
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
  queryInput.placeholder = "поиск по нику, номеру, предмету";
  queryInput.title = "Названия предметов появятся в поиске после «Оценить»";

  const sortSelect = document.createElement("select");
  sortSelect.className = "stw-select";
  for (const [value, label] of [
    ["risk", "сначала тревожные"],
    ["delta", "сначала выгодные"],
    ["size", "больше предметов"],
    ["partner", "по нику"],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sortSelect.appendChild(option);
  }
  filterRow.append(queryInput, sortSelect);

  const openLabel = el("label", "stw-toggle");
  openLabel.title = "Прятать отклонённые, отменённые и истёкшие";
  const openOnly = document.createElement("input");
  openOnly.type = "checkbox";
  openOnly.className = "stw-check";
  openOnly.checked = true;
  openLabel.append(openOnly, document.createTextNode(" только живые"));

  const flaggedLabel = el("label", "stw-toggle");
  flaggedLabel.title = "Только обмены, к которым есть замечания";
  const flaggedOnly = document.createElement("input");
  flaggedOnly.type = "checkbox";
  flaggedOnly.className = "stw-check";
  flaggedLabel.append(flaggedOnly, document.createTextNode(" только с замечаниями"));

  const toggleRow = el("div", "stw-controls stw-toggles");
  toggleRow.append(openLabel, flaggedLabel);

  const shownLine = el("div", "stw-hint", "");

  const actions = el("div", "stw-actions");
  const scanBtn = el("button", "stw-btn stw-btn-primary", "Прочитать обмены");
  scanBtn.type = "button";
  const priceBtn = el("button", "stw-btn", "Оценить");
  priceBtn.type = "button";
  priceBtn.title = "Узнать, что это за предметы, и сколько они стоят на рынке";
  priceBtn.disabled = true;
  const stopBtn = el("button", "stw-btn", "Стоп");
  stopBtn.type = "button";
  stopBtn.disabled = true;
  actions.append(scanBtn, priceBtn, stopBtn);

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

  function currentViews(): OfferView[] {
    return viewOffers(state.offers, state.classes, state.lows, state.filters, state.sort);
  }

  function renderStats(): void {
    const views = currentViews();
    const totals = offerTotals(views);
    statNodes.offers!.textContent = String(totals.offers);
    statNodes.delta!.textContent =
      (totals.delta >= 0 ? "+" : "−") + money(Math.abs(totals.delta));
    statNodes.risky!.textContent = String(totals.risky);

    priceBtn.disabled = state.busy || shownClassRefs(views).length === 0;

    shownLine.textContent = state.offers.length
      ? `Показано ${totals.offers} из ${state.offers.length} · отдаёшь ${totals.gives} предм., ` +
        `получаешь ${totals.gets}`
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
            : "Открой список обменов и нажми «Прочитать обмены» — беру то, что Steam уже нарисовал."
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
          : "Жду, пока Steam дорисует список — потом нажми «Прочитать обмены».",
        ""
      );
      return;
    }
    const guessed = state.offers.filter((offer) => offer.sideSource === "layout").length;
    const totals = offerTotals(currentViews());
    status(
      `Обменов ${state.offers.length}: отдаёшь ${totals.gives} предм., получаешь ${totals.gets}. ` +
        (guessed
          ? `У ${guessed} не удалось понять по аватарам, где чья сторона. `
          : "") +
        "Запросов не потрачено — нажми «Оценить», чтобы узнать цены.",
      guessed ? "warn" : "ok"
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
        status(`Steam остановил оценку — суммы неполные. ${spent}${tail}`, "warn");
        return;
      }
      if (prices.stopped === "aborted") {
        status(`Остановлено. ${spent}${tail}`, "");
        return;
      }
      status(
        (totals.risky
          ? `Тревожных обменов: ${totals.risky}. Читай пометки в строках. `
          : "Ничего опасного не вижу. ") + `${spent}${tail}`,
        totals.risky ? "warn" : "ok"
      );
    } catch (err) {
      status(`Оценка: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
  }

  queryInput.addEventListener("input", () => {
    state.filters.query = queryInput.value;
    renderRows();
    renderStats();
  });

  sortSelect.addEventListener("change", () => {
    state.sort = sortSelect.value as OfferSortKey;
    renderRows();
  });

  openOnly.addEventListener("change", () => {
    state.filters.onlyOpen = openOnly.checked;
    renderRows();
    renderStats();
  });

  flaggedOnly.addEventListener("change", () => {
    state.filters.onlyFlagged = flaggedOnly.checked;
    renderRows();
    renderStats();
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
