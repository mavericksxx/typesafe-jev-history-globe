import { describe, expect, it } from "vitest";
import {
  bindingToRecord,
  classifyTheme,
  EVENT_TARGET,
  parseWikidataPoint,
  parseWikidataYear,
  PERIODS,
  resolveQuotas,
} from "../scripts/fetch-wikidata";
import { THEMES } from "../src/data/types";

describe("parseWikidataYear", () => {
  it("parses a modern CE date", () => {
    expect(parseWikidataYear("+1945-08-06T00:00:00Z")).toBe(1945);
  });

  it("parses a BC date as a negative year", () => {
    expect(parseWikidataYear("-002600-01-01T00:00:00Z")).toBe(-2600);
  });

  it("parses a short-padded BC year", () => {
    expect(parseWikidataYear("-500-06-01T00:00:00Z")).toBe(-500);
  });

  it("defaults to CE when the endpoint omits the leading sign", () => {
    expect(parseWikidataYear("0200-01-01T00:00:00Z")).toBe(200);
  });

  it("returns null for missing or malformed input", () => {
    expect(parseWikidataYear(undefined)).toBeNull();
    expect(parseWikidataYear(null)).toBeNull();
    expect(parseWikidataYear("not a date")).toBeNull();
    expect(parseWikidataYear("")).toBeNull();
  });
});

describe("parseWikidataPoint", () => {
  it("parses a WKT point as {lat, lon}", () => {
    expect(parseWikidataPoint("Point(12.4964 41.9028)")).toEqual({ lat: 41.9028, lon: 12.4964 });
  });

  it("parses negative coordinates", () => {
    expect(parseWikidataPoint("Point(-74.006 40.7128)")).toEqual({ lat: 40.7128, lon: -74.006 });
  });

  it("rejects malformed or missing input", () => {
    expect(parseWikidataPoint(undefined)).toBeNull();
    expect(parseWikidataPoint("garbage")).toBeNull();
  });

  it("rejects out-of-range coordinates", () => {
    expect(parseWikidataPoint("Point(200 40)")).toBeNull();
    expect(parseWikidataPoint("Point(10 100)")).toBeNull();
  });
});

describe("classifyTheme", () => {
  it("matches a keyword to its theme with a high score", () => {
    const th = classifyTheme("Battle of Marathon");
    expect(th.war).toBeGreaterThan(th.culture);
  });

  it("falls back to a documented politics placeholder when nothing matches", () => {
    const th = classifyTheme("Some Obscure Thing");
    expect(th.politics).toBeGreaterThan(0.1);
  });

  it("always returns a score for every theme", () => {
    const th = classifyTheme("Council of Nicaea treaty");
    for (const t of THEMES) expect(typeof th[t]).toBe("number");
  });
});

describe("bindingToRecord", () => {
  const base = {
    item: { value: "http://www.wikidata.org/entity/Q1747689" },
    itemLabel: { value: "Battle of Marathon" },
    date: { value: "-000490-09-12T00:00:00Z" },
    coord: { value: "Point(23.97 38.12)" },
    article: { value: "https://en.wikipedia.org/wiki/Battle_of_Marathon" },
  };

  it("builds a RawEventRecord from a complete binding", () => {
    const rec = bindingToRecord(base);
    expect(rec).not.toBeNull();
    expect(rec!.year).toBe(-490);
    expect(rec!.lat).toBeCloseTo(38.12);
    expect(rec!.lon).toBeCloseTo(23.97);
    expect(rec!.qid).toBe("Q1747689");
    expect(rec!.source).toBe("https://en.wikipedia.org/wiki/Battle_of_Marathon");
    expect(rec!.real).toBe(true);
  });

  it("falls back to the Wikidata entity URL when no article is linked", () => {
    const { article, ...rest } = base;
    const rec = bindingToRecord(rest);
    expect(rec!.source).toBe("https://www.wikidata.org/wiki/Q1747689");
  });

  it("drops a binding missing a date", () => {
    const { date, ...rest } = base;
    expect(bindingToRecord(rest)).toBeNull();
  });

  it("drops a binding missing coordinates", () => {
    const { coord, ...rest } = base;
    expect(bindingToRecord(rest)).toBeNull();
  });

  it("drops a binding with malformed coordinates", () => {
    expect(bindingToRecord({ ...base, coord: { value: "garbage" } })).toBeNull();
  });
});

describe("resolveQuotas", () => {
  it("gives each period its proportional share when supply is unlimited", () => {
    const ceilings = PERIODS.map(() => Number.MAX_SAFE_INTEGER);
    const quotas = resolveQuotas(1000, PERIODS, ceilings);
    quotas.forEach((q, i) => expect(q).toBe(Math.round(1000 * PERIODS[i]!.weight)));
  });

  it("caps a period at its ceiling instead of exceeding real supply", () => {
    const ceilings = PERIODS.map(() => Number.MAX_SAFE_INTEGER);
    ceilings[0] = 3; // antiquity is thin
    const quotas = resolveQuotas(1000, PERIODS, ceilings);
    expect(quotas[0]).toBe(3);
  });

  it("does not backfill a dry period's shortfall into other periods", () => {
    const ceilings = PERIODS.map(() => Number.MAX_SAFE_INTEGER);
    ceilings[0] = 0;
    const quotas = resolveQuotas(1000, PERIODS, ceilings);
    expect(quotas[0]).toBe(0);
    // every other period keeps its own proportional share, unchanged
    for (let i = 1; i < PERIODS.length; i++) {
      expect(quotas[i]).toBe(Math.round(1000 * PERIODS[i]!.weight));
    }
  });

  it("never returns a negative quota", () => {
    const quotas = resolveQuotas(500, PERIODS, PERIODS.map(() => 0));
    quotas.forEach((q) => expect(q).toBeGreaterThanOrEqual(0));
  });

  it("scales cleanly to a 25,000-event target with only the target changing", () => {
    const ceilings = PERIODS.map(() => Number.MAX_SAFE_INTEGER);
    const quotas = resolveQuotas(25_000, PERIODS, ceilings);
    expect(quotas.reduce((a, b) => a + b, 0)).toBeCloseTo(25_000, -1);
  });
});

describe("period weights", () => {
  it("sum to 1 so EVENT_TARGET is fully allocated when supply allows", () => {
    const sum = PERIODS.reduce((s, p) => s + p.weight, 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it("cover 3000 BC through the present with no gaps or overlaps", () => {
    const sorted = [...PERIODS].sort((a, b) => a.start - b.start);
    expect(sorted[0]!.start).toBe(-3000);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.start).toBe(sorted[i - 1]!.end);
    }
  });

  it("exports a raisable target constant (the --target= CLI flag overrides it for pilot runs)", () => {
    expect(EVENT_TARGET).toBeGreaterThan(0);
  });
});
