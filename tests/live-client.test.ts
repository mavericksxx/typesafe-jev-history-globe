import { describe, expect, it } from "vitest";
import { liveStatusText, zeroThemes } from "../src/live/client";
import { THEMES } from "../src/data/types";

describe("liveStatusText", () => {
  it("prompts for input when idle", () => {
    expect(liveStatusText({ kind: "idle" })).toBe("Type an event above.");
  });

  it("shows a judging message while loading", () => {
    expect(liveStatusText({ kind: "loading" })).toMatch(/judging/i);
  });

  it("reports impact, label and latency once scored", () => {
    const text = liveStatusText(
      {
        kind: "scored",
        themes: zeroThemes(),
        impact: 2.7,
        confidence: 0.8,
        location: { kind: "country", country: "France", lat: 46, lon: 2 },
      },
      412
    );
    expect(text).toContain("2.70 / 3");
    expect(text).toContain("world");
    expect(text).toContain("412 ms");
    expect(text).toContain("France");
  });

  it("omits latency when not given", () => {
    const text = liveStatusText({
      kind: "scored",
      themes: zeroThemes(),
      impact: 0,
      confidence: 0.5,
      location: { kind: "none" },
    });
    expect(text).not.toContain("ms");
  });

  it("says location is unknown rather than pinning nothing", () => {
    const text = liveStatusText({
      kind: "scored",
      themes: zeroThemes(),
      impact: 1,
      confidence: 0.9,
      location: { kind: "none" },
    });
    expect(text).toMatch(/location unknown/i);
  });

  it("has a distinct message for not-a-historical-event", () => {
    expect(liveStatusText({ kind: "not_historical" })).toMatch(/doesn't look like a historical event/);
  });

  it("has a distinct message for factually-inaccurate input", () => {
    expect(liveStatusText({ kind: "not_accurate" })).toMatch(/doesn't match the historical record/);
  });

  it("has a distinct message for per-visitor rate limiting", () => {
    expect(liveStatusText({ kind: "rate_limited" })).toMatch(/slow down/i);
  });

  it("has a distinct 'resting' message for the global spend cap", () => {
    expect(liveStatusText({ kind: "resting" })).toMatch(/resting/i);
  });

  it("has a distinct message for network/unreachable errors", () => {
    expect(liveStatusText({ kind: "error" })).toMatch(/couldn't reach/i);
  });
});

describe("zeroThemes", () => {
  it("returns 0 for every theme", () => {
    const z = zeroThemes();
    for (const t of THEMES) expect(z[t]).toBe(0);
  });
});
