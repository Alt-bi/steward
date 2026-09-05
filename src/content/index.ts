import "./ui/panel.css";

import { loadSettings } from "../core/settings";
import { requestPageInfo } from "../steam/page-context";
import { activeFeatures } from "./features/registry";
import { Panel, panelExists } from "./ui/panel";
import { extensionAlive, showStaleNotice, watchForOrphaning } from "./ui/orphan";

/** Importing a feature is what registers it. */
import "./features/reprice";
import "./features/sales";
import "./features/inventory";
import "./features/offers";
import "./features/trade";
import "./features/listing";
import "./features/cards";
import "./features/farm";
import { mountChatRelay } from "./chat-relay";

async function boot(): Promise<void> {
  // An orphaned script (extension was updated under this tab) has a dead
  // chrome.* context - nothing we do here can work, so say so instead of
  // scattering uncaught rejections across the console.
  if (!extensionAlive()) {
    showStaleNotice();
    return;
  }
  // Any rejection from a severed bridge is caught centrally from here on: an
  // orphaned tab used to print «Extension context invalidated» every few
  // seconds, once per farm watchdog tick, with nothing shutting the timers off.
  watchForOrphaning();
  mountChatRelay();
  if (panelExists()) return;

  const url = new URL(location.href);
  const settings = await loadSettings();
  const features = activeFeatures(url, settings);
  if (!features.length) return;

  const panel = new Panel();

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
