import type { Settings } from "../../core/settings";
import type { Panel } from "../ui/panel";

/**
 * Features are self-contained: they declare where they apply and get handed the
 * shared panel. Adding one is a `register()` call plus an import in `content/index.ts`,
 * with nothing to change in the shell.
 */

export interface FeatureContext {
  panel: Panel;
  settings: Settings;
  url: URL;
}

export interface Feature {
  /** Stable id — also the settings key under `features`. */
  id: string;
  /** Tab label. */
  title: string;
  /** Enabled unless the user turned it off. */
  defaultEnabled?: boolean;
  matches(url: URL): boolean;
  mount(ctx: FeatureContext): void | Promise<void>;
}

const registry: Feature[] = [];

export function register(feature: Feature): void {
  if (registry.some((f) => f.id === feature.id)) return;
  registry.push(feature);
}

export function activeFeatures(url: URL, settings: Settings): Feature[] {
  return registry.filter((f) => {
    if (!f.matches(url)) return false;
    const flag = settings.features[f.id];
    return flag ?? f.defaultEnabled ?? true;
  });
}

export function allFeatures(): readonly Feature[] {
  return registry;
}
