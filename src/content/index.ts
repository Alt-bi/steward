import "./ui/panel.css";

import { loadSettings } from "../core/settings";
import { requestPageInfo } from "../steam/page-context";
import { activeFeatures } from "./features/registry";
import { Panel, panelExists } from "./ui/panel";

/** Importing a feature is what registers it. */
import "./features/reprice";
import "./features/buyorders";
import "./features/inventory";
import "./features/offers";
import "./features/trade";
import "./features/listing";
import "./features/cards";
import "./features/farm";
import { mountChatRelay } from "./chat-relay";

function showStaleNotice(): void {
  if (document.getElementById("stw-stale")) return;
  const box = document.createElement("div");
  box.id = "stw-stale";
  box.textContent = "Steward обновился — обнови эту страницу (F5), чтобы вернулся интерфейс.";
  box.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:2147483001;color:#fff;padding:10px 14px;border-radius:8px;font:13px/1.4 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5)";
  box.style.background = "#1b2832";
  document.documentElement.appendChild(box);
}

async function chromeRuntimeAlive(): Promise<boolean> {
  try {
    // getManifest throws once the context is invalidated.
    return Boolean(chrome.runtime?.id && chrome.runtime.getManifest());
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  // An orphaned script (extension was updated under this tab) has a dead
  // chrome.* context - nothing we do here can work, so say so instead of
  // scattering uncaught rejections across the console.
  if (!(await chromeRuntimeAlive())) {
    showStaleNotice();
    return;
  }
  mountChatRelay();
  if (panelExists()) return;

  const url = new URL(location.href);
  const settings = await loadSettings();
  const features = activeFeatures(url, settings);
  if (!features.length) return;

  const panel = new Panel(features.map((f) => f.title.toLowerCase()).join(" · "));

  for (const feature of features) {
    try {
      await feature.mount({ panel, settings, url });
    } catch (err) {
      console.warn(`[Steward] feature ${feature.id} failed to mount`, err);
    }
  }

  requestPageInfo();
}

void boot();
