/**
 * Hand-rolled protobuf for exactly one Steam message: ClientGamesPlayed.
 *
 * The wire format here is NOT guessed: it was diffed byte-for-byte against a
 * real Card Factory frame captured off a working SteamLVLUP session (ring
 * capture, 20 games in one packet — see test/cm-play.test.ts "golden wire").
 *
 * Frame, as the golden bytes show:
 *   uint32le(EMsg | 0x80000000)
 *   uint32le(headerBytes)          // length of the CMsgProtoBufHeader ONLY
 *   CMsgProtoBufHeader: field 1 fixed64 steamid, field 2 varint sessionid
 *   message body follows immediately: repeated field 1 entries, each holding
 *   fixed64 field 2 = game id (bare appid, no type bits)
 */

/** EMsg.k_EServerClientGamesPlayed — named in SteamLVLUP's own constants. */
export const EM_GAMES_PLAYED = 742;

export interface PlayEntry {
  appid: number;
  /** shown in the friends list as "playing ..." — desktop sends the launch info */
  name?: string;
  /** desktop sends true for VAC-secured games; harmless elsewhere */
  secure?: boolean;
}

export interface CmIds {
  /** steamid64 as decimal string. */
  steamid: string;
  /** the chat client's session id, signed int32 as the page stores it */
  sessionid: number;
}

/** protobuf varint, two's-complement for negatives (Steam sends int64). */
export function varintBytes(value: number | bigint): number[] {
  let v = BigInt(value);
  if (v < 0n) v += 1n << 64n;
  const out: number[] = [];
  do {
    out.push(Number(v & 0x7fn) | (v > 0x7fn ? 0x80 : 0));
    v >>= 7n;
  } while (v > 0n);
  return out;
}

const tag = (field: number, wire: number): number[] => varintBytes((field << 3) | wire);

const varField = (field: number, value: number | bigint): number[] => [...tag(field, 0), ...varintBytes(value)];

const lenField = (field: number, bytes: number[]): number[] => [...tag(field, 2), ...varintBytes(bytes.length), ...bytes];

const strField = (field: number, text: string): number[] => lenField(field, Array.from(new TextEncoder().encode(text)));

/** fixed64 — used for the steamid inside CMsgProtoBufHeader and for game_id. */
function fixed64Field(field: number, value: bigint): number[] {
  const out = tag(field, 1);
  let x = BigInt.asUintN(64, value);
  for (let i = 0; i < 8; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}

const u32le = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

/** CMsgProtoBufHeader as the live chat frames write it (verified against two
 * captured frames): field 1 fixed64 steamid, field 2 varint int64 sessionid. */
export function protoBufHeader(ids: CmIds): number[] {
  const steamid = BigInt(ids.steamid);
  const sid = BigInt.asUintN(64, BigInt(ids.sessionid | 0)); // int32 -> int64 two's complement
  return [...fixed64Field(1, steamid), ...varField(2, sid)];
}

/** One GamePlayed per entry; presence of the entry is what says "playing".
 * Golden bytes are minimal: field 1 { fixed64 field 2 = appid }, nothing else. */
export function gamesPlayedBody(entries: PlayEntry[]): number[] {
  const out: number[] = [];
  for (const e of entries) {
    const game = [
      ...fixed64Field(2, BigInt(e.appid)), // game_id, fixed64, bare appid
      ...(e.secure === true ? varField(5, 1) : []), // is_secure — only when asked
      ...(e.name ? strField(7, e.name) : []), // game_extra_info
    ];
    out.push(...lenField(1, game));
  }
  return out;
}

/** Full websocket frame, byte-for-byte per the captured golden frame:
 * u32(EMsg|0x80000000), u32(header length), raw header, raw body. */
export function buildGamesPlayedFrame(entries: PlayEntry[], ids: CmIds): Uint8Array {
  const header = protoBufHeader(ids);
  const body = gamesPlayedBody(entries);
  return new Uint8Array([
    ...u32le((EM_GAMES_PLAYED | 0x80000000) >>> 0),
    ...u32le(header.length),
    ...header,
    ...body,
  ]);
}

/** Read the EMsg out of a CM websocket frame; -1 when it isn't one. */
export function frameEMsg(bytes: Uint8Array): number {
  if (bytes.length < 8) return -1;
  const word = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24);
  return word & 0x7fffffff;
}

/** postMessage bridge name; the MAIN script and the content script agree on it. */
export const cmPlayBridgeName = "stw-cm-play";

/**
 * Read the one line that matters from a public profile page: does Steam think
 * this account is playing something right now? This is what a friend sees —
 * and what the drop counter trusts. ws.send() is a transport fact; this is the
 * receipt.
 */
export function inGameFromProfileHtml(html: string): { inGame: boolean; state: string; name?: string } {
  const header = /profile_in_game_header">([^<]*)</.exec(html);
  const name = /profile_in_game_name">([^<]*)</.exec(html);
  const state = (header?.[1] ?? "unknown").trim();
  return { inGame: /In-Game/i.test(state), state, name: name?.[1]?.trim() };
}

// --- reading frames back ---------------------------------------------------

/** One protobuf varint at `at`; null when the bytes run out mid-number. */
function readVarint(bytes: Uint8Array, at: number): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  for (let i = at; i < bytes.length && i - at < 10; i++) {
    const b = bytes[i]!;
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i + 1 };
    shift += 7n;
  }
  return null;
}

export interface FrameHeader {
  emsg: number;
  /** steamid64 as decimal string, when the header carried one. */
  steamid: string | null;
  /** the CM session id, as the signed int32 Steam means. */
  sessionid: number | null;
}

/**
 * Read EMsg and the CMsgProtoBufHeader ids out of ANY proto-framed CM message.
 *
 * This is the load-bearing fallback: `g_FriendsUIApp.m_CMInterface.m_Session`
 * is Steam's private field name and it has no contract with us. Every frame
 * the chat itself sends — heartbeats included — carries the same two ids in
 * its header, so sniffing one outgoing frame tells us who we are without
 * reading a single Steam internal.
 */
export function readFrameHeader(bytes: Uint8Array): FrameHeader | null {
  if (bytes.length < 8) return null;
  const word = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
  if ((word & 0x80000000) === 0) return null; // plain (non-protobuf) framing
  const emsg = word & 0x7fffffff;
  const hlen = (bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24)) >>> 0;
  const end = Math.min(8 + hlen, bytes.length);

  let i = 8;
  let steamid: string | null = null;
  let sessionid: number | null = null;
  while (i < end) {
    const tag = readVarint(bytes, i);
    if (!tag) break;
    i = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const v = readVarint(bytes, i);
      if (!v) break;
      i = v.next;
      if (field === 2) sessionid = Number(BigInt.asIntN(64, v.value)) | 0;
    } else if (wire === 1) {
      if (i + 8 > end) break;
      if (field === 1) {
        let x = 0n;
        for (let k = 7; k >= 0; k--) x = (x << 8n) | BigInt(bytes[i + k]!);
        steamid = x.toString();
      }
      i += 8;
    } else if (wire === 2) {
      const len = readVarint(bytes, i);
      if (!len) break;
      i = len.next + Number(len.value);
    } else if (wire === 5) {
      i += 4;
    } else {
      break;
    }
  }
  return { emsg, steamid, sessionid };
}
