// Calibrates the "country" choice question added to worker/src/index.ts for
// live-mode pinning. Two concerns to resolve empirically, not by guessing:
//
// 1) Wording: "where did this physically happen" vs "which country is this
//    event associated with / whose history does it belong to". These give
//    different answers for events with no country of physical occurrence
//    (Apollo 11 happened on the Moon) — the product decision (see
//    worker/src/index.ts's COUNTRY_QUESTION comment) is that "1969: Apollo
//    11 lands on the Moon" should resolve to the USA (actor-country), not
//    drop to "unknown location". This probe checks that the "associated
//    with" phrasing actually produces that for real, rather than assuming.
// 2) Threshold: how confident is "confident enough to pin" vs "genuinely
//    ambiguous, don't pin" (multi-country events, anachronistic ancient
//    sites)?
//
// Usage: node --env-file=.env scripts/probe-country-question.mjs
import raw from "../src/live/countryCentroids.json" with { type: "json" };

const COUNTRIES = Object.keys(raw);

const cases = [
  ["obvious", "1789: The storming of the Bastille begins the French Revolution"],
  ["obvious", "1969: Apollo 11 lands on the Moon; Neil Armstrong becomes the first person to walk on it"],
  ["multi", "World War II"],
  ["multi", "The Silk Road connected East and West for centuries"],
  ["non-terrestrial", "Apollo 11 lands on the Moon"],
  ["anachronistic-ancient", "Debdieba, a temple, founded c. 3001 BC"],
  ["anachronistic-ancient", "The founding of the city of Rome, 753 BC"],
  ["obvious", "1066: William the Conqueror defeats Harold at Hastings"],
  ["obvious", "1929: The Wall Street stock market crashes, triggering the Great Depression"],
];

const wordings = [
  [
    "physical",
    "In which present-day country did this event physically take place?",
  ],
  [
    "associated",
    "Which present-day country is this event most associated with — the country of the state, institution, or people responsible for it — even if the event itself took place somewhere with no country (such as in space, at sea, or in Antarctica)?",
  ],
];

const bar = (p) => "█".repeat(Math.round(p * 24)).padEnd(24, "·");

for (const [label, instructions] of wordings) {
  console.log(`\n=== wording: ${label}\n${instructions}\n`);
  let toks = 0;
  for (const [kind, text] of cases) {
    const questions = {
      country: {
        type: "choice",
        instructions,
        criteria: Object.fromEntries(COUNTRIES.map((c) => [c, null])),
      },
    };
    const t0 = performance.now();
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: text, model: "jev-latest", questions }),
    });
    const ms = Math.round(performance.now() - t0);
    const { answers, usage } = await res.json();
    toks += usage?.input_tokens ?? 0;
    const probs = answers.country.probabilities ?? {};
    const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
    console.log(
      `${kind.padEnd(20)} ${(top?.[0] ?? "?").padEnd(16)} ${bar(top?.[1] ?? 0)} ${(top?.[1] ?? 0).toFixed(3)}  (${ms}ms)  ${text.slice(0, 55)}`
    );
  }
  console.log(`total input tokens: ${toks} (~${Math.round(toks / cases.length)}/call, ${COUNTRIES.length} options)`);
}
