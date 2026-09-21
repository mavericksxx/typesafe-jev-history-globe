// The /ask page: a standalone entry point (see vite.config.ts's multi-page
// build) for live-scoring a typed event and pinning it on a globe, alongside
// the corpus's own events from the same era for context. Boot + DOM wiring
// only, same split as main.ts/loop.ts, just for a much smaller page — there
// is no timeline, no playback, no narrative; the globe here draws exactly
// once per successful score, not on an animation loop.
import "./styles/main.css";
import { Globe } from "./globe";
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

  const globeBox = byId("askGlobeBox");
  const globeCanvas = byId("askGlobe") as HTMLCanvasElement;
  const globe = new Globe(globeCanvas);
  const globeNote = byId("askGlobeNote");

  /** The pin currently on screen, kept so a resize can repaint it. This page
   * has no animation loop — it draws once per score — and `globe.resize()`
   * reallocates the canvases, so without this a resize leaves a blank globe
   * until the next keystroke. Mobile browsers fire one a moment after load
   * when the URL bar collapses, which wiped the globe on phones. */
  let lastPin: { pin: HistoryEvent; approx: boolean } | null = null;

  function resizeGlobe(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = globeBox.clientWidth;
    if (size <= 0) return; // not laid out yet; a later resize will catch it
    globe.resize(size, dpr);
    if (lastPin) drawPin(lastPin.pin, lastPin.approx);
  }
  window.addEventListener("resize", resizeGlobe);
  // Orientation changes report the old size if measured too early, and some
  // mobile browsers settle the viewport a frame or two after load.
  window.addEventListener("orientationchange", () => setTimeout(resizeGlobe, 150));
  resizeGlobe();
  requestAnimationFrame(resizeGlobe);

  /** Draws the pin plus nearby corpus events once, statically (no
   * animation loop — this page isn't a playback scrubber). All included
   * events (context + pin) are given the same synthetic `t`/`pos` so
   * dots.ts's age-based fade never kicks in; they're meant to all read as
   * "present" at once, not as a moving window in time. */
  function drawPin(pin: HistoryEvent, yearIsApproximate = false): void {
    lastPin = { pin, approx: yearIsApproximate };
    const windowYears = contextWindowYears(pin.year);
    const context = events.filter((e) => e.locKind !== "none" && Math.abs(e.year - pin.year) <= windowYears).slice(0, 400);
    const POS = 0.999;
    const all: HistoryEvent[] = [...context.map((e) => ({ ...e, t: POS })), { ...pin, t: POS }];
    globe.draw({
      theme,
      accent: theme.accent,
      rot: [-pin.lon, -pin.lat],
      pos: POS,
      all,
      dotStart: 0,
      dotEnd: all.length,
      densityIdx: 0,
      pulses: [],
      now: performance.now(),
    });
    // A year the model guessed (rather than one parsed out of the text) comes
    // from an 8-bucket interpolation and is only era-accurate, so it's hedged
    // with "around" rather than stated as a date.
    const shown = pin.year < 0 ? `${-pin.year} BC` : String(pin.year);
    const when = yearIsApproximate ? `around ${shown}` : shown;
    globeNote.textContent = `Pinned ${when} · ${context.length} nearby events shown for context.`;
  }

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
      // Nothing pinned any more, so a later resize must not repaint a stale pin.
      lastPin = null;
      globeNote.textContent = "Type an event above.";
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
