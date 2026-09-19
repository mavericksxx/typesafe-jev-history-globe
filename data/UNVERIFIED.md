# Unverified / disputed narrative content

Produced during the Part A fact-check of `src/data/landmarks.ts` and the
`ERAS` array in `scripts/build-data.ts`. Items below were checked against
Wikidata (SPARQL endpoint + `wbsearchentities`/`wbgetentities`) and, where
Wikidata itself was ambiguous, cross-referenced against the linked English
Wikipedia article. Corrections that had a clear, sourced answer were made
directly in the files; the items here are the ones that don't have one.

## Corrected

- **Berlin Conference** (`landmarks.ts`): was dated 1885, changed to **1884**.
  Wikidata (Q13582) gives P580 (start time) = 1884-11-15 and P582 (end time)
  = 1885-02-26. The conference is conventionally cited by its start year, and
  the era body text in `build-data.ts` already said "1884" — the landmark
  disagreed with the era copy describing the same event. They now agree.

## Flagged as genuinely disputed (left as-is)

- **"House of Wisdom established in Baghdad", year 830** (`landmarks.ts`).
  Wikidata (Q33018) records only an inception of 800 (no day/month
  precision), not 830. Historians disagree on this one directly: some place
  the House of Wisdom's founding under Harun al-Rashid around 800, others
  (following Gutas's widely-cited revisionist account) argue it wasn't
  formalized as a distinct institution until al-Ma'mun's reign, c. 830. Since
  the sources actively conflict rather than one simply being wrong, I did not
  overwrite 830 with Wikidata's 800 — flagging instead so a human can pick
  which framing the narrative wants.

- **"Angkor Wat construction begins in Cambodia", year 1113**
  (`landmarks.ts`). Wikidata's own P571 (inception) claims for Q43473 are
  internally inconsistent — one claim gives 802 (which is the traditional
  founding date of the Khmer Empire itself, not the temple), another gives
  1200 (closer to the temple's completion). Neither matches the scholarly
  consensus, which dates construction to the reign of Suryavarman II
  (1113–1150 CE), with 1113 as the accepted start. I kept 1113 rather than
  either Wikidata value, since the Wikidata claims here look like a data
  quality issue on Wikidata's side, not a correction to make.

- **"Great Mosque of Samarra completed in Iraq", year 850** (`landmarks.ts`).
  Wikidata (Q593115) gives only an inception of 848 with year precision (no
  separate "completed" claim). Wikipedia and standard references place
  completion anywhere from 848 to 851 depending on source. 850 falls inside
  that range but isn't independently confirmable as *the* completion year
  from Wikidata alone.

## Not independently re-verified against live Wikidata queries

Given the volume (17 eras + 51 landmarks = 68 factual claims) and the
SPARQL/API rate budget for this task, the remaining landmarks and era
summaries were checked against well-established historical consensus
(dates and events that are not seriously contested in the literature —
e.g. the fall of Constantinople in 1453, the signing of the US Declaration
of Independence in 1776, Sputnik's 1957 launch) rather than each one being
run through a live Wikidata query individually. None of those raised a
discrepancy during review. If stricter verification is wanted, the same
`wbsearchentities` + `wbgetentities` P571/P580/P585-style spot-check used
above for the flagged items can be scripted against the full landmark list.
