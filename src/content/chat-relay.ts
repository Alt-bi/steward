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
  /** Ask Steam (via our own profile page) whether it sees us In-Game. */
  verify?: boolean;
  /** Golden 742 bytes to inject verbatim (diagnostic replay). */
  replay?: number[];
  /** Replace the playing set without stopping the keep-alive timer. */
  swap?: boolean;
  entries: { appid: number; playing: boolean; secure: boolean; offline: boolean }[];
}

const isChat = () => location.pathname.startsWith("/chat") || location.pathname.startsWith("/family");

/** This relay's build — the worker refuses bridges from an older orphaned script. */
const relayVersion = () => chrome.runtime.getManifest().version as string;

/** Ask the MAIN bridge and wait for its -reply. Exported for the in-page
 * card farm — same page, same socket, no need to route through the worker. */
export function bridgeCall(type: string, extra: Record<string, unknown>): Promise<{ ok?: boolean; note?: string }> {
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
      const stamp = (r: object): object => Object.assign({}, r, { extVersion: relayVersion() });
      if (payload.verify) {
        sendResponse(stamp(await bridgeCall("cm-play/verify", {})));
        return;
      }
      if (payload.replay && payload.replay.length) {
        sendResponse(stamp(await bridgeCall("cm-play/replay", { bytes: payload.replay })));
        return;
      }
      if (payload.stop) {
        sendResponse(stamp(await bridgeCall("cm-play/stop", {})));
        return;
      }
      if (payload.swap) {
        sendResponse(stamp(await bridgeCall("cm-play/swap", { entries: payload.entries })));
        return;
      }
      sendResponse(stamp(await bridgeCall("cm-play/start", { entries: payload.entries })));
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
