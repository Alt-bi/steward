import "./popup.css";

import { send } from "../core/messaging";
import type { NetStats } from "../core/messaging";
import { FIXED_SETTINGS } from "../core/settings";
import { clearHistories } from "../steam/histories";

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const ver = byId<HTMLSpanElement>("ver");
const openMarket = byId<HTMLButtonElement>("open-market");
const openFarm = byId<HTMLButtonElement>("open-farm");
const health = byId<HTMLElement>("health");
const healthLine = byId<HTMLParagraphElement>("health-line");
const healthFill = byId<HTMLElement>("health-fill");
const healthSub = byId<HTMLParagraphElement>("health-sub");
const standard = byId<HTMLDListElement>("standard");
const netBudget = byId<HTMLParagraphElement>("net-budget");
const netLog = byId<HTMLOListElement>("net-log");
const netReset = byId<HTMLButtonElement>("net-reset");

try {
  ver.textContent = chrome.runtime.getManifest().version;
} catch {
  ver.remove();
}

openMarket.addEventListener("click", () => {
  void chrome.tabs.create({ url: "https://steamcommunity.com/market/" });
});

openFarm.addEventListener("click", () => {
  // farm/open reuses an open chat tab (activates it and pushes the hash) —
  // chrome.tabs.create here would pile up duplicate chat tabs, and every
  // duplicate is one more ghost that can hold the farm lease.
  void send("farm/open", {});
});

function amount(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

/**
 * The standard, read out of the constant rather than typed into the markup.
 *
 * The point of the list is that nothing is hidden — a fixed value the owner
 * cannot see is the same as a value they cannot trust. Reading it from
 * `FIXED_SETTINGS` is what keeps the promise true: change the number and this
 * page says the new one, with no second place to forget.
 */
function fillStandard(): void {
  const rows: readonly [string, string][] = [
    ["Пауза между записями", `${(FIXED_SETTINGS.delayMs / 1000).toFixed(1).replace(".", ",")} с`],
    ["Ниже конкурента", `${FIXED_SETTINGS.undercutCents} коп.`],
    ["Глубже не двигаем", `${FIXED_SETTINGS.maxDropPercent}%`],
    ["Свой лот за конкурента", FIXED_SETTINGS.skipSelfUndercut ? "не считаем" : "считаем"],
    ["Лотов одного предмета за проход", FIXED_SETTINGS.onePerItem ? "один" : "все"],
    [
      "Откуда цены",
      FIXED_SETTINGS.priceSource === "search" ? "поиск маркета, пачками" : "priceoverview",
    ],
    ["Цена свежая", `${FIXED_SETTINGS.priceTtlMinutes} мин`],
    ["Запросов цен разом", String(FIXED_SETTINGS.scanConcurrency)],
    ["Точный минимум книги", FIXED_SETTINGS.exactCompetitorLow ? "спрашиваем" : "не спрашиваем"],
    ["Потолок быстрой покупки", amount(FIXED_SETTINGS.quickBuyMaxCents)],
  ];

  standard.replaceChildren();
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    row.append(dt, dd);
    standard.appendChild(row);
  }
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString("ru-RU", { hour12: false });
}

/**
 * What the numbers mean, said once, in the order that matters.
 *
 * A stuck scan used to show a countdown and nothing else, and a rate limit, a
 * dead session and a moved endpoint all looked identical. The state decides the
 * colour; the counters go underneath, where they explain rather than announce.
 */
function verdict(stats: NetStats): { state: string; line: string } {
  if (stats.blocked) {
    return {
      state: "err",
      line: `Steam отказал ${stats.consecutive429} раз подряд — прогоны стоят`,
    };
  }
  if (stats.cooldownMsLeft > 0) {
    return { state: "warn", line: `Пауза ${Math.ceil(stats.cooldownMsLeft / 1000)} с` };
  }
  if (stats.global.tokens < 1) {
    return { state: "warn", line: "Запас исчерпан — ждём восстановления" };
  }
  return { state: "ok", line: "Steam отвечает" };
}

async function refreshNet(): Promise<void> {
  try {
    const stats = await send("net/stats", {});
    const said = verdict(stats);
    const ip = stats.global;

    health.dataset.state = said.state;
    healthLine.textContent = said.line;
    healthFill.style.width = `${Math.round(
      (Math.min(ip.tokens, ip.capacity) / Math.max(1, ip.capacity)) * 100
    )}%`;
    healthSub.textContent =
      `запас ${ip.tokens} из ${ip.capacity}, ${ip.ratePerMin}/мин · ` +
      `ок ${stats.ok} · отказов ${stats.hits429} · пустых ${stats.hitsEmpty}`;

    netBudget.textContent =
      `поиск ${stats.budget.search.tokens}/${stats.budget.search.capacity} ` +
      `(${stats.budget.search.ratePerMin}/мин) · ` +
      `цены ${stats.budget.price.tokens}/${stats.budget.price.capacity} ` +
      `(${stats.budget.price.ratePerMin}/мин) · ` +
      `записи ${stats.budget.write.tokens}/${stats.budget.write.capacity} ` +
      `(${stats.budget.write.ratePerMin}/мин)`;

    const { rows } = await send("log/read", { limit: 40 });
    netLog.replaceChildren();
    for (const row of rows.slice().reverse()) {
      const li = document.createElement("li");
      li.dataset.kind = row.kind;
      li.textContent = `${time(row.t)} ${row.kind} ${row.detail}`;
      li.title = row.detail;
      netLog.appendChild(li);
    }
  } catch {
    health.dataset.state = "idle";
    healthLine.textContent = "фоновый процесс ещё не проснулся";
    healthFill.style.width = "0%";
    healthSub.textContent = "откроется, как только что-нибудь спросит Steam";
  }
}

/** The popup stays open while a scan runs, so keep it live. */
setInterval(() => void refreshNet(), 1500);

netReset.addEventListener("click", () => {
  void (async () => {
    await send("net/reset", {});
    await send("cache/clear", {});
    /** Sale histories live in their own store, and «сбросить кэш» must mean all of it. */
    await clearHistories();
    await refreshNet();
  })();
});

fillStandard();
void refreshNet();
