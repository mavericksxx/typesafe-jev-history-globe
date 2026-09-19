// Live-network check: resolves every EVENT_CLASSES QID (scripts/fetch-wikidata.ts)
// against the live Wikidata SPARQL endpoint and asserts its rdfs:label
// matches what's hard-coded here. This is deliberately a separately-invocable
// script rather than a vitest test (see NON_EVENT_CLASSES/EVENT_CLASSES
// comments in fetch-wikidata.ts) so a flaky or slow public endpoint never
// blocks `npm test` / CI. Run manually before trusting or changing
// EVENT_CLASSES:
//
//   tsx scripts/verify-event-classes.ts
import { EVENT_CLASSES } from "./fetch-wikidata";

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "epochs-globe/1.0 (event-class verification script; contact: parthkohale@gmail.com)";
const RATE_LIMIT_MS = 1500;

async function labelFor(qid: string): Promise<string | null> {
  const query = `SELECT ?label WHERE { wd:${qid} rdfs:label ?label . FILTER(LANG(?label)='en') }`;
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
  });
  if (!res.ok) throw new Error(`${qid}: SPARQL query failed (${res.status} ${res.statusText})`);
  const json = (await res.json()) as { results: { bindings: { label?: { value: string } }[] } };
  return json.results.bindings[0]?.label?.value ?? null;
}

async function main(): Promise<void> {
  let failures = 0;
  for (const { qid, label: expected } of EVENT_CLASSES) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    const actual = await labelFor(qid);
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(`${ok ? "OK  " : "FAIL"} ${qid}: expected "${expected}", got "${actual ?? "(none)"}"`);
  }
  if (failures > 0) {
    console.error(`${failures} EVENT_CLASSES entr${failures === 1 ? "y" : "ies"} mismatched — fix scripts/fetch-wikidata.ts`);
    process.exit(1);
  }
  console.log(`all ${EVENT_CLASSES.length} EVENT_CLASSES entries verified against the live endpoint`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
