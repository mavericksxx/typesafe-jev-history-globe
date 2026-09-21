// Calibrate the second "did this actually happen as described?" noul
// question, added alongside the existing "real" (belongs-in-the-record)
// question in worker/src/index.ts. See that file's ACCURATE_THRESHOLD
// comment for how the numbers here fed the final threshold.
// Usage: node --env-file=.env scripts/probe-accurate-wording.mjs
const cases = [
  ["true-known", "1969: Apollo 11 lands on the Moon; Neil Armstrong becomes the first person to walk on it"],
  ["true-known", "1789: The storming of the Bastille begins the French Revolution"],
  ["true-known", "1066: William the Conqueror defeats Harold at Hastings"],
  ["true-known", "1929: The Wall Street stock market crashes, triggering the Great Depression"],

  ["true-obscure", "Debdieba, a temple, founded c. 3001 BC"],
  ["true-obscure", "Credit Suisse founded 1856"],
  ["true-obscure", "Council of Cesaracosta (592)"],
  ["true-obscure", "The Republic of Ragusa signs a trade treaty with the Ottoman Empire in 1442"],

  ["counterfactual", "1969: The Soviet Union lands the first human on the Moon"],
  ["counterfactual", "1066: Harold defeats William at Hastings, ending Norman ambitions"],
  ["counterfactual", "1815: Napoleon decisively wins the Battle of Waterloo and conquers Britain"],
  ["counterfactual", "1776: The American revolution is crushed and the colonies remain British"],
  ["counterfactual", "1642: The Siege of Vorenhalt ends the Mardovian Empire"],
  ["counterfactual", "2031: The Second Martian War begins"],

  ["junk", "i had toast for breakfast"],
  ["junk", "my grandmother moved house in 1987"],
  ["junk", "the wizard Gandalf defeated the Balrog in Moria"],
  ["junk", "asdfgh qwerty"],
  ["junk", "buy cheap watches click here"],

  ["ambiguous", "1067: Battle of Hastings"],
  ["ambiguous", "Romulus founds Rome in 753 BC"],
];

// Wording candidates to try in order until one separates cleanly. Each is
// tried against the full case set; only the last one tried is what ships.
const wordings = [
  "Did this actually happen as described, with the people, places, and outcome given being factually correct according to the historical record?",
];

const bar = (p) => "█".repeat(Math.round(p * 24)).padEnd(24, "·");

for (const instructions of wordings) {
  const questions = { accurate: { type: "noul", instructions } };
  console.log(`\n=== wording: ${instructions}\n`);
  let toks = 0;
  const byClass = {};
  for (const [kind, text] of cases) {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state: text, model: "jev-latest", questions }),
    });
    const { answers, usage } = await res.json();
    toks += usage?.input_tokens ?? 0;
    const v = answers.accurate.noul;
    (byClass[kind] ??= []).push(v);
    console.log(`${kind.padEnd(14)} ${bar(v)} ${v.toFixed(3)}  ${text.slice(0, 60)}`);
  }
  console.log(`\nsummary (min-max per class):`);
  for (const [kind, vals] of Object.entries(byClass)) {
    console.log(`  ${kind.padEnd(14)} ${Math.min(...vals).toFixed(3)} - ${Math.max(...vals).toFixed(3)}`);
  }
  console.log(`\ntotal input tokens: ${toks} (~${Math.round(toks / cases.length)}/call)`);
}
