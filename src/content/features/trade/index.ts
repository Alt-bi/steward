import { formatCents } from "../../../core/money";
import { loadSettings, type Settings } from "../../../core/settings";
import type { Cents, ItemKeyed } from "../../../core/types";
import { allowSteamTraffic, SteamError, type WaitReason } from "../../../steam/net";
import { currencyId, waitForPage } from "../../../steam/page-context";
import { fetchMarketLows } from "../../../steam/prices";
import {
  currentTrade,
  onTradeSnapshot,
  requestTrade,
  tradeItemKeys,
  type TradeSnapshot,
} from "../../../steam/trade";
import { el, type StatusKind } from "../../ui/panel";
import { describeError } from "../../ui/errors";
import { register, type FeatureContext } from "../registry";
import { analyzeTrade, itemKey, type TradeAnalysis, type TradeWarning } from "./analyze";

/**
 * Reads the offer on screen, prices both sides, and says what is wrong with it.
 *
 * Prices are fetched once per unique item and cached like everywhere else, so
 * dragging items in and out does not re-hit Steam.
 */

interface State {
  busy: boolean;
  abort: boolean;
  settings: Settings;
  snapshot: TradeSnapshot | null;
  lows: Record<string, Cents | null>;
  analysis: TradeAnalysis | null;
}

function money(cents: Cents | null | undefined): string {
  return formatCents(cents, currencyId());
}

async function mount(ctx: FeatureContext): Promise<void> {
  const section = ctx.panel.addSection("trade", "Трейд");

  const state: State = {
    busy: false,
    abort: false,
    settings: ctx.settings,
    snapshot: currentTrade(),
    lows: {},
    analysis: null,
  };

  const stats = el("div", "stw-stats");
  const statNodes: Record<string, HTMLElement> = {};
  for (const [key, label, tone] of [
    ["yours", "отдаёшь", ""],
    ["theirs", "получаешь", ""],
    ["delta", "разница", "warn"],
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

  const actions = el("div", "stw-actions");
  const checkBtn = el("button", "stw-btn stw-btn-primary", "Проверить обмен");
  checkBtn.type = "button";
  const stopBtn = el("button", "stw-btn", "Стоп");
  stopBtn.type = "button";
  stopBtn.disabled = true;
  actions.append(checkBtn, stopBtn);

  const rows = el("div", "stw-rows");
  section.body.append(stats, verdictBox, actions, rows);

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
  }

  const VERDICT_TEXT: Record<TradeAnalysis["verdict"], string> = {
    danger: "Так торговать нельзя",
    warn: "Есть на что посмотреть",
    info: "Замечания",
    ok: "Обмен выглядит чисто",
  };

  function warningRow(warning: TradeWarning): HTMLElement {
    const row = el("div", "stw-row stw-row-warn");
    row.dataset.kind = warning.level;
    row.append(el("div", "stw-name", warning.text));
    return row;
  }

  function itemRow(
    label: string,
    name: string,
    amount: number,
    value: Cents | null,
    flagged: boolean
  ): HTMLElement {
    const row = el("div", "stw-row");
    if (flagged) row.dataset.kind = "danger";
    const title = el("div", "stw-name", amount > 1 ? `${name} ×${amount}` : name);
    const prices = el("div", "stw-prices");
    prices.append(
      value == null
        ? el("span", "stw-tgt stw-muted", "—")
        : el("span", "stw-tgt", money(value))
    );
    row.append(title, prices, el("div", "stw-why", label));
    return row;
  }

  function renderAnalysis(): void {
    const analysis = state.analysis;
    rows.replaceChildren();

    if (!analysis) {
      statNodes.yours!.textContent = "—";
      statNodes.theirs!.textContent = "—";
      statNodes.delta!.textContent = "—";
      verdictBox.hidden = true;
      rows.appendChild(el("div", "stw-empty", "Открой обмен и нажми «Проверить обмен»."));
      return;
    }

    statNodes.yours!.textContent = money(analysis.yours.total);
    statNodes.theirs!.textContent = money(analysis.theirs.total);
    statNodes.delta!.textContent =
      (analysis.delta >= 0 ? "+" : "−") + money(Math.abs(analysis.delta));

    verdictBox.hidden = false;
    verdictBox.dataset.level = analysis.verdict;
    verdictBox.textContent = VERDICT_TEXT[analysis.verdict];

    for (const warning of analysis.warnings) rows.appendChild(warningRow(warning));

    const flagged = new Set(
      analysis.warnings.filter((w) => w.level === "danger" && w.assetid).map((w) => w.assetid!)
    );

    for (const item of analysis.theirs.items) {
      rows.appendChild(
        itemRow(
          "они дают",
          item.name || item.hash || item.assetid,
          item.amount,
          state.lows[itemKey(item)] == null
            ? null
            : state.lows[itemKey(item)]! * Math.max(1, item.amount),
          flagged.has(item.assetid)
        )
      );
    }
    for (const item of analysis.yours.items) {
      rows.appendChild(
        itemRow(
          "ты даёшь",
          item.name || item.hash || item.assetid,
          item.amount,
          state.lows[itemKey(item)] == null
            ? null
            : state.lows[itemKey(item)]! * Math.max(1, item.amount),
          false
        )
      );
    }
  }

  function reanalyze(): void {
    const snapshot = state.snapshot;
    if (!snapshot) {
      state.analysis = null;
      renderAnalysis();
      return;
    }
    state.analysis = analyzeTrade({
      yours: snapshot.yours,
      theirs: snapshot.theirs,
      lows: state.lows,
    });
    renderAnalysis();
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
    requestTrade();
    /** The bridge answers on the next tick; give it a beat before judging. */
    await new Promise((resolve) => setTimeout(resolve, 400));

    const snapshot = state.snapshot ?? currentTrade();
    state.snapshot = snapshot;

    if (!snapshot || !snapshot.present) {
      status("Не вижу обмен на этой странице. Открой страницу обмена и попробуй снова.", "err");
      setBusy(false);
      return;
    }
    if (!snapshot.yours.length && !snapshot.theirs.length) {
      status("В обмене пока ничего нет.", "");
      reanalyze();
      setBusy(false);
      return;
    }

    try {
      const unique = tradeItemKeys(snapshot);
      const items: ItemKeyed[] = [...unique.entries()].map(([key, item]) => ({
        key,
        appid: item.appid,
        hash: item.hash,
        name: item.name || item.hash,
      }));

      if (!items.length) {
        status(
          "Steam ещё не отдал описания предметов. Подожди пару секунд и нажми снова.",
          "warn"
        );
        reanalyze();
        setBusy(false);
        return;
      }

      status(`Считаю ${items.length} позиц. …`, "work");
      const result = await fetchMarketLows(items, {
        ...pacing,
        concurrency: state.settings.scanConcurrency,
        source: state.settings.priceSource,
        ttlMs: state.settings.priceTtlMinutes * 60_000,
        onProgress: (done, total, label) => status(`Цены ${done}/${total} · ${label}`, "work"),
      });

      Object.assign(state.lows, result.lows);
      reanalyze();

      const analysis = state.analysis;
      const dangers = analysis?.warnings.filter((w) => w.level === "danger").length ?? 0;
      const missing = snapshot.undescribed;

      if (dangers) {
        status(`Опасных признаков: ${dangers}. Читай список ниже, не принимай наугад.`, "err");
      } else if (result.stopped === "blocked") {
        status("Steam притормозил, часть цен неизвестна — суммы неполные.", "warn");
      } else if (missing) {
        status(`Описания ${missing} предм. страница ещё не загрузила — суммы неполные.`, "warn");
      } else {
        status("Проверено.", "ok");
      }
    } catch (err) {
      status(`Проверка: ${describeError(err)}`, "err");
    } finally {
      setBusy(false);
    }
  }

  /** Re-price nothing on a drag, but keep the verdict current. */
  onTradeSnapshot((snapshot) => {
    state.snapshot = snapshot;
    if (!state.busy && state.analysis) reanalyze();
  });

  checkBtn.addEventListener("click", () => void check());
  stopBtn.addEventListener("click", () => {
    state.abort = true;
    status("Останавливаю…", "warn");
  });

  requestTrade();
  status("Открой обмен и нажми «Проверить обмен».");
  renderAnalysis();
}

register({
  id: "trade",
  title: "Трейд",
  matches: (url) => url.pathname.startsWith("/tradeoffer"),
  mount,
});
