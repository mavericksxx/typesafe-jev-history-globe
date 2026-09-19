// The "Try it live" judge. Ported from reel.html's keyword-regex `liveJudge`,
// behind the async interface a real Jev call will eventually implement.
import { THEMES } from "../data/types";
import type { Theme } from "../data/types";

export interface Answers {
  themes: Record<Theme, number>;
  impact: number;
  real: number;
}

const KW: Record<Theme, RegExp> = {
  war: /battle|war|defeat|army|siege|invad|conquer|attack|revolt|bomb/i,
  politics: /king|emperor|pope|harold|william|treaty|crown|elect|government|independ|revolution|conqueror|parliament/i,
  religion: /church|pope|bless|temple|god|saint|bible|monk|mosque|faith|holy/i,
  economy: /trade|market|crash|bank|money|wall street|price|merchant|tax|harvest|flood/i,
  science: /print|gutenberg|invent|discover|telescope|steam|electric|moon|vaccine|comput/i,
  culture: /poem|paint|art|music|book|bible|print|theatre|speech|novel/i,
};

/**
 * Mock stand-in for a real Jev call. Kept behind `Promise` so the call site
 * doesn't change once a real judge (a Cloudflare Worker request) replaces it.
 */
export async function judge(text: string): Promise<Answers> {
  const s = text.trim();
  const words = s.split(/\s+/).filter(Boolean).length;
  const themes = {} as Record<Theme, number>;
  for (const t of THEMES) {
    const matches = (s.match(new RegExp(KW[t].source, "gi")) ?? []).length;
    themes[t] = Math.min(0.99, 0.03 + matches * 0.42 + (matches ? words * 0.004 : 0));
  }
  const hasYear = /\b\d{3,4}\b|bc/i.test(s);
  const personal = /\bmy\b|grandm|our /i.test(s);
  const themeSum = Object.values(themes).reduce((a, b) => a + b, 0);
  const impact = Math.max(0, Math.min(3, themeSum * 1.1 - (personal ? 1.6 : 0)));
  const real = Math.max(0.05, Math.min(0.98, (hasYear ? 0.5 : 0.2) + (words > 3 ? 0.3 : 0) - (personal ? 0.45 : 0)));
  return { themes, impact, real };
}
