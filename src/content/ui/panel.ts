/**
 * The shared on-page shell. Features do not build their own windows — they ask
 * the panel for a section and fill it, so a second or third feature costs no
 * layout work and the user only ever drags one box around.
 */

export type StatusKind = "" | "work" | "ok" | "warn" | "err";

export interface Section {
  readonly id: string;
  readonly body: HTMLElement;
  setStatus(text: string, kind?: StatusKind): void;
  show(): void;
}

const ROOT_ID = "stw-root";
const POSITION_KEY = "stwPanelPos";

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
  private readonly sections = new Map<string, { tab: HTMLButtonElement; wrap: HTMLElement }>();
  private active: string | null = null;

  constructor(subtitle: string) {
    this.root = el("div", "stw-panel");
    this.root.id = ROOT_ID;

    const head = el("div", "stw-head");
    const titles = el("div", "stw-titles");
    titles.append(el("div", "stw-title", "Steward"), el("div", "stw-sub", subtitle));

    const collapse = el("button", "stw-iconbtn", "–");
    collapse.type = "button";
    collapse.title = "Свернуть";
    collapse.addEventListener("click", () => this.root.classList.toggle("stw-collapsed"));

    head.append(titles, collapse);

    this.tabsBar = el("div", "stw-tabs");
    this.stack = el("div", "stw-stack");

    this.root.append(head, this.tabsBar, this.stack);
    document.documentElement.appendChild(this.root);

    this.restorePosition();
    this.makeDraggable(head);
  }

  addSection(id: string, title: string): Section {
    const wrap = el("div", "stw-section");
    wrap.dataset.section = id;
    wrap.hidden = true;

    const status = el("div", "stw-status");
    const body = el("div", "stw-body");
    wrap.append(status, body);
    this.stack.appendChild(wrap);

    const tab = el("button", "stw-tab", title);
    tab.type = "button";
    tab.addEventListener("click", () => this.activate(id));
    this.tabsBar.appendChild(tab);

    this.sections.set(id, { tab, wrap });
    this.tabsBar.hidden = this.sections.size < 2;
    if (!this.active) this.activate(id);

    return {
      id,
      body,
      setStatus: (text, kind) => {
        status.textContent = text;
        status.dataset.kind = kind ?? "";
      },
      show: () => this.activate(id),
    };
  }

  private activate(id: string): void {
    for (const [key, entry] of this.sections) {
      const on = key === id;
      entry.wrap.hidden = !on;
      entry.tab.classList.toggle("stw-tab-on", on);
    }
    this.active = id;
  }

  /** Keeps the panel where the user last put it, per browser profile. */
  private restorePosition(): void {
    try {
      const raw = localStorage.getItem(POSITION_KEY);
      if (!raw) return;
      const pos = JSON.parse(raw) as { left: number; top: number };
      if (!Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return;
      this.applyPosition(pos.left, pos.top);
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
}

export function panelExists(): boolean {
  return document.getElementById(ROOT_ID) != null;
}
