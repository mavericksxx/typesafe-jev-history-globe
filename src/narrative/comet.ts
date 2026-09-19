// The comet-trail era connector, ported from the approved "Comet trail"
// option in connectors.html. The reference drives the comet from an inner
// scroll container's scrollTop; this app's narrative scrolls with the page,
// so it's driven from window scroll against the rail's own document-space
// anchors instead, with the viewport centre as the same target-Y the
// reference uses. Colours come from the active GalaxyTheme, not the
// reference's hardcoded Spiral Core hex values, so it works in all six themes.
import type { GalaxyTheme } from "../themes";
import { hexToRgba, hexToRgbaPrefix } from "../util/color";

const TRAIL_LIFE_MS = 1600;
const MAX_TRAIL_POINTS = 800;
const GAP_SAMPLE_PX = 1.5;
const MAX_GAP_SAMPLES = 600;
const RAIL_MARGIN = 14;
const CATMULL_STEPS = 24;

interface Point {
  x: number;
  y: number;
}
interface TrailPoint extends Point {
  born: number;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** A point on `path` at a given y (path is monotonically increasing in y). */
function pointAtY(path: readonly Point[], targetY: number): Point {
  if (!path.length) return { x: RAIL_MARGIN, y: 0 };
  const first = path[0]!;
  if (targetY <= first.y) return first;
  for (let i = 1; i < path.length; i++) {
    const b = path[i]!;
    if (b.y >= targetY) {
      const a = path[i - 1]!;
      const span = b.y - a.y || 1;
      const t = (targetY - a.y) / span;
      return { x: a.x + (b.x - a.x) * t, y: targetY };
    }
  }
  return path[path.length - 1]!;
}

export class CometRail {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private path: Point[] = [];
  private trail: TrailPoint[] = [];
  private lastTrailPt: Point | null = null;
  private dpr = 1;
  private w = 0;
  private h = 0;
  /** Document Y (page coordinates) of this rail's coordinate origin. */
  private originY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("CometRail: 2d context unavailable");
    this.ctx = ctx;
  }

  /** Recomputes the rail's size, document-space origin, era anchors and the
   * Catmull-Rom path between them. Call after the narrative renders and on
   * resize (era heights can reflow with column width). Does not render —
   * callers mark state dirty and let the loop pick it up. */
  measure(wrapperEl: HTMLElement, eraEls: readonly HTMLElement[]): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || 38;
    const wrapperRect = wrapperEl.getBoundingClientRect();
    const h = wrapperEl.clientHeight;
    this.originY = wrapperRect.top + window.scrollY;
    this.w = w;
    this.h = h;
    // CSS size (style.height) and backing-store size (the width/height
    // attributes, in device px) are set separately — the canvas has no
    // intrinsic height of its own since it's absolutely positioned over a
    // content-sized wrapper.
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);

    const centers = eraEls.map((el) => {
      const r = el.getBoundingClientRect();
      return (r.top + r.bottom) / 2 + window.scrollY - this.originY;
    });
    this.path = this.buildPath(centers, w);
    this.trail = [];
    this.lastTrailPt = null;
  }

  private buildPath(centers: readonly number[], w: number): Point[] {
    if (!centers.length) return [];
    const mL = RAIL_MARGIN;
    const mR = w - RAIL_MARGIN;
    const pts: Point[] = centers.map((y, i) => ({ x: i % 2 === 0 ? mL : mR, y }));
    const get = (i: number): Point => pts[clamp(i, 0, pts.length - 1)]!;
    const out: Point[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = get(i - 1);
      const p1 = get(i);
      const p2 = get(i + 1);
      const p3 = get(i + 2);
      for (let s = 0; s < CATMULL_STEPS; s++) {
        const t = s / CATMULL_STEPS;
        out.push({
          x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
          y: catmullRom(p0.y, p1.y, p2.y, p3.y, t),
        });
      }
    }
    out.push(pts[pts.length - 1]!);
    return out;
  }

  /** Whether the trail still has fading points — the loop keeps calling
   * render() every frame while this is true, and stops once it's false. */
  isAnimating(): boolean {
    return this.trail.length > 0;
  }

  /** `targetY` is in document/page coordinates (e.g. `scrollY + innerHeight/2`),
   * matching the reference's viewport-centre target. */
  render(theme: GalaxyTheme, reducedMotion: boolean, now: number, targetYDoc: number): void {
    const { ctx, path } = this;
    if (!path.length) return;
    const targetY = targetYDoc - this.originY;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    const dimColor = hexToRgba(theme.ink3, 0.42);
    const litColor = hexToRgba(theme.accent, 0.55);
    for (let i = 0; i < path.length; i += 3) {
      const p = path[i]!;
      ctx.fillStyle = p.y > targetY ? dimColor : litColor;
      ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    }

    const pos = pointAtY(path, clamp(targetY, path[0]!.y, path[path.length - 1]!.y));

    if (!reducedMotion) {
      if (!this.lastTrailPt) {
        this.trail.push({ x: pos.x, y: pos.y, born: now });
        this.lastTrailPt = pos;
      }
      const gap = Math.abs(pos.y - this.lastTrailPt.y);
      if (gap > GAP_SAMPLE_PX) {
        // Fill fast-scroll jumps by sampling the curved path every ~1.5px
        // between the last drawn point and now, so quick scrolls stay solid.
        const steps = Math.min(MAX_GAP_SAMPLES, Math.ceil(gap / GAP_SAMPLE_PX));
        for (let si = 1; si <= steps; si++) {
          const sy = this.lastTrailPt.y + (pos.y - this.lastTrailPt.y) * (si / steps);
          const sp = pointAtY(path, sy);
          this.trail.push({ x: sp.x, y: sp.y, born: now });
        }
        this.lastTrailPt = pos;
        while (this.trail.length > MAX_TRAIL_POINTS) this.trail.shift();
      }
      while (this.trail.length && now - this.trail[0]!.born > TRAIL_LIFE_MS) this.trail.shift();

      const accent2Prefix = hexToRgbaPrefix(theme.accent2);
      const accentPrefix = hexToRgbaPrefix(theme.accent);
      for (const tp of this.trail) {
        const age = (now - tp.born) / TRAIL_LIFE_MS;
        const sz = Math.max(1, Math.round(6 * (1 - age)));
        const a = Math.pow(1 - age, 1.6) * 0.85;
        ctx.fillStyle = (age < 0.35 ? accent2Prefix : accentPrefix) + a.toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(tp.x, tp.y, sz / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.save();
    ctx.shadowColor = theme.accent;
    ctx.shadowBlur = reducedMotion ? 0 : 12;
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = theme.accent2;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
