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
below for what shipped instead. The live-Jev-call demo never got built for
real — its only remnant, a mock keyword-regex judge at `src/live/judge.ts`
plus the "Try it live" input and section in `index.html`, has been removed
from the repo since it was dead code wired to nothing functional.)

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

A `tests/perf.test.ts` benchmark checks all of this holds a budget: it still
runs against a synthetic 50k-event set sized to stress the render loop (the
live app itself now runs far fewer events — see Phase 1), and one frame's
worth of globe update + draw-prep work at `pos=1` measures **~12.75ms**
against a 25ms budget (dot window 3000 of 18212 candidates, era n=4000, 61
non-empty density cells).

**Data pipeline.** `scripts/build-data.ts` reads `data/raw/events.ndjson`
and writes the bundle the app fetches at runtime into `public/data/`: a
columnar `index.<hash>.json`, ~2000-event text shards (`shards/*.<hash>.json`,
`SHARD_SIZE = 2000`), an `eras.<hash>.json`, and a `manifest.json` that
points at that build's hashed filenames. Every file except `manifest.json`
is content-hashed, so `public/_headers` caches `/data/index.*.json`,
`/data/eras.*.json`, and `/data/shards/*` immutably (`max-age=31536000,
immutable`) while `manifest.json` gets a short revalidated cache
(`max-age=300, must-revalidate`) since it's the one file whose name stays
stable across deploys. Two scripts can produce `data/raw/events.ndjson`,
and `build-data.ts` doesn't care which one wrote it:
`scripts/gen-synthetic.ts` still generates the 50,000-event synthetic set
(used for the perf benchmark and available for development), and
`scripts/fetch-wikidata.ts` is the real-data pipeline the shipped app now
runs on — see Phase 1.

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
  corners — used on cards, buttons, menus, and the hover tooltip.

There are six selectable galaxy themes (`src/themes/index.ts`,
`GALAXY_THEMES`). Theming works by injecting CSS custom properties from a
single TypeScript theme table at runtime (`applyGalaxy`), with a small
inline pre-paint `<script>` in `index.html` that only picks *which* theme
id is marked (from a `jev-galaxy-default` localStorage key) before first
paint, purely to avoid a flash of the wrong theme — the actual token values
always come from the TS table, not from the pre-paint script or the
per-theme CSS blocks that exist in the stylesheet as a paint-order fallback.

## Phases

**Phase 0 — COMPLETE.** The full interactive app, originally built and
validated against a 50,000-event synthetic dataset
(`scripts/gen-synthetic.ts`). Globe, galaxy backdrop, timeline, Jev panel,
narrative scroll story with landmark cards, theme switcher, and
bidirectional reel/scroll sync are all in place. That synthetic set still
exists and still works as a `data/raw/events.ndjson` source — it's what the
perf benchmark runs on — but the deployed app no longer uses it; see
Phase 1. 92 tests pass (`npm test`); production build is ~139.0KB JS
(~54.2KB gzip) plus ~13.9KB CSS (~3.9KB gzip).

**Phase 1 — IN PROGRESS.** Replace the synthetic dataset with real, sourced
events. The app now runs on **15,764 real events sourced from Wikidata**,
built into 8 shards — this landed already; Jev scoring of those events has
not.

- **Sourcing pipeline** (`scripts/fetch-wikidata.ts`). A two-stage fetch:
  candidate discovery (querying by class, with no coordinate requirement),
  then batched coordinate resolution via a fallback chain — `P625` (direct
  coordinates), then `P276/P625` (location's coordinates), then
  `P276/P131+/P625` (location's containing-place coordinates), then, as a
  last resort, `P17/P625` (country coordinates, recorded as
  `locKind: "country"`). Selection applies per-period **and** per-theme
  quotas together, ranks candidates within each bucket by sitelink count
  (a notability proxy) and takes the top slice. Queries are cached to disk
  keyed by a hash of the query, so a re-run resumes instead of re-fetching.
  The WDQS rate limit is a 12s gap between requests (raised from an
  initial value that triggered 429 backoff storms), with retry/backoff on
  429/502/503/504 — a coordinate batch that itself times out is split and
  retried recursively rather than aborting the whole run.
- **Event classes.** `THEME_CLASSES` (`scripts/fetch-wikidata.ts`) is the
  single source of truth for which Wikidata classes belong to which theme;
  `EVENT_CLASSES`, `NON_EVENT_CLASSES`, and `CLASS_THEME_MAP` are all
  derived from it rather than maintained separately.
  `scripts/verify-event-classes.ts` checks every QID in that table against
  the live Wikidata endpoint, because hand-transcribing QIDs is error-prone
  in practice, not just in principle: two verification passes caught nine
  wrong QIDs, including one commented "siege" that was actually a riot, and
  one commented "synod" that was actually a cult film.
- **Theme targets vs. achieved balance.** `THEME_SHARES` targets war 25%,
  politics 25%, religion 15%, culture 15%, economy 10%, science 10%. The
  achieved balance in the shipped 15,764 is war 32.2%, politics 20.3%,
  religion 15.4%, culture 14.6%, science 8.9%, economy 8.6% — Wikidata
  simply doesn't carry enough economy/religion/science material before
  1000 AD to hit the targets at this volume; see the measured ceilings
  below.
- **Measured ceilings.** Wikidata cannot supply 50,000 balanced events. A
  target of 40,000 yields ~33,600 after quota/notability filtering; a
  target of 18,000 yields ~16,050. The binding constraint throughout is
  economy/religion/science supply before 1000 AD. Achieved per-period
  distribution (of 15,764): 3000–1000 BC 247, 1000–500 BC 314, 500–1 BC 538,
  1–500 AD 779, 500–1000 626, 1000–1500 1430, 1500–1800 1800, 1800–1900
  2160, 1900–1950 2520, 1950–2000 2880, 2000–present 2468.
- **Coordinate rung mix.** Of the resolved events: P625 (direct) 11,260,
  P276 (location) 2,905, P131 (containing place) 40, P17 (country) 1,559;
  1,412 candidates were left unresolved and dropped rather than kept with
  no usable location.
- **Data quality caveats (pending Jev scoring).** `impact` is currently a
  flat 1.5 placeholder for every event, and themes are keyword/class-derived
  rather than judged — both are pending a real scoring pass. That pass is
  IN PROGRESS as `scripts/score-events.ts` (not yet in the repo), which will
  call api.typesafe.ai's systemone endpoint with six theme questions plus a
  4-level impact score per event; estimated at ~460 input tokens/event,
  ~$0.30 for all 15,764 at $42/billion input tokens, with output free.
  `minor` is, in the meantime, a crude top-2%-by-sitelinks proxy standing in
  for real impact scores. Some ancient events are bare toponyms (e.g.
  "Debdieba", "Kozan") because founding-dated settlements in Wikidata often
  carry no descriptive text beyond a name and a date.
- **Narrative fact-check.** `data/UNVERIFIED.md` records fact-check findings
  on the hand-written eras and landmarks: one real correction (the Berlin
  Conference landmark said 1885, corrected to 1884 to match Wikidata's
  start-time claim and the era copy) and three disputed dates left as-is
  and flagged for a human call, because the sources genuinely conflict
  rather than one of them simply being wrong.
- **Considered and rejected.** A Wikipedia year-page scraper was assessed as
  a possible second source to thicken antiquity coverage, and deliberately
  not built — the expected gain looked modest, since the ancient record is
  genuinely thin rather than merely hard to query through Wikidata's API.

**Phase 2 — FUTURE.** Not yet scoped. Placeholder only.

## Deployment

Cloudflare Pages, project name `epochs` (`wrangler.toml`), deployed with
`npm run deploy` (`wrangler pages deploy dist --project-name epochs`),
served at the custom domain `epochs.parthkohale.com`. Agents do not run
`wrangler` or deploy — the user runs deploys themselves.
