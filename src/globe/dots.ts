// Event dots: windowed (only a bisected T-space slice is ever drawn — dots
// fade fully out after DOT_FADE_WINDOW) plus a persistent additive density
// layer for the sense of history accumulating. Ported from reel.html's
// per-event loop inside `drawGlobe`, with that structural change.
import { geoDistance } from "d3-geo";
import type { GeoProjection } from "d3-geo";
import { THEMES } from "../data/types";
import type { HistoryEvent, Theme } from "../data/types";

/** How far back (in T-space) a dot stays visible before disappearing entirely. */
export const DOT_FADE_WINDOW = 0.06;

export type Project = (lon: number, lat: number) => [number, number] | null;

export function makeProjector(projection: GeoProjection, center: [number, number]): Project {
  return (lon, lat) => {
    if (geoDistance([lon, lat], center) > 1.52) return null;
    const p = projection([lon, lat]);
    return p as [number, number] | null;
  };
}

export interface DrawDotsOptions {
  ctx: CanvasRenderingContext2D;
  events: readonly HistoryEvent[];
  pos: number;
  project: Project;
  colors: Record<Theme, string>;
  accent: string;
}

/** Draws the crisp, currently-visible dots. `events` should already be the
 * `[pos - DOT_FADE_WINDOW, pos]` bisected slice — this does no filtering by
 * time itself, only by theme colour (batched) and hemisphere visibility. */
export function drawDots({ ctx, events, pos, project, colors, accent }: DrawDotsOptions): void {
  for (const theme of THEMES) {
    ctx.fillStyle = colors[theme];
    for (const e of events) {
      if (e.top !== theme || e.locKind === "none") continue;
      const age = Math.max(0, pos - e.t);
      if (age >= DOT_FADE_WINDOW) continue;
      const p = project(e.lon, e.lat);
      if (!p) continue;
      const fade = 1 - age / DOT_FADE_WINDOW;
      // Confidence dims the dot but never hides it outright.
      const alpha = fade * (e.minor ? 0.55 : 1) * (0.5 + 0.5 * e.conf);
      if (alpha <= 0.01) continue;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(p[0], p[1], (e.minor ? 1.6 : 2.4) + e.impact * 1.2, 0, Math.PI * 2);
      ctx.fill();
      if (!e.minor) {
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

const PULSE_LIFETIME_MS = 1400;
export { PULSE_LIFETIME_MS };

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
