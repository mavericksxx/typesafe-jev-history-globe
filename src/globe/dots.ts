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
      r: (e.minor ? 1.6 : 2.4) + e.impact * 1.2,
      theme: e.top,
      minor: e.minor,
      ageBucket,
    });
  }
  return out;
}

function fadeForBucket(bucket: number): number {
  return 1 - (bucket + 0.5) / AGE_BUCKETS;
}

/** Paints the prepared dots, grouped by (theme, minor, ageBucket) so the
 * whole window is drawn with a handful of fill()/stroke() calls rather than
 * one pair per dot. */
export function paintDots(ctx: CanvasRenderingContext2D, dots: readonly DotDraw[], colors: Record<Theme, string>, accent: string): void {
  const groups = new Map<string, DotDraw[]>();
  for (const d of dots) {
    const key = `${d.theme}|${d.minor ? 1 : 0}|${d.ageBucket}`;
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
    const alpha = fadeForBucket(ageBucket) * (minor ? 0.55 : 1);
    if (alpha <= 0.01) continue;
    ctx.beginPath();
    for (const d of group) {
      ctx.moveTo(d.x + d.r, d.y);
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colors[theme];
    ctx.fill();
    if (!minor) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 0.8;
      ctx.stroke();
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
