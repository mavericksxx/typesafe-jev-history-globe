// Pulls real historical events from Wikidata's public SPARQL endpoint and
// writes them to data/raw/events.ndjson in the same RawEventRecord shape
// gen-synthetic.ts produces, so scripts/build-data.ts's downstream pipeline
// (columnar index + text shards + eras/landmarks, all content-hashed and
// referenced from manifest.json) needs no changes to consume real data
// instead of synthetic data. Run this, then `npm run build-data`; run
// gen-synthetic.ts instead to go back to synthetic — both just populate the
// same data/raw/events.ndjson file.
//
// Usage:
//   tsx scripts/fetch-wikidata.ts                  # full run, EVENT_TARGET below (ceiling, not a quota)
//   tsx scripts/fetch-wikidata.ts --target=500      # pilot run — validate the pipeline before committing to 50k
//   tsx scripts/fetch-wikidata.ts --dry-run         # print period ceilings only, write nothing
//   tsx scripts/fetch-wikidata.ts --dry-run --target=25000   # ceilings for any target, no fetch
//
// Scaling: EVENT_TARGET is the only knob that needs to change to go from the
// ~500-event pilot to the full 50,000-event run. Everything else (period
// quotas, paging, caching, rate limiting) is written to scale with it —
// periods that are simply thin in the historical record cap out at their
// measured ceiling instead of being backfilled with more modern events.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES } from "../src/data/types";
import type { LocKind, RawEventRecord, Theme } from "../src/data/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(REPO_ROOT, "data/raw/events.ndjson");
const CACHE_DIR = path.join(REPO_ROOT, "data/cache/wikidata");
const ENDPOINT = "https://query.wikidata.org/sparql";
// QLever mirrors Wikidata but answers transitive property-path queries
// (wdt:P31/wdt:P279*) that time out (HTTP 504) against WDQS at this scale —
// used ONLY for stage-1 candidate discovery (item/class/date/sitelinks), per
// the task brief's explicit sanction. Its snapshot being a few days stale is
// irrelevant there: every candidate QID is re-resolved (coordinates, label)
// against live WDQS in stage 2, so a stale or since-deleted QID simply fails
// to resolve and is dropped rather than silently trusted.
const QLEVER_ENDPOINT = "https://qlever.dev/api/wikidata";
const USER_AGENT =
  "epochs-history-globe/0.1 (pilot data collection; contact: parthkohale@gmail.com)";

/** Total real events to collect. Raise this to scale the pull — nothing else
 * in this file needs to change. Per-period quotas below are proportional
 * shares of this number, each capped by that period's measured ceiling. */
// The user's stated end goal is the full ~50,000 events (matching the
// synthetic dataset size the renderer is already perf-benchmarked against),
// treated as a CEILING — periods that run dry per resolveQuotas() stay dry
// rather than being padded, duplicated, or backfilled from modern events to
// hit the number. Run this script with a smaller value first (see the
// pilot invocation in the module doc comment above) to validate the
// pipeline before committing to a 50k pull.
export const EVENT_TARGET = 50_000;

/** Be polite to a shared public endpoint: minimum gap between live HTTP
 * requests (cached reads are instant and don't count against this). */
const RATE_LIMIT_MS = 4000;

/** One slice of the 3000 BC - present timeline, with the fraction of
 * EVENT_TARGET it's entitled to. Weights sum to 1. Skewed toward modern
 * (real Wikidata coverage skews that way too) but nowhere near as hard as
 * raw density would push it, so antiquity isn't crowded out entirely — and
 * each period still caps at whatever the record actually has (see
 * `resolveQuotas`), rather than modern periods absorbing the shortfall. */
export interface Period {
  label: string;
  start: number; // inclusive year, negative = BC
  end: number; // exclusive year
  weight: number;
}

// Boundary check (1g): year 0 must land in exactly one period. "500 BC - 1
// BC" ends at (exclusive) 0, so it covers years -500..-1; "1-500 AD" starts
// at (inclusive) 0, so it covers years 0..499. Year 0 (1 BC in the proleptic
// calendar / year 0 in astronomical numbering, see parseWikidataYear) lands
// in "1-500 AD" and nowhere else — this was already correct, verified by the
// "cover 3000 BC through the present with no gaps or overlaps" test below.
export const PERIODS: Period[] = [
  { label: "3000-1000 BC", start: -3000, end: -1000, weight: 0.05 },
  { label: "1000-500 BC", start: -1000, end: -500, weight: 0.04 },
  { label: "500 BC - 1 BC", start: -500, end: 0, weight: 0.05 },
  { label: "1-500 AD", start: 0, end: 500, weight: 0.06 },
  { label: "500-1000", start: 500, end: 1000, weight: 0.06 },
  { label: "1000-1500", start: 1000, end: 1500, weight: 0.08 },
  { label: "1500-1800", start: 1500, end: 1800, weight: 0.1 },
  { label: "1800-1900", start: 1800, end: 1900, weight: 0.12 },
  { label: "1900-1950", start: 1900, end: 1950, weight: 0.14 },
  { label: "1950-2000", start: 1950, end: 2000, weight: 0.16 },
  { label: "2000-present", start: 2000, end: 2027, weight: 0.14 },
];

const WEIGHT_SUM = PERIODS.reduce((s, p) => s + p.weight, 0);
if (Math.abs(WEIGHT_SUM - 1) > 1e-9) {
  throw new Error(`PERIODS weights must sum to 1, got ${WEIGHT_SUM}`);
}

/** Given a measured ceiling per period (how many qualifying Wikidata items
 * actually exist for it), compute how many to fetch from each: the smaller
 * of its proportional share of `target` and its ceiling. Periods that run
 * dry simply produce fewer events — their leftover share is NOT redistributed
 * to other (e.g. modern) periods, so the output stays spread across history
 * rather than collapsing back into a modern-heavy sample.
 *
 * Uses the largest-remainder method so the shares sum to exactly `target`
 * (when ceilings allow) instead of drifting from independent per-period
 * rounding: each period first gets floor(target*weight), then the
 * `target - sum(floors)` leftover slots go to the periods with the largest
 * fractional remainder, one each. */
export function resolveQuotas(
  target: number,
  periods: Period[],
  ceilings: number[]
): number[] {
  const raw = periods.map((p) => target * p.weight);
  const floors = raw.map((v) => Math.floor(v));
  let leftover = target - floors.reduce((a, b) => a + b, 0);
  const remainders = raw
    .map((v, i) => ({ i, frac: v - floors[i]! }))
    .sort((a, b) => b.frac - a.frac);
  const shares = [...floors];
  for (const { i } of remainders) {
    if (leftover <= 0) break;
    shares[i] = shares[i]! + 1;
    leftover--;
  }
  return periods.map((_, i) => Math.max(0, Math.min(shares[i]!, ceilings[i] ?? 0)));
}

// ---- Wikidata date / coordinate parsing -----------------------------------

/** Parses a Wikidata SPARQL dateTime literal ("+1945-08-06T00:00:00Z",
 * "-000489-09-07T00:00:00Z") into a signed calendar year, where negative
 * means BC/BCE and the magnitude is the ordinary historical year (e.g. -490
 * means 490 BC), matching the convention `Period.start`/`.end` already use
 * elsewhere in this file. Returns null if the literal doesn't match the
 * expected shape — callers must drop the event rather than guess.
 *
 * BCE off-by-one (verified live 2026-09-20 against Q31900, Battle of
 * Marathon, commonly dated 490 BC): its wdt:P585 literal is
 * "-0489-09-07T00:00:00Z", i.e. astronomical year -489, NOT -490. Wikidata's
 * RDF export uses astronomical year numbering, where year 0 = 1 BCE and
 * year -1 = 2 BCE — every BCE year is off by one from its magnitude. The
 * previous implementation returned the astronomical value unchanged
 * (-489 for Marathon), which is 490 BC's astronomical year but reads as "489
 * BC" if naively negated back — a real off-by-one bug for every BCE event.
 * Fix: for astronomical year <= 0, historical BC year = astronomicalYear - 1
 * (so -489 -> -490, matching "490 BC"; 0 -> -1, matching "1 BC"). CE years
 * (astronomical year >= 1) are unaffected. */
export function parseWikidataYear(value: string | undefined | null): number | null {
  if (!value) return null;
  // The leading sign is present on most Wikidata dateTime literals but not
  // all (the SPARQL endpoint sometimes omits "+" for CE dates) — default to
  // positive when it's missing rather than dropping the event.
  const m = /^([+-])?(\d{1,6})-\d{2}-\d{2}/.exec(value.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const magnitude = Number(m[2]);
  if (!Number.isFinite(magnitude)) return null;
  const astronomicalYear = sign * magnitude;
  return astronomicalYear <= 0 ? astronomicalYear - 1 : astronomicalYear;
}

/** Parses a WKT "Point(lon lat)" literal into {lat, lon}. Returns null (and
 * the event is dropped) if it's missing or malformed, or the coordinates are
 * out of range. */
export function parseWikidataPoint(value: string | undefined | null): { lat: number; lon: number } | null {
  if (!value) return null;
  const m = /^Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/.exec(value.trim());
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

// ---- Theme classification --------------------------------------------------
// Cheap keyword classification against the item label, mirroring
// src/data/derive.ts's approach — a stand-in, not a real Jev call. Explicitly
// out of scope per the task brief to do LLM-based scoring here.
const THEME_KEYWORDS: Record<Theme, RegExp> = {
  war: /war|battle|siege|invasion|conquest|revolt|uprising|massacre|rebellion/i,
  politics: /treaty|election|coronation|independence|republic|constitution|parliament|revolution|assassinat|founded|unification/i,
  religion: /church|temple|mosque|cathedral|pope|council of|synod|monastery|pilgrimage|crusade/i,
  economy: /trade|famine|market|currency|railway|company|financial|depression|stock/i,
  science: /discover|expedition|invention|observatory|publish|theory|spacecraft|launch|patent/i,
  culture: /festival|painting|opera|novel|monument|olympic|film|architecture/i,
};

export function classifyTheme(label: string): Record<Theme, number> {
  const scores = Object.fromEntries(THEMES.map((t) => [t, 0.1])) as Record<Theme, number>;
  let matched = false;
  for (const t of THEMES) {
    if (THEME_KEYWORDS[t].test(label)) {
      scores[t] = 0.75;
      matched = true;
    }
  }
  if (!matched) scores.politics = 0.4; // documented placeholder lead theme
  return scores;
}

// ---- Part 5: interim theme from Wikidata class, not label keywords --------
// A curated qid->theme map for the classes this pipeline actually queries
// (EVENT_CLASSES, the occurrence subclasses reachable from Q1190554, and
// NON_EVENT_CLASSES below). It intentionally does NOT try to cover the full
// ~283k-item occurrence subclass tree (measured live against QLever,
// 2026-09-20) — that tree is far too broad and long-tailed for a hand-curated
// map to be honest about. Any class not listed here falls back to
// classifyTheme's label-keyword heuristic, which is what happens today for
// every event. Having ?class from the query available is what makes this an
// improvement: the common, high-volume classes (battle, treaty, election,
// church buildings, universities, ...) now get an accurate, deterministic
// theme instead of relying on the label matching a keyword.
export const CLASS_THEME_MAP: Record<string, Theme> = {
  // war
  Q178561: "war", // battle
  Q198: "war", // war
  Q124734: "war", // siege
  Q209749: "war", // invasion
  Q45382: "war", // coup d'état (verified live: Q45382 is coup, not "rebellion" — see EVENT_CLASSES note)
  // politics
  Q131569: "politics", // treaty
  Q1656682: "politics", // planned event (default political framing; usually ceremonies/summits)
  Q40231: "politics", // election
  Q209715: "politics", // coronation
  Q10931: "politics", // revolution
  Q1301371: "politics", // referendum
  Q3624078: "politics", // sovereign state (used for P571/founding events)
  // religion
  Q747074: "religion", // ecumenical council
  Q219557: "religion", // synod
  Q16970: "religion", // church building
  Q32815: "religion", // mosque
  Q34627: "religion", // synagogue
  Q44539: "religion", // temple
  Q44613: "religion", // monastery
  // economy
  Q783794: "economy", // company/business
  Q22667: "economy", // railway
  Q12280: "economy", // bridge
  // science
  Q3918: "science", // university
  Q3914: "science", // school
  Q62832: "science", // observatory
  // culture
  Q33506: "culture", // museum
  Q24354: "culture", // theatre building
  Q22698: "culture", // park
  Q515: "culture", // city (founding — closest single-theme fit for a settlement's inception)
};

/** Interim theme derivation for Part 5: prefers the class->theme map (when
 * the query supplied a recognised ?class), falling back to the label-keyword
 * heuristic (classifyTheme) for classes outside the curated map — which, for
 * the broadened occurrence-subclass tree, is most of them. Still no LLM
 * scoring (out of scope); `impact` stays the documented 1.5 placeholder. */
export function classifyThemeFromClass(label: string, classQid: string | undefined): Record<Theme, number> {
  const theme = classQid ? CLASS_THEME_MAP[classQid] : undefined;
  if (!theme) return classifyTheme(label);
  const scores = Object.fromEntries(THEMES.map((t) => [t, 0.1])) as Record<Theme, number>;
  scores[theme] = 0.8; // higher confidence than the keyword heuristic's 0.75
  return scores;
}

// ---- SPARQL -----------------------------------------------------------------

// A curated list of common historical-event classes, queried by direct
// wdt:P31 (VALUES + UNION of direct instance-of) rather than a transitive
// wdt:P31/wdt:P279* walk from a broad root like "occurrence" (Q1190554).
// The transitive form times out (HTTP 504) at Wikidata's scale — it has to
// walk a huge subclass tree for every candidate item. A fixed class list is
// the standard workaround and is cheap enough to page through repeatedly.
//
// Every QID below was resolved against the live SPARQL endpoint
// (`SELECT ?label WHERE { wd:QID rdfs:label ?label . FILTER(LANG(?label)='en') }`)
// to confirm its rdfs:label before being trusted here — see
// scripts/verify-event-classes.ts, which re-runs that check and is the
// authoritative source of truth for this list (run with
// `tsx scripts/verify-event-classes.ts`). The previous list had six wrong
// QIDs (verified 2026-09-20): Q124757 is "riot" not "siege", Q3839081 is
// "disaster" not "massacre", Q1002697 is "periodical" (a magazine type) not
// "military occupation", Q3241045 is "disease outbreak" not "uprising",
// Q45382 is "coup d'état" not "rebellion", and Q2334719 is "legal case" not
// "historical event". Those six are dropped rather than replaced 1:1, since
// this script broadens the class set structurally in Part 2 instead
// (occurrence subclasses + dated non-event institutions) rather than
// hand-picking more QIDs here.
export const EVENT_CLASSES = [
  { qid: "Q1190554", label: "occurrence" },
  { qid: "Q178561", label: "battle" },
  { qid: "Q198", label: "war" },
  { qid: "Q131569", label: "treaty" },
  { qid: "Q1656682", label: "planned event" },
] as const;

// Part 2c: dated non-event institutions/structures. These usually carry
// wdt:P625 (coordinates) directly on the item itself (unlike most
// non-military "occurrences", which point at a location rather than having
// one) and their P571/P1619/P576 dates reach far back into antiquity —
// expected to be the largest single recovery for the religion/economy/
// science/culture themes and for pre-500-AD periods generally.
// Every QID below was verified live 2026-09-20 against the endpoint (batched
// VALUES + rdfs:label lookup, same pattern EVENT_CLASSES uses) via
// scripts/verify-event-classes.ts, which now checks this list too. Two QIDs
// from the original draft were wrong and are corrected here: Q495015 is
// "Fudan University" not "observatory" (replaced with Q62832, the actual
// "observatory" class), and Q11424 was an explicitly-flagged placeholder for
// "railway" (replaced with Q22667, the real "railway" class).
export const NON_EVENT_CLASSES = [
  { qid: "Q515", label: "city" },
  { qid: "Q44613", label: "monastery" },
  { qid: "Q16970", label: "church building" },
  { qid: "Q32815", label: "mosque" },
  { qid: "Q34627", label: "synagogue" },
  { qid: "Q44539", label: "temple" },
  { qid: "Q3914", label: "school" },
  { qid: "Q3918", label: "university" },
  { qid: "Q62832", label: "observatory" },
  { qid: "Q783794", label: "company" },
  { qid: "Q22698", label: "park" },
  { qid: "Q22667", label: "railway" },
  { qid: "Q12280", label: "bridge" },
  { qid: "Q24354", label: "theatre building" },
  { qid: "Q33506", label: "museum" },
] as const;

/** P571 (inception), P1619 (official opening), P576 (dissolved) — the dates
 * Part 3's dated non-event items carry instead of P585/P580. */
export const NON_EVENT_DATE_PROPS = ["P571", "P1619", "P576"] as const;

function classValuesClause(classes: readonly { qid: string }[] = EVENT_CLASSES): string {
  return `VALUES ?class { ${classes.map((c) => `wd:${c.qid}`).join(" ")} }`;
}

// ---- Part 1/2/3/4: stage-1 candidate discovery -----------------------------
// Stage 1 pulls (item, class, date, sitelinks, enwiki article) with NO
// coordinate requirement — requiring wdt:P625 up front is the single biggest
// yield killer (waiving it roughly triples the ceiling, per the measurement
// in the task brief). Coordinates are resolved separately in stage 2 via a
// fallback chain, batched by QID.
//
// Run against QLEVER_ENDPOINT rather than WDQS: it answers the transitive
// wdt:P31/wdt:P279* walk from occurrence (Q1190554) directly, which is what
// lets Part 2's class broadening happen inline instead of needing a
// materialized closure fed back as hundreds of VALUES batches (283,131
// subclasses of occurrence, measured live 2026-09-20 — far too many to batch
// through WDQS's per-query VALUES limits in any reasonable time). QLever's
// snapshot lag doesn't matter here: every candidate QID stage 2 keeps is
// re-resolved (coordinates, label, sitelinks) against live WDQS, so a stale
// or since-deleted QID just fails to resolve and is silently dropped.
//
// Selection is ranked (Part 4): ORDER BY DESC(?sitelinks) LIMIT N, not the
// old arbitrary ORDER BY ?item, so a broadened class set doesn't hand back an
// arbitrary IRI-ordered slice once Wikidata over-supplies a period.
// NOTE: the raw (pre-SAMPLE) pattern variables are named ?dateRaw/?articleRaw/
// ?sitelinksRaw, distinct from the SELECTed ?date/?article/?sitelinks —
// QLever (unlike WDQS/Blazegraph) rejects "the target of an AS clause was
// already used in the query body", i.e. `(SAMPLE(?x) AS ?x)` is invalid there.
function buildCandidatesQuery(period: Period, limit: number): string {
  const nonEventValues = classValuesClause(NON_EVENT_CLASSES);
  const nonEventDates = NON_EVENT_DATE_PROPS.map((p) => `{ ?item wdt:${p} ?dateRaw }`).join(" UNION ");
  return `SELECT ?item ?class (SAMPLE(?dateRaw) AS ?date) (SAMPLE(?articleRaw) AS ?article) (SAMPLE(?sitelinksRaw) AS ?sitelinks) WHERE {
  {
    # Part 2: occurrence subclass closure, walked inline by QLever.
    ?item wdt:P31 ?class .
    ?class wdt:P279* wd:Q1190554 .
    { ?item wdt:P585 ?dateRaw } UNION { ?item wdt:P580 ?dateRaw }
  } UNION {
    # Part 3: dated non-event institutions/structures.
    ${nonEventValues}
    ?item wdt:P31 ?class .
    ${nonEventDates}
  }
  FILTER(YEAR(?dateRaw) >= ${period.start} && YEAR(?dateRaw) < ${period.end})
  ?item wikibase:sitelinks ?sitelinksRaw .
  OPTIONAL {
    ?articleRaw schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> .
  }
}
GROUP BY ?item ?class
ORDER BY DESC(?sitelinks) ?item
LIMIT ${limit}`;
}

/** Stage-1 ceiling: how many qualifying (item, class, date) candidates exist
 * for a period with NO coordinate requirement — the number Part 1 says is
 * roughly 3x the old coordinate-required ceiling. This is what `resolveQuotas`
 * is measured against now; coordinate resolution in stage 2 then determines
 * how many of those candidates actually make it into the output. */
function buildCandidateCountQuery(period: Period): string {
  const nonEventValues = classValuesClause(NON_EVENT_CLASSES);
  const nonEventDates = NON_EVENT_DATE_PROPS.map((p) => `{ ?item wdt:${p} ?date }`).join(" UNION ");
  return `SELECT (COUNT(DISTINCT ?item) AS ?c) WHERE {
  {
    ?item wdt:P31 ?class .
    ?class wdt:P279* wd:Q1190554 .
    { ?item wdt:P585 ?date } UNION { ?item wdt:P580 ?date }
  } UNION {
    ${nonEventValues}
    ?item wdt:P31 ?class .
    ${nonEventDates}
  }
  FILTER(YEAR(?date) >= ${period.start} && YEAR(?date) < ${period.end})
}`;
}

// ---- Part 1: stage-2 coordinate resolution with fallback chain ------------
// Rungs, first-match wins: direct coordinates -> the location it's part of
// (P276) -> that location's containing administrative entity, transitively
// (P276/P131+) -> the country of the item itself (P17). The last rung sets
// locKind: "country" (already supported by the app — gen-synthetic emits it).
// P131+ is bounded to the batch already in play (COORD_BATCH_SIZE QIDs) so it
// can't run away the way an unbounded whole-graph walk would.
export type CoordRung = "P625" | "P276" | "P131" | "P17";
export const COORD_BATCH_SIZE = 60;

function buildCoordsQuery(qids: string[]): string {
  return `SELECT ?item (SAMPLE(?c1) AS ?c1) (SAMPLE(?c2) AS ?c2) (SAMPLE(?c3) AS ?c3) (SAMPLE(?c4) AS ?c4) WHERE {
  VALUES ?item { ${qids.map((q) => `wd:${q}`).join(" ")} }
  OPTIONAL { ?item wdt:P625 ?c1 . }
  OPTIONAL { ?item wdt:P276 ?loc1 . ?loc1 wdt:P625 ?c2 . }
  OPTIONAL { ?item wdt:P276 ?loc2 . ?loc2 wdt:P131+ ?adm . ?adm wdt:P625 ?c3 . }
  OPTIONAL { ?item wdt:P17 ?country . ?country wdt:P625 ?c4 . }
}
GROUP BY ?item`;
}

interface CoordBinding {
  item: { value: string };
  c1?: { value: string };
  c2?: { value: string };
  c3?: { value: string };
  c4?: { value: string };
}

/** Picks the first rung of the fallback chain (P625 -> P276 -> P131+ -> P17)
 * that resolved to a usable point, and reports which rung it was so the
 * report can show the coordinate-source mix. Returns null if every rung came
 * back empty or malformed — such items are dropped, never guessed at. */
export function chooseCoord(
  b: CoordBinding
): { point: { lat: number; lon: number }; rung: CoordRung } | null {
  const rungs: [CoordRung, string | undefined][] = [
    ["P625", b.c1?.value],
    ["P276", b.c2?.value],
    ["P131", b.c3?.value],
    ["P17", b.c4?.value],
  ];
  for (const [rung, raw] of rungs) {
    const point = parseWikidataPoint(raw);
    if (point) return { point, rung };
  }
  return null;
}

/** Resolves labels for a batch of QIDs via a flat VALUES + label-service
 * query (no GROUP BY — each item appears once already, so the label service
 * binds normally). Requests "en,[AUTO_LANGUAGE],mul,fr,de,es" (1f) and lets
 * callers drop any QID whose label never resolved past the bare QID. */
function buildLabelsQuery(qids: string[]): string {
  return `SELECT ?item ?itemLabel WHERE {
  VALUES ?item { ${qids.map((q) => `wd:${q}`).join(" ")} }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,[AUTO_LANGUAGE],mul,fr,de,es". }
}`;
}

interface SparqlBinding {
  item: { value: string };
  class?: { value: string };
  itemLabel?: { value: string };
  date?: { value: string };
  prec?: { value: string };
  coord?: { value: string };
  article?: { value: string };
  sitelinks?: { value: string };
}
interface SparqlResponse {
  results: { bindings: SparqlBinding[] };
}

function cacheKeyFor(query: string): string {
  return createHash("sha1").update(query).digest("hex").slice(0, 16);
}

let lastRequestAt = 0;
async function politeDelay(): Promise<void> {
  const wait = RATE_LIMIT_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

// WDQS registers common prefixes (wdt:, wd:, p:, psv:, wikibase:, schema:, ...)
// server-side, so queries against it never declare them. QLever does not —
// it requires every prefix used to be declared inline, or it 400s. Rather
// than thread "which endpoint" state through every query builder, every
// query is prefixed with this block before being sent; WDQS tolerates
// (and ignores) redundant PREFIX declarations for prefixes it already knows.
const SPARQL_PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX p: <http://www.wikidata.org/prop/>
PREFIX psv: <http://www.wikidata.org/prop/statement/value/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX bd: <http://www.bigdata.com/rdf#>
PREFIX schema: <http://schema.org/>
`;

const MAX_RETRIES = 5;

/** Runs a SPARQL query, transparently caching the raw JSON response to disk
 * keyed by the query text's hash. A re-run (or a resumed interrupted run)
 * that asks for the same query never re-hits the endpoint.
 *
 * Retries a live 429/502/503 with exponential backoff (honouring
 * Retry-After when the server sends one) rather than failing the whole run:
 * a shared public endpoint occasionally throttles or hiccups under a long
 * multi-period pull even with RATE_LIMIT_MS respected between requests
 * (observed live 2026-09-20 running this exact pipeline). A run that
 * ultimately fails after MAX_RETRIES still throws, and — because nothing is
 * cached until a request succeeds — simply re-invoking the script resumes
 * from every already-cached query. */
async function runQuery(query: string, cacheTag: string, endpoint = ENDPOINT): Promise<unknown> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${cacheTag}-${cacheKeyFor(query)}.json`);
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  }
  const fullQuery = SPARQL_PREFIXES + query;
  const url = `${endpoint}?query=${encodeURIComponent(fullQuery)}&format=json`;
  for (let attempt = 0; ; attempt++) {
    await politeDelay();
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
    });
    if (res.ok) {
      const json = await res.json();
      writeFileSync(cacheFile, JSON.stringify(json));
      return json;
    }
    const retryable = res.status === 429 || res.status === 502 || res.status === 503;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`SPARQL query failed (${res.status} ${res.statusText}): ${cacheTag}`);
    }
    const retryAfterHeader = Number(res.headers.get("Retry-After"));
    const backoffMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader * 1000
      : RATE_LIMIT_MS * 2 ** attempt;
    console.warn(`  ${res.status} on ${cacheTag}, retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
}

async function fetchCeiling(period: Period, periodIdx: number): Promise<number> {
  const json = (await runQuery(buildCandidateCountQuery(period), `count-${periodIdx}`, QLEVER_ENDPOINT)) as {
    results: { bindings: { c: { value: string } }[] };
  };
  const raw = json.results.bindings[0]?.c?.value;
  return raw ? Number(raw) : 0;
}

function citationFor(qid: string, article?: string): string {
  return article ?? `https://www.wikidata.org/wiki/${qid}`;
}

function qidFromUri(uri: string): string {
  return uri.split("/").pop() ?? uri;
}

/** Converts one SPARQL binding into a RawEventRecord, or null if it's
 * missing a usable date or coordinates, or its label never resolved past the
 * bare QID (1f) — such rows are dropped, never guessed at. `minor` is left
 * `true` here; fetchPeriodEvents flips the top ~2%-by-sitelinks per period to
 * `false` afterward (1b), since "top 2% of this period" isn't knowable from
 * a single binding in isolation. */
export function bindingToRecord(b: SparqlBinding, opts?: { rung?: CoordRung }): RawEventRecord | null {
  const year = parseWikidataYear(b.date?.value);
  const point = parseWikidataPoint(b.coord?.value);
  if (year === null || point === null) return null;
  const qid = qidFromUri(b.item.value);
  const label = b.itemLabel?.value ?? qid;
  if (/^Q\d+$/.test(label)) return null; // label never resolved (1f)
  const sitelinks = b.sitelinks?.value ? Number(b.sitelinks.value) : undefined;
  const datePrecision = b.prec?.value ? Number(b.prec.value) : undefined;
  const classQid = b.class?.value ? qidFromUri(b.class.value) : undefined;
  // Part 1: a coordinate resolved via the P17 (country) fallback rung isn't a
  // point location for the item itself — mark it locKind "country" (already
  // rendered distinctly by src/globe/dots.ts) rather than a misleadingly
  // precise "point".
  const locKind: LocKind = opts?.rung === "P17" ? "country" : "point";
  return {
    year,
    text: label,
    lat: point.lat,
    lon: point.lon,
    locKind,
    th: classifyThemeFromClass(label, classQid),
    // No Jev scoring in this pilot (out of scope) — documented placeholder,
    // mid-scale on the 0..3 impact range used elsewhere in the pipeline.
    impact: 1.5,
    real: true,
    minor: true,
    qid,
    source: citationFor(qid, b.article?.value),
    sitelinks,
    datePrecision,
  };
}

/** Fraction of each period's fetched events marked non-minor (1b), ranked by
 * Wikipedia sitelink count — a cheap notability proxy. Matches the rough
 * "~1.5% of synthetic events are notable" ratio gen-synthetic.ts uses, since
 * src/loop.ts and src/globe/dots.ts render every non-minor event with its
 * own pulse/card/stroke and would be overwhelmed if most real events were
 * non-minor. */
const NOTABLE_FRACTION = 0.02;

/** Marks the top NOTABLE_FRACTION of `events` (by sitelinks, descending) as
 * `minor: false`, the rest `minor: true`. Mutates and returns `events`. */
export function markMinor(events: RawEventRecord[]): RawEventRecord[] {
  const ranked = [...events].sort((a, b) => (b.sitelinks ?? 0) - (a.sitelinks ?? 0));
  const notableCount = Math.max(events.length > 0 ? 1 : 0, Math.round(events.length * NOTABLE_FRACTION));
  const notableQids = new Set(ranked.slice(0, notableCount).map((e) => e.qid));
  for (const e of events) e.minor = !notableQids.has(e.qid);
  return events;
}

/** Resolves labels for a page's worth of QIDs in one batched request (see
 * buildLabelsQuery) and returns a QID -> label map. */
async function resolveLabels(qids: string[], cacheTag: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (qids.length === 0) return map;
  const json = (await runQuery(buildLabelsQuery(qids), cacheTag)) as SparqlResponse;
  for (const b of json.results?.bindings ?? []) {
    const label = b.itemLabel?.value;
    if (label) map.set(qidFromUri(b.item.value), label);
  }
  return map;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Overfetch factor for stage-1 candidates: some fraction never resolve
 * coordinates on any fallback rung (Part 1) and get dropped, so asking for
 * exactly `quota` candidates would under-deliver. 1.5x is a conservative
 * cushion given the measured ~74% overall P625-required-vs-waived yield
 * ratio from the task brief's ceiling table. */
const COORD_OVERFETCH = 1.5;

/** Tally of which fallback rung resolved each kept event's coordinates
 * (Part 1), plus how many candidates were dropped for resolving on no rung
 * at all. Reset per process; `main()` prints it in the run summary. */
export const RUNG_STATS: Record<CoordRung | "none", number> = {
  P625: 0,
  P276: 0,
  P131: 0,
  P17: 0,
  none: 0,
};

/** Resolves coordinates for a batch of QIDs (Part 1's fallback chain),
 * batched to COORD_BATCH_SIZE so the bounded P131+ rung stays cheap. Returns
 * a QID -> resolved-coordinate map; QIDs absent from the map resolved on no
 * rung and are dropped by the caller. */
async function resolveCoords(
  qids: string[],
  cacheTag: string
): Promise<Map<string, { point: { lat: number; lon: number }; rung: CoordRung }>> {
  const map = new Map<string, { point: { lat: number; lon: number }; rung: CoordRung }>();
  for (const [i, batch] of chunk(qids, COORD_BATCH_SIZE).entries()) {
    if (batch.length === 0) continue;
    const json = (await runQuery(buildCoordsQuery(batch), `${cacheTag}-${i}`)) as {
      results: { bindings: CoordBinding[] };
    };
    for (const b of json.results?.bindings ?? []) {
      const resolved = chooseCoord(b);
      const qid = qidFromUri(b.item.value);
      if (resolved) map.set(qid, resolved);
    }
  }
  return map;
}

async function fetchPeriodEvents(period: Period, periodIdx: number, quota: number): Promise<RawEventRecord[]> {
  if (quota <= 0) return [];
  // Stage 1: rank-ordered candidates (Part 4), overfetched to absorb
  // coordinate-resolution loss.
  const fetchLimit = Math.ceil(quota * COORD_OVERFETCH);
  const candJson = (await runQuery(
    buildCandidatesQuery(period, fetchLimit),
    `cand-${periodIdx}`,
    QLEVER_ENDPOINT
  )) as SparqlResponse;
  const candidates = candJson.results?.bindings ?? [];
  if (candidates.length === 0) return [];

  // Sequential, not Promise.all: politeDelay's rate limiter tracks a single
  // shared lastRequestAt timestamp, which only holds requests to RATE_LIMIT_MS
  // apart when they're issued one at a time. Concurrent label + coordinate
  // batches raced past it and got 429'd by WDQS live during testing.
  const qids = candidates.map((b) => qidFromUri(b.item.value));
  const labels = new Map<string, string>();
  for (const [i, batch] of chunk(qids, 300).entries()) {
    const part = await resolveLabels(batch, `labels-${periodIdx}-${i}`);
    for (const [k, v] of part) labels.set(k, v);
  }
  const coords = await resolveCoords(qids, `coords-${periodIdx}`);

  const out: RawEventRecord[] = [];
  const seen = new Set<string>();
  for (const b of candidates) {
    if (out.length >= quota) break; // stage-1 order is already rank order
    const qid = qidFromUri(b.item.value);
    if (seen.has(qid)) continue;
    const resolved = coords.get(qid);
    if (!resolved) {
      RUNG_STATS.none++;
      continue; // no rung resolved a coordinate (Part 1) — drop, don't guess
    }
    const label = labels.get(qid);
    const rec = bindingToRecord(
      {
        ...b,
        itemLabel: label ? { value: label } : undefined,
        coord: { value: `Point(${resolved.point.lon} ${resolved.point.lat})` },
      },
      { rung: resolved.rung }
    );
    if (!rec || !rec.qid) continue;
    seen.add(qid);
    RUNG_STATS[resolved.rung]++;
    out.push(rec);
  }
  return markMinor(out);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const targetArg = process.argv.find((a) => a.startsWith("--target="));
  const target = targetArg ? Number(targetArg.split("=")[1]) : EVENT_TARGET;

  console.log(`fetch-wikidata: target ${target} events across ${PERIODS.length} periods (ceiling, not a quota to fill)`);
  const ceilings: number[] = [];
  for (let i = 0; i < PERIODS.length; i++) {
    const c = await fetchCeiling(PERIODS[i]!, i);
    ceilings.push(c);
    console.log(`  ceiling ${PERIODS[i]!.label}: ${c} stage-1 candidates (date, coords waived — see coordinate-fallback stage)`);
  }

  const quotas = resolveQuotas(target, PERIODS, ceilings);
  for (let i = 0; i < PERIODS.length; i++) {
    console.log(`  quota   ${PERIODS[i]!.label}: ${quotas[i]} (of ${Math.round(target * PERIODS[i]!.weight)} desired)`);
  }

  if (dryRun) {
    console.log("dry run: not fetching events or writing output");
    return;
  }

  const all: RawEventRecord[] = [];
  for (let i = 0; i < PERIODS.length; i++) {
    const period = PERIODS[i]!;
    const quota = quotas[i]!;
    if (quota <= 0) continue;
    const events = await fetchPeriodEvents(period, i, quota);
    console.log(`  fetched ${events.length}/${quota} for ${period.label}`);
    all.push(...events);
  }

  // Deterministic ordering: same cached input always yields the same file.
  all.sort((a, b) => a.year - b.year || (a.qid ?? "").localeCompare(b.qid ?? ""));

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, all.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`wrote ${all.length} real events to ${path.relative(REPO_ROOT, OUT_PATH)}`);

  console.log("coordinate-fallback rung mix:");
  for (const [rung, count] of Object.entries(RUNG_STATS)) {
    console.log(`  ${rung}: ${count}`);
  }

  const themeCounts = Object.fromEntries(THEMES.map((t) => [t, 0])) as Record<Theme, number>;
  for (const r of all) {
    let top: Theme = "politics";
    let best = -1;
    for (const t of THEMES) {
      if (r.th[t] > best) {
        best = r.th[t];
        top = t;
      }
    }
    themeCounts[top]++;
  }
  console.log("theme balance (by top scoring theme):");
  for (const t of THEMES) {
    const pct = all.length ? ((themeCounts[t] / all.length) * 100).toFixed(1) : "0.0";
    console.log(`  ${t}: ${themeCounts[t]} (${pct}%)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
