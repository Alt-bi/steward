import "./support/env";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildGamesPlayedFrame,
  frameEMsg,
  gamesPlayedBody,
  inGameFromProfileHtml,
  protoBufHeader,
} from "../src/page/cm-play-core";

const hex = (bytes: number[]): string =>
  bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");

/**
 * Captured live from the chat client's CM websocket (unhooked, unedited):
 * a ClientPersonaState frame carries exactly the header we must reproduce —
 * steamid 76561198117744263 (redacted sample below), sessionid -1470582744.
 */
const LIVE_HEADER = "09 87 ee 62 09 01 00 10 01 10 a8 e0 e2 c2 fa ff ff ff ff 01";

describe("cm-play-core", () => {
  it("writes the header byte-for-byte like the live chat frames", () => {
    const got = protoBufHeader({ steamid: "76561198117744263", sessionid: -1470582744 });
    assert.equal(hex(got), LIVE_HEADER);
  });

  it("encodes a play frame the CM will read", () => {
    const frame = buildGamesPlayedFrame(
      [{ appid: 99000, secure: true, name: "CHUCHEL" }],
      { steamid: "76561198117744263", sessionid: 111 }
    );
    assert.equal(frameEMsg(frame), 742);
    const declared = frame[4]! | (frame[5]! << 8) | (frame[6]! << 16) | (frame[7]! << 24);
    assert.equal(declared, frame.length - 8); // length field honest
    // game_id is field 2 fixed64 per Valve's proto, not a varint in field 1
    const body = gamesPlayedBody([{ appid: 99000, secure: false, name: "" }]);
    assert.equal(body[0], 0x0a); // games_played = field 1, length-delimited
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
    const frame = buildGamesPlayedFrame([], { steamid: "76561198117744263", sessionid: 5 });
    assert.equal(frameEMsg(frame), 742);
    const declared = frame[4]! | (frame[5]! << 8) | (frame[6]! << 16) | (frame[7]! << 24);
    assert.equal(declared, frame.length - 8);
  });
});
