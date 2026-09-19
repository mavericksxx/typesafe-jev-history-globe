import { describe, expect, it } from "vitest";
import {
  bindingToRecord,
  chooseCoord,
  classifyTheme,
  classifyThemeFromClass,
  CLASS_THEME_MAP,
  EVENT_TARGET,
  NON_EVENT_CLASSES,
  parseWikidataPoint,
  parseWikidataYear,
  PERIODS,
  resolveQuotas,
  resolveThemeQuotas,
  THEME_CLASSES,
  THEME_SHARES,
} from "../scripts/fetch-wikidata";
import { THEMES } from "../src/data/types";

describe("parseWikidataYear", () => {
  it("parses a modern CE date", () => {
    expect(parseWikidataYear("+1945-08-06T00:00:00Z")).toBe(1945);
  });

  it("parses a BC date as a negative year, correcting Wikidata's astronomical-year offset", () => {
    // Astronomical year -2600 is 2601 BC (year 0 = 1 BC), not 2600 BC.
    expect(parseWikidataYear("-002600-01-01T00:00:00Z")).toBe(-2601);
  });

  it("parses a short-padded BC year, correcting the astronomical-year offset", () => {
    expect(parseWikidataYear("-500-06-01T00:00:00Z")).toBe(-501);
  });

  it("pins the real observed Wikidata literal for the Battle of Marathon (Q31900), commonly dated 490 BC", () => {
    // Verified live 2026-09-20: wd:Q31900 wdt:P585 = "-0489-09-07T00:00:00Z".
    // Astronomical year -489 = 490 BC.
    expect(parseWikidataYear("-0489-09-07T00:00:00Z")).toBe(-490);
  });

  it("maps astronomical year 0 to 1 BC", () => {
    expect(parseWikidataYear("+0000-01-01T00:00:00Z")).toBe(-1);
    expect(parseWikidataYear("-0000-01-01T00:00:00Z")).toBe(-1);
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
  // Real observed values for Q31900 (Battle of Marathon), verified live
  // 2026-09-20: wdt:P585 = "-0489-09-07T00:00:00Z" (astronomical year -489
  // = 490 BC, see parseWikidataYear).
  const base = {
    item: { value: "http://www.wikidata.org/entity/Q31900" },
    itemLabel: { value: "Battle of Marathon" },
    date: { value: "-0489-09-07T00:00:00Z" },
    coord: { value: "Point(23.97 38.12)" },
    article: { value: "https://en.wikipedia.org/wiki/Battle_of_Marathon" },
  };

  it("builds a RawEventRecord from a complete binding", () => {
    const rec = bindingToRecord(base);
    expect(rec).not.toBeNull();
    expect(rec!.year).toBe(-490);
    expect(rec!.lat).toBeCloseTo(38.12);
    expect(rec!.lon).toBeCloseTo(23.97);
    expect(rec!.qid).toBe("Q31900");
    expect(rec!.source).toBe("https://en.wikipedia.org/wiki/Battle_of_Marathon");
    expect(rec!.real).toBe(true);
  });

  it("falls back to the Wikidata entity URL when no article is linked", () => {
    const { article, ...rest } = base;
    const rec = bindingToRecord(rest);
    expect(rec!.source).toBe("https://www.wikidata.org/wiki/Q31900");
  });

  it("drops a binding whose label never resolved past the bare QID", () => {
    expect(bindingToRecord({ ...base, itemLabel: { value: "Q31900" } })).toBeNull();
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

  it("sums to exactly the target via largest-remainder rounding when supply is unlimited", () => {
    const ceilings = PERIODS.map(() => Number.MAX_SAFE_INTEGER);
    // A target that doesn't divide evenly against every period's weight, so
    // independent per-period rounding would drift from the target.
    const quotas = resolveQuotas(9_999, PERIODS, ceilings);
    expect(quotas.reduce((a, b) => a + b, 0)).toBe(9_999);
  });
});

describe("markMinor", () => {
  it("marks roughly the top 2% by sitelinks as non-minor and the rest minor", async () => {
    const { markMinor } = await import("../scripts/fetch-wikidata");
    const events = Array.from({ length: 100 }, (_, i) => ({
      year: 2000,
      text: `Event ${i}`,
      lat: 0,
      lon: 0,
      locKind: "point" as const,
      th: { war: 0, politics: 0, religion: 0, economy: 0, science: 0, culture: 0 },
      impact: 1.5,
      real: true,
      minor: true,
      qid: `Q${i}`,
      sitelinks: 100 - i, // Q0 is the most notable
    }));
    const marked = markMinor(events);
    const nonMinor = marked.filter((e) => !e.minor);
    expect(nonMinor.length).toBeGreaterThan(0);
    expect(nonMinor.length).toBeLessThan(10);
    expect(nonMinor.every((e) => (e.sitelinks ?? 0) >= 90)).toBe(true);
  });
});

describe("chooseCoord (Part 1: coordinate fallback chain)", () => {
  const item = { value: "http://www.wikidata.org/entity/Q1" };

  it("prefers P625 (direct coordinates) when present", () => {
    const r = chooseCoord({
      item,
      c1: { value: "Point(10 20)" },
      c2: { value: "Point(30 40)" },
    });
    expect(r).toEqual({ point: { lat: 20, lon: 10 }, rung: "P625" });
  });

  it("falls back to P276 (part-of location) when P625 is absent", () => {
    const r = chooseCoord({ item, c2: { value: "Point(30 40)" } });
    expect(r).toEqual({ point: { lat: 40, lon: 30 }, rung: "P276" });
  });

  it("falls back to P276/P131+ (containing admin entity) next", () => {
    const r = chooseCoord({ item, c3: { value: "Point(1 2)" } });
    expect(r).toEqual({ point: { lat: 2, lon: 1 }, rung: "P131" });
  });

  it("falls back to P17 (country) last, and only P17 sets locKind country downstream", () => {
    const r = chooseCoord({ item, c4: { value: "Point(5 6)" } });
    expect(r).toEqual({ point: { lat: 6, lon: 5 }, rung: "P17" });
  });

  it("returns null when every rung is empty or malformed", () => {
    expect(chooseCoord({ item })).toBeNull();
    expect(chooseCoord({ item, c1: { value: "garbage" }, c2: { value: "also garbage" } })).toBeNull();
  });

  it("skips a malformed higher-priority rung and falls through to a valid lower one", () => {
    const r = chooseCoord({ item, c1: { value: "garbage" }, c2: { value: "Point(7 8)" } });
    expect(r).toEqual({ point: { lat: 8, lon: 7 }, rung: "P276" });
  });
});

describe("classifyThemeFromClass (Part 5: class -> theme, not keywords)", () => {
  it("uses the class->theme map when the class is recognised, even if the label would mislead a keyword match", () => {
    // "Fudan University" contains no theme keyword at all — the class map
    // (Q3918 = university -> science) is what makes this accurate.
    const th = classifyThemeFromClass("Fudan University", "Q3918");
    expect(th.science).toBeGreaterThan(th.politics);
  });

  it("falls back to the label-keyword heuristic when the class is unrecognised", () => {
    const th = classifyThemeFromClass("Battle of Marathon", "Q999999999");
    expect(th.war).toBeGreaterThan(th.culture);
  });

  it("falls back to the label-keyword heuristic when no class is supplied", () => {
    const th = classifyThemeFromClass("Battle of Marathon", undefined);
    expect(th.war).toBeGreaterThan(th.culture);
  });

  it("covers every NON_EVENT_CLASSES qid with a religion/economy/science/culture theme", () => {
    const nonWarPolitics: string[] = ["religion", "economy", "science", "culture"];
    for (const { qid } of NON_EVENT_CLASSES) {
      const theme = CLASS_THEME_MAP[qid];
      expect(theme, `${qid} should be in CLASS_THEME_MAP`).toBeDefined();
      expect(nonWarPolitics).toContain(theme);
    }
  });
});

describe("bindingToRecord with a resolved fallback rung (Part 1)", () => {
  const base = {
    item: { value: "http://www.wikidata.org/entity/Q31900" },
    itemLabel: { value: "Battle of Marathon" },
    date: { value: "-0489-09-07T00:00:00Z" },
    coord: { value: "Point(23.97 38.12)" },
  };

  it("marks locKind 'country' when the coordinate resolved via the P17 rung", () => {
    const rec = bindingToRecord(base, { rung: "P17" });
    expect(rec!.locKind).toBe("country");
  });

  it("marks locKind 'point' when the coordinate resolved via P625/P276/P131", () => {
    for (const rung of ["P625", "P276", "P131"] as const) {
      expect(bindingToRecord(base, { rung })!.locKind).toBe("point");
    }
  });

  it("defaults to locKind 'point' when no rung is given", () => {
    expect(bindingToRecord(base)!.locKind).toBe("point");
  });

  it("derives theme from ?class when supplied", () => {
    const rec = bindingToRecord({ ...base, class: { value: "http://www.wikidata.org/entity/Q3918" } });
    expect(rec!.th.science).toBeGreaterThan(rec!.th.war);
  });
});

describe("THEME_SHARES (bucketed selection: fixing the culture/city skew)", () => {
  it("sums to exactly 1", () => {
    const sum = THEMES.reduce((s, t) => s + THEME_SHARES[t], 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it("gives no single theme half or more of the sample", () => {
    for (const t of THEMES) expect(THEME_SHARES[t]).toBeLessThan(0.5);
  });

  it("gives every theme a meaningful floor (no theme is a token sliver)", () => {
    for (const t of THEMES) expect(THEME_SHARES[t]).toBeGreaterThanOrEqual(0.1);
  });

  it("is not a flat 1/6 split — war and politics are weighted higher, reflecting the pre-modern record", () => {
    expect(THEME_SHARES.war).toBeGreaterThan(1 / 6);
    expect(THEME_SHARES.politics).toBeGreaterThan(1 / 6);
  });
});

describe("resolveThemeQuotas", () => {
  const unlimited = Object.fromEntries(THEMES.map((t) => [t, Number.MAX_SAFE_INTEGER])) as Record<
    (typeof THEMES)[number],
    number
  >;

  it("gives each theme its proportional share when supply is unlimited", () => {
    const quotas = resolveThemeQuotas(1000, unlimited);
    for (const t of THEMES) expect(quotas[t]).toBe(Math.round(1000 * THEME_SHARES[t]));
  });

  it("sums to exactly the period quota via largest-remainder rounding when supply is unlimited", () => {
    const quotas = resolveThemeQuotas(999, unlimited);
    const total = THEMES.reduce((s, t) => s + quotas[t]!, 0);
    expect(total).toBe(999);
  });

  it("caps a thin theme at its own ceiling instead of exceeding real supply", () => {
    const ceilings = { ...unlimited, economy: 3 };
    const quotas = resolveThemeQuotas(1000, ceilings);
    expect(quotas.economy).toBe(3);
  });

  it("does not redistribute a thin theme's shortfall into other themes", () => {
    const ceilings = { ...unlimited, science: 0 };
    const quotas = resolveThemeQuotas(1000, ceilings);
    expect(quotas.science).toBe(0);
    for (const t of THEMES) {
      if (t === "science") continue;
      expect(quotas[t]).toBe(Math.round(1000 * THEME_SHARES[t]));
    }
  });

  it("never returns a negative quota", () => {
    const zero = Object.fromEntries(THEMES.map((t) => [t, 0])) as Record<(typeof THEMES)[number], number>;
    const quotas = resolveThemeQuotas(500, zero);
    for (const t of THEMES) expect(quotas[t]).toBeGreaterThanOrEqual(0);
  });
});

describe("THEME_CLASSES (follow-up: economy/science class supply)", () => {
  it("gives economy and science more than the original 3 narrow classes each", () => {
    expect(THEME_CLASSES.economy.length).toBeGreaterThan(3);
    expect(THEME_CLASSES.science.length).toBeGreaterThan(3);
  });

  it("every class in THEME_CLASSES has a unique qid across themes (no double-bucketing)", () => {
    const seen = new Set<string>();
    for (const t of THEMES) {
      for (const c of THEME_CLASSES[t]) {
        expect(seen.has(c.qid), `${c.qid} (${c.label}) appears in more than one theme`).toBe(false);
        seen.add(c.qid);
      }
    }
  });

  it("every class's theme matches CLASS_THEME_MAP (derived consistently)", () => {
    for (const t of THEMES) {
      for (const c of THEME_CLASSES[t]) {
        expect(CLASS_THEME_MAP[c.qid]).toBe(t);
      }
    }
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
