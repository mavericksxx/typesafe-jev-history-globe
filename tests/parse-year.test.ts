import { describe, expect, it } from "vitest";
import { parseYear } from "../src/live/parseYear";

describe("parseYear", () => {
  it("parses a plain 4-digit year", () => {
    expect(parseYear("1969: Apollo 11 lands on the Moon")).toBe(1969);
  });

  it("parses a 3-digit year", () => {
    expect(parseYear("592: Council of Cesaracosta")).toBe(592);
  });

  it("parses BC/BCE as negative", () => {
    expect(parseYear("753 BC: the founding of Rome")).toBe(-753);
    expect(parseYear("3001 BCE, a temple is founded")).toBe(-3001);
  });

  it("parses AD/CE as positive", () => {
    expect(parseYear("1442 AD: a trade treaty is signed")).toBe(1442);
  });

  it("parses 'c.' / 'circa' prefixes", () => {
    expect(parseYear("Debdieba, a temple, founded c. 3001 BC")).toBe(-3001);
    expect(parseYear("circa 1200, a fortress is built")).toBe(1200);
  });

  it("returns undefined when no year is present", () => {
    expect(parseYear("the storming of the Bastille")).toBeUndefined();
    expect(parseYear("")).toBeUndefined();
  });
});
