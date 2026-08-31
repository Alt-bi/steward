/**
 * Hand-rolled protobuf for exactly one Steam message: ClientGamesPlayed.
 *
 * Steam's protobufjs schema does not live in the chat bundle (their factory
 * encodes server-side — we read their code to learn that), so we encode the
 * packet ourselves. The field map comes from Valve's own published protobufs
 * (SteamDatabase/Protobufs, steammessages_clientserver.proto):
 *
 *   CMsgClientGamesPlayed {
 *     repeated GamePlayed games_played = 1;
 *     optional uint32 client_os_type = 2;
 *     GamePlayed { fixed64 game_id = 2; bool is_secure = 5;
 *                  string game_extra_info = 7; uint32 game_flags = 11 }
 *   }
 *
 * Frame on the CM websocket, captured live from the chat's socket:
 *   uint32le(EMsg | 0x80000000) | uint32le(payload length) | payload
 * Payload = CMsgProtoBufHeader as field 1, then the message's own fields.
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

/** One GamePlayed per entry; presence of the entry is what says "playing". */
export function gamesPlayedBody(entries: PlayEntry[]): number[] {
  const out: number[] = [];
  for (const e of entries) {
    const game = [
      ...fixed64Field(2, BigInt(e.appid)), // game_id, fixed64 per Valve's proto
      ...(e.secure === false ? [] : varField(5, 1)), // is_secure
      ...(e.name ? strField(7, e.name) : []), // game_extra_info
    ];
    out.push(...lenField(1, game));
  }
  // client_os_type = 2: Windows, the way the desktop reports it.
  if (entries.length > 0) out.push(...varField(2, 8));
  return out;
}

/** Full websocket frame: header envelope + message fields + frame prefix. */
export function buildGamesPlayedFrame(entries: PlayEntry[], ids: CmIds): Uint8Array {
  const header = protoBufHeader(ids);
  const body = gamesPlayedBody(entries);
  const payload = [...lenField(1, header), ...body];
  return new Uint8Array([...u32le((EM_GAMES_PLAYED | 0x80000000) >>> 0), ...u32le(payload.length), ...payload]);
}

/** Read the EMsg out of a CM websocket frame; -1 when it isn't one. */
export function frameEMsg(bytes: Uint8Array): number {
  if (bytes.length < 8) return -1;
  const word = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24);
  return word & 0x7fffffff;
}

/** postMessage bridge name; the MAIN script and the content script agree on it. */
export const cmPlayBridgeName = "stw-cm-play";
