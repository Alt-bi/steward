import "./support/env";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildGamesPlayedFrame,
  frameEMsg,
  gamesPlayedBody,
  inGameFromProfileHtml,
  protoBufHeader,
  readFrameHeader,
  varintBytes,
} from "../src/page/cm-play-core";

const hex = (bytes: number[]): string =>
  bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");

/**
 * Captured live from the chat client's CM websocket (unhooked, unedited):
 * a ClientPersonaState frame carries exactly the header we must reproduce —
 * redacted steamid, sessionid -1470582744 (a 10-byte negative varint: Steam
 * widens int32 negatives to int64 two's complement).
 */
const LIVE_HEADER = "09 00 10 a6 e8 d2 ff 0f 01 10 a8 e0 e2 c2 fa ff ff ff ff 01";

describe("cm-play-core", () => {
  it("writes the header byte-for-byte like the live chat frames", () => {
    const got = protoBufHeader({ steamid: "76561000000000000", sessionid: -1470582744 });
    assert.equal(hex(got), LIVE_HEADER);
  });

  it("the second u32 is the HEADER length, not the payload length", () => {
    // The golden Card Factory frame (captured off a working farm) is 243 bytes
    // total and declares 15 — the header size. Our first versions wrote the
    // total and wrapped the header in a field; Steam silently ate both.
    const frame = buildGamesPlayedFrame([{ appid: 99000 }], {
      steamid: "76561000000000000",
      sessionid: 1538349215,
    });
    const declared = frame[4]! | (frame[5]! << 8) | (frame[6]! << 16) | (frame[7]! << 24);
    const header = protoBufHeader({ steamid: "76561000000000000", sessionid: 1538349215 });
    assert.equal(declared, header.length);
    assert.equal(frameEMsg(frame), 742);
    // header lands raw after the two words: steamid tag 0x09 at byte 8
    assert.equal(frame[8], 0x09);
  });

  it("a bare appid encodes exactly like the golden frame's games", () => {
    // 20 games of a real farm run were each `0a 09 11 <appid little-endian>`;
    // no secure flags, no names, no os type.
    const body = gamesPlayedBody([{ appid: 461880 }]);
    assert.equal(
      hex(body),
      "0a 09 11 38 0c 07 00 00 00 00 00"
    );
    assert.equal(body.length, 11);
  });

  it("the profile receipt says what Steam sees", () => {
    const playing =
      '<div class="profile_in_game_header">In-Game</div><div class="profile_in_game_name">CHUCHEL</div>';
    const online = '<div class="profile_in_game_header">Currently Online</div>';
    const off = "<div>no badge at all</div>";
    assert.equal(inGameFromProfileHtml(playing).inGame, true);
    assert.equal(inGameFromProfileHtml(playing).name, "CHUCHEL");
    assert.equal(inGameFromProfileHtml(online).inGame, false);
    assert.equal(inGameFromProfileHtml(online).state, "Currently Online");
    assert.equal(inGameFromProfileHtml(off).state, "unknown");
  });

  it("frameEMsg refuses garbage", () => {
    assert.equal(frameEMsg(new Uint8Array([1, 2])), -1);
  });

  it("the empty list stops cleanly and still names itself", () => {
    const frame = buildGamesPlayedFrame([], { steamid: "76561000000000000", sessionid: 5 });
    assert.equal(frameEMsg(frame), 742);
    const declared = frame[4]! | (frame[5]! << 8) | (frame[6]! << 16) | (frame[7]! << 24);
    assert.equal(declared, frame.length - 8); // body is empty, so both agree
  });

  it("negative sessionids widen to int64 like the chat's own frames", () => {
    assert.equal(hex(varintBytes(-1)), "ff ff ff ff ff ff ff ff ff 01");
    assert.equal(hex(varintBytes(0)), "00");
  });
});

describe("readFrameHeader", () => {
  it("reads back the ids we wrote — the sniffer's whole job", () => {
    const frame = buildGamesPlayedFrame([{ appid: 730 }], {
      steamid: "76561000000000000",
      sessionid: -1470582744,
    });
    const head = readFrameHeader(frame);
    assert.equal(head?.emsg, 742);
    assert.equal(head?.steamid, "76561000000000000");
    assert.equal(head?.sessionid, -1470582744);
  });

  it("reads the live chat header off any message, not just ours", () => {
    // The captured ClientPersonaState header, framed as EMsg 703|proto: this
    // is what the chat's own heartbeat looks like, and it names the account
    // without us touching a single Steam JS field.
    const header = LIVE_HEADER.split(" ").map((h) => parseInt(h, 16));
    const word = (703 | 0x80000000) >>> 0;
    const u32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
    const frame = new Uint8Array([...u32(word), ...u32(header.length), ...header, 0x08, 0x01]);
    const head = readFrameHeader(frame);
    assert.equal(head?.emsg, 703);
    assert.equal(head?.steamid, "76561000000000000");
    assert.equal(head?.sessionid, -1470582744);
  });

  it("refuses frames that are not protobuf-framed", () => {
    // No high bit: a plain-struct message carries no CMsgProtoBufHeader.
    assert.equal(readFrameHeader(new Uint8Array([0xd6, 0x02, 0, 0, 0, 0, 0, 0])), null);
    assert.equal(readFrameHeader(new Uint8Array([1, 2])), null);
  });
});
