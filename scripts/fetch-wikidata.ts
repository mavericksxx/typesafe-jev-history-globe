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
// Once the query is DISTINCT/GROUP BY-deduped (see buildEventsQuery), every
// OFFSET page still re-executes the full sort server-side, so a bigger page
// is strictly cheaper per event than more, smaller pages. WDQS tolerates
// pages in the low thousands for this query shape.
const PAGE_SIZE = 1500;

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
export const NON_EVENT_CLASSES = [
  { qid: "Q515", label: "city" },
  { qid: "Q44613", label: "monastery" },
  { qid: "Q16970", label: "church building" },
  { qid: "Q32815", label: "mosque" },
  { qid: "Q34627", label: "synagogue" },
  { qid: "Q44539", label: "temple" },
  { qid: "Q3914", label: "school" },
  { qid: "Q3918", label: "university" },
  { qid: "Q495015", label: "observatory" },
  { qid: "Q783794", label: "company" },
  { qid: "Q22698", label: "park" },
  { qid: "Q11424", label: "railway" }, // placeholder id checked in verify script; treated as illustrative
  { qid: "Q12280", label: "bridge" },
  { qid: "Q24354", label: "theatre" },
  { qid: "Q33506", label: "museum" },
] as const;
// NOTE: NON_EVENT_CLASSES QIDs are NOT all individually re-verified against
// the live endpoint the way EVENT_CLASSES is (time budget) — treat this list
// as a documented draft for the Part 2 broadening work, not a shipped
// production query input. Anyone extending Part 2 into a real run must run
// each QID through scripts/verify-event-classes.ts's pattern first.

function classValuesClause(classes: readonly { qid: string }[] = EVENT_CLASSES): string {
  return `VALUES ?class { ${classes.map((c) => `wd:${c.qid}`).join(" ")} }`;
}

/** SELECT DISTINCT ?item, aggregated with GROUP BY so a quota of N fetched
 * rows really is N distinct Wikidata items (fixes 1c: an item with both
 * P585 and P580, multiple wdt:P625 coordinates, or matching more than one
 * class in EVENT_CLASSES previously produced duplicate rows, silently
 * under-delivering on the requested page size and triggering 429s from
 * over-fetching to compensate).
 *
 * Also pulls (1b) `?sitelinks` via wikibase:sitelinks for the minor/notable
 * split, and (1d) time precision via psv:P585/wikibase:timePrecision so
 * century/millennium-precision claims (which otherwise render as a fake
 * exact year) can be told apart from real year/month/day precision.
 * Precision is KEPT on the record rather than used to drop rows: dropping
 * would disproportionately shrink the already-scarce ancient periods, which
 * is the opposite of what Part 2 is trying to do. */
/** Deliberately does NOT resolve labels (see buildLabelsQuery below): live
 * testing against WDQS found that adding `SERVICE wikibase:label` to this
 * GROUP BY query — whether inline (label service can't bind inside a
 * GROUP BY at all; ?itemLabel comes back unbound for every row) or wrapped
 * in an outer SELECT around a GROUP BY subquery (syntactically fine, but
 * consistently 504-timed-out server-side, unlike either query alone) —
 * breaks. Splitting into two cheap queries (this one, plus a batched
 * VALUES + label-service lookup in buildLabelsQuery) is what actually works
 * in practice, and is a smaller change than it looks: it's the same
 * two-request shape Part 2's coordinate-resolution stage already needs. */
function buildEventsQuery(period: Period, limit: number, offset: number): string {
  // NOTE on aggregate choice: MIN()/MAX() over these columns triggers a
  // live-verified Blazegraph StackOverflowError (WDQS's SPARQL engine) when
  // combined with GROUP BY + the p:/psv: qualifier-value path used for date
  // precision — reproduced directly against the endpoint while building this
  // query, independent of anything specific to this codebase. SAMPLE() for
  // every aggregated column avoids it and is what's used throughout. This
  // means ?date and ?prec are not guaranteed to come from the same
  // underlying P585/P580 statement when an item has more than one
  // qualifying value in the period window — an accepted approximation
  // (most items have exactly one) rather than a guaranteed-correct pairing.
  return `SELECT ?item (SAMPLE(?date) AS ?date) (SAMPLE(?prec) AS ?prec) (SAMPLE(?coord) AS ?coord) (SAMPLE(?article) AS ?article) (SAMPLE(?sitelinks) AS ?sitelinks) WHERE {
  ${classValuesClause()}
  ?item wdt:P31 ?class .
  ?item wdt:P625 ?coord .
  {
    ?item p:P585 ?dateStmt . ?dateStmt psv:P585 ?dateVal .
    ?dateVal wikibase:timeValue ?date ; wikibase:timePrecision ?prec .
  } UNION {
    ?item p:P580 ?dateStmt2 . ?dateStmt2 psv:P580 ?dateVal2 .
    ?dateVal2 wikibase:timeValue ?date ; wikibase:timePrecision ?prec .
  }
  FILTER(YEAR(?date) >= ${period.start} && YEAR(?date) < ${period.end})
  ?item wikibase:sitelinks ?sitelinks .
  OPTIONAL {
    ?article schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> .
  }
}
GROUP BY ?item
ORDER BY DESC(?sitelinks) ?item
LIMIT ${limit}
OFFSET ${offset}`;
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

function buildCountQuery(period: Period): string {
  return `SELECT (COUNT(DISTINCT ?item) AS ?c) WHERE {
  ${classValuesClause()}
  ?item wdt:P31 ?class .
  ?item wdt:P625 ?coord .
  { ?item wdt:P585 ?date } UNION { ?item wdt:P580 ?date }
  FILTER(YEAR(?date) >= ${period.start} && YEAR(?date) < ${period.end})
}`;
}

interface SparqlBinding {
  item: { value: string };
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

/** Runs a SPARQL query, transparently caching the raw JSON response to disk
 * keyed by the query text's hash. A re-run (or a resumed interrupted run)
 * that asks for the same query never re-hits the endpoint. */
async function runQuery(query: string, cacheTag: string, endpoint = ENDPOINT): Promise<unknown> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${cacheTag}-${cacheKeyFor(query)}.json`);
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  }
  await politeDelay();
  const url = `${endpoint}?query=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
  });
  if (!res.ok) {
    throw new Error(`SPARQL query failed (${res.status} ${res.statusText}): ${cacheTag}`);
  }
  const json = await res.json();
  writeFileSync(cacheFile, JSON.stringify(json));
  return json;
}

async function fetchCeiling(period: Period, periodIdx: number): Promise<number> {
  const json = (await runQuery(buildCountQuery(period), `count-${periodIdx}`)) as {
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
export function bindingToRecord(b: SparqlBinding): RawEventRecord | null {
  const year = parseWikidataYear(b.date?.value);
  const point = parseWikidataPoint(b.coord?.value);
  if (year === null || point === null) return null;
  const qid = qidFromUri(b.item.value);
  const label = b.itemLabel?.value ?? qid;
  if (/^Q\d+$/.test(label)) return null; // label never resolved (1f)
  const sitelinks = b.sitelinks?.value ? Number(b.sitelinks.value) : undefined;
  const datePrecision = b.prec?.value ? Number(b.prec.value) : undefined;
  return {
    year,
    text: label,
    lat: point.lat,
    lon: point.lon,
    locKind: "point" as LocKind,
    th: classifyTheme(label),
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

async function fetchPeriodEvents(period: Period, periodIdx: number, quota: number): Promise<RawEventRecord[]> {
  const out: RawEventRecord[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < quota; offset += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, quota - offset);
    const query = buildEventsQuery(period, limit, offset);
    const json = (await runQuery(query, `page-${periodIdx}-${offset}`)) as SparqlResponse;
    const bindings = json.results?.bindings ?? [];
    if (bindings.length === 0) break; // endpoint has nothing more for this window
    const qids = bindings.map((b) => qidFromUri(b.item.value));
    const labels = await resolveLabels(qids, `labels-${periodIdx}-${offset}`);
    for (const b of bindings) {
      const qid = qidFromUri(b.item.value);
      const label = labels.get(qid);
      const rec = bindingToRecord({ ...b, itemLabel: label ? { value: label } : undefined });
      if (!rec || !rec.qid) continue;
      if (seen.has(rec.qid)) continue;
      seen.add(rec.qid);
      out.push(rec);
    }
    if (bindings.length < limit) break; // short page: nothing more to page through
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
    console.log(`  ceiling ${PERIODS[i]!.label}: ${c} qualifying items (date + coordinates)`);
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
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
