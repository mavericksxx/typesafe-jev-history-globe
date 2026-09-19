// The "judgments" event-card stream. Ported from reel.html's `eventCard`.
// Now its own scroll container (see .stream in main.css): newest cards
// still prepend at the top, but if the user has scrolled down to read
// older ones, a prepend compensates the scroll position so their view
// doesn't jump — see the wasScrolledAway/scrollTop adjustment in add().
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

/** How close to the top counts as "at the top" for scroll-preservation
 * purposes — a few px of slop so normal momentum/rounding doesn't count as
 * "scrolled away". */
const AT_TOP_EPSILON_PX = 4;
/** Same idea, for "at the bottom": within this many px of the true end
 * counts as fully scrolled, so the has-more fade drops instead of clipping
 * the last real card. */
const AT_BOTTOM_EPSILON_PX = 2;

export class EventStream {
  private readonly container: HTMLElement;
  private readonly maxCards: number;
  private entries: StreamEntry[] = [];
  private resizeObserver: ResizeObserver | null = null;

  constructor(container: HTMLElement, maxCards = 60) {
    this.container = container;
    this.maxCards = maxCards;
    this.container.addEventListener("scroll", () => this.updateFadeState(), { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.updateFadeState());
      this.resizeObserver.observe(container);
    }
    this.updateFadeState();
  }

  /** Toggles .has-more — the bottom mask-image fade in main.css — so it only
   * shows while there's actually more content below to hint at. Called on
   * scroll, on resize (a ResizeObserver on the container, since the
   * viewport-height-dependent max-height/flex sizing can change how much
   * overflows), and after every content mutation below. */
  private updateFadeState(): void {
    const el = this.container;
    const hasOverflow = el.scrollHeight > el.clientHeight + 1;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - AT_BOTTOM_EPSILON_PX;
    el.classList.toggle("has-more", hasOverflow && !atBottom);
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

    const wasScrolledAway = this.container.scrollTop > AT_TOP_EPSILON_PX;
    const heightBefore = this.container.scrollHeight;
    this.container.prepend(el);
    this.entries.unshift({ idx: e.idx, el, textEl });
    if (wasScrolledAway) {
      // A newest-first prepend otherwise reads as everything sliding down
      // and the view snapping toward the top; compensate scrollTop by
      // exactly how much taller the list just got so whatever the user was
      // reading stays put.
      this.container.scrollTop += this.container.scrollHeight - heightBefore;
    }

    while (this.entries.length > this.maxCards) {
      this.entries.pop();
      this.container.lastElementChild?.remove();
    }
    this.updateFadeState();
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
    this.updateFadeState();
  }

  /** Rebuilds the stream after a scrub, oldest first so the newest ends on
   * top — always resets to the top since this is a fresh jump, not a live
   * feed the user might have scrolled away from. */
  setRecent(events: readonly HistoryEvent[]): void {
    this.clear();
    for (const e of events) this.add(e);
    this.container.scrollTop = 0;
    this.updateFadeState();
  }
}
