import {
  isPicked,
  noneDropped,
  pickAll,
  pickNone,
  togglePick,
  type Picks,
} from "../../../core/picks";
import { send } from "../../../core/messaging";
import {
  batchesOf,
  loadAsfConfig,
  playCommands,
  probeAsf,
  runAsfCommands,
  saveAsfConfig,
  stopCommands,
} from "../../../core/asf";
import { dropsDelta, farmableRows, scanBadges } from "../../../steam/badges";
import { allowSteamTraffic, sleep } from "../../../steam/net";
import { describeError } from "../../ui/errors";
import { el, type StatusKind } from "../../ui/panel";
import { register, type FeatureContext } from "../registry";

/**
 * The cards tab: which games still owe drops, and a way to go and get them.
 *
 * The list is the easy half — the rewritten badge page names everything, and
 * one scan per tab is all it costs. The hard half is what the launch button
 * does, and the honest answer is smaller than the marketing: the gamecards
 * page lost its Start Playing control to the SSR wave, so there is no button
 * to click, and a browser extension is not a SteamKit session no matter how
 * much it wants to be. What works is `steam://run` — the client launches the
 * game, the drop lands on Steam's clock. 32 games in a stream is a bot's job;
 * the handoff plan lives in docs/cards-factory.md.
 */

async function mount(ctx: FeatureContext): Promise<void> {
  const section = ctx.panel.addSection("cards", "Карточки");

  const dropped: Picks = noneDropped();
  let appIds: string[] = [];
  /** appid -> drops remaining at the last scan; empty until the first one. */
  let baseline = new Map<number, number | null>();
  let busy = false;

  const status = (text: string, kind: StatusKind = "") => section.setStatus(text, kind);

  const scanBtn = el("button", "stw-btn", "Сканировать");
  scanBtn.type = "button";
  scanBtn.title =
    "Пройти страницы бейджей (по 150) и оставить игры, где Steam сам считает оставшиеся дропы";

  const allBtn = el("button", "stw-btn stw-btn-thin", "все");
  allBtn.type = "button";
  const noneBtn = el("button", "stw-btn stw-btn-thin", "снять");
  noneBtn.type = "button";

  const modeSelect = el("select", "stw-input");
  modeSelect.append(
    new Option("чат-клиент — поток до 32 игр, без ботов", "chat"),
    new Option("steam://run — по одной, через клиент", "run"),
    new Option("ASF-бот — играть будет бот", "asf")
  );
  modeSelect.title =
    "чат-клиент: держи вкладку steamcommunity.com/chat открытой — игры заявляются в её"
    "  собственное соединение со Steam (тот же приём, что у Card Factory, движок — наш).\n"
    "steam://run: клиент играет по очереди, подтверждая каждую.\n"
    "ASF-бот: SteamKit-бот играет все выбранные сразу.";

  const launchBtn = el("button", "stw-btn", "Запустить");
  launchBtn.type = "button";
  launchBtn.title =
    "По одной игре через steam://run: клиент спросит подтверждение, играет, карточка капает с наигранным временем.\n" +
    "В режиме ASF-бота ставит игры в поток боту — до 32 сразу.";

  const stopBtn = el("button", "stw-btn stw-btn-thin", "стоп");
  const snapBtn = el("button", "stw-btn stw-btn-thin", "снимок 742");
  stopBtn.type = "button";
  stopBtn.title = "Вернуть бота в обычный режим (reset) — дропы больше не фармятся";
  stopBtn.style.display = "none";

  /** ASF wiring, shown only in the bot mode — most users never see these. */
  const asfBox = el("div", "stw-controls");
  asfBox.style.display = "none";
  const urlInput = el("input", "stw-input");
  urlInput.type = "text";
  urlInput.placeholder = "http://localhost:1242";
  urlInput.title = "Адрес web API бота (GlobalConfig → IPC). С loopback ASF пустит без пароля.";
  const passInput = el("input", "stw-input");
  passInput.type = "password";
  passInput.placeholder = "IPC-пароль";
  passInput.title = "IPCPassword из GlobalConfig — нужен, если ASF слушает не localhost";
  const botInput = el("input", "stw-input");
  botInput.type = "text";
  botInput.placeholder = "имя бота (необяз.)";
  botInput.title = "Как зовут фермящего бота; пусто — дефолтный бот ASF";
  const testBtn = el("button", "stw-btn stw-btn-thin", "тест");
  testBtn.type = "button";
  testBtn.title = "Проверить, что ASF отвечает, прежде чем ставить игры";
  const saveBtn = el("button", "stw-btn stw-btn-thin", "сохранить");
  saveBtn.type = "button";
  asfBox.append(urlInput, passInput, botInput, testBtn, saveBtn);

  const head = el("div", "stw-controls");
  head.append(scanBtn, allBtn, noneBtn, modeSelect, launchBtn, stopBtn, snapBtn);

  const stats = el("div", "stw-stats");
  const statNodes: Record<string, HTMLElement> = {};
  for (const [key, label] of [
    ["games", "игр с дропами", ""],
    ["drops", "дропадось", ""],
    ["badges", "бейджей прочитано", ""],
  ] as const) {
    const box = el("div", "stw-stat");
    const n = el("div", "stw-stat-n", "—");
    box.append(n, el("div", "stw-stat-l", label));
    statNodes[key] = n;
    stats.appendChild(box);
  }

  const hint = el(
    "div",
    "stw-hint",
    "Дропы капают по наигранному времени — от минут до часов между карточками. Отметь игры и запускай; счёт обновится на следующем скане."
  );

  const rows = el("div", "stw-rows");
  section.body.append(head, asfBox, stats, hint, rows);

  function setChecks(on: boolean): void {
    rows.querySelectorAll<HTMLInputElement>("input").forEach((cb) => {
      cb.checked = on;
    });
  }

  function renderRows(farmable: ReturnType<typeof farmableRows>): void {
    rows.replaceChildren();
    appIds = [];
    for (const row of farmable) {
      const id = String(row.appid);
      appIds.push(id);

      const line = el("div", "stw-row");
      const name = el("label", "stw-name");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "stw-check";
      check.checked = isPicked(id, dropped);
      check.addEventListener("change", () => togglePick(id, dropped));
      name.append(check, document.createTextNode(` ${row.name}`));
      name.title = `appid ${row.appid}`;

      const drops = el("span", "stw-our", `${row.dropsRemaining ?? 0} др.`);
      line.append(name, drops);
      rows.appendChild(line);
    }
  }

  scanBtn.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    allowSteamTraffic();
    scanBtn.disabled = true;
    status("Считаем бейджи…", "work");
    void (async () => {
      try {
        const scan = await scanBadges({
          onProgress: (read, total) =>
            status(`Прочитано ${read}${total ? ` из ${total}` : ""} бейджей…`, "work"),
        });
        const farmable = farmableRows(scan).sort(
          (a, b) => (b.dropsRemaining ?? 0) - (a.dropsRemaining ?? 0)
        );
        statNodes.games!.textContent = String(farmable.length);
        statNodes.drops!.textContent = String(
          farmable.reduce((n, r) => n + (r.dropsRemaining ?? 0), 0)
        );
        statNodes.badges!.textContent = String(scan.rows.length);
        const now = new Map(scan.rows.map((r) => [r.appid, r.dropsRemaining] as const));
        const landed = dropsDelta(baseline, scan.rows);
        baseline = now;
        if (landed.size) {
          const names = farmable
            .filter((r) => landed.has(r.appid))
            .slice(0, 3)
            .map((r) => `${r.name} −${landed.get(r.appid)}`);
          status(`Капнуло: ${names.join(", ")}${landed.size > names.length ? "…" : ""}`, "ok");
        } else {
          status(farmable.length ? "Отмечай и запускай" : "Дропов не осталось — можно крафтить", "ok");
        }
        renderRows(farmable);
      } catch (err) {
        status(describeError(err), "err");
      } finally {
        busy = false;
        scanBtn.disabled = false;
      }
    })();
  });

  allBtn.addEventListener("click", () => {
    pickAll(appIds, dropped);
    setChecks(true);
  });

  noneBtn.addEventListener("click", () => {
    pickNone(appIds, dropped);
    setChecks(false);
  });

  const asfCfg = () => ({
    url: urlInput.value.trim(),
    password: passInput.value,
    bot: botInput.value.trim(),
  });

  modeSelect.addEventListener("change", () => {
    const bot = modeSelect.value === "asf";
    asfBox.style.display = bot ? "" : "none";
    stopBtn.style.display = bot || modeSelect.value === "chat" ? "" : "none";
  });

  saveBtn.addEventListener("click", () => {
    void saveAsfConfig(asfCfg()).then(() => status("Настройки бота сохранены", "ok"));
  });

  testBtn.addEventListener("click", () => {
    status("Стучимся в ASF…", "work");
    void (async () => {
      const r = await probeAsf(asfCfg());
      status(r.ok ? "Бот на связи" : r.error, r.ok ? "ok" : "err");
    })();
  });

  stopBtn.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    void (async () => {
      if (modeSelect.value === "chat") {
        const r = await send("cm/play", { stop: true, entries: [] });
        status(r.ok ? "Заявка снята — чат больше не «играет»" : "Чат не ответил", r.ok ? "ok" : "err");
        busy = false;
        return;
      }
      const r = await runAsfCommands(asfCfg(), stopCommands(asfCfg()));
      status(
        r.failed ? `Стоп не прошёл: ${r.failed}` : "Бот вернулся в обычный режим",
        r.failed ? "err" : "ok"
      );
      busy = false;
    })();
  });

  launchBtn.addEventListener("click", () => {
    if (busy) return;
    const chosen = appIds.filter((id) => isPicked(id, dropped));
    if (!chosen.length) {
      status("Отметь игры, которые запускаем", "warn");
      return;
    }
    if (modeSelect.value === "chat") {
      busy = true;
      status("Заявляем игры в чат-клиент…", "work");
      void (async () => {
        const r = await send("cm/play", {
          stop: false,
          entries: chosen.map((id) => ({ appid: Number(id), playing: true, secure: true, offline: false })),
        });
        status(
          r.ok
            ? `Заявлено ${chosen.length} — держи вкладку чата открытой`
            : ("Чат не принял заявку: " + ("error" in r ? r.error : "?")),
          r.ok ? "ok" : "err"
        );
        busy = false;
      })();
      return;
    }
    if (modeSelect.value === "asf") {
      busy = true;
      void (async () => {
        /**
         * The Card Factory trick: play each batch as it lands. One play
         * command carries 32 appids — it is the bot, not this tab, that
         * holds the sessions.
         */
        const cfg = asfCfg();
        const commands = playCommands(cfg, chosen.map(Number));
        status(`Ставим ${chosen.length} игр боту…`, "work");
        const r = await runAsfCommands(cfg, commands, (i) =>
          status(`Пачка ${i + 1} из ${commands.length}…`, "work")
        );
        status(
          r.failed ? `Бот встал: ${r.failed}` : `Бот играет ${chosen.length} игр — поток до 32`,
          r.failed ? "err" : "ok"
        );
        busy = false;
      })();
      return;
    }
    busy = true;
    void (async () => {
      /**
       * One handoff per game with a beat between them: the client shows a
       * launch prompt for each, and twenty at once only trains the user to
       * click through blindly. The protocol URL never navigates the page —
       * the OS hands it to Steam and the tab stays where it was.
       */
      for (let i = 0; i < chosen.length; i++) {
        status(`Запуск ${i + 1} из ${chosen.length} — подтверди в окне Steam`, "work");
        window.location.href = `steam://run/${chosen[i]}`;
        await sleep(1500);
      }
      status(`Запущено ${chosen.length} шт. Дропы придут с наигранным временем`, "ok");
      busy = false;
    })();
  });

  snapBtn.title =
    "Показывает сохранённые кадры 742 (ClientGamesPlayed), которые видел любой открытый чат:\n" +
    "наши заявки и чужие (например из Card Factory) — для побайтового сравнения движков.";
  snapBtn.addEventListener("click", () => {
    void (async () => {
      const ring = await send("cm/golden", {});
      if (!ring.frames.length) {
        status("Кольцо пусто — открой чат и нажми Start где-нибудь, либо заявку отсюда", "warn");
        return;
      }
      const foreign = ring.frames.filter((f) => !f.mine);
      const mine = ring.frames.filter((f) => f.mine);
      const sample = (foreign[0] || mine[0])!;
      const shown = sample.bytes.slice(0, 24).map((b) => b.toString(16).padStart(2, "0")).join(" ");
      status(
        `Кадры: своих ${mine.length}, чужих ${foreign.length}. Первый байт-в-байт: ${shown}…`,
        foreign.length ? "ok" : "warn"
      );
    })();
  });

  void loadAsfConfig().then((cfg) => {
    urlInput.value = cfg.url;
    passInput.value = cfg.password;
    botInput.value = cfg.bot;
  });

  status("Нажми «Сканировать» — посчитаем, кому ещё должны карточки");
}

register({
  id: "cards",
  title: "Карточки",
  matches: (url) => /(^|\/)badges\/?$/.test(url.pathname),
  mount,
});
