// Boot + DOM wiring. Input handlers write through state.ts setters; the
// Loop (loop.ts) is the only thing that reads state back out to render.
import "./styles/main.css";
import { eventIndex } from "./data";
import { computeHistogram } from "./data/aggregate";
import { T } from "./data/timescale";
import { THEMES } from "./data/types";
import { loadManifest, loadColumnarIndex, loadEras, eventsFromColumnar, createTextResolver } from "./data/loader";
import {
  getState,
  setPos,
  setPlaying,
  setSpeed,
  setDragging,
  setRotation,
  setGalaxyId,
  setAccent,
  setHoverEvent,
  setNarrativeTarget,
} from "./state";
import { Globe, pickNearest, DOT_FADE_WINDOW } from "./globe";
import { Timeline, TL_COLS } from "./timeline";
import { GalaxyBackdrop } from "./galaxy/backdrop";
import { EraPanel } from "./panel/era";
import { EventStream } from "./panel/stream";
import { makeBars, setBars, makeImpact, setImpact } from "./panel/bars";
import { renderNarrative, observeNarrative } from "./narrative";
import { judge } from "./live/judge";
import { Loop } from "./loop";
import {
  GALAXY_IDS,
  GALAXY_THEMES,
  DEFAULT_GALAXY_ID,
  isGalaxyId,
  getGalaxyTheme,
  applyGalaxyCssVars,
  injectThemeColorVars,
} from "./themes";
import type { GalaxyId } from "./themes";

const DATA_BASE = "/data";
const GALAXY_STORAGE_KEY = "jev-galaxy-default";

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}
function byIdCanvas(id: string): HTMLCanvasElement {
  const el = byId(id);
  if (!(el instanceof HTMLCanvasElement)) throw new Error(`#${id} is not a canvas`);
  return el;
}

async function boot(): Promise<void> {
  injectThemeColorVars();
  await document.fonts.ready;

  const manifest = await loadManifest(DATA_BASE);
  const [columnar, eras] = await Promise.all([
    loadColumnarIndex(DATA_BASE, manifest),
    loadEras(DATA_BASE, manifest),
  ]);
  const events = eventsFromColumnar(columnar);
  eventIndex.setEvents(events);
  const ensureText = createTextResolver(DATA_BASE, manifest);

  const datasetMetaEl = document.getElementById("datasetMeta");
  if (datasetMetaEl) datasetMetaEl.textContent = `${manifest.totalEvents.toLocaleString()} events`;

  renderNarrative(byId("eraList"), eras);
  const narrativeNav = document.querySelector<HTMLElement>(".narrative");
  if (narrativeNav) observeNarrative(narrativeNav);

  // ---------- galaxy theme ----------
  const initialId: GalaxyId = isGalaxyId(document.documentElement.dataset.galaxy)
    ? (document.documentElement.dataset.galaxy as GalaxyId)
    : DEFAULT_GALAXY_ID;
  const galaxyBackdrop = new GalaxyBackdrop(byIdCanvas("galaxyBg"), getGalaxyTheme(initialId));

  let savedDefaultId: GalaxyId | null = (() => {
    try {
      const v = localStorage.getItem(GALAXY_STORAGE_KEY);
      return isGalaxyId(v) ? v : null;
    } catch {
      return null;
    }
  })();

  const themeBtn = byId("themeBtn");
  const themeMenu = byId("themeMenu");
  const themeBtnLabel = byId("themeBtnLabel");
  const themeBtnSwatch = byId("themeBtnSwatch");
  let menuOpen = false;

  function applyGalaxy(id: GalaxyId, opts?: { commit?: boolean }): void {
    const theme = getGalaxyTheme(id);
    applyGalaxyCssVars(theme);
    setGalaxyId(id, opts?.commit !== false);
    setAccent(theme.accent);
    galaxyBackdrop.setTheme(theme, window.innerWidth, window.innerHeight);
    if (!opts || opts.commit !== false) renderThemeMenu();
  }

  function renderThemeMenu(): void {
    const state = getState();
    const theme = getGalaxyTheme(state.galaxyId);
    themeBtnLabel.textContent = theme.name;
    themeBtnSwatch.style.background = state.accent;
    themeMenu.innerHTML =
      GALAXY_IDS.map((id) => {
        const g = GALAXY_THEMES[id];
        const checked = id === state.committedGalaxyId;
        const isDefault = id === savedDefaultId;
        return (
          `<li role="none"><button type="button" class="theme-row" role="menuitemradio" aria-checked="${checked}" data-theme="${id}">` +
          `<span class="row-swatches" aria-hidden="true">${g.swatches.map((c) => `<span style="background:${c}"></span>`).join("")}</span>` +
          `<span class="row-name">${g.name}</span>` +
          (isDefault ? `<span class="row-default-tag">default</span>` : "") +
          `</button></li>`
        );
      }).join("") +
      `<li class="theme-menu-divider" role="separator"></li>` +
      `<li role="none"><button type="button" role="menuitem" class="set-default-btn" id="setDefaultBtn">Set &ldquo;${theme.name}&rdquo; as default</button></li>`;

    themeMenu.querySelectorAll<HTMLElement>(".theme-row").forEach((row) => {
      const id = row.dataset.theme as GalaxyId;
      row.addEventListener("click", () => {
        applyGalaxy(id);
        closeThemeMenu(true);
      });
      row.addEventListener("pointerenter", () => applyGalaxy(id, { commit: false }));
      row.addEventListener("focus", () => applyGalaxy(id, { commit: false }));
      row.addEventListener("pointerleave", () => applyGalaxy(getState().committedGalaxyId, { commit: false }));
    });
    document.getElementById("setDefaultBtn")?.addEventListener("click", () => {
      try {
        localStorage.setItem(GALAXY_STORAGE_KEY, getState().committedGalaxyId);
        savedDefaultId = getState().committedGalaxyId;
      } catch {
        /* ignore */
      }
      renderThemeMenu();
    });
  }

  function menuFocusables(): HTMLElement[] {
    return [...themeMenu.querySelectorAll<HTMLElement>(".theme-row, .set-default-btn")];
  }
  function openThemeMenu(): void {
    menuOpen = true;
    themeMenu.hidden = false;
    themeBtn.setAttribute("aria-expanded", "true");
    const items = menuFocusables();
    (themeMenu.querySelector<HTMLElement>('.theme-row[aria-checked="true"]') ?? items[0])?.focus();
    document.addEventListener("pointerdown", onDocPointerDown, true);
  }
  function closeThemeMenu(refocusBtn: boolean): void {
    if (!menuOpen) return;
    menuOpen = false;
    themeMenu.hidden = true;
    themeBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    if (getState().galaxyId !== getState().committedGalaxyId) applyGalaxy(getState().committedGalaxyId, { commit: false });
    if (refocusBtn) themeBtn.focus();
  }
  function onDocPointerDown(e: PointerEvent): void {
    const target = e.target as Node;
    if (!themeMenu.contains(target) && target !== themeBtn && !themeBtn.contains(target)) closeThemeMenu(false);
  }
  themeBtn.addEventListener("click", () => (menuOpen ? closeThemeMenu(true) : openThemeMenu()));
  themeBtn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!menuOpen) openThemeMenu();
    }
  });
  themeMenu.addEventListener("keydown", (e) => {
    const items = menuFocusables();
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      closeThemeMenu(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1 + items.length) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === "Tab") {
      closeThemeMenu(false);
    }
  });

  applyGalaxy(initialId, { commit: true });

  // ---------- globe / timeline / panel ----------
  const globeBox = byId("globeBox");
  const globeCanvas = byIdCanvas("globe");
  const globe = new Globe(globeCanvas);

  const timeline = new Timeline({
    canvas: byIdCanvas("tlCanvas"),
    ticks: byId("tlTicks"),
    handle: byId("tlHandle"),
    label: byId("tlLabel"),
  });
  timeline.setHistogram(computeHistogram(events, TL_COLS));

  const eraPanel = new EraPanel({
    themeBars: byId("eraThemeBars"),
    regionBars: byId("eraRegionBars"),
    moodBars: byId("eraMoodBars"),
    impact: byId("eraImpact"),
    conf: byId("eraConf"),
    n: byId("eraN"),
    range: byId("eraRange"),
  });

  const stream = new EventStream(byId("stream"));

  const loop = new Loop({
    globe,
    timeline,
    galaxyBackdrop,
    eraPanel,
    stream,
    els: {
      yearChip: byId("yearChip"),
      hover: byId("hover"),
      sEvents: byId("sEvents"),
      sCalls: byId("sCalls"),
      sCost: byId("sCost"),
      sTheme: byId("sTheme"),
    },
    ensureText,
  });

  function resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    globe.resize(globeBox.clientWidth, dpr);
    timeline.resize(dpr);
    galaxyBackdrop.resize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener("resize", resize);
  resize();

  // ---------- playback controls ----------
  const playBtn = byId("play") as HTMLButtonElement;
  function setPlayLabel(): void {
    const state = getState();
    const label = state.playing ? "Pause" : state.pos >= 1 ? "Replay" : "Play";
    playBtn.textContent = label;
    playBtn.setAttribute("aria-label", label);
  }
  playBtn.addEventListener("click", () => {
    setNarrativeTarget(null);
    if (getState().pos >= 1) {
      setPos(0);
      loop.syncEventsTo(0, false);
    }
    setPlaying(!getState().playing);
    setPlayLabel();
  });
  document.querySelectorAll<HTMLButtonElement>(".speed button").forEach((b) => {
    b.addEventListener("click", () => {
      setSpeed(Number(b.dataset.s));
      document.querySelectorAll<HTMLButtonElement>(".speed button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    });
  });

  // ---------- timeline scrub ----------
  const tlStage = byId("tlStage");
  const tlHandle = byId("tlHandle");
  let tlDragging = false;
  function tlPosFromEvent(e: PointerEvent): number {
    const r = tlStage.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }
  tlStage.addEventListener("pointerdown", (e) => {
    setNarrativeTarget(null);
    tlDragging = true;
    tlStage.setPointerCapture(e.pointerId);
    setPos(tlPosFromEvent(e));
    loop.syncEventsTo(getState().pos, false);
    tlHandle.focus();
  });
  tlStage.addEventListener("pointermove", (e) => {
    if (!tlDragging) return;
    setPos(tlPosFromEvent(e));
    loop.syncEventsTo(getState().pos, false);
  });
  tlStage.addEventListener("pointerup", () => (tlDragging = false));
  tlStage.addEventListener("pointercancel", () => (tlDragging = false));
  tlHandle.addEventListener("keydown", (e) => {
    const step = 0.01;
    let np: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") np = Math.min(1, getState().pos + step);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") np = Math.max(0, getState().pos - step);
    else if (e.key === "Home") np = 0;
    else if (e.key === "End") np = 1;
    if (np === null) return;
    e.preventDefault();
    setNarrativeTarget(null);
    setPos(np);
    loop.syncEventsTo(getState().pos, false);
  });

  // ---------- globe drag + hover ----------
  let dragAnchor: [number, number] | null = null;
  const hoverEl = byId("hover");
  globeCanvas.addEventListener("pointerdown", (e) => {
    setDragging(true);
    globeCanvas.setPointerCapture(e.pointerId);
    dragAnchor = [e.clientX, e.clientY];
  });
  globeCanvas.addEventListener("pointerup", () => setDragging(false));
  globeCanvas.addEventListener("pointercancel", () => setDragging(false));
  globeCanvas.addEventListener("pointermove", (e) => {
    const rect = globeCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const state = getState();
    if (state.dragging && dragAnchor) {
      const dx = e.clientX - dragAnchor[0];
      const dy = e.clientY - dragAnchor[1];
      dragAnchor = [e.clientX, e.clientY];
      const rot: [number, number] = [state.rot[0] + dx * 0.35, Math.max(-60, Math.min(60, state.rot[1] - dy * 0.35))];
      setRotation(rot, rot);
      return;
    }
    hoverEl.style.left = `${Math.min(globeCanvas.clientWidth - 250, mx + 12)}px`;
    hoverEl.style.top = `${my + 12}px`;
    const dotEvents = eventIndex.range(state.pos - DOT_FADE_WINDOW, state.pos);
    setHoverEvent(pickNearest(dotEvents, globe.projectionRef, mx, my));
  });
  globeCanvas.addEventListener("pointerleave", () => setHoverEvent(null));

  // ---------- live (mock Jev judge) ----------
  const liveInput = byId("live") as HTMLInputElement;
  const liveRows = makeBars(byId("liveBars"), THEMES);
  const liveImpactCells = makeImpact(byId("liveImpact"));
  const liveRealEl = byId("liveReal");
  let liveTimer: ReturnType<typeof setTimeout> | undefined;

  async function runLiveJudge(): Promise<void> {
    const answers = await judge(liveInput.value);
    setBars(liveRows, answers.themes);
    setImpact(liveImpactCells, Math.max(0, answers.impact));
    liveRealEl.textContent = `real event? ${answers.real.toFixed(2)}`;
  }
  liveInput.addEventListener("input", () => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => void runLiveJudge(), 300);
  });
  document.querySelectorAll<HTMLButtonElement>("#chips button").forEach((b) => {
    b.addEventListener("click", () => {
      liveInput.value = b.textContent ?? "";
      void runLiveJudge();
    });
  });

  // ---------- boot at a resting state that already shows content ----------
  setPos(T(1520));
  loop.syncEventsTo(getState().pos, false);
  setRotation(getState().targetRot, getState().targetRot);
  void runLiveJudge();
  setPlayLabel();
  loop.start();
}

void boot();
