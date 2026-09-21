// One-off probe (not part of the shipped pipeline) comparing the old and a
// candidate new impact question wording against a mixed sample of
// institution foundings and marquee world-historical events, to validate
// Task 3's reword before committing to it. Run:
//   node --env-file=.env scripts/probe-impact-wording.mjs
import { readFileSync } from "node:fs";

const sample = JSON.parse(readFileSync("/tmp/wording_sample.json", "utf8"));

const OLD = {
  type: "score",
  instructions: "How much did this event change the course of world history?",
  criteria: [
    "Barely noticed outside its locality",
    "Mattered to one country or region",
    "Reshaped a whole region for generations",
    "Changed the course of world history",
  ],
};

const NEW = {
  type: "score",
  instructions:
    "Judge THIS SPECIFIC event's actual historical consequence, not how important its general category usually sounds. Most institutions (a university, a mosque, a hospital, a company) are founded without changing anything beyond their own city or organisation — score those low even if 'universities matter' in the abstract.",
  criteria: [
    "This specific instance had negligible effect beyond its immediate locality or organisation — most local institution foundings, routine elections, ordinary buildings.",
    "This specific instance had a lasting effect within one country or region, but did not alter events elsewhere (e.g. a respected national university, a regional bank).",
    "This specific instance measurably reshaped a whole region for generations (e.g. a major war, a revolution, an empire's founding or collapse).",
    "This specific instance changed the course of world history across many countries and generations (e.g. a world war, a global pandemic, the fall of an ancient empire).",
  ],
};

const NEW2 = {
  type: "score",
  instructions:
    "Score how much THIS ONE EVENT, by itself, changed the course of history — not how well-known, large, or prestigious the resulting institution or place is today. The founding of a specific named university, mosque, hospital, company, museum or bank is ALMOST ALWAYS a 0 or 1 on this scale: it is a routine administrative act, even when the institution it created later became famous. Only score 2+ if this specific founding, opening, election, or building event itself directly triggered a war, a revolution, a famine, a mass migration, or comparably wide upheaval at the time.",
  criteria: [
    "Routine and local: a specific institution, building, or settlement being founded/opened, an ordinary election, a routine treaty. True even for a famous, large, or old institution — its current fame does not change how small this one act was at the time.",
    "Notable within one country or region, but did not itself set off events beyond it — e.g. a founding that sparked significant regional change, a contested election, a regional treaty.",
    "This specific event reshaped a whole region for generations — a major war, a revolution, an empire's rise or collapse, a conquest.",
    "This specific event changed the course of world history across many countries and generations — a world war, a global pandemic, the fall of a major ancient empire.",
  ],
};

async function scoreOne(text, impactQuestion) {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      state: text,
      model: "jev-latest",
      questions: { impact: impactQuestion },
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const { answers, usage } = await res.json();
  return { score: answers.impact.score, confidence: answers.impact.confidence, tokens: usage.input_tokens };
}

let totalTokens = 0;
const rows = [];
for (const r of sample) {
  const [oldR, newR, new2R] = await Promise.all([
    scoreOne(r.text, OLD),
    scoreOne(r.text, NEW),
    scoreOne(r.text, NEW2),
  ]);
  totalTokens += oldR.tokens + newR.tokens + new2R.tokens;
  rows.push({ text: r.text, old: oldR.score, new: newR.score, new2: new2R.score });
  console.log(
    `${r.text.padEnd(45)} old=${oldR.score.toFixed(2)}  new=${newR.score.toFixed(2)}  new2=${new2R.score.toFixed(2)}`
  );
}
console.log(`\ntotal tokens: ${totalTokens} (~$${((totalTokens * 42) / 1e9).toFixed(4)})`);

const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
console.log(`old avg: ${avg("old").toFixed(2)}, new avg: ${avg("new").toFixed(2)}, new2 avg: ${avg("new2").toFixed(2)}`);
