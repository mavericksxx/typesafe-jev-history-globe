# epochs — plan

## What this is

A pixel-art galaxy history globe: scrub from 3000 BC to today and watch
historical events light up on a spinning globe rendered like a starfield.
Every event is tagged against "the Jev" — a set of theme scores (war,
politics, religion, economy, science, culture), an impact level, and a
confidence — and that tagging drives the dot's colour and how strongly it
reads on screen.

This document describes the app as it actually exists in the repo today,
not as originally envisioned. (An earlier version of this plan described a
different visual direction — a cream/navy "printed atlas" look with an
essay-and-globe layout and a live "type an event" demo backed by a
Cloudflare Worker. That direction was superseded; see "Design direction"
below for what shipped instead. The live-Jev-call demo does not currently
exist in the app — `src/live/judge.ts` is the only remnant of it and is not
wired into the UI.)

## Architecture

**Stack.** Vite + strict vanilla TypeScript, ESM throughout. No framework —
DOM and canvas are driven directly. Runtime dependencies are `d3-geo`
(projection), `d3-scale`, `d3-array` (bisection), and `topojson-client`
(land geometry). Tests run on `vitest`; data-build and synthetic-data
scripts run on `tsx`. `npm run typecheck` runs `tsc --noEmit`.

**State and render loop.** `src/state.ts` holds the single `AppState` object
(position in T-space, playing/speed, rotation, focus/hover event, pulses,
narrative-scroll target, galaxy theme, dirty flags) plus a set of setter
functions — nothing else is allowed to mutate state directly. `src/loop.ts`
is the single `requestAnimationFrame` loop: every frame it re-derives what
should be visible from `pos`, then only repaints the globe canvas, the
timeline canvas, or the narrative comet rail if their respective dirty flag
(`DirtyFlags.globe` / `.timeline` / `.narrative`) is set.

**Event querying.** `src/data/index.ts` builds an `EventIndex` over the
(time-sorted) event array and uses `d3-array`'s `bisector` to turn "what's
visible at this position" into a `[start, end)` range lookup — no scan or
filter over the full event list happens per frame. Two windows are pulled
from that index each frame:
- **Dot window** (`src/globe/dots.ts`): the bisected range is bounded to the
  most recent `MAX_VISIBLE_DOTS = 3000` events before being drawn.
- **Era window** (`src/data/aggregate.ts`, `ERA_WINDOW = 4000`): a wider
  window used to compute the "what's dominant right now" era snapshot shown
  in the panel.

A 36×18 `DensityGrid` (`src/globe/density.ts`, 10° cells in both axes) backs
the glow/heatmap layer under the globe; it's an accumulate-and-decay grid
that's only rebuilt when doing so is cheaper than incrementally updating it.
Pulses (the "event just fired" flash) are tracked as a separate bounded
list, `MAX_PULSES = 300` (`src/state.ts`), and are only emitted for
non-minor events.

A `tests/perf.test.ts` benchmark checks all of this holds a budget: with the
50k-event synthetic set, one frame's worth of globe update + draw-prep work
at `pos=1` measured **12.12ms** against a 25ms budget (dot window 3000 of
18212 candidates, era n=4000, 61 non-empty density cells).

**Data pipeline.** `scripts/build-data.ts` reads `data/raw/events.ndjson`
and writes the bundle the app fetches at runtime into `public/data/`: a
columnar `index.<hash>.json`, ~2000-event text shards (`shards/*.<hash>.json`,
`SHARD_SIZE = 2000`), an `eras.<hash>.json`, and a `manifest.json` that
points at that build's hashed filenames. Every file except `manifest.json`
is content-hashed, so `public/_headers` caches `/data/index.*.json`,
`/data/eras.*.json`, and `/data/shards/*` immutably (`max-age=31536000,
immutable`) while `manifest.json` gets a short revalidated cache
(`max-age=300, must-revalidate`) since it's the one file whose name stays
stable across deploys. `scripts/gen-synthetic.ts` generates the current
50,000-event synthetic dataset used for development and the perf benchmark.

**Narrative.** `src/narrative/index.ts` uses an `IntersectionObserver` over
`.era-sec` and `.landmark-card` elements to drive the active-era state as
the user scrolls a 17-era narrative column interleaved with landmark cards.
`src/narrative/comet.ts` (`CometRail`) paints the connector trail alongside
that column. `src/narrative/reelScroll.ts` (`ReelScroll`) syncs the replay
("reel") playback and narrative scroll position bidirectionally — scrolling
drives playback position, and letting the reel play scrolls the narrative
to match — but only on the desktop two-column layout (`min-width: 861px`);
below that breakpoint the columns stack and scroll sync is not active.

## Design direction

The app currently uses a dark galaxy backdrop with a pixel-art aesthetic
(pixel-scale rendering, dithered star tints, a per-theme nebula field) and
an "Instrument panel" UI layered over it — direction B, applied across the
app in commit `b814774`. Panel surfaces, cards, and controls share one
visual vocabulary defined as CSS custom properties in `src/styles/main.css`:

- `--b-fill`: the panel-surface background (`color-mix` of the theme's
  void color with transparency).
- `--b-border`: the panel-surface hairline border (`color-mix` of the
  theme's accent color with transparency).
- `--notch`: a shared `clip-path: polygon(...)` that clips the corners of
  panel surfaces into a small chamfered/notched shape instead of rounded
  corners — used on cards, buttons, menus, the hover tooltip, and the live
  input.

There are six selectable galaxy themes (`src/themes/index.ts`,
`GALAXY_THEMES`). Theming works by injecting CSS custom properties from a
single TypeScript theme table at runtime (`applyGalaxy`), with a small
inline pre-paint `<script>` in `index.html` that only picks *which* theme
id is marked (from a `jev-galaxy-default` localStorage key) before first
paint, purely to avoid a flash of the wrong theme — the actual token values
always come from the TS table, not from the pre-paint script or the
per-theme CSS blocks that exist in the stylesheet as a paint-order fallback.

## Phases

**Phase 0 — COMPLETE.** The full interactive app, built against a 50,000-
event synthetic dataset (`scripts/gen-synthetic.ts`). Globe, galaxy
backdrop, timeline, Jev panel, narrative scroll story with landmark cards,
theme switcher, and bidirectional reel/scroll sync are all in place. 36
tests pass (`npm test`); production build is ~140.6KB JS (~55.0KB gzip) plus
~14.6KB CSS (~4.0KB gzip); the perf benchmark holds ~12ms at `pos=1` against
a 25ms budget.

**Phase 1 — IN PROGRESS.** Replace the synthetic dataset with real, sourced
events. Plan: a ~500-event pilot pulled and geolocated via Wikidata, each
event carrying a stable QID and a citation, then scaling to ~5,000 events.
Jev scoring (theme scores, impact, confidence) of these real events is part
of this phase. Note: as of this writing, no Wikidata/QID plumbing exists
yet in `src/` or `scripts/` — `data/raw/` currently holds only
`sample.ndjson`, and the real-data pipeline (fetch, geolocate, score,
convert into `events.ndjson`) still needs to be built.

**Phase 2 — FUTURE.** Not yet scoped. Placeholder only.

## Deployment

Cloudflare Pages, project name `epochs` (`wrangler.toml`), deployed with
`npm run deploy` (`wrangler pages deploy dist --project-name epochs`),
served at the custom domain `epochs.parthkohale.com`. Agents do not run
`wrangler` or deploy — the user runs deploys themselves.
