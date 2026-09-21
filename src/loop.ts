// The single rAF loop. Ported from reel.html's `frame()`, restructured so
// every per-frame query goes through the bisected EventIndex — as index
// bounds iterated over `all()` in place, never a slice/filter/full scan —
// and the globe/timeline only redraw when their dirty flag is set.
import { eventIndex, boundToMostRecent } from "./data";
import { computeEraSnapshot, ERA_WINDOW } from "./data/aggregate";
import { fmtYear } from "./data/timescale";
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
  reelDrivesScroll,
} from "./state";
import { Globe, DOT_FADE_WINDOW, boundDotWindow } from "./globe";
import { Timeline } from "./timeline";
import { GalaxyBackdrop } from "./galaxy/backdrop";
import { CometRail } from "./narrative/comet";
import { ReelScroll } from "./narrative/reelScroll";
import { EraPanel } from "./panel/era";
import { EventStream } from "./panel/stream";
import { LiveCard } from "./panel/live";
import { getGalaxyTheme } from "./themes";

const REEL_SECONDS = 150;
/** A narrative-scroll jump bigger than this fraction of T-space (or any
 * backward jump) skips the smooth per-frame tween entirely — see
 * easeNarrative. Tweening a big jump used to mean `pos` swept through every
 * intermediate value across several frames, and since updateFocusRotation
 * and syncEventsTo both react to "the current pos" every frame, a fast
 * scroll made the globe retarget/pulse/rotate through everything in
 * between — the "replays while catching up" jitter. */
const LARGE_JUMP_T = 0.02;
const FOCUS_WINDOW = 0.03;
const FOCUS_FALLBACK_MAX_STEPS = 200;
const RECENT_CARDS_MAX_STEPS = 5000;
const GALAXY_FRAME_MS = 1000 / 12;
const PULSE_LIFETIME_MS = 1400;
/** Same idea as MAX_VISIBLE_DOTS: ERA_WINDOW's bisected width can still be
 * ~18k events in the dense modern era, and the oldest members of an
 * oversized window carry the least weight anyway (weight decays with age),
 * so capping to the most recent events barely changes the snapshot. */
const MAX_ERA_EVENTS = 4000;

export interface LoopEls {
  hover: HTMLElement;
  sEvents: HTMLElement;
  sCalls: HTMLElement;
  sTheme: HTMLElement;
}

export interface LoopDeps {
  globe: Globe;
  timeline: Timeline;
  galaxyBackdrop: GalaxyBackdrop;
  cometRail: CometRail;
  reelScroll: ReelScroll;
  eraPanel: EraPanel;
  stream: EventStream;
  live: LiveCard;
  els: LoopEls;
  ensureText: (e: HistoryEvent) => Promise<string>;
  /** Called when playback reaches the end on its own (not via a manual pause). */
  onPlaybackEnd?: () => void;
}

/** Bounded nearest-neighbour search around `pos`'s insertion point — never a
 * full scan, and never allocates an intermediate array (no `.filter`),
 * unlike reel.html's `findFocusEvent` fallback. Exported for the perf test. */
export function findFocusEvent(pos: number): HistoryEvent | null {
  const all = eventIndex.all();
  const [wStart, wEnd] = eventIndex.range(pos - FOCUS_WINDOW, pos);
  let best: HistoryEvent | null = null;
  for (let i = wStart; i < wEnd; i++) {
    const e = all[i]!;
    if (e.minor) continue;
    if (!best || e.impact > best.impact) best = e;
  }
  if (best) return best;

  if (!all.length) return null;
  const mid = eventIndex.lowerBound(pos);
  let lo = mid - 1;
  let hi = mid;
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

/** Walks backward from index `n`, bounded, collecting the last `max`
 * non-minor events without allocating a slice/filter of the events between
 * them. Used to rebuild the card stream after a scrub/jump. */
function collectRecentCards(all: readonly HistoryEvent[], n: number, max: number): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  let steps = 0;
  for (let i = n - 1; i >= 0 && out.length < max && steps < RECENT_CARDS_MAX_STEPS; i--, steps++) {
    const e = all[i]!;
    if (!e.minor) out.push(e);
  }
  return out.reverse();
}

export class Loop {
  private readonly deps: LoopDeps;
  private last = performance.now();
  private lastGalaxyDraw = 0;
  private raf = 0;
  private lastRenderedHover: HistoryEvent | null = null;
  /** The event currently shown on the live card. It's deliberately kept OUT
   * of the judgments stream — otherwise the newest judgment renders twice,
   * once live and once at the top of the stream. It's prepended to the
   * stream when the next notable event takes over the live card. */
  private liveHeld: HistoryEvent | null = null;

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
        // One more than the stream shows, since the newest of them goes to
        // the live card instead of the stream.
        const recent = collectRecentCards(all, n, 4);
        const newest = recent.length ? recent[recent.length - 1]! : null;
        this.deps.stream.setRecent(recent.slice(0, -1));
        for (const e of recent) this.warmText(e);
        // The live card always tracks "the most recent notable event at or
        // before pos", whether that's from a scrub, a jump, or first boot —
        // not just events crossed one at a time during playback.
        this.liveHeld = newest;
        this.deps.live.setTarget(newest);
      }
    } else {
      const start = state.idx;
      setIdx(n);
      const crossed: HistoryEvent[] = [];
      for (let i = start; i < n; i++) {
        const e = all[i]!;
        // Only notable events get a pulse/card — a minor filler event
        // crossing pos shouldn't cost a projection + stroke every frame in
        // the dense modern era.
        if (!e.minor) {
          pushPulse(e, performance.now());
          this.warmText(e);
          crossed.push(e);
        }
      }
      // Only retarget the live card if a new notable event actually crossed
      // this frame — otherwise it keeps easing toward whatever it already
      // had, exactly as a live instrument should between readings. The one
      // taking over the live card is withheld from the stream; the one it
      // displaces (plus anything else crossed this frame) goes in.
      if (crossed.length) {
        if (this.liveHeld) this.deps.stream.add(this.liveHeld);
        for (let i = 0; i < crossed.length - 1; i++) this.deps.stream.add(crossed[i]!);
        this.liveHeld = crossed[crossed.length - 1]!;
        this.deps.live.setTarget(this.liveHeld);
      }
    }
    setCalls(Math.max(getState().calls, n));
  }

  private warmText(e: HistoryEvent): void {
    if (e.text) return;
    this.deps.ensureText(e).then(
      (text) => {
        if (text) {
          this.deps.stream.updateText(e.idx, text);
          this.deps.live.updateText(e.idx, text);
        }
      },
      () => {
        /* a failed shard fetch just means this card keeps its placeholder text */
      }
    );
  }

  /**
   * Debounced: a candidate focus has to be the best pick for FOCUS_DEBOUNCE_MS
   * running before the camera actually retargets to it. Without this, a fast
   * scroll that fires the narrative's IntersectionObserver across several
   * era sections in quick succession could still make the camera commit to
   * (and pulse) 2-3 different candidates in a row before settling — this
   * makes it settle on whichever one is still the best pick once things
   * stop changing, instead of ping-ponging through each intermediate one.
   */
  private static readonly FOCUS_DEBOUNCE_MS = 120;
  private pendingFocus: HistoryEvent | null = null;
  private pendingFocusSince = 0;

  private updateFocusRotation(pos: number, now: number): void {
    const state = getState();
    // A landmark card centred in the narrative overrides the usual
    // corpus-derived focus entirely: point the camera at its lat/lon so
    // scrolling past a landmark actually "visits" it on the globe, and
    // don't let findFocusEvent (searching the synthetic corpus, which knows
    // nothing about these hand-curated events) fight it a moment later.
    if (state.narrativeLandmark) {
      const lm = state.narrativeLandmark;
      const latClamped = Math.max(-35, Math.min(35, lm.lat * 0.6));
      setTargetRotation([-lm.lon, -latClamped]);
      this.pendingFocus = null;
      return;
    }
    const f = findFocusEvent(pos);
    if (!f || f === state.focusEvent) {
      this.pendingFocus = null;
      return;
    }
    if (f !== this.pendingFocus) {
      this.pendingFocus = f;
      this.pendingFocusSince = now;
      return;
    }
    if (now - this.pendingFocusSince < Loop.FOCUS_DEBOUNCE_MS) return;
    setFocusEvent(f);
    const latClamped = Math.max(-35, Math.min(35, f.lat * 0.6));
    setTargetRotation([-f.lon, -latClamped]);
    if (!state.reducedMotion) pushPulse(f, now);
    this.pendingFocus = null;
  }

  private advancePlayback(dt: number): void {
    const state = getState();
    if (!state.playing) return;
    setPos(state.pos + (dt * state.speed) / REEL_SECONDS);
    this.syncEventsTo(getState().pos, true);
    if (getState().pos >= 1) {
      setPlaying(false);
      this.deps.onPlaybackEnd?.();
    }
  }

  /**
   * Small movements (normal reading-pace scroll) still tween `pos` smoothly
   * across frames, exactly as before. A large jump — or any backward one —
   * snaps straight to the target instead of tweening through it: tweening
   * a big jump meant `pos` swept through every intermediate value across
   * several frames, and since both syncEventsTo and updateFocusRotation
   * (called from frame() every frame) react to "the current pos", a fast
   * scroll made the globe pulse/retarget/rotate through everything it
   * passed on the way — the "replays while catching up" jitter. Snapping
   * means syncEventsTo below runs once, at the destination (its `emit:
   * false` path already only refreshes idx/cards, no pulses), and
   * updateFocusRotation (called once per frame, right after this returns)
   * sees the landed pos and retargets exactly once instead of once per
   * swept-past event.
   */
  private easeNarrative(dt: number): void {
    const state = getState();
    if (state.narrativeTarget === null || state.playing || state.dragging || state.timelineActive) return;
    const delta = state.narrativeTarget - state.pos;
    const snap = state.reducedMotion || delta < 0.0015 || delta < 0 || delta > LARGE_JUMP_T;
    if (snap) {
      setPos(state.narrativeTarget);
      this.syncEventsTo(getState().pos, false);
      setNarrativeTarget(null);
    } else {
      const k = 1 - Math.pow(0.01, dt);
      setPos(state.pos + delta * k);
      this.syncEventsTo(getState().pos, false);
    }
  }

  /**
   * The reverse of easeNarrative: while the reel is driving (playback, or a
   * timeline click/drag within its grace period — see reelDrivesScroll()),
   * eases the page scroll so the narrative item matching `pos` sits at the
   * viewport centre, interpolating continuously between item anchors by
   * year rather than jumping item to item. A plain window.scrollTo per
   * frame (via ReelScroll#step), not scrollIntoView. Desktop-only: on the
   * stacked mobile layout the narrative and stage share one scroll, so
   * hijacking it would fight the user's ability to read either column.
   */
  private driveReelScroll(dt: number): void {
    if (!this.deps.reelScroll.isDesktopLayout) return;
    if (!reelDrivesScroll()) return;
    const state = getState();
    const target = this.deps.reelScroll.targetScrollY(state.pos);
    if (target === null) return;
    const k = state.reducedMotion ? 1 : 1 - Math.pow(0.01, dt);
    this.deps.reelScroll.step(target, k, state.reducedMotion);
  }

  private easeRotation(dt: number): void {
    const state = getState();
    if (state.dragging) return;
    if (state.reducedMotion) {
      // No idle spin under reduced motion, and setRotation itself now
      // no-ops once rot has actually settled on target, so this doesn't
      // mark the globe dirty forever.
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
    this.driveReelScroll(dt);

    const state = getState();
    const lo = state.pos - ERA_WINDOW;
    const all = eventIndex.all();
    const [eraWindowStart, eraWindowEnd] = eventIndex.range(lo, state.pos);
    const [eraStart, eraEnd] = boundToMostRecent(eraWindowStart, eraWindowEnd, MAX_ERA_EVENTS);
    const snapshot = computeEraSnapshot(all, eraStart, eraEnd, state.pos, lo);
    const topTheme = this.deps.eraPanel.update(snapshot, state.pos, dt, {
      reducedMotion: state.reducedMotion,
      playing: state.playing,
      now,
    });
    this.deps.live.step(dt, state.reducedMotion);

    this.updateFocusRotation(state.pos, now);
    prunePulses(now, PULSE_LIFETIME_MS);

    const afterFocus = getState();

    if (afterFocus.dirty.globe) {
      const [dotWindowStart, dotWindowEnd] = eventIndex.range(afterFocus.pos - DOT_FADE_WINDOW, afterFocus.pos);
      const [dotStart, dotEnd] = boundDotWindow(dotWindowStart, dotWindowEnd);
      this.deps.globe.draw({
        theme: getGalaxyTheme(afterFocus.galaxyId),
        accent: afterFocus.accent,
        rot: afterFocus.rot,
        pos: afterFocus.pos,
        all,
        dotStart,
        dotEnd,
        densityIdx: eventIndex.countUpTo(afterFocus.pos),
        pulses: afterFocus.pulses,
        now,
      });
      this.updateHover(afterFocus.hoverEvent);
    }

    if (afterFocus.dirty.timeline) {
      this.deps.timeline.render(afterFocus.pos, afterFocus.accent);
    }

    if (now - this.lastGalaxyDraw >= GALAXY_FRAME_MS) {
      this.lastGalaxyDraw = now;
      this.deps.galaxyBackdrop.draw(now, afterFocus.reducedMotion, window.scrollY);
    }

    // Comet rail: only paints on a scroll (dirty.narrative) or while its own
    // trail is still fading — never a permanent 60fps loop when idle.
    if (afterFocus.dirty.narrative || this.deps.cometRail.isAnimating()) {
      const targetYDoc = window.scrollY + window.innerHeight / 2;
      this.deps.cometRail.render(getGalaxyTheme(afterFocus.galaxyId), afterFocus.reducedMotion, now, targetYDoc);
    }

    this.deps.els.sEvents.textContent = afterFocus.idx.toLocaleString();
    const judged = afterFocus.calls + Math.floor(afterFocus.pos * 40);
    this.deps.els.sCalls.textContent = judged.toLocaleString();
    // The dominant stat is always accent-coloured (see #sTheme in
    // main.css), not tinted per winning theme — colour in this stats row
    // is reserved for the bar fills, not the summary text.
    this.deps.els.sTheme.textContent = afterFocus.idx ? topTheme : "—";

    clearDirty();
    this.raf = requestAnimationFrame(this.frame);
  };

  private updateHover(hovered: HistoryEvent | null): void {
    const el = this.deps.els.hover;
    if (!hovered) {
      el.hidden = true;
      this.lastRenderedHover = null;
      return;
    }
    el.hidden = false;
    const render = (text: string): void => {
      const approx = hovered.locKind === "country" ? " · approximate location" : "";
      el.innerHTML = `${fmtYear(hovered.year)} · ${escapeHtml(text)}<small>${hovered.top} ${hovered.th[hovered.top].toFixed(2)} · impact ${hovered.impact.toFixed(1)}${approx}</small>`;
    };
    // The globe is dirty most frames (idle spin), but the hovered event only
    // actually changes on a pointermove — skip re-rendering the DOM otherwise.
    if (hovered === this.lastRenderedHover) return;
    this.lastRenderedHover = hovered;
    if (hovered.text) {
      render(hovered.text);
    } else {
      render("…");
      this.deps.ensureText(hovered).then(
        (text) => {
          if (getState().hoverEvent === hovered) render(text || "…");
        },
        () => {
          /* keep the placeholder if the shard fetch failed */
        }
      );
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
