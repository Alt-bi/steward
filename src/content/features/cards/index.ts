import {
  isPicked,
  noneDropped,
  pickAll,
  pickNone,
  togglePick,
  type Picks,
} from "../../../core/picks";
import { farmableRows, scanBadges } from "../../../steam/badges";
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

  const launchBtn = el("button", "stw-btn", "Запустить в Steam");
  launchBtn.type = "button";
  launchBtn.title =
    "По одной игре через steam://run: клиент спросит подтверждение, играет, карточка капает с наигранным временем.\n" +
    "Поток из 32 игр — забота SteamKit-бота (docs/cards-factory.md), браузер его не заменит.";

  const head = el("div", "stw-controls");
  head.append(scanBtn, allBtn, noneBtn, launchBtn);

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
  section.body.append(head, stats, hint, rows);

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
        renderRows(farmable);
        status(farmable.length ? "Отмечай и запускай" : "Дропов не осталось — можно крафтить", "ok");
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

  launchBtn.addEventListener("click", () => {
    if (busy) return;
    const chosen = appIds.filter((id) => isPicked(id, dropped));
    if (!chosen.length) {
      status("Отметь игры, которые запускаем", "warn");
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

  status("Нажми «Сканировать» — посчитаем, кому ещё должны карточки");
}

register({
  id: "cards",
  title: "Карточки",
  matches: (url) => /(^|\/)badges\/?$/.test(url.pathname),
  mount,
});
