// Live-network check: resolves every EVENT_CLASSES QID (scripts/fetch-wikidata.ts)
// against the live Wikidata SPARQL endpoint and asserts its rdfs:label
// matches what's hard-coded here. This is deliberately a separately-invocable
// script rather than a vitest test (see NON_EVENT_CLASSES/EVENT_CLASSES
// comments in fetch-wikidata.ts) so a flaky or slow public endpoint never
// blocks `npm test` / CI. Run manually before trusting or changing
// EVENT_CLASSES:
//
//   tsx scripts/verify-event-classes.ts
import { EVENT_CLASSES, NON_EVENT_CLASSES } from "./fetch-wikidata";

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "epochs-globe/1.0 (event-class verification script; contact: parthkohale@gmail.com)";
const RATE_LIMIT_MS = 1500;

// A growing class list means more sequential live requests, which measurably
// hits transient 429/502 responses from the shared public endpoint (observed
// live 2026-09-20 running this exact script). Retry those a few times with
// backoff instead of aborting the whole verification run on one hiccup.
const MAX_RETRIES = 4;

async function labelFor(qid: string): Promise<string | null> {
  const query = `SELECT ?label WHERE { wd:${qid} rdfs:label ?label . FILTER(LANG(?label)='en') }`;
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
    });
    if (res.ok) {
      const json = (await res.json()) as { results: { bindings: { label?: { value: string } }[] } };
      return json.results.bindings[0]?.label?.value ?? null;
    }
    const retryable = res.status === 429 || res.status === 502 || res.status === 503;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`${qid}: SPARQL query failed (${res.status} ${res.statusText})`);
    }
    const backoffMs = RATE_LIMIT_MS * 2 ** (attempt + 1);
    console.warn(`  ${res.status} on ${qid}, retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
}

async function main(): Promise<void> {
  let failures = 0;
  const allClasses = [...EVENT_CLASSES, ...NON_EVENT_CLASSES];
  for (const { qid, label: expected } of allClasses) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    const actual = await labelFor(qid);
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(`${ok ? "OK  " : "FAIL"} ${qid}: expected "${expected}", got "${actual ?? "(none)"}"`);
  }
  if (failures > 0) {
    console.error(
      `${failures} of ${allClasses.length} class entries (EVENT_CLASSES + NON_EVENT_CLASSES) mismatched — fix scripts/fetch-wikidata.ts`
    );
    process.exit(1);
  }
  console.log(`all ${allClasses.length} EVENT_CLASSES + NON_EVENT_CLASSES entries verified against the live endpoint`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
