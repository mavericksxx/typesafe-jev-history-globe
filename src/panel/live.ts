// The persistent "live" card above the judgments stream: names the current
// event and eases its six theme bars toward that event's real scores every
// frame, so a burst of events (the 1900s) reads as continuous motion instead
// of a slideshow. Same makeBars/setBars widgets as the stream cards and
// EraPanel, and the same per-frame-ease idiom as EraPanel.update — driven
// from the existing rAF loop (loop.ts), not a second timer.
import { THEMES, IMPACT_LABELS } from "../data/types";
import type { HistoryEvent, Theme } from "../data/types";
import { fmtYear } from "../data/timescale";
import { THEME_COLORS } from "../themes";
import { makeBars, setBars } from "./bars";
import type { BarRow } from "./bars";

/** How long the bars take to settle (~95% of the way) on a new target.
 * Comfortably inside the 300-450ms range: fast enough to read as a live
 * instrument (values visibly move) but slow enough that a single value is
 * still readable before the next event retargets it — see DECAY_PER_SEC. */
const SETTLE_MS = 380;
/** Per-second decay constant k such that k^(SETTLE_MS/1000) = 0.05 (95%
 * closed by SETTLE_MS). Same exponential-ease idiom as EraPanel.update's
 * `1 - Math.pow(0.02, dt)`, just tuned for a much shorter settle time. */
const DECAY_PER_SEC = Math.pow(0.05, 1000 / SETTLE_MS);
/** Below this per-theme delta, skip re-writing the DOM this frame — once
 * settled, six bar-width writes every frame forever is pure waste. */
const CHANGE_EPSILON = 0.0005;

function zeroThemes(): Record<Theme, number> {
  return Object.fromEntries(THEMES.map((k) => [k, 0])) as Record<Theme, number>;
}

/**
 * One ease-toward-target step, pure and DOM-free so it's directly testable.
 * Always continues from `cur` (the actual current displayed value), never
 * from whatever the previous target was — that's what makes a target change
 * mid-ease keep flowing instead of restarting or queueing. `reducedMotion`
 * snaps straight to `target`. Output is always clamped to 0..1.
 */
export function easeThemes(
  cur: Record<Theme, number>,
  target: Record<Theme, number>,
  dt: number,
  reducedMotion: boolean
): Record<Theme, number> {
  const k = reducedMotion ? 1 : 1 - Math.pow(DECAY_PER_SEC, dt);
  const out = {} as Record<Theme, number>;
  for (const t of THEMES) {
    const v = cur[t] + (target[t] - cur[t]) * k;
    out[t] = Math.max(0, Math.min(1, v));
  }
  return out;
}

export class LiveCard {
  private readonly yearEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly confEl: HTMLElement;
  private readonly rows: BarRow<Theme>[];
  private cur = zeroThemes();
  private target: HistoryEvent | null = null;

  constructor(container: HTMLElement) {
    container.innerHTML =
      `<p class="ev-title"><em id="liveYear">&mdash;</em><span class="ev-text" id="liveText">Waiting for the reel to start&hellip;</span></p>` +
      `<div class="bars" id="liveBars"></div>` +
      `<div class="conf"><span id="liveConf">&nbsp;</span></div>`;
    const barsEl = container.querySelector<HTMLElement>("#liveBars");
    const yearEl = container.querySelector<HTMLElement>("#liveYear");
    const titleEl = container.querySelector<HTMLElement>("#liveText");
    const confEl = container.querySelector<HTMLElement>("#liveConf");
    if (!barsEl || !yearEl || !titleEl || !confEl) throw new Error("LiveCard: template missing an expected element");
    this.rows = makeBars(barsEl, THEMES, THEME_COLORS);
    this.yearEl = yearEl;
    this.titleEl = titleEl;
    this.confEl = confEl;
  }

  /** Which event the bars should be gliding toward. A no-op if it's already
   * the current target (called from syncEventsTo, which may re-derive "the
   * latest notable event" every scrub without it actually having changed). */
  setTarget(e: HistoryEvent | null): void {
    if (e === this.target) return;
    this.target = e;
    if (!e) {
      this.yearEl.textContent = "—";
      this.titleEl.textContent = "Waiting for the reel to start…";
      this.confEl.textContent = "";
      return;
    }
    this.yearEl.textContent = fmtYear(e.year);
    this.titleEl.textContent = e.text || "…";
    this.confEl.textContent = `impact ${e.impact.toFixed(2)} / 3 · ${IMPACT_LABELS[Math.round(e.impact)]}`;
  }

  /** Patches in text that arrived after this became the target (lazy-loaded
   * shard) — mirrors EventStream#updateText. No-ops if the target has since
   * moved on to a different event. */
  updateText(idx: number, text: string): void {
    if (this.target && this.target.idx === idx && text) this.titleEl.textContent = text;
  }

  /** Advances the bar ease by one frame. Call every frame regardless of
   * dirty flags (EraPanel.update is called the same way); the CHANGE_EPSILON
   * check above keeps the actual DOM writes to "nothing" once settled. */
  step(dt: number, reducedMotion: boolean): void {
    const targetTh = this.target ? this.target.th : zeroThemes();
    const next = easeThemes(this.cur, targetTh, dt, reducedMotion);
    const changed = THEMES.some((t) => Math.abs(next[t] - this.cur[t]) > CHANGE_EPSILON);
    this.cur = next;
    if (changed) setBars(this.rows, this.cur);
  }
}
