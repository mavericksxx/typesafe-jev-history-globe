import { describe, expect, it } from "vitest";
import { applyJevAnswer, sampleRepresentative } from "../scripts/score-events";
import { PERIODS } from "../scripts/fetch-wikidata";
import { THEMES } from "../src/data/types";
import type { RawEventRecord, Theme } from "../src/data/types";

function makeRecord(overrides: Partial<RawEventRecord> & { year: number }): RawEventRecord {
  const th = Object.fromEntries(THEMES.map((t) => [t, 0.1])) as Record<Theme, number>;
  return {
    text: `event ${overrides.year}`,
    lat: 0,
    lon: 0,
    locKind: "point",
    th,
    impact: 1.5,
    real: true,
    minor: true,
    qid: `Q${overrides.year}`,
    sitelinks: 0,
    ...overrides,
  };
}

/** Builds a corpus with events in every period and every top-scoring theme,
 * plus a spread of sitelink counts, so sampling has real diversity to draw
 * from. */
function buildCorpus(): RawEventRecord[] {
  const records: RawEventRecord[] = [];
  for (const period of PERIODS) {
    const midYear = Math.floor((period.start + period.end) / 2);
    for (const theme of THEMES) {
      for (let i = 0; i < 5; i++) {
        const th = Object.fromEntries(THEMES.map((t) => [t, t === theme ? 0.9 : 0.1])) as Record<
          Theme,
          number
        >;
        records.push(
          makeRecord({
            year: midYear + i,
            text: `${theme} event ${period.label} #${i}`,
            th,
            qid: `Q${period.label}-${theme}-${i}`,
            sitelinks: i * 100, // spread from 0 (bare toponym proxy) to 400
          })
        );
      }
    }
  }
  return records;
}

describe("sampleRepresentative", () => {
  it("returns every record when the corpus is already <= limit", () => {
    const corpus = buildCorpus().slice(0, 10);
    expect(sampleRepresentative(corpus, 500)).toHaveLength(10);
  });

  it("picks exactly `limit` records (or fewer, never more) from a larger corpus", () => {
    const corpus = buildCorpus();
    const sample = sampleRepresentative(corpus, 60);
    expect(sample.length).toBeLessThanOrEqual(60);
    expect(sample.length).toBeGreaterThan(0);
  });

  it("spreads the sample across multiple historical periods, not just the densest one", () => {
    const corpus = buildCorpus();
    const sample = sampleRepresentative(corpus, 66); // 11 periods * 6 themes
    const periodsHit = new Set(
      sample.map((r) => PERIODS.findIndex((p) => r.year >= p.start && r.year < p.end))
    );
    expect(periodsHit.size).toBeGreaterThan(1);
    // With a corpus that's uniform across all 11 periods, a representative
    // sample of this size should touch most of them.
    expect(periodsHit.size).toBeGreaterThanOrEqual(8);
  });

  it("spreads the sample across multiple themes within a period", () => {
    const corpus = buildCorpus();
    const sample = sampleRepresentative(corpus, 66);
    const themesHit = new Set(
      sample.map((r) => THEMES.reduce((best, t) => (r.th[t] > r.th[best] ? t : best), THEMES[0]!))
    );
    expect(themesHit.size).toBeGreaterThan(1);
  });

  it("includes both high- and low-sitelink events rather than only the most notable", () => {
    const corpus = buildCorpus();
    // A large-enough per-bucket quota (>1 per period/theme) is needed to
    // exercise the high/low interleave at all.
    const sample = sampleRepresentative(corpus, 132);
    const sitelinks = sample.map((r) => r.sitelinks ?? 0);
    expect(Math.min(...sitelinks)).toBeLessThanOrEqual(100);
    expect(Math.max(...sitelinks)).toBeGreaterThanOrEqual(300);
  });

  it("never picks the same record twice", () => {
    const corpus = buildCorpus();
    const sample = sampleRepresentative(corpus, 100);
    expect(new Set(sample).size).toBe(sample.length);
  });
});

describe("applyJevAnswer", () => {
  const base = makeRecord({ year: 1900, text: "some event" });

  it("maps the six noul theme scores onto th", () => {
    const answer = {
      war: { noul: 0.9 },
      politics: { noul: 0.2 },
      religion: { noul: 0.05 },
      economy: { noul: 0.1 },
      science: { noul: 0.01 },
      culture: { noul: 0.3 },
      impact: { score: 2.5, confidence: 0.8, probabilities: {} },
    } as const;
    const out = applyJevAnswer(base, answer as never);
    expect(out.th.war).toBe(0.9);
    expect(out.th.culture).toBe(0.3);
  });

  it("maps impact.score onto impact and impact.confidence onto confidence", () => {
    const answer = {
      war: { noul: 0.1 },
      politics: { noul: 0.1 },
      religion: { noul: 0.1 },
      economy: { noul: 0.1 },
      science: { noul: 0.1 },
      culture: { noul: 0.1 },
      impact: { score: 3, confidence: 0.95, probabilities: {} },
    } as const;
    const out = applyJevAnswer(base, answer as never);
    expect(out.impact).toBe(3);
    expect(out.confidence).toBe(0.95);
  });

  it("derives minor=false only when impact clears the notable threshold", () => {
    const lowImpact = {
      war: { noul: 0.1 },
      politics: { noul: 0.1 },
      religion: { noul: 0.1 },
      economy: { noul: 0.1 },
      science: { noul: 0.1 },
      culture: { noul: 0.1 },
      impact: { score: 0.5, confidence: 0.5, probabilities: {} },
    } as const;
    expect(applyJevAnswer(base, lowImpact as never).minor).toBe(true);

    // 2.5 clears the old (too-generous) threshold but not the current one —
    // pins the pilot-measured MINOR_THRESHOLD=2.9 rather than 2.0.
    const midImpact = { ...lowImpact, impact: { score: 2.5, confidence: 0.5, probabilities: {} } } as const;
    expect(applyJevAnswer(base, midImpact as never).minor).toBe(true);

    const highImpact = {
      ...lowImpact,
      impact: { score: 2.95, confidence: 0.5, probabilities: {} },
    } as const;
    expect(applyJevAnswer(base, highImpact as never).minor).toBe(false);
  });
});
