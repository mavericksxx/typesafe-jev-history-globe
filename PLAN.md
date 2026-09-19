# Jev History Globe

A spinning 3D globe with a time slider. Scrub from 3000 BC to today and watch ~50k historical events light up by type: wars flare, science clusters, empires rise and fall. Jev tags every event once; the visuals replay for free forever.

## Why Jev

- **Typed tags with confidence** for every event, not free-text summaries.
- **Cheap enough for a whole corpus:** ~50k events × ~460 tokens ≈ 23M tokens ≈ **$1** (measured; output tokens are free) at $42 per billion input tokens.
- **Confidence becomes part of the look:** low-confidence tags glow dimmer.

## Pipeline

1. **Collect events.** Wikipedia year pages ("1905", "1066 BC", …) list events as one-line bullets. Parse them into `{year, text, linked_articles}`.
2. **Locate them.** Look up linked articles in Wikidata to get coordinates (place, country, battle site). Drop events with no location, or pin them to the country's centroid.
3. **Tag with Jev.** One call per event (batched if the API supports it):
   Composite scoring, validated in `scripts/probe-composite.mjs`:
   - six Noul theme questions (war, politics, religion, economy, science, culture), each 0–1
   - an `impact` Score with four levels (local → changed world history)
   - a `country` Choice (≤255 options) for placing the event when there's no coordinate
   The dot colour comes from the highest-scoring theme. Every answer includes all its probabilities, and those drive the bars.
   Keep the raw response next to each event. Never call Jev again for an event that's already tagged.
4. **Save** everything to `events.json` (or SQLite). This is the only step that costs money.
5. **Render.** A static web app with a d3-geo orthographic globe (see Design):
   - Globe with a dot per event, colored by category, sized by scale
   - Opacity set by Jev's confidence
   - Time slider with play/pause and speed control; events fade in and out as time passes
   - Category filters and a hover card with the event text, tag and confidence
   - Optional: density heatmap mode, "follow a category" mode

## Design: AI 2040 look

Reference: https://ai-2040.com/ (teardown in `project-builder-ai-agent/docs/ai-2040-design-inspo.md`). Printed-atlas look, not a glowing sci-fi globe.

- **Palette:** `#fffff8` cream canvas, `#14202e` navy ink, `#8b0000` oxblood accent. Categories use ink tints plus one or two muted accents (oxblood, ochre, slate), not a rainbow.
- **Type:** `et-book, Palatino, Georgia, serif` for titles and event text. `Menlo, monospace` for the year, stats and legend labels.
- **Globe:** a line-art orthographic globe (d3-geo): white ocean, thin black coastlines, no textures and no bloom. Events are small solid dots. Scale sets the size and Jev confidence sets the opacity.
- **Backdrop:** a halftone dot field behind the globe whose density follows event volume over time. This replaces the glow as the "lots happening" signal.
- **Layout:** long-form serif column on the left, sticky globe panel on the right. Under the globe: a mono year chip, a dotted timeline with a scrubber, a category legend with counts, and a small stat row (events, wars, discoveries in view).
- **Scroll story (optional):** essay sections tagged with `data-year` and parked with `scroll-margin-top: 50vh`. An IntersectionObserver sets the active era and the globe tweens to it. Free scrubbing still works.
- **Motion:** still by default; animation only under `prefers-reduced-motion: no-preference`.
- **Rendering:** 50k SVG nodes is too many. Draw the outline and graticule in SVG, and draw the event dots on a `<canvas>` using the same projection. No three.js is needed.

## Jev panel: moving bars

On the right, cards styled after the Jev Doom demo: one card per question, one bar per option, the winning option bold and the rest dimmed, with `conf` shown under each card. Bars slide between values.

### Showreel (the default experience)
Record once, then replay forever for free. We save data, not video, so the replay stays interactive (pause, scrub, hover) and sharp at any size.
- **Per-event cards**: the saved answers for each event pop in as the year arrives.
- **Era panel**: every 5–10 years, one Jev call is made with the events in that window ("what dominated this era?"). On playback the page tweens from one snapshot to the next.
- **Save each call's latency** and show it in a corner (`412 ms`).
- **Label it** "Recorded run · jev-1.13.0 · <date>". Re-recording later on a new model gives a before/after comparison.

### Live mode ("Try it live")
- **The user types an event.** Once typing pauses for ~300 ms, Jev is asked again, so the bars shift as the sentence grows.
- **Place**: from the `country` Choice, or the user clicks the globe. **Year**: typed by the user. A Noul question, "is this a real historical event?", filters out junk.
- **Tiny server** (a Cloudflare Worker) holds the API key. It enforces a per-visitor limit (2 calls/s, 300 a day) and a global daily cap (about $0.50); when the cap is hit it shows "Jev is resting".
- Measured: about $0.00002 per call and 370–450 ms per call once the connection is warm.

## Budget ($5 total)

| Step | Tokens | Cost |
|---|---|---|
| Pilot: 500 events | ~230k | ~$0.01 |
| Full run: 50k events | ~23M | ~$1 |
| Showreel era snapshots: ~1k | ~1M | < $0.05 |
| Live mode, per visitor typing an event (~20 calls) | ~9k | ~$0.0004 |
| Headroom for re-runs / prompt tweaks | | plenty |

Add a hard token counter to the tagging script that stops at a set cap.

## First steps (1–2 done: `scripts/probe*.mjs`)

1. Read docs.typesafe.ai: request format, typed schemas, batching, rate limits, and **whether output tokens are billed**.
2. Get an API key from console.typesafe.ai.
3. Scrape ~500 events from a few centuries, tag them, and check the tags by hand. Adjust categories if needed.
4. Build the globe on the pilot data before scaling up.
5. Run the full 50k.

## Open questions

- Output-token pricing, and any early-access limits.
- BC-era year pages are sparse; supplement with Wikidata "point in time" queries?
- How to show events with a wide or uncertain location (e.g. "the Renaissance").
