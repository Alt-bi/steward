import "./support/env";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ASF_DEFAULTS,
  batchesOf,
  loadAsfConfig,
  playCommands,
  probeAsf,
  runAsfCommands,
  saveAsfConfig,
  stopCommands,
} from "../src/core/asf";
import { asfCalls, resetEnv, setAsf } from "./support/env";

describe("asf batching — the 32-game stream", () => {
  it("splits 40 games into 32 + 8", () => {
    const ids = Array.from({ length: 40 }, (_, i) => 1000 + i);
    const batches = batchesOf(ids);
    assert.deepEqual(batches.map((b) => b.length), [32, 8]);
  });

  it("leaves a short list alone", () => {
    assert.deepEqual(batchesOf([440]), [[440]]);
    assert.deepEqual(batchesOf([]), []);
  });
});

describe("asf commands — the shape ASF understands", () => {
  it("names the bot first, appids comma-joined", () => {
    const cmds = playCommands({ ...ASF_DEFAULTS, bot: "jo" }, [440, 730]);
    assert.deepEqual(cmds, ["play jo 440,730"]);
  });

  it("targets the default bot when the name is blank", () => {
    assert.deepEqual(playCommands(ASF_DEFAULTS, [440]), ["play 440"]);
  });

  it("stops by handing bots back with reset", () => {
    assert.deepEqual(stopCommands(ASF_DEFAULTS), ["reset"]);
    assert.deepEqual(stopCommands({ ...ASF_DEFAULTS, bot: "jo" }), ["reset jo"]);
  });
});

describe("asf run — commands through the worker bus", () => {
  it("sends play, then reports the whole stream standing", async () => {
    await resetEnv();
    const r = await runAsfCommands(ASF_DEFAULTS, ["play 440", "play 730"]);
    assert.deepEqual(asfCalls, ["play 440", "play 730"]);
    assert.equal(r.done, 2);
    assert.equal(r.failed, undefined);
  });

  it("stops at a refusal and names the command that failed", async () => {
    await resetEnv();
    setAsf(({ command }) =>
      command.includes("730") ? { ok: false, error: "HTTP 400" } : { ok: true, value: "OK" }
    );
    const r = await runAsfCommands(ASF_DEFAULTS, ["play 440", "play 730"]);
    assert.deepEqual(asfCalls, ["play 440", "play 730"]);
    assert.equal(r.done, 1);
    assert.match(r.failed ?? "", /play 730.*HTTP 400/);
  });

  it("reads a refusal hidden in a 200 answer", async () => {
    await resetEnv();
    setAsf(() => ({ ok: true, value: "Error: You don't own this game" }));
    const r = await runAsfCommands(ASF_DEFAULTS, ["play 440"]);
    assert.match(r.failed ?? "", /don't own/);
  });

  it("refuses before the bus when the url is blank", async () => {
    await resetEnv();
    const r = await probeAsf({ ...ASF_DEFAULTS, url: "  " });
    assert.equal(r.ok, false);
    assert.equal(asfCalls.length, 0);
  });

  it("keeps the bot settings where the next tab finds them", async () => {
    await resetEnv();
    await saveAsfConfig({ url: "http://127.0.0.1:1242", password: "hunter2", bot: "jo" });
    const cfg = await loadAsfConfig();
    assert.equal(cfg.url, "http://127.0.0.1:1242");
    assert.equal(cfg.bot, "jo");
  });
});
