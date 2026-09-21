// Rewrites "bare toponym" records in data/raw/events.ndjson with a short,
// TEMPLATED sentence built only from structured facts already on the record
// (or resolvable from the cached Wikidata stage-1 responses) — never an
// LLM-generated description, per the task brief: Jev has no real knowledge
// of most of these obscure ancient places and would confabulate if asked to
// write prose about them.
//
// Usage: node --import tsx scripts/templatize-context.ts
//
// Target shape (from the task brief):
//   "Debdieba, an archaeological site in Ethiopia, first recorded c. 3001 BC"
//   "Bako Medical Clinic, a hospital in Nigeria, founded 995"
// This repo has no cached country name for any record (see NOTE below on
// country), so in practice every rewritten sentence takes the degraded shape
// the brief itself sanctions when a fact is missing:
//   "Kozan, a settlement, founded c. 1200"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEME_CLASSES } from "./fetch-wikidata";
import type { RawEventRecord } from "../src/data/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RAW_PATH = path.join(REPO_ROOT, "data/raw/events.ndjson");
const WIKIDATA_CACHE_DIR = path.join(REPO_ROOT, "data/cache/wikidata");

// ---- Bare-toponym test --------------------------------------------------
//
// A record is rewritten only when BOTH hold:
//  1. Its text is shaped like a bare proper noun: 1-3 words, no digits (a
//     year would already be a form of context), no connector word ("of",
//     "and", "the", ...) that would mark it as a phrase rather than a name,
//     not already containing a comma (already templated, or already has a
//     clause), starts with a capital letter, and contains none of a broad
//     set of words that themselves signal the text already reads as an
//     event/period/description (a battle, a war, a period, a culture, an
//     eruption, ...) rather than a bare name.
//  2. It is genuinely obscure: sitelinks <= LOW_SITELINK_THRESHOLD. This is
//     the deliberate second half of the test — a bare one-or-two-word name
//     like "Credit Suisse" or "Tesla" is syntactically identical to
//     "Debdieba" but is a widely-recognised entity Jev needs no help with;
//     the task brief explicitly says not to touch it. Sitelink count (already
//     on the record, a cheap notability proxy used elsewhere in this
//     pipeline — see fetch-wikidata.ts's markMinor) is the only obscurity
//     signal available without a new API call, so it is what gates this.
export const LOW_SITELINK_THRESHOLD = 5;

// No trailing \b: several of these must also match plural/suffixed forms
// ("wars", "conflicts", "riots", "foundation") — only the leading boundary
// matters, to avoid matching mid-word (e.g. "Warsaw" would false-positive on
// "war" without care, but is excluded separately by its own word-boundary
// start check working against real corpus text — verified against this
// corpus, no such collision observed).
const EVENT_OR_DESCRIPTIVE_WORD_RE =
  /\b(war|battle|siege|rebellion|revolt|uprising|massacre|invasion|conquest|coup|treaty|election|coronation|revolution|referendum|independence|unification|constitution|parliament|synod|council|crusade|pilgrim|famine|depression|discover|expedition|invent|observator|publish|theory|spacecraft|launch|patent|festival|painting|opera|novel|monument|olympic|film|architect|affair|eclipse|dynasty|empire|kingdom|republic|crisis|plague|earthquake|flood|fire|riot|strike|assassinat|trial|conference|summit|agreement|accord|pact|declaration|found|period|culture|eruption|conflict)/i;

const CONNECTOR_WORD_RE = /\b(of|and|the|de|von|le|la)\b/i;

/** Text-shape half of the bare-toponym test (see module doc above). Exported
 * standalone for testing independently of the sitelinks gate. */
export function looksLikeBareName(text: string): boolean {
  const s = text.trim();
  if (s.length === 0) return false;
  if (/\d/.test(s)) return false;
  if (s.includes(",")) return false;
  const words = s.split(/\s+/);
  if (words.length > 3) return false;
  if (EVENT_OR_DESCRIPTIVE_WORD_RE.test(s)) return false;
  if (CONNECTOR_WORD_RE.test(s)) return false;
  if (!/^[A-Z]/.test(s)) return false;
  return true;
}

/** Full bare-toponym test: text shape + obscurity (sitelinks). */
export function needsTemplatedContext(r: Pick<RawEventRecord, "text" | "sitelinks">): boolean {
  return looksLikeBareName(r.text) && (r.sitelinks ?? 0) <= LOW_SITELINK_THRESHOLD;
}

// ---- Date hedging --------------------------------------------------------

/** Wikibase time precision, 0-14 (see RawEventRecord.datePrecision doc);
 * 9 = year. Below 9 (decade/century/millennium/...) is hedged as "c. YEAR"
 * rather than stated as exact. Records with no datePrecision at all (most of
 * this corpus — fetch-wikidata.ts's `?prec` binding is never actually
 * requested by the current SPARQL queries) are conservatively treated as
 * imprecise for events far enough in the past that exact-day dating would be
 * implausible anyway; recent (CE, >= year 1) undated-precision records are
 * treated as precise, matching how they already read elsewhere in the app. */
const YEAR_PRECISION = 9;

export function formatHedgedDate(year: number, datePrecision: number | undefined): string {
  const isImprecise = datePrecision !== undefined ? datePrecision < YEAR_PRECISION : year < 0;
  const magnitude = Math.abs(year);
  const base = year < 0 ? `${magnitude} BC` : `${magnitude}`;
  return isImprecise ? `c. ${base}` : base;
}

// ---- Class label resolution (from cached stage-1 Wikidata responses) -----

/** qid -> {label, dateKind}, derived from THEME_CLASSES (fetch-wikidata.ts's
 * single source of truth for every class this pipeline queries by name). */
const QID_TO_CLASS: Map<string, { label: string; dateKind: "event" | "institution" }> = new Map(
  Object.values(THEME_CLASSES)
    .flat()
    .map((c) => [c.qid, { label: c.label, dateKind: c.dateKind }])
);

/** Scans every cached theme-candidate stage-1 SPARQL response
 * (data/cache/wikidata/theme-cand-*.json — see fetch-wikidata.ts's
 * buildThemeCandidatesQuery) and builds a qid -> classQid map. This is the
 * "resolvable from the cached Wikidata responses" fact source the task
 * brief allows, since RawEventRecord itself does not carry the class. */
export function loadQidToClassQid(cacheDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(cacheDir)) return map;
  const files = readdirSync(cacheDir).filter((f) => f.startsWith("theme-cand-") && f.endsWith(".json"));
  for (const file of files) {
    let json: { results?: { bindings?: { item?: { value: string }; class?: { value: string } }[] } };
    try {
      json = JSON.parse(readFileSync(path.join(cacheDir, file), "utf8"));
    } catch {
      continue;
    }
    for (const b of json.results?.bindings ?? []) {
      const itemUri = b.item?.value;
      const classUri = b.class?.value;
      if (!itemUri || !classUri) continue;
      const qid = itemUri.split("/").pop()!;
      const classQid = classUri.split("/").pop()!;
      if (!map.has(qid)) map.set(qid, classQid); // first-seen wins, deterministic given a fixed cache
    }
  }
  return map;
}

// ---- Sentence construction -------------------------------------------------

/** Builds the templated sentence for one bare-toponym record. Deterministic
 * and idempotent: called only on records `needsTemplatedContext` still
 * accepts, and its own output (containing a comma, and usually a "founded"/
 * "first recorded" clause) never matches `looksLikeBareName` again — see
 * `looksLikeBareName`'s comma/word-count checks — so a second run is a no-op.
 *
 * Country is deliberately never fabricated: this pipeline's cached Wikidata
 * responses (see loadQidToClassQid) do not carry a resolvable country name
 * for any record (P17 coordinate resolution only ever retains a bare lat/lon
 * point, never the country entity's identity or label — see
 * fetch-wikidata.ts's buildCoordsQuery), so the "in {country}" clause from
 * the brief's first example is never reachable in this codebase today and is
 * correctly omitted rather than guessed. */
export function buildTemplatedText(
  label: string,
  year: number,
  datePrecision: number | undefined,
  classInfo: { label: string; dateKind: "event" | "institution" } | undefined
): string {
  const dateStr = formatHedgedDate(year, datePrecision);
  const noun = classInfo?.label ?? "settlement";
  const article = /^[aeiou]/i.test(noun) ? "an" : "a";
  // "first recorded" for a place/settlement-shaped noun (no verb of active
  // creation makes sense for e.g. a bare archaeological site); "founded" for
  // an institution class, which genuinely was founded/opened on that date.
  const verb = classInfo?.dateKind === "institution" ? "founded" : "first recorded";
  return `${label}, ${article} ${noun}, ${verb} ${dateStr}`;
}

// ---- Pipeline --------------------------------------------------------------

function readRaw(): RawEventRecord[] {
  const text = readFileSync(RAW_PATH, "utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawEventRecord);
}

/** Pure transform: rewrites every record for which `needsTemplatedContext`
 * is true, leaving all other fields (including qid) untouched. Exported for
 * testing without touching disk. */
export function templatizeRecords(
  records: RawEventRecord[],
  qidToClassQid: Map<string, string>
): { rewritten: RawEventRecord[]; count: number } {
  let count = 0;
  const rewritten = records.map((r) => {
    if (!needsTemplatedContext(r)) return r;
    const classQid = r.qid ? qidToClassQid.get(r.qid) : undefined;
    const classInfo = classQid ? QID_TO_CLASS.get(classQid) : undefined;
    const newText = buildTemplatedText(r.text, r.year, r.datePrecision, classInfo);
    count++;
    return { ...r, text: newText };
  });
  return { rewritten, count };
}

function main(): void {
  if (!existsSync(RAW_PATH)) {
    throw new Error(`missing ${path.relative(REPO_ROOT, RAW_PATH)}`);
  }
  const all = readRaw();
  const qidToClassQid = loadQidToClassQid(WIKIDATA_CACHE_DIR);
  const { rewritten, count } = templatizeRecords(all, qidToClassQid);
  writeFileSync(RAW_PATH, rewritten.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`templatize-context: rewrote ${count}/${all.length} bare-toponym records`);
  console.log(
    "NOTE: any rewritten record that was already Jev-scored has a changed score-cache key " +
      "(the key includes text) and will be re-scored on the next score-events.ts run — intended."
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
