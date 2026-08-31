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

async function boot(): Promise<void> {
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
