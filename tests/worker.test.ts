import { describe, expect, it } from "vitest";
import {
  MAX_TEXT_LEN,
  PER_DAY_LIMIT,
  PER_SECOND_LIMIT,
  GLOBAL_DAILY_TOKEN_CAP,
  PRECHARGE_ESTIMATE_TOKENS,
  REAL_THRESHOLD,
  ACCURATE_THRESHOLD,
  validateText,
  mapJevAnswers,
  checkVisitorLimit,
  hasGlobalBudget,
  recordSpend,
} from "../worker/src/index";
import type { RateStore } from "../worker/src/index";

/** In-memory stand-in for the KV-shaped store the rate-limit functions take
 * — exercises the same get/put contract the real Worker uses without any
 * network or Cloudflare runtime. */
function makeStore(): RateStore {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key) ?? null,
    put: async (key, value) => {
      map.set(key, value);
    },
  };
}

function fullAnswers(
  overrides: Partial<{ real: number; accurate: number; impact: number; confidence: number }> = {}
) {
  return {
    war: { noul: 0.9 },
    politics: { noul: 0.4 },
    religion: { noul: 0.1 },
    economy: { noul: 0.05 },
    science: { noul: 0.02 },
    culture: { noul: 0.1 },
    impact: { score: overrides.impact ?? 3, confidence: overrides.confidence ?? 0.95 },
    real: { noul: overrides.real ?? 0.9 },
    accurate: { noul: overrides.accurate ?? 0.9 },
  };
}

describe("validateText", () => {
  it("rejects non-strings", () => {
    expect(validateText(42).ok).toBe(false);
    expect(validateText(null).ok).toBe(false);
    expect(validateText(undefined).ok).toBe(false);
  });

  it("rejects empty/whitespace-only text", () => {
    expect(validateText("").ok).toBe(false);
    expect(validateText("   ").ok).toBe(false);
  });

  it("rejects text over the length cap", () => {
    const tooLong = "a".repeat(MAX_TEXT_LEN + 1);
    const result = validateText(tooLong);
    expect(result.ok).toBe(false);
  });

  it("accepts and trims valid text up to the cap", () => {
    const atCap = "a".repeat(MAX_TEXT_LEN);
    expect(validateText(atCap)).toEqual({ ok: true, text: atCap });
    expect(validateText("  1066, Battle of Hastings  ")).toEqual({
      ok: true,
      text: "1066, Battle of Hastings",
    });
  });
});

describe("mapJevAnswers", () => {
  it("maps a normal event to status ok with themes/impact/confidence", () => {
    const result = mapJevAnswers(fullAnswers());
    expect(result).toEqual({
      status: "ok",
      themes: { war: 0.9, politics: 0.4, religion: 0.1, economy: 0.05, science: 0.02, culture: 0.1 },
      impact: 3,
      confidence: 0.95,
    });
  });

  it("flags input below the real-event threshold as not_historical", () => {
    const result = mapJevAnswers(fullAnswers({ real: REAL_THRESHOLD - 0.01 }));
    expect(result).toEqual({ status: "not_historical" });
  });

  it("treats exactly the threshold as real (boundary is inclusive)", () => {
    const result = mapJevAnswers(fullAnswers({ real: REAL_THRESHOLD }));
    expect(result.status).toBe("ok");
  });

  it("flags input below the accurate threshold as not_accurate, even when it passes real", () => {
    const result = mapJevAnswers(fullAnswers({ accurate: ACCURATE_THRESHOLD - 0.01 }));
    expect(result).toEqual({ status: "not_accurate" });
  });

  it("treats exactly the accurate threshold as accurate (boundary is inclusive)", () => {
    const result = mapJevAnswers(fullAnswers({ accurate: ACCURATE_THRESHOLD }));
    expect(result.status).toBe("ok");
  });

  it("checks not_historical before not_accurate: failing both reports not_historical", () => {
    const result = mapJevAnswers(fullAnswers({ real: REAL_THRESHOLD - 0.01, accurate: ACCURATE_THRESHOLD - 0.01 }));
    expect(result).toEqual({ status: "not_historical" });
  });

  it("requires both real and accurate to pass for status ok", () => {
    const result = mapJevAnswers(fullAnswers());
    expect(result.status).toBe("ok");
  });
});

describe("checkVisitorLimit", () => {
  it("allows up to PER_SECOND_LIMIT calls in the same second, then blocks", async () => {
    const store = makeStore();
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let i = 0; i < PER_SECOND_LIMIT; i++) {
      expect(await checkVisitorLimit(store, "1.2.3.4", now)).toEqual({ allowed: true });
    }
    expect(await checkVisitorLimit(store, "1.2.3.4", now)).toEqual({ allowed: false, scope: "second" });
  });

  it("resets the per-second limit on the next second", async () => {
    const store = makeStore();
    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let i = 0; i < PER_SECOND_LIMIT; i++) await checkVisitorLimit(store, "1.2.3.4", t0);
    expect(await checkVisitorLimit(store, "1.2.3.4", t0 + 1000)).toEqual({ allowed: true });
  });

  it("allows up to PER_DAY_LIMIT calls in a day, spread across seconds, then blocks", async () => {
    const store = makeStore();
    const dayStart = Date.UTC(2026, 0, 1, 0, 0, 0);
    let allowed = 0;
    for (let i = 0; i < PER_DAY_LIMIT + 5; i++) {
      const now = dayStart + i * 1000; // one call per second, well under the per-second cap
      const result = await checkVisitorLimit(store, "9.9.9.9", now);
      if (result.allowed) allowed++;
    }
    expect(allowed).toBe(PER_DAY_LIMIT);
  });

  it("tracks different visitors independently", async () => {
    const store = makeStore();
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let i = 0; i < PER_SECOND_LIMIT; i++) await checkVisitorLimit(store, "1.1.1.1", now);
    expect(await checkVisitorLimit(store, "2.2.2.2", now)).toEqual({ allowed: true });
  });
});

describe("hasGlobalBudget / recordSpend", () => {
  it("has budget when nothing has been spent today", async () => {
    const store = makeStore();
    expect(await hasGlobalBudget(store, Date.now())).toBe(true);
  });

  it("runs out of budget once recorded spend plus the pre-charge estimate would exceed the cap", async () => {
    const store = makeStore();
    const now = Date.now();
    await recordSpend(store, GLOBAL_DAILY_TOKEN_CAP - PRECHARGE_ESTIMATE_TOKENS + 1, now);
    expect(await hasGlobalBudget(store, now)).toBe(false);
  });

  it("stays open right at the edge of the pre-charge estimate", async () => {
    const store = makeStore();
    const now = Date.now();
    await recordSpend(store, GLOBAL_DAILY_TOKEN_CAP - PRECHARGE_ESTIMATE_TOKENS, now);
    expect(await hasGlobalBudget(store, now)).toBe(true);
  });

  it("tracks spend per UTC day, not cumulatively forever", async () => {
    const store = makeStore();
    const day1 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const day2 = Date.UTC(2026, 0, 2, 12, 0, 0);
    await recordSpend(store, GLOBAL_DAILY_TOKEN_CAP, day1);
    expect(await hasGlobalBudget(store, day1)).toBe(false);
    expect(await hasGlobalBudget(store, day2)).toBe(true);
  });
});
