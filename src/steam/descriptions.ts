import type { Pacing } from "./net";
import { fetchText, SteamError } from "./net";

/**
 * What an item on the trade-offers page actually is.
 *
 * The offers list renders items as pictures: every tile carries only
 * `classinfo/{appid}/{classid}/{instanceid}`, and the name arrives later, when the
 * user hovers. Without the name there is no market_hash_name, and without that
 * there is no price — so an inbox cannot be valued from the page alone.
 *
 * This is the one place in the extension that asks Steam about something the page
 * did not already say. It is affordable because a class is immutable: «Chroma
 * Case» has meant the same thing since it existed, so an answer is kept and never
 * asked for twice.
 */

export interface ClassRef {
  appid: number;
  classid: string;
  instanceid: string;
}

export interface ItemClass extends ClassRef {
  key: string;
  /** market_hash_name — what every price endpoint wants. */
  hash: string;
  name: string;
  marketable: boolean;
  tradable: boolean;
}

export function classKey(ref: ClassRef): string {
  return `${ref.appid}:${ref.classid}:${ref.instanceid || "0"}`;
}

/**
 * `l=english` on purpose. The display name is localized, market_hash_name is not,
 * and asking in the page's language to make one label prettier would risk the
 * field the prices are keyed by.
 */
export function hoverUrl(ref: ClassRef): string {
  return (
    "https://steamcommunity.com/economy/itemclasshover/" +
    `${ref.appid}/${ref.classid}/${ref.instanceid || "0"}` +
    "?content_only=1&l=english&omit_owner=1"
  );
}

/**
 * The object inside `BuildHover( 'hover', {…}, UserYou )`.
 *
 * Walked rather than matched with a regex: descriptions carry item names, and an
 * item name is allowed to contain a brace. Counting them while respecting strings
 * is the only way to find where the object ends.
 */
export function extractHoverJson(text: string): string | null {
  const body = String(text ?? "");
  const call = body.indexOf("BuildHover");
  const start = body.indexOf("{", call < 0 ? 0 : call);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

interface RawDescription {
  market_hash_name?: string;
  market_name?: string;
  name?: string;
  marketable?: number | string | boolean;
  tradable?: number | string | boolean;
}

function flag(value: number | string | boolean | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return value === true || value === 1 || value === "1";
}

export function parseItemClass(ref: ClassRef, text: string): ItemClass | null {
  const json = extractHoverJson(text);
  if (!json) return null;

  let raw: RawDescription;
  try {
    raw = JSON.parse(json) as RawDescription;
  } catch {
    return null;
  }

  const hash = String(raw.market_hash_name ?? "").trim();
  const name = String(raw.market_name ?? raw.name ?? "").trim() || hash;
  /** A description with no name at all is not an answer, it is a shell. */
  if (!hash && !name) return null;

  return {
    ...ref,
    key: classKey(ref),
    hash,
    name,
    /** Steam omits both flags when they are true. */
    marketable: flag(raw.marketable, true),
    tradable: flag(raw.tradable, true),
  };
}

export async function fetchItemClass(ref: ClassRef, pacing: Pacing): Promise<ItemClass> {
  const text = await fetchText(hoverUrl(ref), {
    kind: "description",
    ...pacing,
    isEmpty: (body) => !String(body).includes("BuildHover"),
  });
  const parsed = parseItemClass(ref, text);
  if (!parsed) throw new SteamError("bad_json", "hover_unreadable");
  return parsed;
}

/* ------------------------------------------------------------------ the store */

const STORE_KEY = "stwItemClasses";

/** Enough for a very full inbox many times over; beyond it the oldest go. */
const STORE_CAP = 4000;

type StoredClass = Pick<ItemClass, "hash" | "name" | "marketable" | "tradable">;
type Store = Record<string, StoredClass>;

let memory: Store | null = null;

async function loadStore(): Promise<Store> {
  if (memory) return memory;
  try {
    const got = (await chrome.storage.local.get({ [STORE_KEY]: {} })) as Record<string, unknown>;
    const raw = got[STORE_KEY];
    memory = raw && typeof raw === "object" ? ({ ...raw } as Store) : {};
  } catch {
    /** No storage is a slower scan, never a failed one. */
    memory = {};
  }
  return memory;
}

async function saveStore(store: Store): Promise<void> {
  const keys = Object.keys(store);
  const trimmed =
    keys.length <= STORE_CAP
      ? store
      : Object.fromEntries(keys.slice(keys.length - STORE_CAP).map((k) => [k, store[k]!]));
  memory = trimmed;
  try {
    await chrome.storage.local.set({ [STORE_KEY]: trimmed });
  } catch {
    /* The scan already has its answers; failing to keep them is not a failure. */
  }
}

/** Drops what we learned, for the same reason the price cache can be dropped. */
export async function clearItemClasses(): Promise<void> {
  memory = {};
  try {
    await chrome.storage.local.set({ [STORE_KEY]: {} });
  } catch {
    /* nothing to undo */
  }
}

/**
 * Which of these we have never asked about.
 *
 * Exists so a caller can say what a scan will cost *before* starting it: a full
 * inbox of unfamiliar items is one request each, and a user who is told «this is
 * 300 requests» can decide, while a user watching a progress bar cannot.
 */
export async function unknownClasses(refs: readonly ClassRef[]): Promise<ClassRef[]> {
  const store = await loadStore();
  const out = new Map<string, ClassRef>();
  for (const ref of refs) {
    if (!ref.appid || !ref.classid) continue;
    const key = classKey(ref);
    if (store[key] || out.has(key)) continue;
    out.set(key, ref);
  }
  return [...out.values()];
}

export interface ResolveOptions extends Pacing {
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface ResolveResult {
  /** Class key -> what it is, or null when Steam would not say. */
  classes: Record<string, ItemClass | null>;
  /** Refs we never resolved. Feed them back to continue where we stopped. */
  unresolved: ClassRef[];
  stopped: "blocked" | "aborted" | null;
  requests: number;
  fromCache: number;
}

function stopKind(err: unknown): "blocked" | "aborted" | null {
  if (!(err instanceof SteamError)) return null;
  if (err.kind === "aborted") return "aborted";
  if (err.kind === "blocked" || err.kind === "rate_limited") return "blocked";
  return null;
}

export async function resolveItemClasses(
  refs: readonly ClassRef[],
  opts: ResolveOptions = {}
): Promise<ResolveResult> {
  const result: ResolveResult = {
    classes: {},
    unresolved: [],
    stopped: null,
    requests: 0,
    fromCache: 0,
  };
  if (!refs.length) return result;

  /** One request per class, however many tiles across however many offers share it. */
  const wanted = new Map<string, ClassRef>();
  for (const ref of refs) {
    if (!ref.appid || !ref.classid) continue;
    const key = classKey(ref);
    if (!wanted.has(key)) wanted.set(key, ref);
  }

  const store = await loadStore();
  const todo: ClassRef[] = [];
  for (const [key, ref] of wanted) {
    const hit = store[key];
    if (hit) {
      result.classes[key] = { ...ref, key, ...hit };
      result.fromCache += 1;
    } else {
      todo.push(ref);
    }
  }
  if (!todo.length) return result;

  let next = 0;
  let halted = false;
  let done = result.fromCache;
  let learned = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (halted) return;
      if (opts.abort?.()) {
        result.stopped ??= "aborted";
        halted = true;
        return;
      }
      const ref = todo[next++];
      if (!ref) return;

      try {
        const found = await fetchItemClass(ref, { abort: opts.abort, onWait: opts.onWait });
        result.requests += 1;
        result.classes[found.key] = found;
        store[found.key] = {
          hash: found.hash,
          name: found.name,
          marketable: found.marketable,
          tradable: found.tradable,
        };
        learned += 1;
      } catch (err) {
        const stop = stopKind(err);
        if (stop) {
          result.stopped ??= stop;
          halted = true;
          return;
        }
        if (err instanceof SteamError && err.kind === "not_logged_in") {
          halted = true;
          throw err;
        }
        result.requests += 1;
        /** Left unresolved rather than cached as nothing: a bad answer is not a fact. */
      }
      done += 1;
      opts.onProgress?.(done, wanted.size);
    }
  }

  const size = Math.max(1, Math.min(opts.concurrency ?? 2, todo.length));
  try {
    await Promise.all(Array.from({ length: size }, () => worker()));
  } finally {
    if (learned) await saveStore(store);
  }

  for (const ref of todo) {
    const key = classKey(ref);
    if (result.classes[key] == null) {
      result.classes[key] = null;
      result.unresolved.push(ref);
    }
  }
  return result;
}
