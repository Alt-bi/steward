import { formatCents } from "../../../core/money";
import { loadSettings, type Settings } from "../../../core/settings";
import type { Cents } from "../../../core/types";
import { buyListing } from "../../../steam/actions";
import { fetchCheapestListings, type MarketListing } from "../../../steam/listings";
import { SteamError, type WaitReason } from "../../../steam/net";
import { currencyId, sessionId, waitForPage } from "../../../steam/page-context";
import {
  downsample,
  fetchPriceHistory,
  sparkline,
  summarizeHistory,
  type HistoryPoint,
  type HistoryStats,
} from "../../../steam/pricehistory";
import { el, type StatusKind } from "../../ui/panel";
import { register, type FeatureContext } from "../registry";
import { describeLiquidity, judgePrice, type PriceJudgement } from "./verdict";

/**
 * The single-item page: what it costs now, what it has been going for, and whether
 * that is a good price. Buying is available for exactly one listing — the cheapest
 * — and never without a confirmation carrying the real number.
 */

const CHART_WIDTH = 396;
const CHART_HEIGHT = 64;
const CHART_BUCKETS = 90;

interface State {
  busy: boolean;
  abort: boolean;
  settings: Settings;
  appid: number;
  hash: string;
  listings: MarketListing[];
  history: HistoryPoint[];
  stats: HistoryStats | null;
  judgement: PriceJudgement | null;
}

/** `/market/listings/730/AK-47%20%7C%20Redline%20(Field-Tested)` */
export function parseListingUrl(pathname: string): { appid: number; hash: string } | null {
  const match = /\/market\/listings\/(\d+)\/([^/?#]+)/.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  let hash: string;
  try {
    hash = decodeURIComponent(match[2]);
  } catch {
    hash = match[2];
  }
  return { appid: Number(match[1]), hash };
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
      case "empty":
        return "Steam не отдал историю продаж";
      case "aborted":
        return "остановлено";
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

const BUY_ERRORS: Record<string, string> = {
  over_the_limit: "цена выше лимита быстрой покупки — подними его в настройках, если это осознанно",
  price_does_not_add_up: "цена и комиссия не сходятся с суммой — покупка отменена",
  bad_price: "Steam отдал бессмысленную цену — покупка отменена",
};

async function mount(ctx: FeatureContext): Promise<void> {
  const target = parseListingUrl(location.pathname);
  if (!target) return;

  const section = ctx.panel.addSection("listing", "Предмет");

  const state: State = {
    busy: false,
    abort: false,
    settings: ctx.settings,
    appid: target.appid,
    hash: target.hash,
    listings: [],
    history: [],
    stats: null,
    judgement: null,
  };

  const stats = el("div", "stw-stats");
  const statNodes: Record<string, HTMLElement> = {};
  for (const [key, label, tone] of [
    ["now", "сейчас", "warn"],
    ["avg", "средняя 30д", ""],
    ["low", "минимум 30д", ""],
  ] as const) {
    const box = el("div", "stw-stat");
    if (tone) box.dataset.tone = tone;
    const n = el("div", "stw-stat-n", "—");
    box.append(n, el("div", "stw-stat-l", label));
    statNodes[key] = n;
    stats.appendChild(box);
  }

  const verdictBox = el("div", "stw-verdict");
  verdictBox.hidden = true;

  const chartBox = el("div", "stw-chart");
  chartBox.hidden = true;

  const actions = el("div", "stw-actions");
  const checkBtn = el("button", "stw-btn stw-btn-primary", "Посмотреть цену");
  checkBtn.type = "button";
  const buyBtn = el("button", "stw-btn stw-btn-go", "Купить дешёвый");
  buyBtn.type = "button";
  buyBtn.disabled = true;
  const stopBtn = el("button", "stw-btn", "Стоп");
  stopBtn.type = "button";
  stopBtn.disabled = true;
  actions.append(checkBtn, buyBtn, stopBtn);

  const rows = el("div", "stw-rows");
  section.body.append(stats, verdictBox, chartBox, actions, rows);

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

  function setBusy(busy: boolean): void {
    state.busy = busy;
    checkBtn.disabled = busy;
    stopBtn.disabled = !busy;
    buyBtn.disabled = busy || !cheapest();
  }

  function cheapest(): MarketListing | null {
    return state.listings[0] ?? null;
  }

  const VERDICT_TEXT: Record<PriceJudgement["verdict"], string> = {
    cheap: "Дешевле обычного",
    fair: "Обычная цена",
    expensive: "Дороже обычного",
    unknown: "Судить не по чему",
  };

  const VERDICT_LEVEL: Record<PriceJudgement["verdict"], string> = {
    cheap: "ok",
    fair: "",
    expensive: "warn",
    unknown: "",
  };

  function renderChart(): void {
    if (state.history.length < 2) {
      chartBox.hidden = true;
      return;
    }
    const points = downsample(state.history, CHART_BUCKETS);
    const geometry = sparkline(points, CHART_WIDTH, CHART_HEIGHT, 2);
    if (!geometry) {
      chartBox.hidden = true;
      return;
    }

    /** Built as real SVG nodes rather than innerHTML, to keep the CSP simple. */
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", String(CHART_HEIGHT));
    svg.setAttribute("preserveAspectRatio", "none");

    const area = document.createElementNS(ns, "path");
    area.setAttribute("d", geometry.area);
    area.setAttribute("class", "stw-chart-area");

    const line = document.createElementNS(ns, "path");
    line.setAttribute("d", geometry.line);
    line.setAttribute("class", "stw-chart-line");
    line.setAttribute("fill", "none");

    svg.append(area, line);

    chartBox.replaceChildren();
    chartBox.appendChild(svg);

    const scale = el("div", "stw-chart-scale");
    scale.append(
      el("span", "", money(geometry.max)),
      el("span", "stw-chart-span", `${points.length} точек`),
      el("span", "", money(geometry.min))
    );
    chartBox.appendChild(scale);
    chartBox.hidden = false;
  }

  function renderAll(): void {
    const low = cheapest();
    statNodes.now!.textContent = low ? money(low.buyer) : "—";
    statNodes.avg!.textContent = money(state.stats?.average30d ?? null);
    statNodes.low!.textContent = money(state.stats?.min30d ?? null);

    if (state.judgement) {
      verdictBox.hidden = false;
      verdictBox.dataset.level = VERDICT_LEVEL[state.judgement.verdict];
      verdictBox.textContent = `${VERDICT_TEXT[state.judgement.verdict]} — ${state.judgement.text}`;
    } else {
      verdictBox.hidden = true;
    }

    renderChart();

    rows.replaceChildren();
    if (!state.listings.length) {
      rows.appendChild(el("div", "stw-empty", "Нажми «Посмотреть цену»."));
      return;
    }

    if (state.stats) {
      const liquidity = el("div", "stw-row stw-row-warn");
      liquidity.dataset.kind = "info";
      liquidity.append(el("div", "stw-name", describeLiquidity(state.stats)));
      rows.appendChild(liquidity);
    }

    for (let i = 0; i < Math.min(state.listings.length, 8); i++) {
      const listing = state.listings[i]!;
      const row = el("div", "stw-row");
      if (i === 0) row.dataset.kind = "reprice";
      row.append(
        el("div", "stw-name", i === 0 ? "самый дешёвый лот" : `лот ${i + 1}`),
        (() => {
          const prices = el("div", "stw-prices");
          prices.append(el("span", "stw-tgt", money(listing.buyer)));
          return prices;
        })(),
        el("div", "stw-why", `продавцу ${money(listing.price)}, комиссия ${money(listing.fee)}`)
      );
      rows.appendChild(row);
    }
  }

  async function check(): Promise<void> {
    if (state.busy) return;
    state.abort = false;
    setBusy(true);
    state.settings = await loadSettings();
    await waitForPage();

    try {
      status("Читаю лоты…", "work");
      state.listings = await fetchCheapestListings(state.appid, state.hash, pacing, 10);

      status("Читаю историю продаж…", "work");
      try {
        state.history = await fetchPriceHistory(state.appid, state.hash, pacing);
      } catch (err) {
        /** No history is a smaller problem than no prices; keep what we have. */
        state.history = [];
        if (err instanceof SteamError && err.kind === "aborted") throw err;
      }

      state.stats = summarizeHistory(state.history);
      state.judgement = judgePrice(cheapest()?.buyer ?? null, state.stats);
      renderAll();

      if (!state.listings.length) {
        status("Лотов на продажу нет.", "warn");
      } else if (!state.history.length) {
        status("Цены есть, истории продаж Steam не дал.", "warn");
      } else {
        status(`Готово. Продаж за месяц: ${state.stats.volume30d}.`, "ok");
      }
    } catch (err) {
      status(`Цена: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
  }

  /**
   * One purchase, on an explicit click, with the amount spelled out and checked
   * against the configured ceiling. Nothing here loops or retries.
   */
  async function buy(): Promise<void> {
    if (state.busy) return;
    const listing = cheapest();
    if (!listing) return;

    state.settings = await loadSettings();
    const cap = state.settings.quickBuyMaxCents;

    if (!sessionId()) {
      status("Не вижу sessionid — зайди в Steam в этой вкладке.", "err");
      return;
    }
    if (!(cap > 0)) {
      status("Лимит быстрой покупки равен нулю — покупка выключена.", "warn");
      return;
    }
    if (listing.buyer > cap) {
      status(
        `${money(listing.buyer)} дороже лимита быстрой покупки ${money(cap)}. ` +
          "Подними лимит в настройках, если это осознанно.",
        "warn"
      );
      return;
    }

    const confirmed = window.confirm(
      `Купить «${state.hash}» за ${money(listing.buyer)}?\n\n` +
        `Продавцу ${money(listing.price)}, комиссия ${money(listing.fee)}.\n` +
        `Лимит быстрой покупки: ${money(cap)}.\n\n` +
        "Деньги спишутся с кошелька Steam сразу."
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      status(`Покупаю за ${money(listing.buyer)}…`, "work");
      await buyListing(
        {
          listingId: listing.listingId,
          subtotal: listing.price,
          fee: listing.fee,
          total: listing.buyer,
          currencyId: currencyId(),
        },
        cap,
        pacing
      );
      status(`Куплено за ${money(listing.buyer)}. Обнови страницу, чтобы увидеть в инвентаре.`, "ok");
      state.listings = state.listings.slice(1);
      renderAll();
    } catch (err) {
      const code = err instanceof SteamError ? err.message : "";
      status(`Покупка: ${BUY_ERRORS[code] ?? describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
  }

  checkBtn.addEventListener("click", () => void check());
  buyBtn.addEventListener("click", () => void buy());
  stopBtn.addEventListener("click", () => {
    state.abort = true;
    status("Останавливаю…", "warn");
  });

  status(`${state.hash} — нажми «Посмотреть цену».`);
  renderAll();
}

register({
  id: "listing",
  title: "Предмет",
  matches: (url) => /\/market\/listings\/\d+\//.test(url.pathname),
  mount,
});
