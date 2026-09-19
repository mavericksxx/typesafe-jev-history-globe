// Hand-curated landmark events shown as small cards between narrative eras
// (see scripts/build-data.ts, which bundles these into public/data). A
// stopgap for Phase 1's real Jev-scored corpus — the shape (year, lat, lon,
// text, top theme) is a subset of HistoryEvent's core fields on purpose, so
// swapping these for real corpus entries later is a drop-in change, not a
// rewrite of the narrative/comet code that consumes them.
//
// Real, well-known events with correct years and coordinates; 2-3 per era,
// each falling within its era's year range (see the ERAS start years in
// scripts/build-data.ts) so narrative/index.ts's bucketing places them
// under the right era.
import type { LandmarkEvent } from "./types";

export const LANDMARKS: LandmarkEvent[] = [
  // Early civilisations
  { year: -2600, lat: 27.5, lon: 68.3, text: "Indus Valley cities Harappa and Mohenjo-daro flourish", top: "culture" },
  { year: -2560, lat: 29.98, lon: 31.13, text: "Great Pyramid of Giza completed", top: "culture" },
  { year: -2334, lat: 33.0, lon: 44.4, text: "Sargon of Akkad founds the first known empire", top: "politics" },

  // Bronze Age
  { year: -1754, lat: 32.54, lon: 44.42, text: "Code of Hammurabi inscribed in Babylon", top: "politics" },
  { year: -1600, lat: 34.7, lon: 114.9, text: "Shang dynasty founded in the Yellow River valley", top: "politics" },
  { year: -1274, lat: 34.56, lon: 36.52, text: "Battle of Kadesh between Egypt and the Hittites", top: "war" },

  // Iron Age empires
  { year: -1200, lat: 39.9, lon: 34.6, text: "Bronze Age collapse: Hattusa and Mycenae destroyed", top: "war" },
  { year: -814, lat: 36.85, lon: 10.32, text: "Carthage founded by Phoenician settlers", top: "economy" },
  { year: -671, lat: 30.0, lon: 31.2, text: "Assyria conquers Egypt under Esarhaddon", top: "war" },

  // Classical Greece
  { year: -490, lat: 38.12, lon: 23.97, text: "Battle of Marathon", top: "war" },
  { year: -447, lat: 37.97, lon: 23.73, text: "Construction of the Parthenon begins in Athens", top: "culture" },
  { year: -399, lat: 37.98, lon: 23.73, text: "Trial and execution of Socrates in Athens", top: "culture" },

  // Rome & Han
  { year: -221, lat: 34.26, lon: 108.94, text: "Qin Shi Huang unifies China", top: "politics" },
  { year: -44, lat: 41.89, lon: 12.48, text: "Julius Caesar assassinated in Rome", top: "politics" },
  { year: 79, lat: 40.75, lon: 14.49, text: "Vesuvius buries Pompeii", top: "science" },

  // Late antiquity
  { year: 313, lat: 45.46, lon: 9.19, text: "Edict of Milan legalises Christianity in the Roman Empire", top: "religion" },
  { year: 320, lat: 25.6, lon: 85.1, text: "Gupta Empire founded, ushering a classical age in India", top: "culture" },
  { year: 476, lat: 44.42, lon: 12.2, text: "Last Western Roman emperor deposed", top: "politics" },

  // Early medieval
  { year: 618, lat: 34.27, lon: 108.95, text: "Tang dynasty founded in China", top: "politics" },
  { year: 622, lat: 24.47, lon: 39.61, text: "Muhammad's migration (Hijra) to Medina", top: "religion" },
  { year: 762, lat: 33.31, lon: 44.37, text: "Baghdad founded as the Abbasid capital", top: "politics" },

  // Islamic Golden Age
  { year: 830, lat: 33.31, lon: 44.37, text: "House of Wisdom established in Baghdad", top: "science" },
  { year: 850, lat: 34.2, lon: 43.87, text: "Great Mosque of Samarra completed in Iraq", top: "religion" },
  { year: 969, lat: 30.04, lon: 31.24, text: "Fatimid Caliphate founds Cairo", top: "politics" },

  // High medieval
  { year: 1054, lat: 41.01, lon: 28.98, text: "Great Schism splits the Church", top: "religion" },
  { year: 1096, lat: 31.78, lon: 35.23, text: "First Crusade departs for Jerusalem", top: "war" },
  { year: 1113, lat: 13.41, lon: 103.87, text: "Angkor Wat construction begins in Cambodia", top: "religion" },

  // Mongol era
  { year: 1206, lat: 47.92, lon: 106.92, text: "Genghis Khan unites the Mongols", top: "war" },
  { year: 1258, lat: 33.31, lon: 44.37, text: "Mongols sack Baghdad", top: "war" },
  { year: 1271, lat: 39.9, lon: 116.4, text: "Kublai Khan founds the Yuan dynasty", top: "economy" },

  // Renaissance
  { year: 1405, lat: 32.06, lon: 118.8, text: "Zheng He's first treasure voyage departs Nanjing", top: "economy" },
  { year: 1453, lat: 41.01, lon: 28.98, text: "Fall of Constantinople", top: "war" },
  { year: 1455, lat: 49.99, lon: 8.27, text: "Gutenberg Bible printed", top: "science" },

  // Age of exploration
  { year: 1492, lat: 24.06, lon: -74.53, text: "Columbus reaches the Caribbean", top: "economy" },
  { year: 1498, lat: 11.25, lon: 75.77, text: "Vasco da Gama reaches India by sea around Africa", top: "economy" },
  { year: 1521, lat: 19.43, lon: -99.13, text: "Tenochtitlan falls to Cortés", top: "war" },

  // Revolutions
  { year: 1687, lat: 52.2, lon: 0.12, text: "Newton publishes the Principia", top: "science" },
  { year: 1776, lat: 39.95, lon: -75.15, text: "US Declaration of Independence signed", top: "politics" },
  { year: 1791, lat: 19.76, lon: -72.2, text: "Haitian Revolution begins", top: "politics" },

  // Industrial age
  { year: 1830, lat: 53.41, lon: -2.98, text: "Liverpool-Manchester railway opens", top: "economy" },
  { year: 1868, lat: 35.68, lon: 139.69, text: "Meiji Restoration begins in Japan", top: "politics" },
  { year: 1884, lat: 52.52, lon: 13.4, text: "Berlin Conference partitions Africa", top: "politics" },

  // World wars
  { year: 1914, lat: 43.86, lon: 18.41, text: "Assassination in Sarajevo triggers the First World War", top: "war" },
  { year: 1917, lat: 59.94, lon: 30.31, text: "Russian Revolution", top: "politics" },
  { year: 1945, lat: 34.39, lon: 132.45, text: "Atomic bombing of Hiroshima", top: "war" },

  // Cold War
  { year: 1947, lat: 28.61, lon: 77.21, text: "Partition of India creates India and Pakistan", top: "politics" },
  { year: 1957, lat: 45.92, lon: 63.34, text: "Sputnik launched", top: "science" },
  { year: 1969, lat: 28.57, lon: -80.65, text: "Apollo 11 lands on the Moon", top: "science" },

  // Digital age
  { year: 1991, lat: 46.23, lon: 6.05, text: "World Wide Web released to the public at CERN", top: "science" },
  { year: 2008, lat: 40.71, lon: -74.01, text: "Global financial crisis spreads from US mortgage markets", top: "economy" },
  { year: 2022, lat: 37.77, lon: -122.42, text: "Large language models see rapid public adoption", top: "science" },
];
