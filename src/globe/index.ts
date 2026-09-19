// The globe: orchestrates projection, land, dots, density and the cached
// rotation-invariant bezel/ocean/glow layer. Ported from reel.html's
// `drawGlobe`, restructured so the parts that don't depend on rotation are
// only ever redrawn on resize or theme change.
import type { GeoProjection, GeoPath } from "d3-geo";
import { createProjection, fitProjection, graticule } from "./projection";
import { land } from "./land";
import { drawDots, drawPulses, makeProjector } from "./dots";
import type { Pulse, Project } from "./dots";
import { DensityLayer } from "./density";
import { THEME_COLORS } from "../themes";
import type { GalaxyTheme } from "../themes";
import { THEMES } from "../data/types";
import type { HistoryEvent, Theme } from "../data/types";
import { hexToRgba } from "../util/color";

const DOT_COLORS: Record<Theme, string> = Object.fromEntries(
  THEMES.map((t) => [t, THEME_COLORS[t]])
) as Record<Theme, string>;

export interface GlobeDrawOptions {
  theme: GalaxyTheme;
  accent: string;
  rot: [number, number];
  pos: number;
  /** Pre-bisected `[pos - DOT_FADE_WINDOW, pos]` slice — never the full dataset. */
  windowedEvents: readonly HistoryEvent[];
  pulses: readonly Pulse[];
  now: number;
}

export class Globe {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly projection: GeoProjection;
  private readonly path: GeoPath;
  private readonly density = new DensityLayer();
  private readonly underlay: HTMLCanvasElement;
  private readonly underlayCtx: CanvasRenderingContext2D;
  private readonly overlay: HTMLCanvasElement;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private w = 0;
  private dpr = 1;
  private staticCacheKey = "";

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Globe: 2d context unavailable");
    this.ctx = ctx;
    const created = createProjection(ctx);
    this.projection = created.projection;
    this.path = created.path;

    this.underlay = document.createElement("canvas");
    const uctx = this.underlay.getContext("2d");
    if (!uctx) throw new Error("Globe: 2d context unavailable (underlay)");
    this.underlayCtx = uctx;

    this.overlay = document.createElement("canvas");
    const octx = this.overlay.getContext("2d");
    if (!octx) throw new Error("Globe: 2d context unavailable (overlay)");
    this.overlayCtx = octx;
  }

  get projectionRef(): GeoProjection {
    return this.projection;
  }

  /** `cssSize` is the CSS-pixel width/height of the (square) globe box. */
  resize(cssSize: number, dpr: number): void {
    this.w = cssSize;
    this.dpr = dpr;
    const px = Math.round(cssSize * dpr);
    this.canvas.width = px;
    this.canvas.height = px;
    this.underlay.width = px;
    this.underlay.height = px;
    this.overlay.width = px;
    this.overlay.height = px;
    fitProjection(this.projection, cssSize);
    this.density.resize(px, px, dpr);
    this.staticCacheKey = "";
  }

  private rebuildStaticLayers(theme: GalaxyTheme, accent: string): void {
    const key = `${theme.id}:${accent}:${this.w}`;
    if (key === this.staticCacheKey) return;
    this.staticCacheKey = key;

    const px = this.canvas.width;
    const cx = px / 2;
    const r = this.projection.scale() * this.dpr;

    const u = this.underlayCtx;
    u.setTransform(1, 0, 0, 1, 0, 0);
    u.clearRect(0, 0, px, px);
    u.beginPath();
    u.arc(cx, cx, r, 0, Math.PI * 2);
    u.fillStyle = theme.ocean;
    u.fill();

    const o = this.overlayCtx;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, px, px);
    if (theme.rim === "steps") {
      for (let i = 5; i >= 1; i--) {
        o.beginPath();
        o.arc(cx, cx, r * (1 + i * 0.018), 0, Math.PI * 2);
        o.strokeStyle = accent;
        o.globalAlpha = (0.1 * (6 - i)) / 5;
        o.lineWidth = r * 0.05;
        o.stroke();
      }
      o.globalAlpha = 1;
    } else {
      const glow = o.createRadialGradient(cx, cx, r * 0.86, cx, cx, r * 1.15);
      glow.addColorStop(0, hexToRgba(accent, 0));
      glow.addColorStop(1, hexToRgba(accent, 0.55));
      o.save();
      o.beginPath();
      o.arc(cx, cx, r * 1.15, 0, Math.PI * 2);
      o.fillStyle = glow;
      o.fill();
      o.restore();
    }
    o.beginPath();
    o.arc(cx, cx, r, 0, Math.PI * 2);
    o.strokeStyle = theme.coast;
    o.lineWidth = 1.8 * this.dpr;
    o.stroke();

    const rb = r + Math.max(4 * this.dpr, r * 0.035);
    o.beginPath();
    o.arc(cx, cx, rb, 0, Math.PI * 2);
    o.strokeStyle = hexToRgba(theme.bezel, 0.55);
    o.lineWidth = this.dpr;
    o.stroke();
    for (let deg = 0; deg < 360; deg += 10) {
      const a = (deg * Math.PI) / 180;
      const major = deg % 90 === 0;
      const len = (major ? 6 : 3.5) * this.dpr;
      o.beginPath();
      o.moveTo(cx + Math.cos(a) * rb, cx + Math.sin(a) * rb);
      o.lineTo(cx + Math.cos(a) * (rb + len), cx + Math.sin(a) * (rb + len));
      o.strokeStyle = hexToRgba(theme.bezel, 0.6);
      o.lineWidth = (major ? 1.2 : 0.7) * this.dpr;
      o.stroke();
    }
    o.font = `${Math.max(7, r * 0.026)}px "IBM Plex Mono",monospace`;
    o.fillStyle = hexToRgba(theme.bezel, 0.75);
    o.textAlign = "center";
    o.textBaseline = "middle";
    for (const deg of [0, 90, 180, 270]) {
      const a = (deg * Math.PI) / 180;
      const lr = rb + 11 * this.dpr;
      o.fillText(String(deg), cx + Math.cos(a) * lr, cx + Math.sin(a) * lr);
    }
  }

  /** Nearest visible event to a CSS-pixel pointer position, or null. Exposed
   * for pick.ts callers that already hold the same windowed event slice. */
  currentCenter(): [number, number] {
    const r = this.projection.rotate();
    return [-r[0], -r[1]];
  }

  draw(opts: GlobeDrawOptions): void {
    this.rebuildStaticLayers(opts.theme, opts.accent);
    const { ctx, canvas } = this;
    const px = canvas.width;

    this.projection.rotate(opts.rot);
    const center: [number, number] = [-opts.rot[0], -opts.rot[1]];
    const project: Project = makeProjector(this.projection, center);

    // 1) cached ocean disk (device-pixel bitmap)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    ctx.drawImage(this.underlay, 0, 0);

    // 2) rotation-dependent graticule + land (CSS-unit space, live path draws)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    this.path(graticule);
    ctx.strokeStyle = opts.theme.graticule;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.beginPath();
    this.path(land);
    ctx.fillStyle = opts.theme.land;
    ctx.fill();
    ctx.strokeStyle = opts.theme.coast;
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // 3) cached rim/glow + bezel ring/ticks/labels
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.overlay, 0, 0);

    // 4) persistent density layer (additive, slow decay)
    this.density.step(opts.windowedEvents, project, DOT_COLORS);
    ctx.drawImage(this.density.element, 0, 0);

    // 5) live windowed dots + pulses, drawn last so they sit above the glow
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawDots({
      ctx,
      events: opts.windowedEvents,
      pos: opts.pos,
      project,
      colors: DOT_COLORS,
      accent: opts.accent,
    });
    drawPulses(ctx, opts.pulses, opts.now, project, DOT_COLORS);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

export { DOT_FADE_WINDOW } from "./dots";
export { pickNearest } from "./pick";
