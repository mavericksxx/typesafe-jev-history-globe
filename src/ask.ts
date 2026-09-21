// The /ask page: a standalone entry point (see vite.config.ts's multi-page
// build) for live-scoring a typed event and pinning it on a globe, alongside
// the corpus's own events from the same era for context. Boot + DOM wiring
// only, same split as main.ts/loop.ts, just for a much smaller page — there
// is no timeline, no playback and no narrative. It does run a small animation
// loop: the galaxy backdrop drifts, and the globe eases round to each new pin
// from a resting view of the corpus.
import "./styles/main.css";
import { Globe } from "./globe";
import { GalaxyBackdrop } from "./galaxy/backdrop";
import type { HistoryEvent } from "./data/types";
import { THEMES } from "./data/types";
import { T } from "./data/timescale";
import { loadManifest, loadColumnarIndex, eventsFromColumnar } from "./data/loader";
import { makeBars, setBars } from "./panel/bars";
import { THEME_COLORS, getGalaxyTheme, applyGalaxyCssVars, injectThemeColorVars, isGalaxyId, DEFAULT_GALAXY_ID } from "./themes";
import type { GalaxyTheme } from "./themes";
import { scoreLive, liveStatusText, zeroThemes } from "./live/client";
import type { LiveState } from "./live/client";

const DATA_BASE = "/data";

/** How many years either side of the pin's year still counts as "the same
 * era" for context dots — matches roughly the era-card windows in
 * data/eras.json rather than an arbitrary constant. Widened for very old
 * events, where the corpus is sparse (same reasoning as dots.ts's
 * sparse-window handling on the main page). */
function contextWindowYears(year: number): number {
  return year < 500 ? 600 : 150;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

async function boot(): Promise<void> {
  injectThemeColorVars();
  const galaxyId = isGalaxyId(document.documentElement.dataset.galaxy) ? document.documentElement.dataset.galaxy : DEFAULT_GALAXY_ID;
  const theme: GalaxyTheme = getGalaxyTheme(galaxyId);
  applyGalaxyCssVars(theme);

  const manifest = await loadManifest(DATA_BASE);
  const columnar = await loadColumnarIndex(DATA_BASE, manifest);
  const events = eventsFromColumnar(columnar);

  // The galaxy field behind everything, same as the main page — the #galaxyBg
  // canvas was already in this page's markup but nothing was ever driving it,
  // so /ask rendered on flat black while the globe page had stars.
  const backdropCanvas = byId("galaxyBg") as HTMLCanvasElement;
  const backdrop = new GalaxyBackdrop(backdropCanvas, theme);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function resizeBackdrop(): void {
    backdrop.setTheme(theme, window.innerWidth, window.innerHeight);
  }
  resizeBackdrop();
  window.addEventListener("resize", resizeBackdrop);

  const globeBox = byId("askGlobeBox");
  const globeCanvas = byId("askGlobe") as HTMLCanvasElement;
  const globe = new Globe(globeCanvas);
  const globeNote = byId("askGlobeNote");

  /** What the globe is currently showing. The page has no timeline, but it
   * does animate: the globe sits at rest showing a spread of the corpus, then
   * rotates to the pin when a score lands. `shown` is what a repaint needs —
   * a resize reallocates the canvases, so we must be able to redraw at any
   * moment (mobile browsers fire a resize when the URL bar collapses, which
   * used to leave a blank globe). */
  let shown: { pin: HistoryEvent | null; context: HistoryEvent[]; approx: boolean } = {
    pin: null,
    context: [],
    approx: false,
  };
  const POS = 0.999;
  /** Current and target camera rotation, eased between so a new pin glides
   * into view rather than cutting. */
  let rot: [number, number] = [-10, -15];
  let rotTarget: [number, number] = [-10, -15];
  let globeDirty = true;

  function resizeGlobe(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = globeBox.clientWidth;
    if (size <= 0) return; // not laid out yet; a later resize will catch it
    globe.resize(size, dpr);
    globeDirty = true;
  }
  window.addEventListener("resize", resizeGlobe);
  // Orientation changes report the old size if measured too early, and some
  // mobile browsers settle the viewport a frame or two after load.
  window.addEventListener("orientationchange", () => setTimeout(resizeGlobe, 150));
  resizeGlobe();
  requestAnimationFrame(resizeGlobe);

  function paintGlobe(): void {
    const all: HistoryEvent[] = shown.context.map((e) => ({ ...e, t: POS }));
    if (shown.pin) all.push({ ...shown.pin, t: POS });
    globe.draw({
      theme,
      accent: theme.accent,
      rot,
      pos: POS,
      all,
      dotStart: 0,
      dotEnd: all.length,
      densityIdx: 0,
      pulses: [],
      now: performance.now(),
    });
  }

  /** Shortest way round the sphere, so rotating from 170° to -170° goes 20°
   * the near way rather than 340° the long way. */
  function shortestDelta(from: number, to: number): number {
    return ((to - from + 540) % 360) - 180;
  }

  // One loop drives the galaxy backdrop (it has drifting stars of its own)
  // and the globe's rotation easing. The globe only repaints when something
  // actually changed — at rest this costs a backdrop draw and nothing else.
  function frame(now: number): void {
    backdrop.draw(now, reducedMotion, 0);
    const dLon = shortestDelta(rot[0], rotTarget[0]);
    const dLat = rotTarget[1] - rot[1];
    if (Math.abs(dLon) > 0.05 || Math.abs(dLat) > 0.05) {
      const k = reducedMotion ? 1 : 0.12;
      rot = [rot[0] + dLon * k, rot[1] + dLat * k];
      globeDirty = true;
    }
    if (globeDirty) {
      globeDirty = false;
      paintGlobe();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /** A spread of the corpus for the globe to show before anyone has typed
   * anything — the page shouldn't open on an empty sphere. Takes the most
   * significant events across all of history rather than one era's worth, so
   * the resting globe reads as "everything we know" and the pin later reads
   * as "and here's yours". */
  function showIdleGlobe(): void {
    const spread = events
      .filter((e) => e.locKind !== "none")
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 600);
    shown = { pin: null, context: spread, approx: false };
    globeDirty = true;
  }

  /** Swaps the globe to the scored event: its own era for context, the pin on
   * top, and the camera eased round to it. */
  function drawPin(pin: HistoryEvent, yearIsApproximate = false): void {
    const windowYears = contextWindowYears(pin.year);
    const context = events
      .filter((e) => e.locKind !== "none" && Math.abs(e.year - pin.year) <= windowYears)
      .slice(0, 400);
    shown = { pin, context, approx: yearIsApproximate };
    rotTarget = [-pin.lon, -pin.lat];
    globeDirty = true;
    const label = pin.year < 0 ? `${-pin.year} BC` : String(pin.year);
    const when = yearIsApproximate ? `around ${label}` : label;
    globeNote.textContent = `Pinned ${when} · ${context.length} nearby events shown for context.`;
  }

  showIdleGlobe();

  // ---------- input + scoring (debounce, abort, all states) ----------
  const input = byId("askInput") as HTMLInputElement;
  const status = byId("askStatus");
  const locEl = byId("askLoc");
  const bars = makeBars(byId("askBars"), THEMES, THEME_COLORS);
  setBars(bars, zeroThemes());

  let debounce: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;
  let requestId = 0;

  function renderLocation(state: LiveState): void {
    if (state.kind !== "scored") {
      locEl.textContent = "";
      return;
    }
    if (state.location.kind === "country") {
      locEl.textContent = `Pinned: associated with ${state.location.country} (approximate — not a precise site).`;
      locEl.classList.remove("is-error");
    } else {
      locEl.textContent = "Location unknown — not pinned on the globe.";
      locEl.classList.add("is-error");
    }
  }

  function renderState(state: LiveState, latencyMs?: number): void {
    status.textContent = liveStatusText(state, latencyMs);
    status.classList.toggle("is-error", state.kind === "error" || state.kind === "rate_limited" || state.kind === "resting");
    if (state.kind === "scored") setBars(bars, state.themes);
    renderLocation(state);

    if (state.kind === "scored" && state.location.kind === "country" && state.year != null) {
      const top = THEMES.reduce((a, b) => (state.themes[b] > state.themes[a] ? b : a));
      drawPin({
        idx: -1,
        year: state.year,
        t: T(state.year),
        text: input.value,
        lat: state.location.lat,
        lon: state.location.lon,
        locKind: "country",
        th: state.themes,
        ext: { disaster: 0, exploration: 0, revolution: 0, empire: 0 },
        top,
        impact: state.impact,
        conf: state.confidence,
        region: "europe",
        real: true,
        minor: false,
      }, state.yearIsApproximate === true);
    } else if (state.kind !== "loading") {
      // Back to the resting globe rather than leaving the last pin stranded.
      showIdleGlobe();
      globeNote.textContent = "Type an event above — the globe will move to it.";
    }
  }

  async function run(text: string): Promise<void> {
    abort?.abort();
    if (!text.trim()) {
      renderState({ kind: "idle" });
      setBars(bars, zeroThemes());
      return;
    }
    const id = ++requestId;
    const controller = new AbortController();
    abort = controller;
    renderState({ kind: "loading" });
    const t0 = performance.now();
    try {
      const state = await scoreLive(text, controller.signal);
      if (id !== requestId) return;
      renderState(state, Math.round(performance.now() - t0));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      if (id !== requestId) return;
      renderState({ kind: "error" });
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(debounce);
    const text = input.value;
    debounce = setTimeout(() => void run(text), 300);
  });
}

void boot();
