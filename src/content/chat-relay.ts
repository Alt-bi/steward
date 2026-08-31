import { send } from "../core/messaging";
import { cmPlayBridgeName } from "../page/cm-play-core";

/**
 * Chat relay (ISOLATED world, runs on steamcommunity.com/chat).
 *
 * The Cards tab never touches the chat page directly. It asks the worker,
 * the worker routes to a chat tab, and this relay carries the request across
 * the world boundary into our MAIN bridge — and back. It also forwards every
 * captured ClientGamesPlayed frame the bridge sees (ours, or a golden one
 * pressed by another extension) into the worker's small capture ring, so the
 * tab can compare encodings byte for byte.
 *
 * No panel is mounted on the chat page: this is all this script does here.
 */

/** Same name the MAIN bridge exports — one constant, no drift possible. */
const BRIDGE = cmPlayBridgeName;

interface RelayPayload {
  stop: boolean;
  entries: { appid: number; playing: boolean; secure: boolean; offline: boolean }[];
}

const isChat = () => location.pathname.startsWith("/chat") || location.pathname.startsWith("/family");

/** Ask the MAIN bridge and wait for its -reply. */
function bridgeCall(type: string, extra: Record<string, unknown>): Promise<{ ok?: boolean; note?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const onMsg = (event: MessageEvent) => {
      const d = event.data as { source?: string; type?: string; ok?: boolean; note?: string } | null;
      if (event.source !== window || d?.source !== BRIDGE + "-reply" || d.type !== type) return;
      settled = true;
      window.removeEventListener("message", onMsg);
      resolve({ ok: !!d.ok, note: d.note });
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ source: BRIDGE, type, ...extra }, "*");
    setTimeout(() => {
      if (settled) return;
      window.removeEventListener("message", onMsg);
      resolve({ ok: false, note: "чат не ответил (обнови страницу чата)" });
    }, 5000);
  });
}

export function mountChatRelay(): void {
  if (!isChat()) return;

  // Worker → here (asked from the Cards tab through the worker router).
  // Not a Protocol envelope: this hop is worker→tab, the router above owns
  // the typed side; here a plain tagged object keeps the worlds separate.
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const m = message as { __cmrelay?: boolean; payload?: RelayPayload } | null;
    if (!m || m.__cmrelay !== true || !m.payload) return false;
    const payload = m.payload;
    void (async () => {
      if (payload.stop) {
        const res = await bridgeCall("cm-play/stop", {});
        sendResponse(res);
        return;
      }
      const res = await bridgeCall("cm-play/start", { entries: payload.entries });
      sendResponse(res);
    })();
    return true; // async response
  });

  // MAIN bridge → worker: captured 742 frames (passive, including other
  // extensions' Start presses — read-only observation).
  window.addEventListener("message", (event) => {
    const d = event.data as { source?: string; type?: string; bytes?: number[]; mine?: boolean } | null;
    if (event.source !== window || d?.source !== BRIDGE || d.type !== "cm-play/captured" || !d.bytes) return;
    void send("cm/capture", { bytes: d.bytes, mine: !!d.mine }).catch(() => undefined);
  });
}
