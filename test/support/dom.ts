/**
 * Just enough DOM to mount a panel section in node.
 *
 * Every «ничего не работает» in this project so far could have been a feature
 * whose `mount()` threw — `boot()` catches that per feature, so the panel comes
 * up with an empty tab and the console line scrolls past. Nothing offline could
 * catch it, because nothing offline ever built the interface. This does.
 *
 * It is deliberately small and installed on demand: `installDom()` swaps the
 * globals, the returned `restore()` puts them back, so the other 698 tests keep
 * the lean stub from `support/env`.
 */

import { cmPlayBridgeName } from "../../src/page/cm-play-core";
import { postFromPage } from "./env";

interface FakeNode {
  nodeType: number;
  textContent: string;
}

export interface FakeElement extends FakeNode {
  tagName: string;
  className: string;
  id: string;
  title: string;
  type: string;
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  value: string;
  children: (FakeElement | FakeNode)[];
  dataset: Record<string, string>;
  style: Record<string, unknown>;
  classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    toggle(name: string, on?: boolean): void;
    contains(name: string): boolean;
  };
  listeners: Map<string, ((event: unknown) => void)[]>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  append(...nodes: (FakeElement | FakeNode | string)[]): void;
  appendChild(node: FakeElement | FakeNode): FakeElement | FakeNode;
  replaceChildren(...nodes: (FakeElement | FakeNode | string)[]): void;
  remove(): void;
  closest(selector: string): FakeElement | null;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
  addEventListener(type: string, fn: (event: unknown) => void): void;
  removeEventListener(type: string, fn: (event: unknown) => void): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

/**
 * A deliberately small selector matcher: comma lists of `tag`, `.class`, `#id`
 * and one trailing attribute test (`[a]`, `[a="v"]`, `[a^="v"]`, `[a*="v"]`).
 *
 * That is every selector this codebase actually hands a node — including the
 * market's `.market_listing_row[id^="mylisting_"], [id^="mylisting_"]`. It is
 * not a CSS engine and must not grow into one: anything richer is a second
 * implementation of the browser to keep honest, and the point of the shim is
 * to run our code, not to reimplement theirs.
 */
const ATTR = /\[([\w-]+)(?:([~^*$|]?=)"([^"]*)")?\]/;

function matchesOne(node: FakeElement, selector: string): boolean {
  let sel = selector.trim();
  if (!sel) return false;

  const attr = ATTR.exec(sel);
  if (attr) {
    sel = sel.replace(ATTR, "").trim();
    const [, name, op, want] = attr;
    const have = node.getAttribute(name!);
    if (have === null) return false;
    if (op === "=" && have !== want) return false;
    if (op === "^=" && !have.startsWith(want!)) return false;
    if (op === "*=" && !have.includes(want!)) return false;
  }

  if (!sel) return true;
  if (sel.startsWith(".")) return node.classList.contains(sel.slice(1));
  if (sel.startsWith("#")) return node.id === sel.slice(1);
  const [tag, ...classes] = sel.split(".");
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  return classes.every((c) => node.classList.contains(c));
}

function matches(node: FakeElement, selector: string): boolean {
  return String(selector).split(",").some((part) => matchesOne(node, part));
}

function descendants(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of root.children) {
    if (child.nodeType !== 1) continue;
    const element = child as FakeElement;
    out.push(element, ...descendants(element));
  }
  return out;
}

function textNode(text: string): FakeNode {
  return { nodeType: 3, textContent: text };
}

export function createElement(tagName: string): FakeElement {
  const classes = new Set<string>();
  const attrs: Record<string, string> = {};
  let ownText = "";
  const node: FakeElement = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    className: "",
    id: "",
    title: "",
    type: "",
    hidden: false,
    disabled: false,
    checked: false,
    value: "",
    children: [],
    dataset: {},
    style: {},
    listeners: new Map(),
    getAttribute: (name) => {
      if (name === "id") return node.id || null;
      if (name === "class") return node.className || null;
      if (name === "title") return node.title || null;
      return attrs[name] ?? null;
    },
    setAttribute: (name, value) => {
      if (name === "id") node.id = value;
      else if (name === "class") node.className = value;
      else attrs[name] = value;
    },
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (name, on) => {
        const want = on ?? !classes.has(name);
        if (want) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    append(...nodes) {
      for (const n of nodes) node.children.push(typeof n === "string" ? textNode(n) : n);
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    /** Redrawing a list is `replaceChildren(...rows)` in half the features. */
    replaceChildren(...nodes) {
      node.children.length = 0;
      node.append(...nodes);
    },
    remove() {
      /* nothing owns a parent pointer here; a removed node is simply dropped */
    },
    // Selector support is deliberately tiny: `.class`, `tag`, and `#id` only.
    // Anything richer would be a second CSS engine to keep honest.
    closest: (selector) => (matches(node, selector) ? node : null),
    querySelector: (selector) => descendants(node).find((n) => matches(n, selector)) ?? null,
    querySelectorAll: (selector) => descendants(node).filter((n) => matches(n, selector)),
    addEventListener(type, fn) {
      const list = node.listeners.get(type) ?? [];
      list.push(fn);
      node.listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = (node.listeners.get(type) ?? []).filter((f) => f !== fn);
      node.listeners.set(type, list);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    get textContent(): string {
      return ownText + node.children.map((c) => c.textContent).join("");
    },
    /** Matches the browser: assigning textContent replaces every child. */
    set textContent(value: string) {
      node.children.length = 0;
      ownText = value;
    },
  } as FakeElement;
  // `className` is a plain field, but the class list has to see it too.
  Object.defineProperty(node, "className", {
    get: () => [...classes].join(" "),
    set: (value: string) => {
      classes.clear();
      String(value ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .forEach((n) => classes.add(n));
    },
    enumerable: true,
  });
  return node;
}

/** Depth-first walk over an element tree. */
export function walk(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (node: FakeElement | FakeNode): void => {
    if (node.nodeType !== 1) return;
    const element = node as FakeElement;
    out.push(element);
    for (const child of element.children) visit(child);
  };
  visit(root);
  return out;
}

/** Fire an element's listeners for one event type, as a click would. */
export function fire(node: FakeElement, type = "click"): void {
  for (const fn of node.listeners.get(type) ?? []) fn({ type, target: node });
}

/** Every element of a tag, by tag name. */
export function byTag(root: FakeElement, tagName: string): FakeElement[] {
  return walk(root).filter((n) => n.tagName === tagName.toUpperCase());
}

export interface DomHandle {
  root: FakeElement;
  /** Timers armed while the shim was installed; none of them actually fire. */
  intervals: { ms: number; fn: () => void }[];
  restore(): void;
}

/**
 * Swap in the shim. Timers are recorded rather than armed — a smoke test must
 * not leave a farm heartbeat running in the test process.
 */
export interface DomExtras {
  /** Nodes `document.getElementById` should find — a page Steam already drew. */
  byId?: Record<string, FakeElement>;
  /** `document.scripts`, which is where /market keeps its item-hover blob. */
  scripts?: { textContent: string }[];
}

export function installDom(
  url = "https://steamcommunity.com/chat/#stw-farm",
  extras: DomExtras = {}
): DomHandle {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    document: g.document,
    location: g.location,
    setInterval: g.setInterval,
    clearInterval: g.clearInterval,
    chromeStorage: (g.chrome as { storage?: Record<string, unknown> } | undefined)?.storage,
  };

  const root = createElement("html");
  const intervals: { ms: number; fn: () => void }[] = [];

  g.document = {
    cookie: "",
    documentElement: root,
    body: createElement("body"),
    createElement: (tag: string) => createElement(tag),
    createTextNode: (text: string) => textNode(text),
    getElementById: (id: string) => extras.byId?.[id] ?? null,
    querySelector: (sel: string) =>
      Object.values(extras.byId ?? {})
        .flatMap((node) => [node, ...walk(node)])
        .find((node) => matches(node, sel)) ?? null,
    querySelectorAll: (sel: string) =>
      Object.values(extras.byId ?? {})
        .flatMap((node) => [node, ...walk(node)])
        .filter((node) => matches(node, sel)),
    scripts: extras.scripts ?? [],
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  };
  g.location = new URL(url);
  g.setInterval = ((fn: () => void, ms: number) => intervals.push({ ms, fn })) as unknown;
  g.clearInterval = (() => {}) as unknown;

  // storage.onChanged is real in the browser and missing from the lean stub;
  // a feature that subscribes to it would throw on mount without this.
  const chrome = g.chrome as { storage: Record<string, unknown> };
  chrome.storage = { ...chrome.storage, onChanged: { addListener: () => {} } };

  return {
    root,
    intervals,
    restore(): void {
      g.document = saved.document;
      g.location = saved.location;
      g.setInterval = saved.setInterval;
      g.clearInterval = saved.clearInterval;
      if (saved.chromeStorage) (g.chrome as { storage: unknown }).storage = saved.chromeStorage;
    },
  };
}

/**
 * A chat bridge that answers.
 *
 * `bridgeCall` posts to the page world and waits five seconds for a reply that
 * never comes in tests — so anything the factory does with the socket either
 * hangs the suite or is quietly written off as «чат не ответил», and the code
 * paths that matter most go untested. This answers like the MAIN bridge does:
 * on a later turn of the loop, addressed to the same message type.
 */
export interface FakeBridge {
  /** Every payload the panel posted, in order. */
  calls: { type: string; entries?: { appid: number }[] }[];
  /** appids the fake socket currently claims. */
  claimed: number[];
  restore(): void;
}

export function installBridge(name = cmPlayBridgeName, ok = true): FakeBridge {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.postMessage;
  const bridge: FakeBridge = {
    calls: [],
    claimed: [],
    restore(): void {
      g.postMessage = saved;
    },
  };

  g.postMessage = (data: unknown) => {
    const d = data as { source?: string; type?: string; entries?: { appid: number }[] };
    if (d?.source !== name || !d.type) return;
    bridge.calls.push({ type: d.type, entries: d.entries });
    if (ok) {
      if (d.type === "cm-play/swap" || d.type === "cm-play/start") {
        bridge.claimed = (d.entries ?? []).map((e) => e.appid);
      }
      if (d.type === "cm-play/stop") bridge.claimed = [];
    }
    const reply = {
      source: `${name}-reply`,
      type: d.type,
      ok,
      note: ok ? `сокет жив, заявлено ${bridge.claimed.length}` : "сокет чата не найден",
      appids: [...bridge.claimed],
    };
    // A real bridge answers on a later turn, never on this call stack.
    setTimeout(() => postFromPage(reply), 0);
  };
  return bridge;
}

/**
 * DOMParser for the test env: markup string in, queryable tree out.
 *
 * The SSR market hands listing rows as a JSON string, so `parseMarkup()` must
 * build a document that was never rendered — and the tests must exercise that
 * same path. Deliberately tiny: tags, attributes, nesting, text. No scripts,
 * no self-closing cleverness beyond the known void elements, numeric entities
 * only for the handful the market markup actually ships.
 */
const VOID_TAGS = new Set(["img", "br", "input", "meta", "link", "hr", "source"]);

const TAG = /<\/?([a-zA-Z][\w-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s">]+))?)*)\s*(\/?)>/g;
const ATTR_PAIR = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+)))?/g;

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

function applyAttributes(node: FakeElement, source: string | undefined): void {
  if (!source) return;
  ATTR_PAIR.lastIndex = 0;
  let m = ATTR_PAIR.exec(source);
  while (m) {
    const name = m[1]!;
    const value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    node.setAttribute(name, value);
    if (name === "href" || name === "src") {
      // href/href-shaped attributes double as data in market rows.
    }
    m = ATTR_PAIR.exec(source);
  }
}

function parseMarkupTree(source: string): FakeElement {
  const root = createElement("div");
  const stack: FakeElement[] = [root];
  let at = 0;
  TAG.lastIndex = 0;
  let m = TAG.exec(source);
  while (m) {
    const text = source.slice(at, m.index);
    if (text) stack[stack.length - 1]!.append(decodeEntities(text));
    at = TAG.lastIndex;
    const [full, name, attrs, selfClose] = m as unknown as [string, string, string | undefined, string | undefined];
    if (full.startsWith("</")) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tagName === name.toUpperCase()) {
          stack.length = i;
          break;
        }
      }
    } else if (!VOID_TAGS.has(name.toLowerCase()) && !selfClose) {
      const el2 = createElement(name);
      applyAttributes(el2, attrs);
      stack[stack.length - 1]!.appendChild(el2);
      stack.push(el2);
    } else {
      const el2 = createElement(name);
      applyAttributes(el2, attrs);
      stack[stack.length - 1]!.appendChild(el2);
    }
    m = TAG.exec(source);
  }
  const rest = source.slice(at);
  if (rest) stack[stack.length - 1]!.append(decodeEntities(rest));
  return root;
}

class FakeDOMParser {
  parseFromString(source: string, _type?: string): {
    querySelectorAll(selector: string): FakeElement[];
    querySelector(selector: string): FakeElement | null;
  } {
    const body = parseMarkupTree(source);
    return {
      querySelectorAll: (selector) => body.querySelectorAll(selector),
      querySelector: (selector) => body.querySelector(selector),
    };
  }
}
(globalThis as { DOMParser?: unknown }).DOMParser = FakeDOMParser;
