// Composite-scoring probe: ask several yes/no and score questions per event, draw bars.
// Usage: node --env-file=.env scripts/probe-composite.mjs
const events = [
  "Battle of Hastings, 1066: Norman forces under William the Conqueror defeat King Harold II's English army.",
  "1517: Martin Luther posts his Ninety-five Theses, criticising the sale of indulgences.",
  "1492: Christopher Columbus reaches the Caribbean, beginning European colonisation of the Americas.",
  "1929: The Wall Street stock market crashes, triggering the Great Depression.",
  "1969: Apollo 11 lands on the Moon; Neil Armstrong becomes the first person to walk on it.",
];

const themes = {
  war: "Does this event involve war, battle or armed conflict?",
  politics: "Does this event involve political power, rulers or government?",
  religion: "Does this event involve religion or religious institutions?",
  economy: "Does this event involve trade, money or the economy?",
  science: "Does this event involve science, discovery or technology?",
  culture: "Does this event involve art, culture or ideas?",
};

const questions = {
  ...Object.fromEntries(Object.entries(themes).map(([k, q]) => [k, { type: "noul", instructions: q }])),
  impact: {
    type: "score",
    instructions: "How much did this event change the course of world history?",
    criteria: ["Barely noticed outside its locality", "Mattered to one country or region", "Reshaped a whole region for generations", "Changed the course of world history"],
  },
};

const bar = (p) => "█".repeat(Math.round(p * 24)).padEnd(24, "·");

let tokens = 0;
for (const state of events) {
  const t0 = performance.now();
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: "jev-latest", questions }),
  });
  const ms = Math.round(performance.now() - t0);
  const { answers, usage } = await res.json();
  tokens += usage.input_tokens;
  console.log(`\n${state.slice(0, 70)}…  (${ms} ms, ${usage.input_tokens} tok)`);
  for (const k of Object.keys(themes)) console.log(`  ${k.padEnd(9)} ${bar(answers[k].noul)} ${answers[k].noul.toFixed(2)}`);
  const a = answers.impact;
  console.log(`  impact    ${a.score.toFixed(2)}/3  conf ${a.confidence}  ` + Object.values(a.probabilities).map((p) => p.toFixed(2)).join(" / "));
}
console.log(`\ntotal input tokens: ${tokens} (~${Math.round(tokens / events.length)}/event)`);
