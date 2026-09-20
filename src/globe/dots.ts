// Event dots: windowed (only a bisected T-space slice is ever drawn — dots
// fade fully out after DOT_FADE_WINDOW), count-bounded to the most recent
// MAX_VISIBLE_DOTS, and prepared in a single pass that's pure (no canvas
// calls) so it can be timed/tested without a DOM. Ported from reel.html's
// per-event loop inside `drawGlobe`, restructured for cost at scale.
import { geoDistance } from "d3-geo";
import type { GeoProjection } from "d3-geo";
import type { HistoryEvent, Theme } from "../data/types";
import { boundToMostRecent } from "../data";

/** How far back (in T-space) a dot stays visible before disappearing entirely. */
export const DOT_FADE_WINDOW = 0.06;

/** However large the bisected window is, only the most recent this-many
 * events are drawn as crisp dots — bounds per-frame cost independent of how
 * dense the current era is (the modern era alone can have ~18k in-window). */
export const MAX_VISIBLE_DOTS = 3000;

/** Quantizes the continuous age-based fade into a handful of buckets so dots
 * can be batched into one fill() per (theme, minor, bucket) group instead of
 * one draw call per dot. */
const AGE_BUCKETS = 4;

/** Below this many events in the current dot window, dots are treated as
 * "sparse" and get scaled up so a genuinely thin era (pre-1000 AD) doesn't
 * read as broken/empty. At or above it, sizing is unchanged from before the
 * real-data switch. Tied to the actual in-window count rather than a
 * hardcoded year/era so it degrades gracefully at any point in time. */
const SPARSE_WINDOW_COUNT = 80;
/** How much bigger a dot gets at the sparsest extreme (windowCount -> 0). */
const MAX_SPARSE_SCALE = 1.7;

/** Size multiplier for dots given how many events are in the current window
 * (`dotEnd - dotStart`). One division + one clamp — cheap enough to compute
 * once per prepareDots call rather than per dot. */
export function sparseSizeScale(windowCount: number): number {
  if (windowCount >= SPARSE_WINDOW_COUNT) return 1;
  const t = 1 - Math.max(0, windowCount) / SPARSE_WINDOW_COUNT;
  return 1 + t * (MAX_SPARSE_SCALE - 1);
}

export type Project = (lon: number, lat: number) => [number, number] | null;

export function makeProjector(projection: GeoProjection, center: [number, number]): Project {
  return (lon, lat) => {
    if (geoDistance([lon, lat], center) > 1.52) return null;
    const p = projection([lon, lat]);
    return p as [number, number] | null;
  };
}

/** Given a bisected `[start, end)` window, returns the sub-range that should
 * actually be drawn, capped to the most recent `MAX_VISIBLE_DOTS`. */
export function boundDotWindow(start: number, end: number): [start: number, end: number] {
  return boundToMostRecent(start, end, MAX_VISIBLE_DOTS);
}

export interface DotDraw {
  x: number;
  y: number;
  r: number;
  theme: Theme;
  minor: boolean;
  ageBucket: number;
  /** True for `locKind === "country"` events pinned to a country centroid
   * rather than a real point — painted hollow so they read as "somewhere in
   * this country" instead of implying precision the source data doesn't have. */
  approximate: boolean;
}

/**
 * Pure prep pass: one projection call and one bookkeeping pass per event in
 * `[start, end)`, no ctx/canvas calls. Safe to call (and time) from Node.
 */
export function prepareDots(
  all: readonly HistoryEvent[],
  start: number,
  end: number,
  pos: number,
  project: Project
): DotDraw[] {
  const sizeScale = sparseSizeScale(end - start);
  const out: DotDraw[] = [];
  for (let i = start; i < end; i++) {
    const e = all[i]!;
    if (e.locKind === "none") continue;
    const age = Math.max(0, pos - e.t);
    if (age >= DOT_FADE_WINDOW) continue;
    const p = project(e.lon, e.lat);
    if (!p) continue;
    const ageBucket = Math.min(AGE_BUCKETS - 1, Math.floor((age / DOT_FADE_WINDOW) * AGE_BUCKETS));
    out.push({
      x: p[0],
      y: p[1],
      r: ((e.minor ? 1.6 : 2.4) + e.impact * 1.2) * sizeScale,
      theme: e.top,
      minor: e.minor,
      ageBucket,
      approximate: e.locKind === "country",
    });
  }
  return out;
}

function fadeForBucket(bucket: number): number {
  return 1 - (bucket + 0.5) / AGE_BUCKETS;
}

/** Below this, dots also linger visually (higher alpha floor as they age)
 * rather than only growing — see `sparseSizeScale` for the size half of the
 * same "sparse eras shouldn't look empty" fix. */
const SPARSE_PERSIST_COUNT = 80;
const MAX_PERSIST_FLOOR = 0.35;

/** How much a fading dot's alpha is floored, given how many events are in
 * the current window — 0 (no floor, current behaviour) once the window is
 * no longer sparse. */
export function sparseAlphaFloor(windowCount: number): number {
  if (windowCount >= SPARSE_PERSIST_COUNT) return 0;
  return (1 - Math.max(0, windowCount) / SPARSE_PERSIST_COUNT) * MAX_PERSIST_FLOOR;
}

/** Paints the prepared dots, grouped by (theme, minor, ageBucket, approximate)
 * so the whole window is drawn with a handful of fill()/stroke() calls
 * rather than one pair per dot. `alphaFloor` (see sparseAlphaFloor) keeps
 * aging dots from fading all the way to invisible when very few are on
 * screen at all. */
export function paintDots(
  ctx: CanvasRenderingContext2D,
  dots: readonly DotDraw[],
  colors: Record<Theme, string>,
  accent: string,
  alphaFloor = 0
): void {
  const groups = new Map<string, DotDraw[]>();
  for (const d of dots) {
    const key = `${d.theme}|${d.minor ? 1 : 0}|${d.ageBucket}|${d.approximate ? 1 : 0}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(d);
  }
  for (const [key, group] of groups) {
    const parts = key.split("|");
    const theme = parts[0] as Theme;
    const minor = parts[1] === "1";
    const ageBucket = Number(parts[2]);
    const approximate = parts[3] === "1";
    const alpha = Math.max(fadeForBucket(ageBucket), alphaFloor) * (minor ? 0.55 : 1);
    if (alpha <= 0.01) continue;
    ctx.beginPath();
    for (const d of group) {
      ctx.moveTo(d.x + d.r, d.y);
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    }
    if (approximate) {
      // Country-centroid pin: no precise point exists, so render a soft
      // hollow ring instead of a solid filled dot — "somewhere in this
      // country", not "here". No accent outline (that's reserved for
      // precisely-located non-minor events).
      ctx.globalAlpha = alpha * 0.6;
      ctx.strokeStyle = colors[theme];
      ctx.lineWidth = 0.9;
      ctx.stroke();
    } else {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = colors[theme];
      ctx.fill();
      if (!minor) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
}

export interface Pulse {
  event: HistoryEvent;
  t: number;
}

export const PULSE_LIFETIME_MS = 1400;

export function drawPulses(
  ctx: CanvasRenderingContext2D,
  pulses: readonly Pulse[],
  now: number,
  project: Project,
  colors: Record<Theme, string>
): void {
  for (const p of pulses) {
    const age = now - p.t;
    if (age >= PULSE_LIFETIME_MS) continue;
    const pt = project(p.event.lon, p.event.lat);
    if (!pt) continue;
    const k = age / PULSE_LIFETIME_MS;
    ctx.beginPath();
    ctx.arc(pt[0], pt[1], 4 + k * 22, 0, Math.PI * 2);
    ctx.strokeStyle = colors[p.event.top];
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
