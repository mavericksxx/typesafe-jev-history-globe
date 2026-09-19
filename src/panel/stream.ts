// The "judgments" event-card stream. Ported from reel.html's `eventCard`.
import { THEMES, IMPACT_LABELS } from "../data/types";
import type { HistoryEvent } from "../data/types";
import { fmtYear } from "../data/timescale";
import { makeBars, setBars } from "./bars";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface StreamEntry {
  idx: number;
  el: HTMLElement;
  textEl: HTMLElement;
}

export class EventStream {
  private readonly container: HTMLElement;
  private readonly maxCards: number;
  private entries: StreamEntry[] = [];

  constructor(container: HTMLElement, maxCards = 3) {
    this.container = container;
    this.maxCards = maxCards;
  }

  add(e: HistoryEvent): void {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML =
      `<p class="ev-title"><em>${fmtYear(e.year)}</em><span class="ev-text">${escapeHtml(e.text)}</span></p>` +
      `<div class="bars"></div>` +
      `<div class="conf"><span>impact ${e.impact.toFixed(2)} / 3 · ${IMPACT_LABELS[Math.round(e.impact)]}</span></div>`;
    const barsEl = el.querySelector<HTMLElement>(".bars");
    const textEl = el.querySelector<HTMLElement>(".ev-text");
    if (!barsEl || !textEl) throw new Error("EventStream: card template missing .bars/.ev-text");
    const rows = makeBars(barsEl, THEMES);
    this.container.prepend(el);
    this.entries.unshift({ idx: e.idx, el, textEl });
    while (this.entries.length > this.maxCards) {
      this.entries.pop();
      this.container.lastElementChild?.remove();
    }
    // double-rAF so the 0%-width bars paint once before animating to value,
    // matching the mockup's slide-in.
    requestAnimationFrame(() => requestAnimationFrame(() => setBars(rows, e.th)));
  }

  /** Patches in text that arrived after the card was already rendered
   * (lazy-loaded shard). No-ops if the card has since scrolled off. */
  updateText(idx: number, text: string): void {
    const entry = this.entries.find((c) => c.idx === idx);
    if (entry) entry.textEl.textContent = text;
  }

  clear(): void {
    this.container.innerHTML = "";
    this.entries = [];
  }

  /** Rebuilds the stream after a scrub, oldest first so the newest ends on top. */
  setRecent(events: readonly HistoryEvent[]): void {
    this.clear();
    for (const e of events) this.add(e);
  }
}
