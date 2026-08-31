/**
 * Small panel choices that should survive a page turn.
 *
 * Not settings: nothing here changes what the extension does to Steam, and none
 * of it belongs in the popup. It is the sort order you picked, the price level you
 * are working at, the filter you left on — the things that are infuriating to
 * re-pick every time Steam paginates, and that nobody would go to a settings
 * screen to configure.
 *
 * Deliberately fail-quiet in both directions: a missing value is the default, and
 * a storage error is a forgotten preference, never a broken panel.
 */

const STORE_KEY = "stwPrefs";

type Prefs = Record<string, unknown>;

let memory: Prefs | null = null;

async function load(): Promise<Prefs> {
  if (memory) return memory;
  try {
    const got = (await chrome.storage.local.get({ [STORE_KEY]: {} })) as Record<string, unknown>;
    const raw = got[STORE_KEY];
    memory = raw && typeof raw === "object" ? ({ ...raw } as Prefs) : {};
  } catch {
    memory = {};
  }
  return memory;
}

/**
 * `allowed` is the whole validation story on purpose. A stored preference is
 * data from disk that outlives the version that wrote it, so a value that is no
 * longer one of the options has to fall back rather than reach a `switch`.
 */
export async function loadPref<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T
): Promise<T> {
  const prefs = await load();
  const value = prefs[key];
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export async function loadFlag(key: string, fallback: boolean): Promise<boolean> {
  const prefs = await load();
  const value = prefs[key];
  return typeof value === "boolean" ? value : fallback;
}

export async function savePref(key: string, value: string | boolean): Promise<void> {
  const prefs = await load();
  prefs[key] = value;
  try {
    await chrome.storage.local.set({ [STORE_KEY]: prefs });
  } catch {
    /* A forgotten preference is a small loss; a thrown one would break the panel. */
  }
}
