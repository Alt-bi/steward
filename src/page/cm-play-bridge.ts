import {
  buildGamesPlayedFrame,
  cmPlayBridgeName,
  frameEMsg,
  EM_GAMES_PLAYED,
  inGameFromProfileHtml,
  type CmIds,
  type PlayEntry,
} from "./cm-play-core";

/**
 * The chat client's socket, driven from our code.
 *
 * How SteamLVLUP drops cards, read out of their shipped bundle: a content
 * script on steamcommunity.com/chat asks THEIR server to encode a
 * ClientGamesPlayed message, gets the finished protobuf bytes back, and shoves
 * them into the chat client's own CM websocket
 * (g_FriendsUIApp.m_CMInterface.m_Socket.send). Steam trusts the socket
 * because it is the chat's own authenticated connection — the account is
 * "playing" whatever the packet says, no game launches, no bot, no browser
 * process. We do the same trick minus their server: the encoder in
 * cm-play-core is the whole backend.
 *
 * Runs in MAIN world on /chat and /family/chat: only this page context sees
 * g_FriendsUIApp. Talks to the content script via window.postMessage only —
 * never touches anything else the page owns.
 *
 * It also PASSIVELY captures any 742 frame flowing through that socket while
 * our bridge is loaded — including the ones another extension injects. That
 * is how the user's own Card Factory run hands us its golden bytes for
 * comparison, read-only, without us pressing any button for them.
 */

interface CmShape {
  m_Socket?: WebSocket;
  m_steamid?: { ConvertTo64BitString(): string };
  m_Session?: { m_nSessionID: number };
}

/** The chat's client object; Steam rewrites it on reconnect, so nothing caches it. */
const cm = (): CmShape | undefined =>
  (window as unknown as { g_FriendsUIApp?: { m_CMInterface?: CmShape } }).g_FriendsUIApp?.m_CMInterface;

/** Where the CM socket hides; re-resolved every action, Steam rewrites it on reconnect. */
const cmSocket = (): WebSocket | null => {
  const ws = cm()?.m_Socket;
  return ws && ws.readyState === WebSocket.OPEN ? ws : null;
};

const cmIds = (): CmIds | null => {
  const c = cm();
  if (!c?.m_steamid || !c?.m_Session) return null;
  return { steamid: c.m_steamid.ConvertTo64BitString(), sessionid: c.m_Session.m_nSessionID | 0 };
};

let playing: PlayEntry[] = [];
let keepTimer: number | null = null;
/** Set while WE call ws.send, so the hook tags the frame as ours. */
let oursPending = false;

function ourSend(ws: WebSocket, frame: Uint8Array): void {
  oursPending = true;
  try {
    ws.send(frame);
  } finally {
    oursPending = false;
  }
}

/** Steam forgets "playing" without company; SLVLUP pings every 15s. We resend
 * the same packet — ClientGamesPlayed is idempotent by design. */
function keepAlive(): void {
  const ws = cmSocket();
  const ids = cmIds();
  if (!ws || !ids || playing.length === 0) return;
  ourSend(ws, buildGamesPlayedFrame(playing, ids));
}

function start(entries: PlayEntry[]): { ok: boolean; note?: string } {
  const ws = cmSocket();
  const ids = cmIds();
  if (!ws || !ids) return { ok: false, note: "open the chat (steamcommunity.com/chat) first" };
  playing = entries.slice(0, 32); // the stream Card Factory size
  ourSend(ws, buildGamesPlayedFrame(playing, ids));
  if (keepTimer === null) {
    keepTimer = window.setInterval(keepAlive, KEEPALIVE_MS);
  }
  return { ok: true, note: playing.length + " game(s) claimed" };
}

/**
 * Swap the claimed set without restarting the keep-alive timer — the factory
 * calls this the moment a game is finished. A naive rotation that stops and
 * starts between drop-outs flashes an empty session past Steam; keep-alive
 * must flow across every swap, so this path never idles the timer.
 */
function setPlaying(entries: PlayEntry[]): { ok: boolean; note?: string } {
  const ws = cmSocket();
  const ids = cmIds();
  if (!ws || !ids) return { ok: false, note: "open the chat (steamcommunity.com/chat) first" };
  playing = entries.slice(0, 32);
  ourSend(ws, buildGamesPlayedFrame(playing, ids));
  if (playing.length === 0 && keepTimer !== null) {
    window.clearInterval(keepTimer);
    keepTimer = null;
  } else if (playing.length > 0 && keepTimer === null) {
    keepTimer = window.setInterval(keepAlive, KEEPALIVE_MS);
  }
  return { ok: true, note: playing.length + " game(s) playing" };
}

function stop(): { ok: boolean; note?: string } {
  const ws = cmSocket();
  const ids = cmIds();
  if (keepTimer !== null) {
    window.clearInterval(keepTimer);
    keepTimer = null;
  }
  const was = playing.length;
  playing = [];
  if (ws && ids) ourSend(ws, buildGamesPlayedFrame([], ids)); // the empty list clears the state
  return { ok: true, note: was + " released" };
}

/** Replay raw bytes exactly as captured (golden-frame debugging path). */
function replayRaw(bytes: number[]): { ok: boolean; note?: string } {
  const ws = cmSocket();
  if (!ws) return { ok: false, note: "open the chat (steamcommunity.com/chat) first" };
  const b = new Uint8Array(bytes);
  ws.send(b);
  // Compare the sid baked into the golden frame with this chat's live sid —
  // that is the difference between "Steam trusts our socket" and "the frame
  // encodes a session Steam already knows".
  let note = "raw frame injected";
  const ids = cmIds();
  if (ids && b.length > 18) {
    const hlen = b[4]! + (b[5]! << 8);
    const start = 8 + 9; // header tag + fixed64 steamid
    let v = 0n;
    let shift = 0n;
    for (let i = start; i < 8 + hlen && i < b.length; i++) {
      v |= BigInt(b[i]! % 128) << shift;
      shift += 7n;
      if (b[i]! < 128) break;
    }
    if (v >= 1n << 63n) v -= 1n << 64n;
    note = "golden sid " + v + ", chat sid " + ids.sessionid + (v === BigInt(ids.sessionid) ? " (SAME)" : " (different)");
  }
  return { ok: true, note };
}

/**
 * The honest receipt: ask Steam itself whether it thinks we are playing.
 * Same-origin fetch of our public profile — the In-Game line there is exactly
 * what a friend (and the drop counter) sees. ws.send() lies; this does not.
 */
async function verify(): Promise<{ ok: boolean; note?: string }> {
  const ids = cmIds();
  if (!ids) return { ok: false, note: "no chat session" };
  try {
    const res = await fetch(`https://steamcommunity.com/profiles/${ids.steamid}?l=english`, {
      credentials: "include",
      cache: "no-store",
    });
    const seen = inGameFromProfileHtml(await res.text());
    if (seen.inGame) return { ok: true, note: "In-Game" + (seen.name ? ": " + seen.name : "") };
    return { ok: false, note: seen.state };
  } catch (e) {
    return { ok: false, note: "profile check failed: " + String(e) };
  }
}

const KEEPALIVE_MS = 25_000;

// --- passive capture -------------------------------------------------------
// A WeakMap guards against wrapping the same socket twice across reconnects.
const hooked = new WeakSet<WebSocket>();

function hookSocket(ws: WebSocket): void {
  if (hooked.has(ws)) return;
  hooked.add(ws);
  const original = ws.send.bind(ws);
  ws.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
    const mine = oursPending;
    oursPending = false;
    try {
      if (data instanceof Uint8Array && frameEMsg(data) === EM_GAMES_PLAYED) {
        window.postMessage(
          { source: cmPlayBridgeName, type: "cm-play/captured", bytes: Array.from(data), mine, at: Date.now() },
          "*"
        );
      }
    } catch {
      /* capture must never break the page's own send */
    }
    return original(data);
  };
}

/** Poll for the chat socket appearing (Steam creates it after login). */
let pollTicks = 0;
const poll = window.setInterval(() => {
  const ws = cm()?.m_Socket;
  if (ws) {
    hookSocket(ws);
    if (hooked.has(ws) && pollTicks > 240) window.clearInterval(poll);
  }
  pollTicks += 1;
  if (pollTicks > 240) window.clearInterval(poll); // 4 minutes: enough for a slow login
}, 1000);

window.addEventListener("message", (event: MessageEvent) => {
  const d = event.data as { source?: string; type?: string; entries?: PlayEntry[]; bytes?: number[] } | null;
  if (!d || d.source !== cmPlayBridgeName) return;
  const ids = cmIds();
  const result =
    d.type === "cm-play/start"
      ? start(d.entries || [])
      : d.type === "cm-play/swap"
        ? setPlaying(d.entries || [])
        : d.type === "cm-play/stop"
          ? stop()
          : d.type === "cm-play/replay"
            ? replayRaw(d.bytes || [])
            : d.type === "cm-play/verify"
              ? null // async; handled below
              : null;
  if (d.type === "cm-play/verify") {
    void verify().then((r) => {
      window.postMessage({ source: cmPlayBridgeName + "-reply", type: d.type, steamid: ids?.steamid ?? null, ...r }, "*");
    });
    return;
  }
  if (result) {
    window.postMessage({ source: cmPlayBridgeName + "-reply", type: d.type, steamid: ids?.steamid ?? null, ...result }, "*");
  }
});

// The page knows us now.
window.postMessage({ source: cmPlayBridgeName, type: "cm-play/ready", at: Date.now() }, "*");
