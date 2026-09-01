import {
  buildGamesPlayedFrame,
  cmPlayBridgeName,
  frameEMsg,
  readFrameHeader,
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
 * Runs in MAIN world on /chat and /family/chat at document_start: only this
 * page context sees the chat's socket, and only document_start lands before
 * that socket is constructed. Talks to the content script via
 * window.postMessage only — never touches anything else the page owns.
 *
 * Two ways to find the socket, on purpose:
 *  1. `g_FriendsUIApp.m_CMInterface.m_Socket` — Steam's own field, fastest;
 *  2. the `WebSocket.prototype.send` patch below — whichever socket sends a
 *     parseable CM frame IS the CM socket, by evidence rather than by name.
 * Path 1 is a private Steam name with no contract; when it is renamed the farm
 * dies silently. Path 2 cannot be renamed away, and it hands us the
 * steamid/sessionid out of the chat's own heartbeats as a bonus.
 *
 * It also PASSIVELY captures any 742 frame flowing through that socket while
 * our bridge is loaded — including the ones another extension injects. That
 * is how the user's own Card Factory run hands us its golden bytes for
 * comparison, read-only, without us pressing any button for them.
 */

const OPEN = 1; // WebSocket.OPEN, spelled out — the page may redefine the global.
const KEEPALIVE_MS = 25_000;

interface CmShape {
  m_Socket?: WebSocket;
  m_steamid?: { ConvertTo64BitString(): string };
  m_Session?: { m_nSessionID: number };
}

/** The chat's client object; Steam rewrites it on reconnect, so nothing caches it. */
const cm = (): CmShape | undefined =>
  (window as unknown as { g_FriendsUIApp?: { m_CMInterface?: CmShape } }).g_FriendsUIApp?.m_CMInterface;

// --- what the traffic told us ----------------------------------------------
/** The socket that last sent a frame we could parse as CM. Evidence, not a name. */
let sniffedSocket: WebSocket | null = null;
/** ids lifted from that frame's header — survives any Steam field rename. */
let sniffedIds: CmIds | null = null;

const isLive = (ws: unknown): ws is WebSocket =>
  !!ws && typeof (ws as WebSocket).send === "function" && (ws as WebSocket).readyState === OPEN;

/**
 * Last resort: walk the CM interface looking for something that quacks like an
 * open socket. Two levels deep, own properties only — enough to survive a
 * rename of `m_Socket`, cheap enough to run per action.
 */
function findSocketIn(root: unknown, depth = 2): WebSocket | null {
  if (!root || typeof root !== "object" || depth < 0) return null;
  let values: unknown[];
  try {
    values = Object.values(root as Record<string, unknown>);
  } catch {
    return null; // exotic proxies on the page are not ours to poke
  }
  for (const value of values) {
    if (isLive(value) && typeof (value as WebSocket).url === "string") return value;
  }
  if (depth === 0) return null;
  for (const value of values) {
    if (value && typeof value === "object") {
      const found = findSocketIn(value, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/** Where the CM socket hides; re-resolved every action, Steam rewrites it on reconnect. */
const cmSocket = (): WebSocket | null => {
  const named = cm()?.m_Socket;
  if (isLive(named)) return named;
  if (isLive(sniffedSocket)) return sniffedSocket;
  return findSocketIn(cm());
};

const cmIds = (): CmIds | null => {
  const c = cm();
  const steamid = c?.m_steamid?.ConvertTo64BitString?.();
  const sessionid = c?.m_Session?.m_nSessionID;
  if (steamid && typeof sessionid === "number") return { steamid, sessionid: sessionid | 0 };
  // Steam's own outgoing frames carry both ids in every header; the sniffer
  // reads them there, so a renamed m_Session costs us nothing.
  return sniffedIds;
};

let playing: PlayEntry[] = [];
let keepTimer: number | null = null;
/** The socket the current claim was pushed into — a new one means re-claim now. */
let claimedOn: WebSocket | null = null;
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

/**
 * Steam forgets "playing" without company; SLVLUP pings every 15s. We resend
 * the same packet — ClientGamesPlayed is idempotent by design.
 *
 * It is also the reconnect cure: the chat drops and rebuilds its socket on
 * every network hiccup, and a claim pushed into the dead one is gone. Each
 * tick re-resolves the socket, so the new one carries the claim within 25 s
 * without anybody pressing anything.
 */
function keepAlive(): void {
  const ws = cmSocket();
  const ids = cmIds();
  if (!ws || !ids || playing.length === 0) return;
  ourSend(ws, buildGamesPlayedFrame(playing, ids));
  claimedOn = ws;
}

function armKeepAlive(): void {
  if (keepTimer === null) keepTimer = window.setInterval(keepAlive, KEEPALIVE_MS);
}

function disarmKeepAlive(): void {
  if (keepTimer !== null) window.clearInterval(keepTimer);
  keepTimer = null;
}

/** Why we cannot reach Steam right now — the farm's status line prints this verbatim. */
function reachNote(ws: WebSocket | null, ids: CmIds | null): string {
  if (!ws && !ids) return "чат ещё не подключился — дай вкладке чата войти (или обнови её)";
  if (!ws) return "сокет чата закрыт — обнови вкладку чата (F5)";
  return "чат ещё не назвал сессию — пара секунд, он логинится";
}

function start(entries: PlayEntry[]): { ok: boolean; note?: string } {
  const ws = cmSocket();
  const ids = cmIds();
  if (!ws || !ids) return { ok: false, note: reachNote(ws, ids) };
  playing = entries.slice(0, 32); // the stream Card Factory size
  ourSend(ws, buildGamesPlayedFrame(playing, ids));
  claimedOn = ws;
  armKeepAlive();
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
  if (!ws || !ids) return { ok: false, note: reachNote(ws, ids) };
  playing = entries.slice(0, 32);
  ourSend(ws, buildGamesPlayedFrame(playing, ids));
  claimedOn = ws;
  if (playing.length === 0) disarmKeepAlive();
  else armKeepAlive();
  return { ok: true, note: playing.length + " game(s) playing" };
}

function stop(): { ok: boolean; note?: string } {
  const ws = cmSocket();
  const ids = cmIds();
  disarmKeepAlive();
  const was = playing.length;
  playing = [];
  claimedOn = null;
  if (ws && ids) ourSend(ws, buildGamesPlayedFrame([], ids)); // the empty list clears the state
  return { ok: true, note: was + " released" };
}

/**
 * What is actually claimed on the wire right now.
 *
 * The farm keeps its intent in chrome.storage; this is the fact. They part
 * ways on every page reload (and an extension update reloads every Steam
 * tab): storage still says "playing 8", a fresh bridge has claimed nothing.
 * A factory that compares its plan against its own plan happily reports
 * «идёт: в игре 8» while Steam has never been told a thing.
 */
function claimState(): {
  ok: boolean;
  note: string;
  appids: number[];
  socket: boolean;
  ids: boolean;
  keepAlive: boolean;
} {
  const ws = cmSocket();
  const ids = cmIds();
  return {
    ok: !!ws && !!ids,
    note: ws && ids ? `сокет жив, заявлено ${playing.length}` : reachNote(ws, ids),
    appids: playing.map((e) => e.appid),
    socket: !!ws,
    ids: !!ids,
    keepAlive: keepTimer !== null,
  };
}

/** Replay raw bytes exactly as captured (golden-frame debugging path). */
function replayRaw(bytes: number[]): { ok: boolean; note?: string } {
  const ws = cmSocket();
  if (!ws) return { ok: false, note: reachNote(ws, cmIds()) };
  const b = new Uint8Array(bytes);
  ws.send(b);
  // Compare the sid baked into the golden frame with this chat's live sid —
  // that is the difference between "Steam trusts our socket" and "the frame
  // encodes a session Steam already knows".
  const ids = cmIds();
  const golden = readFrameHeader(b);
  if (ids && golden && golden.sessionid !== null) {
    const same = golden.sessionid === ids.sessionid;
    return {
      ok: true,
      note: `golden sid ${golden.sessionid}, chat sid ${ids.sessionid}` + (same ? " (SAME)" : " (different)"),
    };
  }
  return { ok: true, note: "raw frame injected" };
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

// --- watching the traffic --------------------------------------------------

/** Read one outgoing frame: which socket is the CM one, and who we are. */
function observe(ws: WebSocket, data: unknown, mine: boolean): void {
  if (!(data instanceof Uint8Array)) return;
  // Any frame the chat sends identifies the socket AND names us. The heartbeat
  // every ~9 s is enough; we never have to ask Steam's JS for either.
  const head = readFrameHeader(data);
  if (head && head.steamid) {
    sniffedSocket = ws;
    if (head.sessionid !== null) sniffedIds = { steamid: head.steamid, sessionid: head.sessionid };
  }
  if (frameEMsg(data) === EM_GAMES_PLAYED) {
    window.postMessage(
      { source: cmPlayBridgeName, type: "cm-play/captured", bytes: Array.from(data), mine, at: Date.now() },
      "*"
    );
  }
}

/**
 * Watch every WebSocket the page will ever have, by patching the one method
 * they all share.
 *
 * The obvious alternative — replacing `window.WebSocket` with a Proxy — was
 * tried and reverted: swapping a global constructor out from under a page as
 * large as the chat client is a real chance of breaking the chat itself, and a
 * broken chat is indistinguishable from a broken farm. Patching
 * `WebSocket.prototype.send` touches no identity the page can observe, needs
 * no per-socket bookkeeping, and catches sockets that existed before us and
 * every one Steam builds on reconnect.
 *
 * The patch is installed once and delegates to the native `send` no matter
 * what our own code does: an exception on our side must never cost the page
 * a message.
 */
try {
  const proto = WebSocket.prototype as WebSocket & { __stwHooked?: boolean };
  if (!proto.__stwHooked) {
    const nativeSend = proto.send;
    proto.send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
      const mine = oursPending;
      oursPending = false;
      try {
        observe(this, data, mine);
      } catch {
        /* observation must never break the page's own send */
      }
      return nativeSend.call(this, data);
    };
    Object.defineProperty(proto, "__stwHooked", { value: true, enumerable: false });
  }
} catch {
  /* a frozen prototype just means we fall back to the named field below */
}

/**
 * A reconnect leaves the claim on a socket nobody listens to any more. Re-push
 * it the moment a different live socket shows up, instead of waiting out the
 * keep-alive.
 */
window.setInterval(() => {
  if (playing.length === 0) return;
  const live = cmSocket();
  if (live && live !== claimedOn) keepAlive();
}, 2000);

window.addEventListener("message", (event: MessageEvent) => {
  const d = event.data as { source?: string; type?: string; entries?: PlayEntry[]; bytes?: number[] } | null;
  if (!d || d.source !== cmPlayBridgeName) return;
  const reply = (extra: object): void => {
    window.postMessage(
      { source: cmPlayBridgeName + "-reply", type: d.type, steamid: cmIds()?.steamid ?? null, ...extra },
      "*"
    );
  };
  switch (d.type) {
    case "cm-play/start":
      reply(start(d.entries || []));
      return;
    case "cm-play/swap":
      reply(setPlaying(d.entries || []));
      return;
    case "cm-play/stop":
      reply(stop());
      return;
    case "cm-play/replay":
      reply(replayRaw(d.bytes || []));
      return;
    case "cm-play/state":
      reply(claimState());
      return;
    case "cm-play/verify":
      void verify().then(reply);
      return;
    default:
      return;
  }
});

// The page knows us now.
window.postMessage({ source: cmPlayBridgeName, type: "cm-play/ready", at: Date.now() }, "*");
