# epochs

A pixel-art galaxy history globe: scrub a timeline from 3000 BC to today and
watch real historical events light up on a spinning globe rendered like a
starfield. Every event is tagged against "the Jev" — theme scores (war,
politics, religion, economy, science, culture), an impact level, and a
confidence — and that tagging drives how each dot looks and how strongly it
reads on screen.

See [PLAN.md](./PLAN.md) for the full architecture, data pipeline, and
phase-by-phase history — this file is intentionally short.

<!-- TODO: add a screenshot of the app here once one is captured -->

## Quickstart

```sh
npm install
npm run dev
```

Open the printed local URL. You'll land on a spinning galaxy globe with a
timeline scrubber; drag or play the timeline to move through history, and
scroll the narrative column alongside it for a curated 17-era tour with
landmark cards.

## Data pipeline

The event data isn't hand-written — it's sourced, deduplicated, filled in,
and scored by a short chain of scripts, each writing its output for the
next to read:

1. **`scripts/fetch-wikidata.ts`** — queries Wikidata for candidate events
   by class and period, resolves coordinates through a fallback chain, and
   writes `data/raw/events.ndjson`.
2. **`scripts/dedupe-events.ts`** — removes duplicate Wikidata items that
   independent sourcing buckets could otherwise select twice.
3. **`scripts/templatize-context.ts`** — rewrites bare-toponym records
   (e.g. a settlement with only a name and a founding date) into a short
   sentence built from structured Wikidata facts, deterministically.
4. **`scripts/score-events.ts`** — calls typesafe.ai's Jev model to score
   every event's theme mix, impact, and confidence.
5. **`scripts/build-data.ts`** — reads the scored NDJSON and writes the
   columnar, sharded, content-hashed bundle in `public/data/` that the app
   actually fetches at runtime.

Honest caveats: fetching from Wikidata takes **hours** against a
rate-limited public endpoint, and scoring costs real money (the full
corpus cost **$0.44** total). Both steps cache their work to disk, so
re-runs don't repeat cost or time already paid — but neither step re-runs
"for free" the first time. You do not need to run any of this to work on
the app; the built data is committed under `public/data/`.

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Production build to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run the test suite (`vitest run`) |
| `npm run gen-synthetic` | Generate the 50k synthetic event set (`data/raw/events.ndjson`), used for the perf benchmark and dev |
| `npm run fetch-wikidata` | Run step 1 of the data pipeline above |
| `npm run build-data` | Run step 5 of the data pipeline above |
| `npm run deploy` | Deploy `dist/` to Cloudflare Pages |

(`dedupe-events.ts`, `templatize-context.ts`, and `score-events.ts` aren't
wired up as npm scripts — run them directly with `tsx scripts/<name>.ts`,
per the usage comment at the top of each file.)

## Data provenance and licensing

Events are sourced from [Wikidata](https://www.wikidata.org) (CC0); every
event carries its stable Wikidata QID. Theme, impact, and confidence scores
come from typesafe.ai's Jev model. About **3.3%** of the 15,356-event
corpus (507 events) is marked notable. A small number of ancient entries
are templated from structured Wikidata facts (class + date) rather than
written as original prose, because Wikidata's own text for them is just a
name.

## Deployment

Deployed to Cloudflare Pages (project `epochs`, see `wrangler.toml`) at the
custom domain **epochs.parthkohale.com**, via:

```sh
npm run deploy
```

The typesafe.ai API key lives in `.env` as `TYPESAFE_API_KEY`. It's needed
**only** for running `scripts/score-events.ts` — the app itself, `npm run
dev`, and `npm run build` need nothing from it.

## Known limitations

- **Antiquity is genuinely sparse.** Coverage before ~1000 AD is thin
  because Wikidata's own record is thin there, not because of a bug in the
  sourcing pipeline.
- **Country-centroid events are approximate.** When no finer location was
  resolvable, an event falls back to its country's coordinates and renders
  as a hollow ring rather than a filled dot, with a tooltip saying so.
- **Era/landmark narrative text is hand-written**, and only spot-checked
  against sources (see `data/UNVERIFIED.md`), not exhaustively verified.
- **50,000 balanced events is not reachable from Wikidata** at the current
  quality bar — measured: a 40,000-event target yields only ~33,600 after
  quota/notability filtering, bottlenecked by economy/religion/science
  supply before 1000 AD.
