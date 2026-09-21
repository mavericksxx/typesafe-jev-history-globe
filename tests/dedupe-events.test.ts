import { describe, expect, it } from "vitest";
import { dedupeByQid } from "../scripts/dedupe-events";
import type { RawEventRecord } from "../src/data/types";

function rec(overrides: Partial<RawEventRecord> & { year: number }): RawEventRecord {
  return {
    text: `event ${overrides.year}`,
    lat: 0,
    lon: 0,
    locKind: "point",
    th: { war: 0.1, politics: 0.1, religion: 0.1, economy: 0.1, science: 0.1, culture: 0.1 },
    impact: 1.5,
    real: true,
    minor: true,
    ...overrides,
  };
}

describe("dedupeByQid", () => {
  it("keeps only the first occurrence of a duplicated qid", () => {
    const records = [
      rec({ year: -950, qid: "Q1", text: "Ashkelon" }),
      rec({ year: 1948, qid: "Q1", text: "Ashkelon" }),
    ];
    const { kept, removed } = dedupeByQid(records);
    expect(removed).toBe(1);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.year).toBe(-950);
  });

  it("handles more than two duplicates of the same qid", () => {
    const records = [
      rec({ year: 1, qid: "Q1" }),
      rec({ year: 2, qid: "Q1" }),
      rec({ year: 3, qid: "Q1" }),
    ];
    const { kept, removed } = dedupeByQid(records);
    expect(removed).toBe(2);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.year).toBe(1);
  });

  it("never drops records without a qid, even if identical", () => {
    const records = [rec({ year: 1, qid: undefined }), rec({ year: 1, qid: undefined })];
    const { kept, removed } = dedupeByQid(records);
    expect(removed).toBe(0);
    expect(kept).toHaveLength(2);
  });

  it("leaves a corpus with no duplicates unchanged", () => {
    const records = [rec({ year: 1, qid: "Q1" }), rec({ year: 2, qid: "Q2" })];
    const { kept, removed } = dedupeByQid(records);
    expect(removed).toBe(0);
    expect(kept).toEqual(records);
  });

  it("is idempotent: deduping already-deduped output changes nothing", () => {
    const records = [
      rec({ year: -950, qid: "Q1" }),
      rec({ year: 1948, qid: "Q1" }),
      rec({ year: 5, qid: "Q2" }),
    ];
    const once = dedupeByQid(records).kept;
    const twice = dedupeByQid(once);
    expect(twice.removed).toBe(0);
    expect(twice.kept).toEqual(once);
  });
});
