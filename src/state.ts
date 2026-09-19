// The single AppState. No DOM here: renderers read this, input handlers
// write through the setters below, and only loop.ts calls update/render.
import type { HistoryEvent } from "./data/types";
import type { GalaxyId } from "./themes";
import { DEFAULT_GALAXY_ID } from "./themes";

export interface Pulse {
  event: HistoryEvent;
  t: number;
}

export interface DirtyFlags {
  /** Rotation, position, a pulse, or hover changed — the globe canvas needs a repaint. */
  globe: boolean;
  /** Position changed — the timeline canvas/handle need a repaint. */
  timeline: boolean;
}

export interface AppState {
  pos: number;
  playing: boolean;
  speed: number;
  rot: [number, number];
  targetRot: [number, number];
  dragging: boolean;
  galaxyId: GalaxyId;
  /** The last galaxy the user actually clicked (vs. a hover/focus preview). */
  committedGalaxyId: GalaxyId;
  accent: string;
  focusEvent: HistoryEvent | null;
  hoverEvent: HistoryEvent | null;
  pulses: Pulse[];
  /** Scroll-narrative easing target, in T-space; null when not scroll-driven. */
  narrativeTarget: number | null;
  calls: number;
  idx: number;
  readonly reducedMotion: boolean;
  dirty: DirtyFlags;
}

function initialState(): AppState {
  return {
    pos: 0,
    playing: false,
    speed: 1,
    rot: [-10, -25],
    targetRot: [-10, -25],
    dragging: false,
    galaxyId: DEFAULT_GALAXY_ID,
    committedGalaxyId: DEFAULT_GALAXY_ID,
    accent: "#f0c869",
    focusEvent: null,
    hoverEvent: null,
    pulses: [],
    narrativeTarget: null,
    calls: 0,
    idx: 0,
    reducedMotion:
      typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)").matches : false,
    dirty: { globe: true, timeline: true },
  };
}

const state: AppState = initialState();

export function getState(): AppState {
  return state;
}

export function setPos(p: number): void {
  const clamped = Math.max(0, Math.min(1, p));
  if (clamped === state.pos) return;
  state.pos = clamped;
  state.dirty.globe = true;
  state.dirty.timeline = true;
}

export function setPlaying(playing: boolean): void {
  state.playing = playing;
}

export function setSpeed(speed: number): void {
  state.speed = speed;
}

/** No-ops (and doesn't mark the globe dirty) if rot/target are unchanged —
 * matters most under reduced motion, where easeRotation would otherwise
 * call this every frame even once rot has already settled on target. */
export function setRotation(rot: [number, number], target?: [number, number]): void {
  const t = target ?? state.targetRot;
  const unchanged =
    rot[0] === state.rot[0] && rot[1] === state.rot[1] && t[0] === state.targetRot[0] && t[1] === state.targetRot[1];
  if (unchanged) return;
  state.rot = rot;
  state.targetRot = t;
  state.dirty.globe = true;
}

export function setTargetRotation(target: [number, number]): void {
  state.targetRot = target;
}

export function setDragging(dragging: boolean): void {
  state.dragging = dragging;
}

export function setGalaxyId(id: GalaxyId, commit: boolean): void {
  state.galaxyId = id;
  if (commit) state.committedGalaxyId = id;
  state.dirty.globe = true;
}

export function setAccent(accent: string): void {
  state.accent = accent;
  state.dirty.globe = true;
  state.dirty.timeline = true;
}

export function setHoverEvent(event: HistoryEvent | null): void {
  if (event === state.hoverEvent) return;
  state.hoverEvent = event;
  state.dirty.globe = true;
}

export function setFocusEvent(event: HistoryEvent | null): void {
  state.focusEvent = event;
}

/** Caps at MAX_PULSES (oldest dropped first) so a fast scrub through a dense
 * era can't grow the live pulse list without bound. */
export const MAX_PULSES = 300;

export function pushPulse(event: HistoryEvent, t: number): void {
  state.pulses.push({ event, t });
  if (state.pulses.length > MAX_PULSES) state.pulses.splice(0, state.pulses.length - MAX_PULSES);
  state.dirty.globe = true;
}

export function prunePulses(now: number, maxAgeMs: number): void {
  if (!state.pulses.length) return;
  const before = state.pulses.length;
  state.pulses = state.pulses.filter((p) => now - p.t < maxAgeMs);
  if (state.pulses.length !== before) state.dirty.globe = true;
}

export function setNarrativeTarget(target: number | null): void {
  state.narrativeTarget = target;
}

export function setCalls(calls: number): void {
  state.calls = calls;
}

export function setIdx(idx: number): void {
  state.idx = idx;
}

export function clearDirty(): void {
  state.dirty.globe = false;
  state.dirty.timeline = false;
}

export function markAllDirty(): void {
  state.dirty.globe = true;
  state.dirty.timeline = true;
}
