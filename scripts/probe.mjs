// One-off probe: send a single event to Jev and print every answer's probabilities.
// Usage: node --env-file=.env scripts/probe.mjs "Battle of Hastings, 1066"
const event = process.argv[2] ?? "Battle of Hastings, 1066: Norman forces under William the Conqueror defeat King Harold II's English army.";

const countries = ["England", "France", "Italy", "Germany", "Spain", "Greece", "Egypt", "Turkey", "Iran", "Iraq",
  "India", "China", "Japan", "Russia", "United States", "Mexico", "Peru", "Brazil", "Mongolia", "Norway"];

const body = {
  state: event,
  model: "jev-latest",
  questions: {
    category: {
      type: "choice",
      instructions: "What kind of historical event is this?",
      criteria: { war: null, discovery: null, invention: null, disaster: null, art: null, politics: null, religion: null, economy: null },
    },
    scale: {
      type: "score",
      instructions: "How far did this event's impact reach?",
      criteria: ["Local: one city or region", "Regional: a country or neighbouring countries", "Global: many parts of the world"],
    },
    country: {
      type: "choice",
      instructions: "In which present-day country did this event mainly take place?",
      criteria: Object.fromEntries(countries.map((c) => [c, null])),
    },
    is_real_event: {
      type: "noul",
      instructions: "Is this a real, documented historical event?",
    },
  },
};

const t0 = performance.now();
const res = await fetch("https://api.typesafe.ai/v1/systemone", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const ms = Math.round(performance.now() - t0);
console.log(`HTTP ${res.status} in ${ms} ms`);
console.log(JSON.stringify(await res.json(), null, 2));
