import { send } from "../../../core/messaging";
import { formatCents } from "../../../core/money";
import { loadSettings, type Settings } from "../../../core/settings";
import type { Cents, ItemKeyed, Listing, RepricePlan } from "../../../core/types";
import { needsConfirmation, removeListing, sellItem } from "../../../steam/actions";
import { fetchCompetitorLow } from "../../../steam/listings";
import { loadMyListings } from "../../../steam/mylistings";
import { sleep, SteamError, type WaitReason } from "../../../steam/net";
import { currencyId, feeConfig, sessionId, waitForPage } from "../../../steam/page-context";
import { fetchMarketLows } from "../../../steam/prices";
import { el, type StatusKind } from "../../ui/panel";
import { register, type FeatureContext } from "../registry";
import {
  buildPlans,
  competitorFromMarketLow,
  groupListings,
  type CompetitorLow,
  type ItemGroup,
} from "./plan";

/** Listing pages opened in parallel when the market minimum turned out to be ours. */
const EXACT_CONCURRENCY = 2;

interface State {
  busy: boolean;
  abort: boolean;
  settings: Settings;
  listings: Listing[];
  groups: Map<string, ItemGroup>;
  /** Everything we have learned so far, kept across a continue. */
  marketLows: Record<string, Cents | null>;
  lows: Map<string, CompetitorLow>;
  /** Items Steam stopped us before pricing. */
  unresolved: ItemKeyed[];
  plans: RepricePlan[];
}

function money(cents: Cents | null | undefined): string {
  return formatCents(cents, currencyId());
}

function planRow(plan: RepricePlan): HTMLElement {
  const row = el("div", "stw-row");
  row.dataset.id = plan.listingId;
  row.dataset.kind = plan.result ?? plan.action;

  const name = el("div", "stw-name", plan.name);
  name.title = plan.hash;

  const prices = el("div", "stw-prices");
  prices.append(
    el("span", "stw-our", money(plan.ourBuyer)),
    el("span", "stw-arrow", "→"),
    plan.action === "reprice"
      ? el("span", "stw-tgt", money(plan.targetBuyer))
      : el("span", "stw-tgt stw-muted", money(plan.competitorBuyer))
  );

  row.append(name, prices, el("div", "stw-why", plan.resultMessage ?? plan.reason));
  return row;
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
  const section = ctx.panel.addSection("reprice", "Репрайс");

  const state: State = {
    busy: false,
    abort: false,
    settings: ctx.settings,
    listings: [],
    groups: new Map(),
    marketLows: {},
    lows: new Map(),
    unresolved: [],
    plans: [],
  };

  const stats = el("div", "stw-stats");
  const statNodes: Record<string, HTMLElement> = {};
  for (const [key, label, tone] of [
    ["total", "лотов", ""],
    ["over", "оверпрайс", "warn"],
    ["skip", "пропуск", ""],
  ] as const) {
    const box = el("div", "stw-stat");
    if (tone) box.dataset.tone = tone;
    const n = el("div", "stw-stat-n", "0");
    box.append(n, el("div", "stw-stat-l", label));
    statNodes[key] = n;
    stats.appendChild(box);
  }

  const actions = el("div", "stw-actions");
  const scanBtn = el("button", "stw-btn stw-btn-primary", "Сканировать");
  scanBtn.type = "button";
  const applyBtn = el("button", "stw-btn stw-btn-go", "Переставить");
  applyBtn.type = "button";
  applyBtn.disabled = true;
  const stopBtn = el("button", "stw-btn", "Стоп");
  stopBtn.type = "button";
  stopBtn.disabled = true;
  actions.append(scanBtn, applyBtn, stopBtn);

  /** Only appears when a run stopped with items left, so it never adds noise. */
  const resumeRow = el("div", "stw-actions stw-resume");
  const resumeBtn = el("button", "stw-btn stw-btn-primary", "Догрузить цены");
  resumeBtn.type = "button";
  resumeRow.appendChild(resumeBtn);
  resumeRow.hidden = true;

  const rows = el("div", "stw-rows");
  section.body.append(stats, actions, resumeRow, rows);

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

  function pendingReprices(): RepricePlan[] {
    return state.plans.filter((p) => p.action === "reprice" && p.result !== "ok");
  }

  function renderStats(): void {
    const over = state.plans.filter((p) => p.action === "reprice").length;
    statNodes.total!.textContent = String(state.listings.length);
    statNodes.over!.textContent = String(over);
    statNodes.skip!.textContent = String(state.plans.length - over);
    const todo = pendingReprices().length;
    applyBtn.textContent = todo ? `Переставить ${todo}` : "Переставить";
    applyBtn.disabled = state.busy || todo === 0;
  }

  function renderRows(): void {
    rows.replaceChildren();
    if (!state.plans.length) {
      rows.appendChild(el("div", "stw-empty", "Нажми «Сканировать» — сверю лоты с минимумом рынка."));
      return;
    }
    for (const plan of state.plans) rows.appendChild(planRow(plan));
  }

  function patchRow(plan: RepricePlan): void {
    const node = rows.querySelector(`.stw-row[data-id="${plan.listingId}"]`);
    node?.replaceWith(planRow(plan));
  }

  function setBusy(busy: boolean): void {
    state.busy = busy;
    scanBtn.disabled = busy;
    resumeBtn.disabled = busy;
    stopBtn.disabled = !busy;
    applyBtn.disabled = busy || pendingReprices().length === 0;
  }

  /** Opens listing pages only for items whose market minimum turned out to be ours. */
  async function resolveExactLows(unsettled: ItemGroup[]): Promise<"blocked" | "aborted" | null> {
    let next = 0;
    let done = 0;
    let stop: "blocked" | "aborted" | null = null;

    async function worker(): Promise<void> {
      for (;;) {
        if (stop) return;
        if (state.abort) {
          stop = "aborted";
          return;
        }
        const group = unsettled[next++];
        if (!group) return;
        try {
          const buyer = await fetchCompetitorLow(group.appid, group.hash, group.ourListingIds, pacing);
          if (buyer != null) state.lows.set(group.key, { buyer, source: "listings" });
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
        }
        done += 1;
        status(`Проверяю конкурентов ${done}/${unsettled.length} · ${group.name}`, "work");
      }
    }

    const size = Math.max(1, Math.min(EXACT_CONCURRENCY, unsettled.length));
    await Promise.all(Array.from({ length: size }, () => worker()));
    return stop;
  }

  /**
   * Prices the given items, folds the answers into what we already knew, and
   * replans. Used by both the initial scan and the continue button.
   */
  async function priceAndPlan(toFetch: ItemKeyed[]): Promise<void> {
    const result = await fetchMarketLows(toFetch, {
      ...pacing,
      concurrency: state.settings.scanConcurrency,
      source: state.settings.priceSource,
      ttlMs: state.settings.priceTtlMinutes * 60_000,
      onProgress: (done, total, label) => status(`Цены ${done}/${total} · ${label}`, "work"),
    });

    Object.assign(state.marketLows, result.lows);
    state.unresolved = result.unresolved;

    for (const group of state.groups.values()) {
      const known = state.lows.get(group.key);
      /** An exact answer from a listing page outranks anything priceoverview said. */
      if (known?.source === "listings") continue;
      state.lows.set(group.key, competitorFromMarketLow(group, state.marketLows[group.key] ?? null));
    }

    let exactStop: "blocked" | "aborted" | null = null;
    if (state.settings.exactCompetitorLow && !result.stopped) {
      const unsettled = [...state.groups.values()].filter(
        (g) => state.lows.get(g.key)?.source === "ours"
      );
      if (unsettled.length) {
        status(`Проверяю конкурентов по ${unsettled.length} предметам…`, "work");
        exactStop = await resolveExactLows(unsettled);
      }
    }

    state.plans = buildPlans(state.groups, state.lows, state.settings, feeConfig());
    renderRows();
    renderStats();

    const stopped = result.stopped ?? exactStop;
    const todo = pendingReprices().length;
    const priced = Object.values(state.marketLows).filter((v) => v != null).length;
    const totalItems = state.groups.size;

    resumeRow.hidden = state.unresolved.length === 0;
    resumeBtn.textContent = `Догрузить цены (${state.unresolved.length})`;

    const cached = result.fromCache ? `, из кэша ${result.fromCache}` : "";
    const spent = `Запросов ${result.requests}${cached}.`;

    if (stopped === "blocked") {
      status(
        `Steam притормозил на ${priced} из ${totalItems} предметов. ` +
          `Что успели — посчитано${todo ? `, оверпрайс: ${todo}` : ""}. ` +
          `Остальное — «Догрузить цены» через минуту. ${spent}`,
        "warn"
      );
      return;
    }
    if (stopped === "aborted") {
      status(`Остановлено на ${priced} из ${totalItems}. ${spent}`, "");
      return;
    }

    status(
      (todo
        ? `${todo} оверпрайс — можно поставить ниже чужого минимума.`
        : "Оверпрайса нет, всё стоит по рынку.") +
        ` Цены есть у ${priced} из ${totalItems}. ${spent}`,
      todo ? "warn" : "ok"
    );
  }

  async function scan(): Promise<void> {
    if (state.busy) return;
    state.abort = false;
    state.listings = [];
    state.groups = new Map();
    state.marketLows = {};
    state.lows = new Map();
    state.unresolved = [];
    state.plans = [];
    resumeRow.hidden = true;
    setBusy(true);
    renderRows();
    renderStats();

    /** A previous run may have tripped the breaker; pressing Scan is the retry. */
    await send("net/unblock", {}).catch(() => undefined);

    state.settings = await loadSettings();
    await waitForPage();

    if (!sessionId()) {
      status("Не вижу sessionid — зайди в Steam в этой вкладке.", "err");
      setBusy(false);
      return;
    }

    try {
      status("Читаю мои лоты…", "work");
      const { listings, meta } = await loadMyListings({
        ...pacing,
        onProgress: (loaded, total) => status(`Лоты: ${loaded} / ${total}`, "work"),
      });
      state.listings = listings;
      renderStats();

      if (!listings.length) {
        status(
          `Лоты не разобрались (Steam total=${meta.total}). Обнови расширение и перезагрузи маркет.`,
          "err"
        );
        setBusy(false);
        return;
      }

      state.groups = groupListings(listings);
      /**
       * With hundreds of unique items a full pass takes many minutes, so the order
       * matters: price the listings holding the most money first. If Steam cuts us
       * off halfway, the half we got is the half worth acting on.
       */
      const uniques: ItemKeyed[] = [...state.groups.values()]
        .map((g) => ({
          key: g.key,
          appid: g.appid,
          hash: g.hash,
          name: g.name,
          worth: Math.max(...g.listings.map((l) => l.ourBuyer), 0),
        }))
        .sort((a, b) => b.worth - a.worth)
        .map(({ worth: _worth, ...item }) => item);

      status(`Лотов ${listings.length}, уникальных ${uniques.length} — качаю минимумы…`, "work");
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
    await send("net/unblock", {}).catch(() => undefined);
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

  async function apply(): Promise<void> {
    if (state.busy) return;
    const todo = pendingReprices();
    if (!todo.length) return;

    const confirmed = window.confirm(
      `Снять ${todo.length} лот(ов) и выставить ниже чужого минимума?\n\n` +
        "После этого продажи надо подтвердить в Steam Guard."
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
      status(`Переставляю ${i + 1}/${todo.length}: ${plan.name}`, "work");

      try {
        if (!plan.assetid) throw new SteamError("http", "нет assetid — нельзя выставить снова");
        await removeListing(plan.listingId, pacing);
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
        plan.result = "fail";
        plan.resultMessage = `ошибка: ${describeError(err)}`;
        failed += 1;
        if (err instanceof SteamError && (err.kind === "rate_limited" || err.kind === "blocked")) {
          await sleep(8000);
        }
      }

      patchRow(plan);
      renderStats();
    }

    const parts = [`Готово: ${ok} ок`];
    if (failed) parts.push(`${failed} ошибок`);
    if (guard) parts.push(`подтверди ${guard} в Steam Guard`);
    if (state.abort) parts.push("остановлено");
    status(parts.join(" · "), failed ? "warn" : "ok");
    setBusy(false);
  }

  scanBtn.addEventListener("click", () => void scan());
  resumeBtn.addEventListener("click", () => void resume());
  applyBtn.addEventListener("click", () => void apply());
  stopBtn.addEventListener("click", () => {
    state.abort = true;
    status("Останавливаю…", "warn");
  });

  status("Открой маркет, будучи в Steam, и нажми «Сканировать».");
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
