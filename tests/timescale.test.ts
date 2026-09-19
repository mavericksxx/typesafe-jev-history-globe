import { describe, expect, it } from "vitest";
import { T, fmtYear } from "../src/data/timescale";

describe("T (piecewise timescale)", () => {
  it("maps domain anchors to their exact range values", () => {
    expect(T(-3000)).toBeCloseTo(0);
    expect(T(0)).toBeCloseTo(0.14);
    expect(T(1000)).toBeCloseTo(0.3);
    expect(T(1500)).toBeCloseTo(0.44);
    expect(T(1800)).toBeCloseTo(0.6);
    expect(T(1900)).toBeCloseTo(0.76);
    expect(T(2026)).toBeCloseTo(1);
  });

  it("clamps outside the domain instead of extrapolating", () => {
    expect(T(-10000)).toBeCloseTo(0);
    expect(T(5000)).toBeCloseTo(1);
  });

  it("is monotonically increasing", () => {
    const years = [-3000, -1500, -100, 0, 500, 1000, 1250, 1500, 1650, 1800, 1850, 1900, 1960, 2026];
    for (let i = 1; i < years.length; i++) {
      expect(T(years[i]!)).toBeGreaterThanOrEqual(T(years[i - 1]!));
    }
  });

  it("gives modern centuries more room than ancient ones", () => {
    // 100 years around 1950 should span more T than 100 years around -2500.
    const modernSpan = T(2000) - T(1900);
    const ancientSpan = T(-2400) - T(-2500);
    expect(modernSpan).toBeGreaterThan(ancientSpan);
  });

  it("round-trips through invert", () => {
    for (const y of [-2500, -100, 500, 1517, 1900, 2020]) {
      expect(T.invert(T(y))).toBeCloseTo(y, 5);
    }
  });
});

describe("fmtYear", () => {
  it("formats BC years", () => {
    expect(fmtYear(-2560)).toBe("2560 BC");
    expect(fmtYear(-1)).toBe("1 BC");
  });

  it("formats AD years under 1000 with a prefix", () => {
    expect(fmtYear(0)).toBe("AD 0");
    expect(fmtYear(79)).toBe("AD 79");
    expect(fmtYear(999)).toBe("AD 999");
  });

  it("formats years 1000+ bare", () => {
    expect(fmtYear(1000)).toBe("1000");
    expect(fmtYear(2026)).toBe("2026");
  });
});
