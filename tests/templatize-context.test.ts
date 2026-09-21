import { describe, expect, it } from "vitest";
import {
  buildTemplatedText,
  formatHedgedDate,
  looksLikeBareName,
  needsTemplatedContext,
  templatizeRecords,
} from "../scripts/templatize-context";
import type { RawEventRecord } from "../src/data/types";

function rec(overrides: Partial<RawEventRecord> & { year: number; text: string }): RawEventRecord {
  return {
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

describe("looksLikeBareName", () => {
  it("accepts a bare one-word proper noun", () => {
    expect(looksLikeBareName("Debdieba")).toBe(true);
    expect(looksLikeBareName("Kozan")).toBe(true);
    expect(looksLikeBareName("Calvar")).toBe(true);
  });

  it("accepts a bare two-or-three-word proper noun", () => {
    expect(looksLikeBareName("Al-Masala Obelisk")).toBe(true);
  });

  it("rejects text that already contains a year or number", () => {
    expect(looksLikeBareName("Revolution of 1848")).toBe(false);
  });

  it("rejects text longer than three words", () => {
    expect(looksLikeBareName("The Great Wall Foundation Ceremony")).toBe(false);
  });

  it("rejects text already carrying an event/period word (negative cases)", () => {
    expect(looksLikeBareName("Punic Wars")).toBe(false);
    expect(looksLikeBareName("Dreyfus affair")).toBe(false);
    expect(looksLikeBareName("Battle of Marathon")).toBe(false);
    expect(looksLikeBareName("Akkad period")).toBe(false);
    expect(looksLikeBareName("Dolmen Culture")).toBe(false);
  });

  it("rejects text with a connector word (a phrase, not a bare name)", () => {
    expect(looksLikeBareName("Kingdom of Kush")).toBe(false);
    expect(looksLikeBareName("Republic of the Congo")).toBe(false);
  });

  it("rejects text that already contains a comma (already templated or already has a clause)", () => {
    expect(looksLikeBareName("Debdieba, a settlement, founded c. 3001 BC")).toBe(false);
  });

  it("rejects lowercase-leading text", () => {
    expect(looksLikeBareName("some obscure place")).toBe(false);
  });
});

describe("needsTemplatedContext (shape + obscurity gate)", () => {
  it("does not rewrite a well-known short entity with high sitelinks", () => {
    // Shape-identical to a bare toponym, but Credit Suisse is not obscure —
    // the sitelinks gate is what keeps this untouched (see task brief).
    expect(needsTemplatedContext({ text: "Credit Suisse", sitelinks: 400 })).toBe(false);
  });

  it("rewrites a genuinely obscure bare toponym", () => {
    expect(needsTemplatedContext({ text: "Debdieba", sitelinks: 2 })).toBe(true);
  });

  it("treats a missing sitelinks count as maximally obscure (0)", () => {
    expect(needsTemplatedContext({ text: "Debdieba", sitelinks: undefined })).toBe(true);
  });
});

describe("formatHedgedDate", () => {
  it("hedges a century/millennium-precision date as approximate", () => {
    expect(formatHedgedDate(-3001, 4)).toBe("c. 3001 BC");
  });

  it("states a year-precision date exactly", () => {
    expect(formatHedgedDate(995, 9)).toBe("995");
  });

  it("hedges a BC date with no datePrecision recorded (conservative default)", () => {
    expect(formatHedgedDate(-1200, undefined)).toBe("c. 1200 BC");
  });

  it("states a CE date with no datePrecision recorded as exact", () => {
    expect(formatHedgedDate(1200, undefined)).toBe("1200");
  });
});

describe("buildTemplatedText", () => {
  it("uses 'founded' + the resolved institution class label when known", () => {
    const text = buildTemplatedText("Bako Medical Clinic", 995, 9, { label: "hospital", dateKind: "institution" });
    expect(text).toBe("Bako Medical Clinic, a hospital, founded 995");
  });

  it("degrades to a generic 'settlement' + 'first recorded' when no class is known", () => {
    const text = buildTemplatedText("Kozan", -1200, 4, undefined);
    expect(text).toBe("Kozan, a settlement, first recorded c. 1200 BC");
  });

  it("keeps the original label as the leading noun", () => {
    const text = buildTemplatedText("Debdieba", -3001, 4, undefined);
    expect(text.startsWith("Debdieba,")).toBe(true);
  });

  it("uses 'an' before a vowel-leading class noun", () => {
    const text = buildTemplatedText("X", 100, 9, { label: "observatory", dateKind: "institution" });
    expect(text).toContain("an observatory");
  });
});

describe("templatizeRecords", () => {
  it("rewrites only records that need templated context, leaving others untouched", () => {
    const records = [
      rec({ year: -3001, text: "Debdieba", sitelinks: 2, qid: "Q1" }),
      rec({ year: 1789, text: "French Revolution", sitelinks: 5000, qid: "Q2" }),
      rec({ year: 1998, text: "Credit Suisse", sitelinks: 400, qid: "Q3" }),
    ];
    const { rewritten, count } = templatizeRecords(records, new Map());
    expect(count).toBe(1);
    expect(rewritten[0]!.text).not.toBe("Debdieba");
    expect(rewritten[0]!.text.startsWith("Debdieba,")).toBe(true);
    expect(rewritten[1]!.text).toBe("French Revolution");
    expect(rewritten[2]!.text).toBe("Credit Suisse");
  });

  it("preserves every other field on a rewritten record", () => {
    const original = rec({ year: -3001, text: "Debdieba", sitelinks: 2, qid: "Q1", lat: 12, lon: 34 });
    const { rewritten } = templatizeRecords([original], new Map());
    expect(rewritten[0]!.qid).toBe("Q1");
    expect(rewritten[0]!.lat).toBe(12);
    expect(rewritten[0]!.lon).toBe(34);
    expect(rewritten[0]!.year).toBe(-3001);
  });

  it("is idempotent: running it twice changes nothing the second time", () => {
    const records = [rec({ year: -3001, text: "Debdieba", sitelinks: 2, qid: "Q1" })];
    const once = templatizeRecords(records, new Map()).rewritten;
    const twice = templatizeRecords(once, new Map());
    expect(twice.count).toBe(0);
    expect(twice.rewritten).toEqual(once);
  });

  it("uses the qid->class map to pick a specific institution label when available", () => {
    const records = [rec({ year: 995, text: "Bako Clinic", sitelinks: 1, qid: "Q1" })];
    const qidToClassQid = new Map([["Q1", "Q16917"]]); // Q16917 = hospital
    const { rewritten } = templatizeRecords(records, qidToClassQid);
    expect(rewritten[0]!.text).toBe("Bako Clinic, a hospital, founded 995");
  });
});
