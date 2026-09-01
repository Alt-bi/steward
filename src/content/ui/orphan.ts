/**
 * What to do when the extension is pulled out from under a running page.
 *
 * An update (or a Reload in edge://extensions) does not migrate content scripts
 * that are already running in an open tab. The script keeps executing, but its
 * `chrome.*` bridge is severed: every call throws «Extension context
 * invalidated», forever. The farm tab is the worst case — it arms a 5 s
 * watchdog, a 10 s heartbeat and a scan loop, so an orphaned chat tab prints
 * an uncaught rejection every few seconds until the user closes it. That is
 * the console noise the user reported, and it is also the tab NOT farming.
 *
 * So: every timer we arm is registered here, the first sign of orphaning stops
 * all of them at once, and the user gets one sentence («press F5») instead of
 * a scrolling wall of the same error.
 */

const timers = new Set<number>();
let dead = false;

/** True while our `chrome.*` bridge still exists. */
export function extensionAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

/**
 * Whether this failure is the severed bridge rather than anything about Steam.
 * All three wordings mean the same thing: the half of us that lived in the
 * browser is gone.
 */
export function isOrphanError(err: unknown): boolean {
  const text = String((err as Error | null)?.message ?? err ?? "");
  return /Extension context invalidated|Receiving end does not exist|message port closed/i.test(text);
}

/**
 * `setInterval` that dies with the extension. The callback is skipped once the
 * bridge is gone, and an orphan error thrown out of it retires every timer we
 * own — one notice, no spam.
 */
export function keptInterval(fn: () => void, ms: number): number {
  const id = window.setInterval(() => {
    if (dead) return;
    if (!extensionAlive()) {
      noteOrphaned();
      return;
    }
    try {
      fn();
    } catch (err) {
      if (isOrphanError(err)) noteOrphaned();
      else throw err;
    }
  }, ms);
  timers.add(id);
  return id;
}

/** Stop one kept timer (a loop the feature itself re-arms). */
export function clearKept(id: number | null): void {
  if (id === null) return;
  window.clearInterval(id);
  timers.delete(id);
}

/** True once the page has been declared orphaned — features stop deciding things. */
export function isOrphaned(): boolean {
  return dead;
}

/**
 * Retire the page: stop every timer we armed and say so, once.
 *
 * Nothing here can talk to the worker any more, so the notice is built by hand
 * out of the DOM the page already has.
 */
export function noteOrphaned(): void {
  if (dead) return;
  dead = true;
  for (const id of timers) window.clearInterval(id);
  timers.clear();
  showStaleNotice();
}

export function showStaleNotice(): void {
  if (document.getElementById("stw-stale")) return;
  const box = document.createElement("div");
  box.id = "stw-stale";
  box.textContent = "Steward обновился — обнови эту страницу (F5), чтобы вернулся интерфейс.";
  box.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:2147483001;color:#fff;padding:10px 14px;border-radius:8px;font:13px/1.4 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5)";
  box.style.background = "#1b2832";
  document.documentElement.appendChild(box);
}

/**
 * The catch-all. Any promise we forgot to guard — a storage read inside a
 * timer, a `send()` racing the update — lands here instead of in the console,
 * and takes the whole orphaned machine down with it.
 */
export function watchForOrphaning(): void {
  window.addEventListener("unhandledrejection", (event) => {
    if (!isOrphanError(event.reason)) return;
    event.preventDefault();
    noteOrphaned();
  });
}
