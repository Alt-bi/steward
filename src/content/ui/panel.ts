/**
 * The shared on-page shell. Features do not build their own windows — they ask
 * the panel for a section and fill it, so a second or third feature costs no
 * layout work and the user only ever drags one box around.
 */

export type StatusKind = "" | "work" | "ok" | "warn" | "err";

export interface Section {
  readonly id: string;
  readonly body: HTMLElement;
  /**
   * The headline, and everything that qualifies it.
   *
   * A run has one result and several caveats, and printing them as one
   * paragraph buries the result: four lines of text where the sentence that
   * matters is the first eight words. `detail` folds away under «подробнее»,
   * closed, until someone wants it.
   */
  setStatus(text: string, kind?: StatusKind, detail?: string): void;
  show(): void;
}

const ROOT_ID = "stw-root";
const POSITION_KEY = "stwPanelPos";
const WIDTH_KEY = "stwPanelWidth";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class Panel {
  readonly root: HTMLElement;
  private readonly tabsBar: HTMLElement;
  private readonly stack: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly sections = new Map<
    string,
    { tab: HTMLButtonElement; wrap: HTMLElement; title: string }
  >();
  private active: string | null = null;

  constructor() {
    this.root = el("div", "stw-panel");
    this.root.id = ROOT_ID;

    const head = el("div", "stw-head");
    const titles = el("div", "stw-titles");
    /**
     * The version belongs in the corner the user actually looks at. Without it,
     * a session running a build from before a fix reports that fix's bugs
     * verbatim — every "still broken" report is a version check first. It is a
     * footnote to the name, not a second heading, so it is written like one.
     */
    const title = el("div", "stw-title");
    title.append(
      document.createTextNode("Steward"),
      el("span", "stw-ver", chrome.runtime.getManifest().version)
    );
    /**
     * The subtitle used to list the tabs — the same words the tab bar under it
     * was already showing, in a quieter colour. It now names the section only
     * when there is no tab bar to name it.
     */
    this.subtitle = el("div", "stw-sub", "");
    titles.append(title, this.subtitle);

    const collapse = el("button", "stw-iconbtn", "–");
    collapse.type = "button";
    collapse.title = "Свернуть";
    collapse.addEventListener("click", () => {
      const folded = this.root.classList.toggle("stw-collapsed");
      collapse.textContent = folded ? "+" : "–";
      collapse.title = folded ? "Развернуть" : "Свернуть";
    });

    head.append(titles, collapse);

    this.tabsBar = el("div", "stw-tabs");
    this.stack = el("div", "stw-stack");

    this.root.append(head, this.tabsBar, this.stack);
    document.documentElement.appendChild(this.root);

    this.restorePosition();
    this.makeDraggable(head);
    this.rememberWidth();
  }

  addSection(id: string, title: string): Section {
    const wrap = el("div", "stw-section");
    wrap.dataset.section = id;
    wrap.hidden = true;

    const status = el("div", "stw-status");
    const statusLine = el("div", "stw-status-line");
    const statusMore = document.createElement("details");
    statusMore.className = "stw-status-more";
    const statusSummary = el("summary", "stw-status-summary", "подробнее");
    const statusDetail = el("div", "stw-status-detail");
    statusMore.append(statusSummary, statusDetail);
    statusMore.hidden = true;
    status.append(statusLine, statusMore);
    const body = el("div", "stw-body");
    wrap.append(status, body);
    this.stack.appendChild(wrap);

    const tab = el("button", "stw-tab", title);
    tab.type = "button";
    tab.addEventListener("click", () => this.activate(id));
    this.tabsBar.appendChild(tab);

    this.sections.set(id, { tab, wrap, title });
    this.tabsBar.hidden = this.sections.size < 2;
    this.activate(this.active ?? id);

    return {
      id,
      body,
      setStatus: (text, kind, detail) => {
        statusLine.textContent = text;
        status.dataset.kind = kind ?? "";
        statusDetail.textContent = detail ?? "";
        statusMore.hidden = !detail;
        /** A new answer is a new question: never leave yesterday’s notes open. */
        if (!detail) statusMore.open = false;
      },
      show: () => this.activate(id),
    };
  }

  private activate(id: string): void {
    let name = "";
    for (const [key, entry] of this.sections) {
      const on = key === id;
      entry.wrap.hidden = !on;
      entry.tab.classList.toggle("stw-tab-on", on);
      if (on) name = entry.title;
    }
    this.active = id;
    this.subtitle.textContent = this.tabsBar.hidden ? name : "";
  }

  /** Keeps the panel where the user last put it, per browser profile. */
  private restorePosition(): void {
    try {
      const raw = localStorage.getItem(POSITION_KEY);
      if (raw) {
        const pos = JSON.parse(raw) as { left: number; top: number };
        if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
          this.applyPosition(pos.left, pos.top);
        }
      }
      const w = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(w) && w >= 320 && w <= window.innerWidth - 24) {
        this.root.style.width = `${w}px`;
      }
    } catch {
      /* a stale value must never keep the panel off screen */
    }
  }

  private applyPosition(left: number, top: number): void {
    const x = Math.max(8, Math.min(window.innerWidth - 80, left));
    const y = Math.max(8, Math.min(window.innerHeight - 40, top));
    this.root.style.right = "auto";
    this.root.style.bottom = "auto";
    this.root.style.left = `${x}px`;
    this.root.style.top = `${y}px`;
  }

  private makeDraggable(handle: HTMLElement): void {
    let drag: { dx: number; dy: number } | null = null;

    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button")) return;
      const r = this.root.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      this.applyPosition(r.left, r.top);
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      this.applyPosition(e.clientX - drag.dx, e.clientY - drag.dy);
    });

    window.addEventListener("mouseup", () => {
      if (!drag) return;
      drag = null;
      const r = this.root.getBoundingClientRect();
      try {
        localStorage.setItem(POSITION_KEY, JSON.stringify({ left: r.left, top: r.top }));
      } catch {
        /* private mode */
      }
    });
  }

  /**
   * The panel can be dragged wider by its bottom-right corner (`resize:
   * horizontal` in CSS). Whatever changes the box — the grip or a drag —
   * the width is remembered so a wide table stays wide next visit.
   */
  private rememberWidth(): void {
    let saved = 0;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? 0);
      if (width <= 0 || width === saved) return;
      saved = width;
      try {
        localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        /* private mode */
      }
    });
    observer.observe(this.root);
  }
}

export function panelExists(): boolean {
  return document.getElementById(ROOT_ID) != null;
}
