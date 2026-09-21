// One-off (but idempotent and re-runnable) pass to remove duplicate QIDs
// from data/raw/events.ndjson. fetch-wikidata.ts's per-theme/per-period
// candidate queries could independently select the same Wikidata item twice
// (e.g. once under an ancient founding-date bucket, once under a later
// bucket where a different date property on the same item — P571 vs P585,
// or a second P585 value — fell in a different period's range). 381 QIDs
// were found duplicated this way across the 15,764-event corpus (408 extra
// records beyond one-per-QID).
//
// Dedup rule (deterministic, documented): keep the FIRST occurrence of each
// QID in file order. fetch-wikidata.ts always writes events sorted by
// `year` ascending before persisting them (see its `all.sort(...)` in
// main()), so "first occurrence in the file" is equivalent to "the
// occurrence with the earliest year" — which for a founding-dated
// institution or settlement is its inception/founding date, the
// semantically primary one, rather than a coincidental later date the item
// also carries. Records without a `qid` (synthetic/mock data) are never
// deduped against each other by this pass.
//
// Usage: node --import tsx scripts/dedupe-events.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RawEventRecord } from "../src/data/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RAW_PATH = path.join(REPO_ROOT, "data/raw/events.ndjson");

/** Keeps one record per qid (first occurrence in array order), passing
 * through every record with no qid unchanged. Pure and idempotent: running
 * it again on its own output changes nothing. */
export function dedupeByQid(records: RawEventRecord[]): {
  kept: RawEventRecord[];
  removed: number;
} {
  const seen = new Set<string>();
  const kept: RawEventRecord[] = [];
  let removed = 0;
  for (const r of records) {
    if (!r.qid) {
      kept.push(r);
      continue;
    }
    if (seen.has(r.qid)) {
      removed++;
      continue;
    }
    seen.add(r.qid);
    kept.push(r);
  }
  return { kept, removed };
}

function readRaw(): RawEventRecord[] {
  const text = readFileSync(RAW_PATH, "utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawEventRecord);
}

function main(): void {
  if (!existsSync(RAW_PATH)) {
    throw new Error(`missing ${path.relative(REPO_ROOT, RAW_PATH)}`);
  }
  const all = readRaw();
  const { kept, removed } = dedupeByQid(all);
  writeFileSync(RAW_PATH, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(
    `dedupe-events: removed ${removed} duplicate-QID record(s) (${all.length} -> ${kept.length})`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
