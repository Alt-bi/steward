import { el, type StatusKind } from "../../ui/panel";
import { bridgeCall } from "../../chat-relay";
import { dropsDelta, farmableRows, scanBadges, type BadgeRow } from "../../../steam/badges";
import { FARM_MAX, claimChanged, farmTick } from "./engine";
import { register, type FeatureContext } from "../registry";
import { clearKept, isOrphaned, keptInterval } from "../../ui/orphan";

/**
 * The card factory, living where the drop machine actually is: on /chat,
 * next to the CM socket it drives. The badges page only points here — one page
 * to keep open, one ledger to watch, exactly like the third-party factories
 * the user came from, minus their cloud.
 *
 * One rule, no modes: everything Steam says still owes cards is farmed, bench
 * first, 32 at a time. The queue, the checkbox list, the auto toggle and the
 * forever-ban «×» are gone — each was a way to end up with a running factory
 * that had silently excluded every game it could farm, which is exactly what
 * happened to the user twice.
 *
 * The loop is scan → tick → swap. Steam's badge counters are the only drop
 * ledger that matters, so every decision is made from a fresh scan, never from
 * a remembered count. Swaps ride cm-play/swap so the keep-alive never idles.
 */

const FARM_KEY = "stwFarm";
const SCAN_MS = 5 * 60 * 1000; // badge pages are cheap but not free
const HEART_MS = 10 * 1000;
// A lease is dead after two missed heartbeats plus slack. The watchdog below
// re-checks every WATCHDOG_MS, so a dead tab (update, Edge sleep, close)
// frees the farm on its own — nobody has to chase ghosts across tabs.
const LEADER_STALE_MS = 30 * 1000;
const WATCHDOG_MS = 5 * 1000;
const LOG_CAP = 40;

/** The chat socket's own account of what it claims — never storage's guess. */
interface ChatClaim {
  /** False when the bridge did not answer at all; then nothing is known. */
  known: boolean;
  appids: number[];
  note: string;
  ok: boolean;
}

interface FarmState {
  running: boolean;
  playing: number[];
  names: Record<string, string>;
  log: { at: number; text: string }[];
  leader: string;
  leaderAt: number;
  /** Why the last rotation tick failed — the status line must show it. */
  lastErr?: string;
  lastErrAt?: number;
}

const EMPTY: FarmState = {
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
  // Old builds also stored `queue`, `dropped` and `auto` here. Nothing reads
  // them any more, so the user's forever-banned games come back on their own —
  // which is the whole point of deleting the ban list.
  const saved = got[FARM_KEY] as Partial<FarmState> | undefined;
  return {
    ...EMPTY,
    ...saved,
    playing: Array.isArray(saved?.playing) ? saved.playing : [],
    log: Array.isArray(saved?.log) ? saved.log : [],
    names: saved?.names ?? {},
  };
}

async function writeFarm(patch: Partial<FarmState>): Promise<FarmState> {
  const next = { ...(await readFarm()), ...patch };
  await chrome.storage.local.set({ [FARM_KEY]: next });
  return next;
}

function pushLog(state: FarmState, text: string): FarmState["log"] {
  return [{ at: Date.now(), text }, ...state.log].slice(0, LOG_CAP);
}

/** Most-owed first: the games that pay off soonest go on the bench first. */
function byDropsDesc(a: BadgeRow, b: BadgeRow): number {
  return (b.dropsRemaining ?? 0) - (a.dropsRemaining ?? 0);
}

register({
  id: "farm",
  title: "Фабрика",
  defaultEnabled: true,
  matches: (url) => url.pathname.startsWith("/chat"),
  async mount(ctx: FeatureContext) {
    const section = ctx.panel.addSection("farm", "Фабрика карточек");
    const setStatus = section.setStatus;

    const btnStart = el("button", "stw-btn stw-btn-go", "Старт");
    btnStart.type = "button";
    btnStart.title = "Фармить все игры, за которые Steam ещё должен карточки";
    const btnStop = el("button", "stw-btn stw-btn-danger", "Стоп");
    btnStop.type = "button";
    btnStop.title = "Снять заявку. Закрытая вкладка чата делает то же самое — так устроен Steam.";
    const btnRescan = el("button", "stw-btn stw-btn-thin", "Пересчитать");
    btnRescan.type = "button";
    btnRescan.title = "Пройти страницы бейджей заново: счётчики и состав фарма берутся только оттуда";
    const btnClaim = el("button", "stw-btn stw-btn-thin", "Забрать себе");
    btnClaim.type = "button";
    btnClaim.hidden = true;

    /** Starting is the one thing this tab is for, so it gets the width. */
    const controls = el("div", "stw-actions stw-actions-main");
    controls.append(btnStart);
    const controlsRest = el("div", "stw-actions stw-actions-rest");
    controlsRest.append(btnStop, btnRescan, btnClaim);

    const stats = el("div", "stw-stats");
    const statsNodes: Record<string, HTMLElement> = {};
    const statBoxes: Record<string, HTMLElement> = {};
    for (const [key, label] of [
      ["playing", "в игре"],
      ["games", "ждут очереди"],
      ["drops", "дропов осталось"],
    ] as const) {
      const box = el("div", "stw-stat");
      const n = el("div", "stw-stat-n", "—");
      box.append(n, el("div", "stw-stat-l", label));
      statsNodes[key] = n;
      statBoxes[key] = box;
      stats.appendChild(box);
    }

    /**
     * The scan bar. A badge walk is paced to a few pages a minute, so without
     * it the panel sits mute for a minute or two after «Старт» — the user read
     * that as a freeze, and they were right to: nothing on screen moved.
     */
    const prog = el("div", "stw-prog");
    const progText = el("div", "stw-prog-text", "");
    const progTrack = el("div", "stw-prog-track");
    const progFill = el("div", "stw-prog-fill");
    progTrack.appendChild(progFill);
    prog.append(progText, progTrack);
    prog.hidden = true;

    const wire = el("div", "stw-farm-wire");
    const rowsWrap = el("div", "stw-rows stw-farm-rows");
    const logWrap = el("div", "stw-farm-log");

    section.body.append(
      stats,
      el(
        "div",
        "stw-hint",
        `До ${FARM_MAX} игр разом, выбитые сменяются следующими. Вкладку чата держи открытой: заявка живёт в ней.`
      ),
      controls,
      controlsRest,
      prog,
      wire,
      rowsWrap,
      logWrap
    );

    let busy = false;
    let timer: number | null = null;
    let lastCounts = new Map<number, number | null>();
    /** The last scan — the list below is drawn from it. */
    let scanRows: BadgeRow[] = [];
    /**
     * Has a scan finished in this tab yet? Until it has, an empty bench is a
     * factory warming up, not a broken one — telling those two apart is the
     * difference between «запускаюсь» and a red alarm the user cannot act on.
     */
    let scanned = false;
    /** Live badge-walk position, or null when no walk is in flight. */
    let scanning: { page: number; rows: number; total: number | null } | null = null;
    /** Last answer from the chat socket — rendered, so "not working" is visible. */
    let chat: ChatClaim = { known: false, appids: [], note: "ещё не спрашивали", ok: false };
    /** Owed but no free slot; a count only, since the bench holds 32. */
    let waiting = 0;

    // The page seeded by «Открыть фабрику» on /badges arrives as #stw-farm —
    // pull the section forward, now and on any later hash-navigation.
    if (location.hash === "#stw-farm") section.show();
    window.addEventListener("hashchange", () => {
      if (location.hash === "#stw-farm") section.show();
    });

    function fmtTime(ms: number): string {
      return new Date(ms).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    }

    /** The status line for whatever the factory is doing right now. */
    function statusFor(
      state: FarmState,
      leaderBlocked: boolean
    ): [string, StatusKind, string?] {
      if (leaderBlocked) {
        return [
          "Фабрику ведёт другая вкладка чата",
          "warn",
          "Живая вкладка заявляет о себе каждые 10 секунд, мёртвая освобождает фабрику примерно за 30. Нужно прямо сейчас — «Забрать себе».",
        ];
      }
      if (state.running) {
        if (state.playing.length) {
          return [
            `Фабрика идёт: в игре ${state.playing.length}` +
              (waiting ? `, ждут очереди ${waiting}` : "") +
              ` · пересчёт каждые ${Math.round(SCAN_MS / 60000)} мин`,
            "work",
          ];
        }
        // Nothing on the wire yet. Before the first scan lands that is simply
        // the warm-up — Steam's badge pages are rate-paced and take up to a
        // couple of minutes. Only claim something is wrong once we have looked.
        if (!scanned) return ["Запускаюсь: читаю бейджи и ставлю первые игры…", "work"];
        if (state.lastErr) return [`Крутится, но чат не поставил ни одной игры: ${state.lastErr}`, "err"];
        return ["Крутится, но чат не поставил ни одной игры", "err"];
      }
      if (state.playing.length) return [`Пауза: ${state.playing.length} игр заявлено, ротация стоит`, ""];
      if (scanRows.length) return [`Готово к старту: ${scanRows.length} игр ещё должны карточек`, ""];
      return ["Жми «Старт» — фабрика сама всё посчитает и займётся дропами", ""];
    }

    function render(state: FarmState, leaderBlocked: boolean): void {
      btnStart.disabled = busy || leaderBlocked || state.running;
      // Stop works from any tab — a ghost lease must never lock the off switch.
      btnStop.disabled = !state.running;
      btnRescan.disabled = busy || leaderBlocked;
      btnClaim.hidden = !leaderBlocked;

      const [text, kind, detail] = statusFor(state, leaderBlocked);
      setStatus(text, kind, detail);

      statsNodes.playing!.textContent = String(state.playing.length);
      statBoxes.playing!.dataset.tone = state.playing.length ? "go" : "";
      statsNodes.games!.textContent = String(waiting);
      statsNodes.drops!.textContent = scanned
        ? String(scanRows.reduce((n, r) => n + (r.dropsRemaining ?? 0), 0))
        : "—";

      // The wire, spelled out. Every «не работает» report so far was the page
      // believing storage while the socket carried nothing.
      wire.textContent = `Чат: ${chat.note}`;
      wire.dataset.kind = chat.known && chat.ok ? "ok" : "warn";

      logWrap.textContent = "";
      for (const entry of state.log.slice(0, 6)) {
        logWrap.append(el("div", "stw-farm-logline", `${fmtTime(entry.at)} — ${entry.text}`));
      }
    }

    /**
     * Repaint the parts a scan moves, and nothing else.
     *
     * Deliberately never touches `disabled`: this runs while `busy` is set, and
     * a full `render()` from inside a tick is what left «Старт» frozen after
     * every scan in 2.32.0.
     */
    function paintScan(): void {
      prog.hidden = scanning === null;
      if (!scanning) return;
      const { page, rows, total } = scanning;
      // Steam only names the total after page 1; until then the page number is
      // the only honest progress there is, so the bar creeps instead of lying.
      const pct = total && total > 0 ? Math.min(100, Math.round((rows / total) * 100)) : Math.min(90, page * 15);
      progFill.style.width = `${pct}%`;
      progText.textContent = total
        ? `Бейджи: ${rows} из ${total} · страница ${page}`
        : `Бейджи: страница ${page}…`;
      setStatus(
        total ? `Считаю бейджи: ${rows} из ${total}` : "Считаю бейджи: страница 1…",
        "work"
      );
    }

    /** The one list: every game that still owes cards, the claimed ones first. */
    function renderRows(playing: readonly number[]): void {
      const onBench = new Set(playing);
      const order = [
        ...playing.map((appid) => scanRows.find((r) => r.appid === appid)).filter((r): r is BadgeRow => !!r),
        ...scanRows.filter((r) => !onBench.has(r.appid)),
      ];
      rowsWrap.textContent = "";
      if (!order.length) {
        rowsWrap.append(
          el("div", "stw-empty", scanned ? "Дропов не осталось нигде" : "Список появится после пересчёта")
        );
        return;
      }
      for (const [i, row] of order.entries()) {
        const line = el("div", "stw-farm-row");
        const playingNow = onBench.has(row.appid);
        if (playingNow) line.classList.add("stw-farm-row-play");
        line.append(el("span", "stw-farm-idx", String(i + 1)), el("span", "stw-farm-name", row.name));
        if (row.cardsTotal) {
          line.append(el("span", "stw-farm-cards", `${row.cardsCollected ?? 0}/${row.cardsTotal}`));
        }
        line.append(el("span", "stw-farm-drops", `${row.dropsRemaining ?? 0} др.`));
        if (playingNow) line.append(el("span", "stw-farm-tag", "в игре"));
        line.title = `appid ${row.appid}`;
        rowsWrap.appendChild(line);
      }
    }

    async function leaderBlocked(state: FarmState): Promise<boolean> {
      return state.leader !== instanceId && Date.now() - state.leaderAt < LEADER_STALE_MS;
    }

    async function swapIn(playing: number[]): Promise<void> {
      const r = await bridgeCall("cm-play/swap", {
        entries: playing.map((appid) => ({ appid, playing: true, secure: false, offline: false })),
      });
      if (!r.ok) throw new Error(r.note || "чат не принял ротацию");
      chat = { known: true, appids: [...playing], note: `сокет жив, заявлено ${playing.length}`, ok: true };
    }

    async function stopClaim(): Promise<void> {
      await bridgeCall("cm-play/stop", { entries: [] });
      chat = { known: true, appids: [], note: "заявка снята", ok: true };
    }

    /**
     * What the chat socket is actually claiming, asked of the socket itself.
     *
     * Storage holds the factory's *intent*; only the bridge knows the *fact*,
     * and the two part ways every time this page reloads — an F5, an Edge
     * sleep, or the extension update that reloads every Steam tab by design.
     * Comparing the new bench against the stored one found them equal and
     * skipped the swap: nothing reached the socket while the status happily
     * reported «идёт: в игре 8». Ask the wire.
     */
    async function liveClaim(): Promise<ChatClaim> {
      const r = await bridgeCall("cm-play/state", {});
      if (!r.ok || !Array.isArray(r.appids)) {
        return { known: false, appids: [], note: r.note || "чат не ответил", ok: false };
      }
      return { known: true, appids: r.appids, note: r.note || "", ok: true };
    }

    /**
     * Put the first games on the wire from page one alone.
     *
     * The full walk is gated to a few badge pages a minute — a minute or two on
     * a normal library. Waiting for it meant «Старт» was followed by that long
     * a stretch of a factory that was switched on and farming nothing, which is
     * exactly what the user saw. One page costs one request and carries the
     * most-owed games already, so the bench fills within seconds and the full
     * scan below corrects it.
     *
     * It only runs when the bench is empty, so a working factory never pays for
     * the extra page.
     */
    async function primeBench(): Promise<void> {
      const state = await readFarm();
      if (!state.running || state.playing.length) return;
      const first = await scanBadges({
        maxPages: 1,
        onProgress: (p) => {
          scanning = { page: p.page, rows: p.rows, total: p.total };
          paintScan();
        },
      });
      const rows = farmableRows(first).sort(byDropsDesc);
      if (!rows.length) return;
      const bench = rows.slice(0, FARM_MAX).map((r) => r.appid);
      await swapIn(bench);
      if (!scanRows.length) scanRows = rows;
      await writeFarm({
        playing: bench,
        leader: instanceId,
        leaderAt: Date.now(),
        names: Object.fromEntries(rows.map((r) => [r.appid, r.name])),
      });
      renderRows(bench);
      statsNodes.playing!.textContent = String(bench.length);
      statBoxes.playing!.dataset.tone = "go";
    }

    /**
     * The scan-and-rotate half of a tick. Returns the one status line that has
     * to survive the redraw below (finished / failed), or null for the normal
     * case where `render` already words it.
     *
     * It deliberately does NOT draw the controls: every early return here used
     * to redraw the panel while `busy` was still set, and `render` disables
     * «Старт» and «Пересчитать» while busy. `busy` cleared a moment later in
     * `finally`, but nothing redrew — so a finished scan left both buttons dead
     * until some unrelated event happened to repaint. That is the «кнопка старт
     * недоступна» the user hit.
     */
    async function runTick(): Promise<[string, StatusKind] | null> {
      // Best effort: a factory that cannot prime still gets the full scan
      // below, and the bridge's own error surfaces there.
      await primeBench().catch(() => undefined);

      const scan = await scanBadges({
        maxPages: 20,
        onProgress: (p) => {
          scanning = { page: p.page, rows: p.rows, total: p.total };
          paintScan();
        },
      });
      scanning = null;
      prog.hidden = true;
      // Zero rows AND an incomplete walk means the badge page did not read at
      // all — moved markup, a login wall, a sorry-page that slipped the net
      // checks. Say so and touch nothing: the running claim keeps its games
      // through the keep-alive while we retry, instead of the scan's silence
      // being read as «всё выбито».
      if (!scan.rows.length && !scan.complete) {
        throw new Error("страница бейджей не прочиталась — открой /my/badges и проверь, что она грузится");
      }
      scanRows = farmableRows(scan).sort(byDropsDesc);
      scanned = true;

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
        waiting = 0;
        return null;
      }

      const next = farmTick({
        rows: scan.rows,
        scanComplete: scan.complete,
        prevPlaying: state.playing,
      });
      waiting = next.waiting.length;

      let log = state.log;
      for (const [appid, n] of gained) {
        log = [{ at: Date.now(), text: `+${n} карта: ${byAppid.get(appid) || appid}` }, ...log].slice(0, LOG_CAP);
      }
      for (const a of next.finishedNow) {
        log = [{ at: Date.now(), text: `выбито всё: ${byAppid.get(a) || a} — ставим следующую` }, ...log].slice(0, LOG_CAP);
      }

      // The socket is the only thing that knows what Steam was told. A bench
      // that matches storage but not the wire is the silent-death case.
      chat = await liveClaim();
      const claimed = chat.known ? chat.appids : null;
      if (claimChanged(next.playing, claimed)) {
        if (next.playing.length === 0) {
          if (claimed === null || claimed.length) await stopClaim();
        } else {
          // Throws with the bridge's own note when the chat cannot carry it —
          // the caller writes that into lastErr and the status line.
          await swapIn(next.playing);
        }
      }

      await writeFarm({
        playing: next.playing,
        leader: instanceId,
        leaderAt: Date.now(),
        lastErr: "",
        lastErrAt: 0,
        names: { ...state.names, ...Object.fromEntries(byAppid) },
        log,
      });

      const anyOwed = scan.rows.some((r) => !r.foil && (r.dropsRemaining ?? 0) > 0);
      if (next.done && scan.complete && !anyOwed) {
        // Closing on this tick must mean Steam itself says nothing is owed.
        // An empty bench from a failed or partial scan is not victory — the
        // loop keeps retrying instead of lying.
        await writeFarm({ running: false });
        return ["Дропов нигде не осталось — фабрика закончила. Можно крафтить значки.", "ok"];
      }
      return null;
    }

    async function tick(manual = false): Promise<void> {
      if (busy || isOrphaned()) return;
      const state0 = await readFarm();
      // A manual scan is always allowed — it is how the list gets built on a
      // stopped factory. The rotation half below only runs while it is on.
      if (!manual && (!state0.running || (await leaderBlocked(state0)))) return;
      busy = true;
      let note: [string, StatusKind] | null = null;
      try {
        note = await runTick();
      } catch (err) {
        const why = String((err as Error).message || err);
        const state = await readFarm();
        await writeFarm({
          lastErr: why.slice(0, 160),
          lastErrAt: Date.now(),
          log: pushLog({ ...state, log: [] }, `сбой цикла: ${why.slice(0, 90)}`),
        });
        note = [`Цикл ошибся: ${why.slice(0, 110)}`, "err"];
      } finally {
        busy = false;
        scanning = null;
        prog.hidden = true;
      }
      // One redraw, and only after `busy` is down — otherwise the tick freezes
      // the very buttons it just finished using.
      const fresh = await readFarm();
      renderRows(fresh.playing);
      render(fresh, await leaderBlocked(fresh));
      if (note) setStatus(note[0], note[1]);
    }

    function armLoop(): void {
      clearKept(timer);
      // keptInterval, not setInterval: an extension update severs chrome.* under
      // a running tab, and a scan loop that keeps firing into a dead bridge just
      // prints «Extension context invalidated» until the tab is closed.
      timer = keptInterval(() => {
        void tick().catch(() => undefined);
      }, SCAN_MS);
    }

    /** Take the lease (with a log line) and run — used by watchdog and «Забрать себе». */
    async function adoptAndRun(state: FarmState, why: string): Promise<void> {
      await writeFarm({ leader: instanceId, leaderAt: Date.now(), log: pushLog(state, why) });
      armLoop();
      render(await readFarm(), false);
      void tick();
    }

    /**
     * Should this tab own the lease right now? Running, and either we lead or
     * the previous leader stopped heartbeating (closed tab, F5, an extension
     * update, Edge sleep — a live tab claims itself every 10 s).
     */
    async function adoptIfOurs(): Promise<boolean> {
      if (isOrphaned()) return false;
      const state = await readFarm();
      if (!state.running) return false;
      if (state.leader === instanceId) {
        if (timer === null) armLoop();
        render(state, false);
        return true;
      }
      if (Date.now() - state.leaderAt < LEADER_STALE_MS) return false;
      // Two follower tabs can spot a dead lease on the same watchdog tick —
      // re-read first so only the one that still sees it stale adopts.
      if ((await readFarm()).leaderAt === state.leaderAt) {
        await adoptAndRun(state, "подхватили фабрику — прежняя вкладка пропала");
      }
      return true;
    }

    /**
     * Put the bench back on the wire after this page was reloaded.
     *
     * A reload wipes the bridge's claim but not storage, and the rotation loop
     * only wakes every 5 minutes — behind a 30 s lease wait and a 20-page badge
     * scan. That gap is minutes of a factory that says «идёт» and farms
     * nothing. This re-claims within seconds and retries while the chat client
     * finishes logging in (its socket does not exist at document_idle yet).
     */
    async function resumeClaim(): Promise<void> {
      for (let attempt = 0; attempt < 20; attempt++) {
        if (isOrphaned()) return;
        const state = await readFarm();
        if (!state.running || state.playing.length === 0) return;
        if (!(await leaderBlocked(state))) {
          chat = await liveClaim();
          if (chat.known && chat.ok) {
            if (!claimChanged(state.playing, chat.appids)) {
              render(state, false);
              return; // already on the wire — a reload that landed on its feet
            }
            try {
              await swapIn(state.playing);
              await writeFarm({
                log: pushLog(state, `заявка восстановлена после перезагрузки: ${state.playing.length} игр`),
              });
              render(await readFarm(), false);
              return;
            } catch {
              /* the socket is not ready yet — the retry below is the cure */
            }
          }
          render(state, false);
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    btnStart.addEventListener("click", () => {
      void (async () => {
        const state = await writeFarm({ running: true, leader: instanceId, leaderAt: Date.now() });
        render(state, false);
        armLoop();
        void tick();
      })().catch(() => undefined);
    });

    btnStop.addEventListener("click", () => {
      void (async () => {
        const state = await readFarm();
        // A stop only clears the lease this tab actually holds; stopping from
        // a follower tab pauses the farm but leaves the leader to re-pick it
        // up — the lease lives or dies with its owner.
        const ours = state.leader === instanceId;
        await writeFarm(ours ? { running: false, playing: [], leader: "", leaderAt: 0 } : { running: false, playing: [] });
        clearKept(timer);
        timer = null;
        try {
          await stopClaim();
        } catch {
          /* the tab may already be gone; the claim dies with the socket */
        }
        waiting = 0;
        const fresh = await readFarm();
        renderRows(fresh.playing);
        render(fresh, false);
      })().catch(() => undefined);
    });

    btnRescan.addEventListener("click", () => {
      void tick(true).catch(() => undefined);
    });

    btnClaim.addEventListener("click", () => {
      void (async () => {
        await adoptAndRun(await readFarm(), "фабрика забрана этой вкладкой по кнопке");
      })().catch(() => undefined);
    });

    // Leader heartbeat — a second farm tab must see this page is alive fast.
    keptInterval(() => {
      void (async () => {
        const state = await readFarm();
        if (state.running && state.leader === instanceId) await writeFarm({ leaderAt: Date.now() });
      })().catch(() => undefined);
    }, HEART_MS);

    // Self-healing: every WATCHDOG_MS the tab asks itself whether the farm
    // should be running here. If the lease is ours (or the previous owner went
    // silent — closed tab, F5, extension update, Edge sleep), this tab adopts
    // and rotates on its own. The user should never have to press «Забрать
    // себе»: the button stays only as a manual override for a live second tab.
    // Background tabs adopt too — the farm is usually kept in a background
    // tab, and a lease only a visible tab can heal is a lock again.
    keptInterval(() => {
      void adoptIfOurs().catch(() => undefined);
    }, WATCHDOG_MS);

    // Coming back to a backgrounded farm tab re-checks the lease immediately.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void adoptIfOurs().catch(() => undefined);
    });

    // Re-render on storage writes (another chat tab took over, or stopped the
    // farm). A lease heartbeat is a storage write every 10 s — re-scanning 20
    // badge pages per heartbeat is a Steam rate-limit bomb, so rotation only
    // re-runs when the lease changes hands or the farm is switched on or off.
    let lastSeen = { leader: "", running: "" };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(FARM_KEY in changes)) return;
      void (async () => {
        const state = await readFarm();
        const mark = { leader: state.leader, running: String(state.running) };
        const matters = mark.leader !== lastSeen.leader || mark.running !== lastSeen.running;
        lastSeen = mark;
        // A scan in flight owns the status line; a heartbeat write must not
        // stomp the progress the user is watching.
        if (!busy) render(state, await leaderBlocked(state));
        if (!matters) return;
        if (state.running && state.leader === instanceId && timer === null) armLoop();
        if (state.running && state.leader === instanceId) void tick();
      })().catch(() => undefined);
    });

    // A claim the factory still holds must not idle: if the page reloaded, the
    // socket re-claims here — not on some tick five minutes out.
    void (async () => {
      const state = await readFarm();
      lastCounts = new Map();
      renderRows(state.playing);
      render(state, await leaderBlocked(state));
      await resumeClaim();
    })().catch(() => undefined);
  },
});
