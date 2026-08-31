/**
 * Talking to an ArchiSteamFarm instance - the honest engine for card farming.
 *
 * Dropping cards is a Steam session protocol, not a web call: a browser
 * extension cannot say it, and the SSR wave removed even the Start Playing
 * button from the gamecards pages. ASF speaks the session protocol properly
 * (SteamKit2) and its web API makes this panel a dispatcher: pick games here,
 * the bot plays them in a stream of up to 32 - the Card Factory trick, done
 * where it belongs.
 *
 * Contract verified against ASF sources (main, 2026-08-31):
 *   POST /Api/Command  body {"Command":"play 440,730"} -> GenericResponse<string>
 *     GenericResponse = { Success: bool, Message: string|null, Result?: T }
 *     Commands run on the default bot; a bot name as first argument retargets
 *     them (Master access).
 *   Auth (ApiAuthenticationMiddleware): with no IPCPassword set, only LOOPBACK
 *     callers are let through (403 otherwise); with a password, it goes in the
 *     ?password= query (401 without it). 5 bad attempts per IP get banned for
 *     an hour - hence: never retry a guessed password.
 *   Commands (wiki, same date): `play <bots?> <appids>` manual farming (the
 *     account must OWN each appid, F2P included), `reset` returns to the
 *     previous playing state, `farm` restarts the automatic module.
 */

import { send } from "./messaging";

export interface AsfConfig {
  url: string;
  /** GlobalConfig's IPCPassword; empty means "instance trusts loopback". */
  password: string;
  /** Bot name to farm with; empty targets ASF's default bot. */
  bot: string;
}

export const ASF_DEFAULTS: AsfConfig = { url: "http://localhost:1242", password: "", bot: "" };

/** Stream size Card Factory uses; ASF plays this many appids in one command. */
export const STREAM_LIMIT = 32;

/** Chunk appids into playing batches, 32 games each. */
export function batchesOf(appids: number[], size = STREAM_LIMIT): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < appids.length; i += size) out.push(appids.slice(i, i + size));
  return out;
}

export function normalizeAsfUrl(raw: string): string {
  let u = raw.trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  return u.replace(/\/+$/, "");
}

/**
 * The commands for a farm run: one `play` per batch, the bot named when the
 * user picked one. `stopCommands` returns the bots to automatic farming.
 */
export function playCommands(cfg: AsfConfig, appids: number[]): string[] {
  const who = cfg.bot.trim() ? cfg.bot.trim() + " " : "";
  return batchesOf(appids).map((b) => `play ${who}${b.join(",")}`);
}

export function stopCommands(cfg: AsfConfig): string[] {
  const who = cfg.bot.trim() ? cfg.bot.trim() + " " : "";
  return [`reset ${who}`.trim()];
}

/** What a refusing bot answers with — play failures arrive inside a 200. */
const REFUSAL = /\b(fail|error|unknown|not owned|invalid)\b/i;

export type AsfAnswer<T> =
  | { ok: true; value?: T; message?: string | null }
  | { ok: false; error: string };

/**
 * One call to the ASF web API. This host is ours, so no Steam pacing - but a
 * timeout, because an unreachable ASF is the common case, not the exception,
 * and a hung promise reads as a hung panel.
 */
/**
 * Commands reach ASF through the worker: a content script's fetch is a page
 * origin call the bot will CORS-reject, and the worker holds the loopback
 * host permission outright.
 */
async function execViaWorker(cfg: AsfConfig, command: string): Promise<AsfAnswer<string>> {
  const base = normalizeAsfUrl(cfg.url);
  if (!base) return { ok: false, error: "URL бота пустой" };
  return send("asf/exec", { url: base, password: cfg.password, command });
}

/** Is the engine there, and is there a bot to farm with? `status` answers both. */
export async function probeAsf(cfg: AsfConfig): Promise<AsfAnswer<string>> {
  return execViaWorker(cfg, "status");
}

/**
 * Commands one after another, stopping at the first failure. Sequential on
 * purpose: ASF runs them through one bot inbox, and fire-and-forget hides
 * which command died. The answer text is kept - it is what the bot replied.
 */
export async function runAsfCommands(
  cfg: AsfConfig,
  commands: string[],
  onEach?: (index: number, command: string) => void
): Promise<{ done: number; failed?: string }> {
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]!;
    onEach?.(i, command);
    const r = await execViaWorker(cfg, command);
    if (!r.ok) return { done: i, failed: `${command} - ${r.error}` };
    /** A play that the bot refused still answers 200 — the text is the verdict. */
    if (command.startsWith("play") && r.value && REFUSAL.test(r.value)) {
      return { done: i, failed: `${command} - ${r.value}` };
    }
  }
  return { done: commands.length };
}

const ASF_KEY = "stw.asf";

export async function loadAsfConfig(): Promise<AsfConfig> {
  const stored = (await chrome.storage.local.get({ [ASF_KEY]: ASF_DEFAULTS })) as {
    [key: string]: Partial<AsfConfig> | undefined;
  };
  return { ...ASF_DEFAULTS, ...stored[ASF_KEY] };
}

export async function saveAsfConfig(cfg: AsfConfig): Promise<void> {
  await chrome.storage.local.set({ [ASF_KEY]: cfg });
}
