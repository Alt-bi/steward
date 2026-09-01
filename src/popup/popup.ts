import "./popup.css";

import { send } from "../core/messaging";
import { clampSettings, loadSettings, saveSettings, type Settings } from "../core/settings";
import { clearHistories } from "../steam/histories";

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const openMarket = byId<HTMLButtonElement>("open-market");
const delay = byId<HTMLInputElement>("delay");
const undercut = byId<HTMLInputElement>("undercut");
const concurrency = byId<HTMLInputElement>("concurrency");
const priceSource = byId<HTMLSelectElement>("price-source");
const priceTtl = byId<HTMLInputElement>("price-ttl");
const quickBuy = byId<HTMLInputElement>("quick-buy");
const onePerItem = byId<HTMLInputElement>("one-per-item");
const exactLow = byId<HTMLInputElement>("exact-low");
const netLine = byId<HTMLParagraphElement>("net-line");
const netLog = byId<HTMLOListElement>("net-log");
const netReset = byId<HTMLButtonElement>("net-reset");

openMarket.addEventListener("click", () => {
  void chrome.tabs.create({ url: "https://steamcommunity.com/market/" });
});

const openFarm = byId<HTMLButtonElement>("open-farm");
openFarm.addEventListener("click", () => {
  // farm/open reuses an open chat tab (activates it and pushes the hash) —
  // chrome.tabs.create here would pile up duplicate chat tabs, and every
  // duplicate is one more ghost that can hold the farm lease.
  void send("farm/open", { appids: [] });
});

function fill(settings: Settings): void {
  delay.value = String(settings.delayMs);
  undercut.value = String(settings.undercutCents);
  concurrency.value = String(settings.scanConcurrency);
  priceSource.value = settings.priceSource;
  priceTtl.value = String(settings.priceTtlMinutes);
  quickBuy.value = String(settings.quickBuyMaxCents);
  onePerItem.checked = settings.onePerItem;
  exactLow.checked = settings.exactCompetitorLow;
}

/** Numbers are clamped on write, so a typo cannot become a ban-worthy delay. */
function bindNumber(
  input: HTMLInputElement,
  key: "delayMs" | "undercutCents" | "scanConcurrency" | "priceTtlMinutes" | "quickBuyMaxCents"
): void {
  input.addEventListener("change", () => {
    const patch = clampSettings({ [key]: Number.parseInt(input.value, 10) } as Partial<Settings>);
    const value = patch[key];
    if (value != null) input.value = String(value);
    void saveSettings(patch);
  });
}

function bindCheck(input: HTMLInputElement, key: "onePerItem" | "exactCompetitorLow"): void {
  input.addEventListener("change", () => {
    void saveSettings({ [key]: input.checked } as Partial<Settings>);
  });
}

bindNumber(delay, "delayMs");
bindNumber(undercut, "undercutCents");
bindNumber(concurrency, "scanConcurrency");
bindNumber(priceTtl, "priceTtlMinutes");
bindNumber(quickBuy, "quickBuyMaxCents");

priceSource.addEventListener("change", () => {
  const value = priceSource.value === "priceoverview" ? "priceoverview" : "search";
  void saveSettings({ priceSource: value });
});
bindCheck(onePerItem, "onePerItem");
bindCheck(exactLow, "exactCompetitorLow");

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString("ru-RU", { hour12: false });
}

/**
 * Without this the only thing a stuck scan showed was a countdown, and there was
 * no way to tell a rate limit apart from a login problem or a moved endpoint.
 */
async function refreshNet(): Promise<void> {
  try {
    const stats = await send("net/stats", {});
    const cooldown =
      stats.cooldownMsLeft > 0 ? ` · пауза ${Math.ceil(stats.cooldownMsLeft / 1000)}с` : "";

    netLine.replaceChildren();
    netLine.append(
      `ок ${stats.ok} · 429×${stats.hits429} · пустых ${stats.hitsEmpty}${cooldown}`
    );
    const budget = document.createElement("div");
    const ip = stats.global;
    budget.textContent =
      `IP ${ip.tokens}/${ip.capacity} (${ip.ratePerMin}/мин) · ` +
      `поиск ${stats.budget.search.tokens}/${stats.budget.search.capacity} ` +
      `(${stats.budget.search.ratePerMin}/мин) · ` +
      `цены ${stats.budget.price.tokens}/${stats.budget.price.capacity} ` +
      `(${stats.budget.price.ratePerMin}/мин)`;
    netLine.append(budget);

    if (stats.blocked) {
      const flag = document.createElement("div");
      flag.className = "blocked";
      flag.textContent = `Steam отказал ${stats.consecutive429} раз подряд — скан остановлен.`;
      netLine.append(flag);
    }

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
    netLine.textContent = "фоновый процесс ещё не проснулся";
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

void (async () => {
  fill(await loadSettings());
  await refreshNet();
})();
