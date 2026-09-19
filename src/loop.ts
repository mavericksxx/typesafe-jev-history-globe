// The single rAF loop. Ported from reel.html's `frame()`, restructured so
// every per-frame query goes through the bisected EventIndex (never a full
// scan) and the globe/timeline only redraw when their dirty flag is set.
import { eventIndex } from "./data";
import { computeEraSnapshot, ERA_WINDOW } from "./data/aggregate";
import { fmtYear, T } from "./data/timescale";
import type { HistoryEvent } from "./data/types";
import {
  getState,
  setPos,
  setPlaying,
  setRotation,
  setTargetRotation,
  setFocusEvent,
  pushPulse,
  prunePulses,
  setNarrativeTarget,
  setCalls,
  setIdx,
  clearDirty,
} from "./state";
import { Globe, DOT_FADE_WINDOW } from "./globe";
import { Timeline } from "./timeline";
import { GalaxyBackdrop } from "./galaxy/backdrop";
import { EraPanel } from "./panel/era";
import { EventStream } from "./panel/stream";
import { getGalaxyTheme } from "./themes";
import { THEME_COLORS } from "./themes";

const REEL_SECONDS = 150;
const FOCUS_WINDOW = 0.03;
const FOCUS_FALLBACK_MAX_STEPS = 200;
const GALAXY_FRAME_MS = 1000 / 12;
const PULSE_LIFETIME_MS = 1400;

export interface LoopEls {
  yearChip: HTMLElement;
  hover: HTMLElement;
  sEvents: HTMLElement;
  sCalls: HTMLElement;
  sCost: HTMLElement;
  sTheme: HTMLElement;
}

export interface LoopDeps {
  globe: Globe;
  timeline: Timeline;
  galaxyBackdrop: GalaxyBackdrop;
  eraPanel: EraPanel;
  stream: EventStream;
  els: LoopEls;
  ensureText: (e: HistoryEvent) => Promise<string>;
}

/** Bounded nearest-neighbour search around `pos`'s insertion point — never a
 * full scan, unlike reel.html's `findFocusEvent` fallback. */
function findFocusEvent(pos: number): HistoryEvent | null {
  const windowed = eventIndex.range(pos - FOCUS_WINDOW, pos).filter((e) => !e.minor);
  if (windowed.length) {
    return windowed.reduce((best, e) => (e.impact > best.impact ? e : best));
  }
  const all = eventIndex.all();
  if (!all.length) return null;
  const mid = eventIndex.lowerBound(pos);
  let lo = mid - 1;
  let hi = mid;
  let best: HistoryEvent | null = null;
  let bestDist = Infinity;
  for (let steps = 0; steps < FOCUS_FALLBACK_MAX_STEPS && (lo >= 0 || hi < all.length); steps++) {
    if (lo >= 0) {
      const e = all[lo]!;
      if (!e.minor) {
        const d = Math.abs(e.t - pos);
        if (d < bestDist) {
          bestDist = d;
          best = e;
        }
      }
      lo--;
    }
    if (hi < all.length) {
      const e = all[hi]!;
      if (!e.minor) {
        const d = Math.abs(e.t - pos);
        if (d < bestDist) {
          bestDist = d;
          best = e;
        }
      }
      hi++;
    }
  }
  return best;
}

export class Loop {
  private readonly deps: LoopDeps;
  private last = performance.now();
  private lastGalaxyDraw = 0;
  private raf = 0;

  constructor(deps: LoopDeps) {
    this.deps = deps;
  }

  start(): void {
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  /** Rebuilds `idx`/the card stream up to `pos`. `emit` distinguishes
   * playing/scrubbing forward (new cards pop in one by one) from a scrub or
   * narrative jump (the stream is rebuilt from the last few events). */
  syncEventsTo(pos: number, emit: boolean): void {
    const state = getState();
    const all = eventIndex.all();
    const n = eventIndex.countUpTo(pos);

    if (n < state.idx || !emit) {
      setIdx(n);
      if (!emit) {
        const start = Math.max(0, n - 200);
        const recent = all.slice(start, n).filter((e) => !e.minor).slice(-3);
        this.deps.stream.setRecent(recent);
        for (const e of recent) this.warmText(e);
      }
    } else {
      const start = state.idx;
      setIdx(n);
      for (let i = start; i < n; i++) {
        const e = all[i]!;
        pushPulse(e, performance.now());
        if (!e.minor) {
          this.deps.stream.add(e);
          this.warmText(e);
        }
      }
    }
    setCalls(Math.max(getState().calls, n));
  }

  private warmText(e: HistoryEvent): void {
    if (e.text) return;
    void this.deps.ensureText(e).then((text) => {
      if (text) this.deps.stream.updateText(e.idx, text);
    });
  }

  private updateFocusRotation(pos: number): void {
    const f = findFocusEvent(pos);
    const state = getState();
    if (f && f !== state.focusEvent) {
      setFocusEvent(f);
      const latClamped = Math.max(-35, Math.min(35, f.lat * 0.6));
      setTargetRotation([-f.lon, -latClamped]);
      if (!state.reducedMotion) pushPulse(f, performance.now());
    }
  }

  private advancePlayback(dt: number): void {
    const state = getState();
    if (!state.playing) return;
    setPos(state.pos + (dt * state.speed) / REEL_SECONDS);
    this.syncEventsTo(getState().pos, true);
    if (getState().pos >= 1) setPlaying(false);
  }

  private easeNarrative(dt: number): void {
    const state = getState();
    if (state.narrativeTarget === null || state.playing || state.dragging) return;
    if (state.reducedMotion || Math.abs(state.narrativeTarget - state.pos) < 0.0015) {
      setPos(state.narrativeTarget);
      this.syncEventsTo(getState().pos, false);
      setNarrativeTarget(null);
    } else {
      const k = 1 - Math.pow(0.01, dt);
      setPos(state.pos + (state.narrativeTarget - state.pos) * k);
      this.syncEventsTo(getState().pos, false);
    }
  }

  private easeRotation(dt: number): void {
    const state = getState();
    if (state.dragging) return;
    if (state.reducedMotion) {
      setRotation([state.targetRot[0], state.targetRot[1]], state.targetRot);
      return;
    }
    const k = 1 - Math.pow(0.02, dt);
    const dLon = ((state.targetRot[0] - state.rot[0] + 540) % 360) - 180;
    let rot: [number, number] = [state.rot[0] + dLon * k, state.rot[1] + (state.targetRot[1] - state.rot[1]) * k];
    let target = state.targetRot;
    if (!state.playing) {
      rot = [rot[0] + dt * 1.5, rot[1]];
      target = [target[0] + dt * 1.5, target[1]];
    }
    setRotation(rot, target);
  }

  private frame = (now: number): void => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;

    this.advancePlayback(dt);
    this.easeNarrative(dt);
    this.easeRotation(dt);

    const state = getState();
    const lo = state.pos - ERA_WINDOW;
    const eraWindow = eventIndex.range(lo, state.pos);
    const snapshot = computeEraSnapshot(eraWindow, state.pos, lo);
    const topTheme = this.deps.eraPanel.update(snapshot, state.pos, dt, {
      reducedMotion: state.reducedMotion,
      playing: state.playing,
      now,
    });

    this.updateFocusRotation(state.pos);
    prunePulses(now, PULSE_LIFETIME_MS);

    const afterFocus = getState();
    const dotEvents = eventIndex.range(afterFocus.pos - DOT_FADE_WINDOW, afterFocus.pos);

    if (afterFocus.dirty.globe) {
      this.deps.globe.draw({
        theme: getGalaxyTheme(afterFocus.galaxyId),
        accent: afterFocus.accent,
        rot: afterFocus.rot,
        pos: afterFocus.pos,
        windowedEvents: dotEvents,
        pulses: afterFocus.pulses,
        now,
      });
      this.updateHover(afterFocus.hoverEvent);
    }

    if (afterFocus.dirty.timeline) {
      this.deps.timeline.render(afterFocus.pos, afterFocus.accent);
      this.deps.els.yearChip.textContent = fmtYear(Math.round(T.invert(afterFocus.pos)));
    }

    if (now - this.lastGalaxyDraw >= GALAXY_FRAME_MS) {
      this.lastGalaxyDraw = now;
      this.deps.galaxyBackdrop.draw(now, afterFocus.reducedMotion, window.scrollY);
    }

    this.deps.els.sEvents.textContent = afterFocus.idx.toLocaleString();
    const judged = afterFocus.calls + Math.floor(afterFocus.pos * 40);
    this.deps.els.sCalls.textContent = judged.toLocaleString();
    this.deps.els.sCost.textContent = `$${(judged * 0.0000193).toFixed(5)}`;
    this.deps.els.sTheme.textContent = afterFocus.idx ? topTheme : "—";
    this.deps.els.sTheme.style.color = afterFocus.idx ? THEME_COLORS[topTheme] : "";

    clearDirty();
    this.raf = requestAnimationFrame(this.frame);
  };

  private updateHover(hovered: HistoryEvent | null): void {
    const el = this.deps.els.hover;
    if (!hovered) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const render = (text: string): void => {
      el.innerHTML = `${fmtYear(hovered.year)} · ${escapeHtml(text)}<small>${hovered.top} ${hovered.th[hovered.top].toFixed(2)} · impact ${hovered.impact.toFixed(1)}</small>`;
    };
    if (hovered.text) {
      render(hovered.text);
    } else {
      render("…");
      void this.deps.ensureText(hovered).then((text) => {
        if (getState().hoverEvent === hovered) render(text || "…");
      });
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
