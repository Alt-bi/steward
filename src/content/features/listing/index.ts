import { formatCents } from "../../../core/money";
import { loadSettings, type Settings } from "../../../core/settings";
import type { Cents } from "../../../core/types";
import { buyListing } from "../../../steam/actions";
import { learnGroups } from "../../../steam/grouping";
import {
  fetchCheapestListings,
  listingsFromInfo,
  listingsFromSsr,
  type MarketListing,
} from "../../../steam/listings";
import { focusedItem, isItemOnPage } from "../../../page/ssr";
import { allowSteamTraffic, SteamError, type WaitReason } from "../../../steam/net";
import {
  bucketMinimum,
  currencyId,
  itemPage,
  listingInfo,
  orderBook,
  sessionId,
  waitForPage,
} from "../../../steam/page-context";
import {
  downsample,
  fetchPriceHistory,
  historyFromPage,
  sparkline,
  summarizeHistory,
  type HistoryPoint,
  type HistoryStats,
} from "../../../steam/pricehistory";
import { el, type StatusKind } from "../../ui/panel";
import { describeError } from "../../ui/errors";
import { describeMissingLevel, levelLabel, levelLadder } from "../../../core/levels";
import { register, type FeatureContext } from "../registry";
import {
  describeDemand,
  describeLiquidity,
  describeNoListings,
  judgePrice,
  type PriceJudgement,
} from "./verdict";

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
  /**
   * The market minimum when we know it but hold no listing rows for this item.
   *
   * The rewritten page ships the book for whichever item of the group it opened
   * on, but a minimum for every one of them. Open a different wear and there is
   * nothing to list — yet the price, which is most of what the panel is for, is
   * sitting right there.
   */
  marketLow: Cents | null;
  /**
   * The demand side, when the page shipped it. Steam asks for the focused item
   * only, so this is null on every other item of a group.
   */
  demand: string;
  history: HistoryPoint[];
  stats: HistoryStats | null;
  judgement: PriceJudgement | null;
  /**
   * Whether a read has actually happened. Without it an empty row list reads the
   * same before and after the button, and «press the button» is what the panel
   * said to a user who had just pressed it.
   */
  checked: boolean;
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

const BUY_ERRORS: Record<string, string> = {
  over_the_limit: "цена выше лимита быстрой покупки — подними его в настройках, если это осознанно",
  price_does_not_add_up: "цена и комиссия не сходятся с суммой — покупка отменена",
  bad_price: "Steam отдал бессмысленную цену — покупка отменена",
};

async function mount(ctx: FeatureContext): Promise<void> {
  const target = parseListingUrl(location.pathname);
  if (!target) return;
  /** What stands in the URL, kept apart from `state.hash` once the page names it. */
  const urlName = target.hash;

  const section = ctx.panel.addSection("listing", "Предмет");

  const state: State = {
    busy: false,
    abort: false,
    settings: ctx.settings,
    appid: target.appid,
    hash: target.hash,
    listings: [],
    marketLow: null,
    demand: "",
    history: [],
    stats: null,
    judgement: null,
    checked: false,
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

  /**
   * The ladder: what the item asks now against what it has been selling for.
   *
   * This is the same set of levels the repricer and the inventory can list at, so
   * a user can read a price here and recognise the option there.
   */
  const ladderBox = el("div", "stw-ladder");
  ladderBox.hidden = true;

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
  section.body.append(stats, verdictBox, ladderBox, chartBox, actions, rows);

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

  /**
   * What one costs right now — the one number the whole panel hangs off.
   *
   * The cheapest lot when we hold the rows, and the market minimum when we only
   * know that. Keeping the two apart is how the verdict came to be judged against
   * a price the stat above it was still showing as «—».
   */
  function currentBuyer(): Cents | null {
    return cheapest()?.buyer ?? state.marketLow;
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

  function renderLadder(): void {
    if (!state.stats?.points) {
      ladderBox.hidden = true;
      return;
    }
    const now = currentBuyer();
    ladderBox.replaceChildren();
    for (const value of levelLadder(now, state.stats)) {
      if (value.level === "market") continue;
      const row = el("div", "stw-ladder-row");
      row.append(el("span", "stw-ladder-l", levelLabel(value.level)));
      if (value.buyer == null) {
        row.append(el("span", "stw-ladder-v stw-muted", "—"));
        row.title = describeMissingLevel(value);
      } else {
        row.append(el("span", "stw-ladder-v", money(value.buyer)));
        if (now != null && now > 0) {
          const diff = Math.round((value.buyer / now - 1) * 100);
          /** Against the current ask, because that is the number on the page. */
          const tone = diff > 0 ? "ok" : diff < 0 ? "warn" : "";
          const tag = el("span", "stw-ladder-d", `${diff > 0 ? "+" : ""}${diff}% к текущей`);
          tag.dataset.level = tone;
          row.append(tag);
        }
        row.title = `${value.volume} продаж(и) за период`;
      }
      ladderBox.appendChild(row);
    }
    ladderBox.hidden = false;
  }

  function renderAll(): void {
    const now = currentBuyer();
    statNodes.now!.textContent = now == null ? "—" : money(now);
    statNodes.avg!.textContent = money(state.stats?.average30d ?? null);
    statNodes.low!.textContent = money(state.stats?.min30d ?? null);

    if (state.judgement) {
      verdictBox.hidden = false;
      verdictBox.dataset.level = VERDICT_LEVEL[state.judgement.verdict];
      verdictBox.textContent = `${VERDICT_TEXT[state.judgement.verdict]} — ${state.judgement.text}`;
    } else {
      verdictBox.hidden = true;
    }

    renderLadder();
    renderChart();

    rows.replaceChildren();

    /**
     * These two describe the item, not the lots, so they are drawn whenever we
     * have them. They used to sit behind a `listings.length` guard, and on a
     * grouped page that guard is usually shut: measured on the live Redline
     * page, all twenty rows Steam ships are Battle-Scarred and Well-Worn while
     * the page is focused on Minimal Wear, so the panel had a price, an average,
     * a verdict and a chart — and under them the words «press the button».
     */
    for (const line of [state.demand, state.stats ? describeLiquidity(state.stats) : ""]) {
      if (!line) continue;
      const row = el("div", "stw-row stw-row-warn");
      row.dataset.kind = "info";
      row.append(el("div", "stw-name", line));
      rows.appendChild(row);
    }

    if (!state.listings.length) {
      rows.appendChild(el("div", "stw-empty", describeNoListings(state.checked, state.marketLow)));
      return;
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
    const quiet = await allowSteamTraffic();
    if (quiet) {
      status(quiet, "warn");
      setBusy(false);
      return;
    }
    state.settings = await loadSettings();
    await waitForPage();

    try {
      status("Читаю лоты…", "work");
      const page = itemPage();
      /**
       * Which item of the group we are actually looking at.
       *
       * The URL is not the answer on a grouped page: it stands at a group id,
       * which is nobody's hash name, so the bucket, the book rows and the
       * history all missed and the panel fell back to a request for a book it
       * already had — then read the cheapest row of a mixed group, of whatever
       * wear, as this page's price. The page names its own focus; use it.
       */
      state.hash = focusedItem(page, urlName);
      /**
       * A grouped page carries the internal name every wear of this skin answers
       * to. Learn it for the whole bucket list — the exact scan of the market
       * front page will ask the book by it instead of a name Steam ignores.
       */
      if (page?.itemName && page.buckets.length && !page.buckets.some((b) => b.hash === page.itemName)) {
        learnGroups(
          state.appid,
          new Map(page.buckets.map((b) => [b.hash, page.itemName!]))
        );
      }
      /**
       * Three sources, cheapest first. The rewritten item page carries the whole
       * book with our own lots already flagged; the classic page still has
       * `g_rgListingInfo`; and only if neither is there do we spend a request —
       * which on the rewritten market answers with the page itself, and is
       * reported as such rather than retried.
       */
      const fromSsr = listingsFromSsr(page?.listings, state.hash);
      const fromPage = fromSsr.length ? fromSsr : listingsFromInfo(listingInfo() ?? undefined);
      state.marketLow = bucketMinimum(state.hash);
      /**
       * The request is the last resort, and only when nothing on the page speaks
       * for this item at all. With a bucket minimum in hand it would buy a worse
       * answer than we already have — and on the rewritten market it answers
       * with the page itself anyway.
       */
      state.listings = fromPage.length
        ? fromPage
        : state.marketLow != null
          ? []
          : await fetchCheapestListings(
              state.appid,
              /** The name Steam answers to, which on a grouped page is the group. */
              page?.itemName ?? urlName,
              pacing,
              10,
              state.hash
            );

      /**
       * The page ships a history for every item of the group, so on a rewritten
       * page this costs nothing at all — and `pricehistory` is the endpoint the
       * governor rations hardest, at roughly six calls a minute.
       */
      /** Whether the name we ended up with is one this page calls an item. */
      const resolved = isItemOnPage(page, state.hash);

      const shipped = historyFromPage(page?.histories.find((h) => h.hash === state.hash)?.points);
      if (shipped.length) {
        state.history = shipped;
      } else if (!resolved) {
        /**
         * The only name we have is one this page does not treat as an item — a
         * group id we could not resolve to a wear. `pricehistory` answers for one
         * of those: measured, 894 points for `G1807209A023004`, a series mixing
         * every wear and every StatTrak variant together. It would draw a chart
         * and carry a verdict, both about no item that exists. Better to have no
         * history than a confident one belonging to something else.
         */
        state.history = [];
      } else {
        status("Читаю историю продаж…", "work");
        try {
          state.history = await fetchPriceHistory(state.appid, state.hash, pacing);
        } catch (err) {
          /** No history is a smaller problem than no prices; keep what we have. */
          state.history = [];
          if (err instanceof SteamError && err.kind === "aborted") throw err;
        }
      }

      state.stats = summarizeHistory(state.history);
      state.judgement = judgePrice(currentBuyer(), state.stats);
      /** Free: the page carries it, and only for the item it is focused on. */
      state.demand = resolved ? describeDemand(orderBook(state.hash), money) : "";
      state.checked = true;
      renderAll();

      /**
       * A grouped page is a chooser, not an item: Steam redirects every wear's own
       * URL onto the group and highlights one of them. The panel follows that
       * highlight, and says so — numbers for a wear the user did not name are only
       * honest if they carry the wear's name.
       */
      const scope = state.hash === urlName ? "" : `Из группы взял «${state.hash}». `;

      if (!resolved) {
        /**
         * We are standing on a group and Steam did not say which of its items the
         * page is showing. Every number available here belongs to the group as a
         * whole — a minimum that is some other wear's, a history that averages ten
         * of them — so the honest output is none of them.
         */
        status(
          `Страница стоит на группе «${urlName}», а какой предмет она показывает — Steam ` +
            "не назвал. Цифры по группе смешивают разные предметы, поэтому не считаю их. " +
            "Открой конкретный износ из списка на странице.",
          "warn"
        );
      } else if (!state.listings.length && state.marketLow != null) {
        /**
         * Not «no listings»: Steam named a minimum, it just did not hand us the
         * individual lots for this item of the group. Everything but the buy
         * button works, so say what is missing rather than what is broken.
         */
        status(
          `${scope}Минимум ${money(state.marketLow)}. Отдельные лоты Steam на этой странице ` +
            "не показал — покупка в один клик недоступна.",
          "warn"
        );
      } else if (!state.listings.length) {
        status(`${scope}Лотов на продажу нет.`, "warn");
      } else if (!state.history.length) {
        status(`${scope}Цены есть, истории продаж Steam не дал.`, "warn");
      } else {
        status(`${scope}Готово. Продаж за месяц: ${state.stats.volume30d}.`, "ok");
      }
    } catch (err) {
      status(`Цена: ${describeError(err, { empty: "Steam не отдал историю продаж" })}`, "err");
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

    /**
     * The page now tells us whose each lot is, and the cheapest one is ours
     * whenever we hold the minimum. Steam would refuse the purchase anyway; the
     * point of catching it here is that the confirmation never offers to spend
     * money on something that cannot be bought.
     */
    if (listing.mine) {
      status("Самый дешёвый лот — твой собственный. Покупать нечего.", "warn");
      return;
    }

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

  /** The URL, because until the page is read we do not yet know what it is about. */
  status(`${urlName} — нажми «Посмотреть цену».`);
  renderAll();
}

register({
  id: "listing",
  title: "Предмет",
  matches: (url) => /\/market\/listings\/\d+\//.test(url.pathname),
  mount,
});
