import { el } from "../../ui/panel";
import { send } from "../../../core/messaging";
import { bridgeCall } from "../../chat-relay";
import { dropsDelta, farmableRows, scanBadges, type BadgeRow } from "../../../steam/badges";
import { isPicked, noneDropped, pickAll, pickNone, togglePick, type Picks } from "../../../core/picks";
import { FARM_MAX, farmTick } from "./engine";
import { register, type FeatureContext } from "../registry";

/**
 * The card factory, living where the drop machine actually is: on /chat,
 * next to the CM socket it drives. The badges page only seeds the queue and
 * points here — one page to keep open, one ledger to watch, exactly like the
 * third-party factories the user came from, minus their cloud.
 *
 * The loop is scan → tick → swap. Steam's badge counters are the only drop
 * ledger that matters, so every decision (evict a finished game, promote the
 * next one) is made from a fresh scan, never from a remembered count. Swaps
 * ride cm-play/swap so the keep-alive never idles between drop-outs.
 */

const FARM_KEY = "stwFarm";
const SCAN_MS = 5 * 60 * 1000; // badge pages are cheap but not free
const HEART_MS = 10 * 1000;
const LEADER_STALE_MS = 45 * 1000;
const LOG_CAP = 40;

interface FarmState {
  queue: number[];
  dropped: number[];
  auto: boolean;
  running: boolean;
  playing: number[];
  names: Record<string, string>;
  log: { at: number; text: string }[];
  leader: string;
  leaderAt: number;
}

const EMPTY: FarmState = {
  queue: [],
  dropped: [],
  auto: true,
  running: false,
  playing: [],
  names: {},
  log: [],
  leader: "",
  leaderAt: 0,
};

const instanceId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());

async function readFarm(): Promise<FarmState> {
  const got = await chrome.storage.local.get(FARM_KEY);
  return { ...EMPTY, ...(got[FARM_KEY] as Partial<FarmState> | undefined) };
}

async function writeFarm(patch: Partial<FarmState>): Promise<FarmState> {
  const next = { ...(await readFarm()), ...patch };
  await chrome.storage.local.set({ [FARM_KEY]: next });
  return next;
}

function pushLog(state: FarmState, text: string): FarmState["log"] {
  return [{ at: Date.now(), text }, ...state.log].slice(0, LOG_CAP);
}

register({
  id: "farm",
  title: "Фабрика",
  defaultEnabled: true,
  matches: (url) => url.pathname.startsWith("/chat"),
  async mount(ctx: FeatureContext) {
    const section = ctx.panel.addSection("farm", "Фабрика карточек");
    const setStatus = section.setStatus;

    const btnStart = el("button", "stw-btn", "Старт");
    const btnStop = el("button", "stw-btn", "Стоп");
    const btnRescan = el("button", "stw-btn", "Сканировать");
    btnRescan.title = "Пройти страницы бейджей: список игр, счётчики и ротация берутся только оттуда";
    const btnClaim = el("button", "stw-btn", "Забрать себе");
    btnClaim.hidden = true;
    const autoBox = el("label", "stw-check");
    const autoInput = el("input");
    autoInput.type = "checkbox";
    autoBox.append(autoInput, document.createTextNode(" фармить все игры с дропами (не только очередь)"));
    const allBtn = el("button", "stw-btn stw-btn-thin", "все");
    allBtn.type = "button";
    const noneBtn = el("button", "stw-btn stw-btn-thin", "снять");
    noneBtn.type = "button";
    const btnQueue = el("button", "stw-btn", "Отмеченные → в фабрику");
    btnQueue.type = "button";
    btnQueue.title = "Заменить очередь отметками из списка ниже — «Старт» не обязателен, если фабрика уже идёт";
    const controls = el("div", "stw-controls");
    controls.append(allBtn, noneBtn, btnQueue);
    const stats = el("div", "stw-stats");
    const statsNodes: Record<string, HTMLElement> = {};
    for (const [key, label] of [
      ["games", "игр с дропами", ""],
      ["drops", "дропадось", ""],
      ["badges", "бейджей прочитано", ""],
    ] as const) {
      const box = el("div", "stw-stat");
      const n = el("div", "stw-stat-n", "—");
      box.append(n, el("div", "stw-stat-l", label));
      statsNodes[key] = n;
      stats.appendChild(box);
    }
    const rowsWrap = el("div", "stw-rows");
    /** The last scan — the checkbox list and «в фабрику» live on it. */
    let scanRows: BadgeRow[] = [];
    const picked: Picks = noneDropped();

    const info = el("div", "stw-farm-info");
    const listWrap = el("div", "stw-farm-list");
    const logWrap = el("div", "stw-farm-log");

    section.body.append(
      el("p", "stw-hint", `Фабрика держит в чате до ${FARM_MAX} игр: выбил все дропы — игра снята, из очереди поставлена следующая. Ориентир — счётчики «осталось дропов» на /my/badges, они пересканируются сами.`),
      stats,
      controls,
      rowsWrap,
      info,
      listWrap,
      autoBox,
      btnStart,
      btnStop,
      btnRescan,
      btnClaim,
      logWrap
    );

    let busy = false;
    let timer: number | null = null;
    let lastCounts = new Map<number, number | null>();

    // The page seeded by «Фабрика» on /badges arrives as #stw-farm — pull the
    // section forward so the first thing the user sees is the machine, and on
    // any later hash-navigation into this tab as well.
    if (location.hash === "#stw-farm") section.show();
    window.addEventListener("hashchange", () => {
      if (location.hash === "#stw-farm") section.show();
    });

    function fmtTime(ms: number): string {
      return new Date(ms).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    }

    function render(state: FarmState, leaderBlocked: boolean): void {
      btnStart.disabled = busy || leaderBlocked || state.running;
      btnStop.disabled = leaderBlocked || !state.running;
      btnRescan.disabled = busy || leaderBlocked;
      autoInput.checked = state.auto;
      btnClaim.hidden = !leaderBlocked;
      setStatus(
        leaderBlocked
          ? "Фабрика уже крутится в другой вкладке чата — закрой её или забери себе"
          : state.running
            ? `Фабрика идёт: в игре ${state.playing.length}, в очереди ${state.queue.length} · скан каждые ${Math.round(SCAN_MS / 60000)} мин`
            : state.playing.length
              ? `Пауза: ${state.playing.length} игр заявлено, ротация стоит`
              : state.queue.length || state.auto
                ? "Фабрика готова — «Старт»"
                : "Очередь пуста: «Сканировать» → отметь игры → «Отмеченные → в фабрику», или включи авто-режим",
        leaderBlocked ? "warn" : state.running ? "work" : ""
      );

      info.textContent = "";
      const playing = el("div");
      playing.textContent = `Сейчас играем (${state.playing.length}): `;
      playing.append(
        ...state.playing.slice(0, 12).map((a) => {
          const chip = el("span", "stw-chip", state.names[String(a)] || String(a));
          return chip;
        }),
        state.playing.length > 12 ? el("span", "stw-muted", ` +${state.playing.length - 12}`) : el("span", "stw-muted", "")
      );
      info.append(playing);

      listWrap.textContent = "";
      for (const a of state.queue.slice(0, 15)) {
        const row = el("div", "stw-farm-row");
        row.append(el("span", "", `${state.names[String(a)] || a}`));
        const drop = el("button", "stw-mini", "×");
        drop.type = "button";
        drop.title = "Убрать из фармы навсегда";
        drop.addEventListener("click", () => void removeGame(a));
        row.append(drop);
        listWrap.append(row);
      }
      if (state.queue.length > 15) listWrap.append(el("div", "stw-muted", `+${state.queue.length - 15} в очереди`));

      logWrap.textContent = "";
      for (const entry of state.log.slice(0, 8)) {
        logWrap.append(el("div", "stw-farm-logline", `${fmtTime(entry.at)} — ${entry.text}`));
      }
    }

    function renderRows(): void {
      rowsWrap.textContent = "";
      for (const row of scanRows) {
        const id = String(row.appid);
        const line = el("div", "stw-row");
        const name = el("label", "stw-name");
        const check = document.createElement("input");
        check.type = "checkbox";
        check.className = "stw-check";
        check.checked = isPicked(id, picked);
        check.addEventListener("change", () => togglePick(id, picked));
        name.append(check, document.createTextNode(` ${row.name}`));
        name.title = `appid ${row.appid}`;
        line.append(name, el("span", "stw-our", `${row.dropsRemaining ?? 0} др.`));
        rowsWrap.appendChild(line);
      }
    }

    async function leaderBlocked(state: FarmState): Promise<boolean> {
      return state.leader !== instanceId && Date.now() - state.leaderAt < LEADER_STALE_MS;
    }

    async function removeGame(appid: number): Promise<void> {
      const state = await readFarm();
      state.queue = state.queue.filter((a) => a !== appid);
      if (!state.dropped.includes(appid)) state.dropped.push(appid);
      await writeFarm({ queue: state.queue, dropped: state.dropped });
      render(state, await leaderBlocked(state));
    }

    async function swapIn(playing: number[]): Promise<void> {
      const r = await bridgeCall("cm-play/swap", { entries: playing.map((appid) => ({ appid, playing: true, secure: false, offline: false })) });
      if (!r.ok) throw new Error(r.note || "чат не принял ротацию");
    }

    async function stopClaim(): Promise<void> {
      await bridgeCall("cm-play/stop", { entries: [] });
    }

    async function tick(manual = false): Promise<void> {
      if (busy) return;
      const state0 = await readFarm();
      // A manual scan is always allowed — it is how the list gets built on a
      // stopped factory. The rotation half below only runs while it is on.
      if (!manual && (!state0.running || (await leaderBlocked(state0)))) return;
      busy = true;
      try {
        const scan = await scanBadges({ maxPages: 20 });
        scanRows = farmableRows(scan).sort((a, b) => (b.dropsRemaining ?? 0) - (a.dropsRemaining ?? 0));
        statsNodes.games!.textContent = String(scanRows.length);
        statsNodes.drops!.textContent = String(scanRows.reduce((n, r) => n + (r.dropsRemaining ?? 0), 0));
        statsNodes.badges!.textContent = String(scan.rows.length);
        renderRows();
        const byAppid = new Map<number, string>();
        const counts = new Map<number, number | null>();
        for (const r of scan.rows) {
          if (r.foil) continue;
          if (!byAppid.has(r.appid)) byAppid.set(r.appid, r.name);
          if (r.dropsRemaining !== null) counts.set(r.appid, r.dropsRemaining);
        }
        const gained = dropsDelta(lastCounts.size ? lastCounts : new Map(counts), scan.rows);
        lastCounts = counts;

        const state = await readFarm();
        if (!state.running) {
          setStatus(
            scanRows.length
              ? `Посчитано: ${scanRows.length} игр должны карточек. Отмечай и «Отмеченные → в фабрику» → «Старт».`
              : "Дропов не осталось — можно крафтить.",
            "ok"
          );
          busy = false;
          return;
        }
        const next = farmTick({
          rows: scan.rows,
          scanComplete: scan.complete,
          prevPlaying: state.playing,
          queued: state.queue,
          dropped: new Set(state.dropped),
          auto: state.auto,
        });

        let log = state.log;
        for (const [appid, n] of gained) {
          const who = scan.rows.find((r) => r.appid === appid)?.name || String(appid);
          log = [{ at: Date.now(), text: `+${n} карта: ${who}` }, ...log].slice(0, LOG_CAP);
        }
        for (const a of next.finishedNow) {
          log = [{ at: Date.now(), text: `выбито всё: ${byAppid.get(a) || a} — снята, ставим следующую` }, ...log].slice(0, LOG_CAP);
        }

        const changed = next.playing.join(",") !== state.playing.join(",");
        if (changed && next.playing.length >= 0) {
          if (next.playing.length === 0 && state.playing.length > 0) await stopClaim();
          else await swapIn(next.playing);
        }

        await writeFarm({
          playing: next.playing,
          queue: next.queue,
          leader: instanceId,
          leaderAt: Date.now(),
          names: { ...state.names, ...Object.fromEntries(byAppid) },
          log,
        });
        const anyOwed = scan.rows.some((r) => !r.foil && (r.dropsRemaining ?? 0) > 0);
        if (next.done && state.playing.length === 0 && scan.complete && !anyOwed) {
          // Closing on this tick must mean Steam itself says nothing is owed.
          // An empty bench from a failed or partial scan is not victory — the
          // loop keeps retrying instead of lying.
          setStatus("Дропов нигде не осталось — фабрика закончила. Жми «Пересчитать» для проверки.", "ok");
          await writeFarm({ running: false });
        }
        const fresh = await readFarm();
        render(fresh, false);
        renderRows();
      } catch (err) {
        const state = await readFarm();
        await writeFarm({
          log: pushLog({ ...state, log: [] }, `сбой цикла: ${(err as Error).message?.slice(0, 80) || err}`),
        });
        setStatus("Цикл фабрики ошибся — см. журнал ниже", "err");
      } finally {
        busy = false;
      }
    }

    function armLoop(): void {
      if (timer !== null) window.clearInterval(timer);
      timer = window.setInterval(() => {
        void tick();
      }, SCAN_MS);
    }

    btnStart.addEventListener("click", () => {
      void (async () => {
        await writeFarm({ running: true, leader: instanceId, leaderAt: Date.now() });
        armLoop();
        void tick();
      })();
    });

    btnStop.addEventListener("click", () => {
      void (async () => {
        await writeFarm({ running: false, playing: [] });
        if (timer !== null) window.clearInterval(timer);
        timer = null;
        try {
          await stopClaim();
        } catch {
          /* the tab may already be gone; the claim dies with the socket */
        }
        render(await readFarm(), false);
      })();
    });

    btnRescan.addEventListener("click", () => {
      void tick(true);
    });

    allBtn.addEventListener("click", () => {
      pickAll(scanRows.map((r) => String(r.appid)), picked);
      renderRows();
    });

    noneBtn.addEventListener("click", () => {
      pickNone(scanRows.map((r) => String(r.appid)), picked);
      renderRows();
    });

    btnQueue.addEventListener("click", () => {
      void (async () => {
        const chosen = scanRows.filter((r) => isPicked(String(r.appid), picked)).map((r) => r.appid);
        if (!chosen.length) {
          setStatus("Отметь игры в списке (или жми «все»)", "warn");
          return;
        }
        const state = await writeFarm({ queue: chosen });
        setStatus(`Очередь: ${chosen.length} игр — ротируем по отметкам`, "ok");
        render(state, await leaderBlocked(state));
      })();
    });

    btnClaim.addEventListener("click", () => {
      void (async () => {
        await writeFarm({ leader: instanceId, leaderAt: Date.now() });
        render(await readFarm(), false);
      })();
    });

    autoInput.addEventListener("change", () => {
      void (async () => {
        const state = await writeFarm({ auto: autoInput.checked });
        render(state, await leaderBlocked(state));
      })();
    });

    // Leader heartbeat — a second farm tab must see this page is alive fast.
    window.setInterval(() => {
      void (async () => {
        const state = await readFarm();
        if (state.running && state.leader === instanceId) await writeFarm({ leaderAt: Date.now() });
      })();
    }, HEART_MS);

    // Re-render on storage writes (e.g. «Фабрика» seeded the queue from
    // /badges while this tab sat open).
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(FARM_KEY in changes)) return;
      void (async () => {
        const state = await readFarm();
        render(state, await leaderBlocked(state));
        if (state.running && state.leader === instanceId && timer === null) armLoop();
        if (state.running && state.leader === instanceId) void tick();
      })();
    });

    // A swap the factory does not own must not idle: if we still claim games
    // but the page reloaded, the socket re-claims on the first tick.
    void (async () => {
      const state = await readFarm();
      lastCounts = new Map();
      if (state.running && state.leader !== instanceId) return;
      if (state.running && state.leader === instanceId) armLoop();
      render(state, await leaderBlocked(state));
    })();
  },
});
