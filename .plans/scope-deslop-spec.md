# Scope dashboard deslop: spec

Nov 14, 2026. From the interview with Josh, Impeccable's critique (`.impeccable/critique/2026-11-14T22-29-45Z__web-scope-index-html.md`, 23/40) and the unslop-ui rules. Target: `web/scope/`.

## Product facts (for PRODUCT.md)

- **Platform:** web. Plain HTML, CSS, ES modules and canvas; no build step.
- **User:** an independent business owner (first: counter-service food and drink) deciding a change. Hackathon judges watch the owner's view on Josh's 13" MacBook, Chrome full screen, about 1280×832. No projector.
- **Purpose:** try a change on simulated customers before trying it on real ones. See `INDEPENDENT_BUSINESS_SPEC.md`.
- **The screen's first answer:** "Did the change help?" Measured in customers kept (fewer walk-aways). No money figures.
- **Mode:** Operate. Refinement, not a new visual world: keep the survey-linework floor plan, the incident timeline and the incident glyphs.

## Red lines

1. No numbers without the why.
2. Must not look like a generic SaaS dashboard (tile grids, pills, accent buttons that fit any product).
3. No clutter: every control has one home, grouped with what it controls.

## Decisions

| Area | Decision |
|---|---|
| Cases | Parking-lot case removed from the display. The page opens straight into the building: latest recorded Jev run if one exists, otherwise the latest rules run, paused at the start. No case picker. |
| Top bar | Brand, prompt box, theme toggle only. The prompt keeps its size and place; the Simulate button becomes a neutral style. Placeholder shortened so it is not cut off at 1280. |
| Map header | One strip above the map: place name (a human name, not the listing name "Office/Retail - 45,726SF"), the question, provenance ("Jev" or "Rule model"), and Run details. |
| Verdict panel | Top of the side panel; replaces the Suggestions button, dialog and preview. Before a test: the worst line in words ("Lucky Noodle Bar loses the most people: 70 walked away over lunch") and a "Test +1 staff here" button. After: the verdict in customers kept, a before/after/change table, one sentence of why, and the Baseline / +1 staff toggle. No modal. |
| The why | One plain sentence of cause from the two runs (for example the peak line length before and after, and the busiest window), and the counter ringed on the map. |
| Test | Worst counter only (the hard-coded rule). Runs baseline and +1 staff with the rule model on 3 seeds each, and shows a range ("12 to 16 fewer walk-aways"). Says "tested with the rule model". If the run on screen is a Jev run, the comparison still uses the fresh rules pair, and the toggle switches between those two rules runs. |
| Run link | Stored on the server with the run (in `meta.json`): the base run id and the change. Every browser shows "Baseline" and "+1 staff at <counter>". No localStorage for this. |
| Run picker | Removed from the main view. The visible choice is the Baseline / +1 staff toggle. Other recorded runs are listed in Run details. |
| Side panel order | Verdict, live counters, bottleneck ranking, incident feed. Feed groups repeats ("Walked away at Lucky Noodle Bar ×14"). |
| Inspector | Opens in place of the ranking and feed; the verdict and counters stay visible. Clear Back control. |
| Map tools | One quiet "View" menu at the map's corner (color by, heat, people, labels). Reset view appears only after zooming or panning. No frosted glass. |
| Map labels | Counters clear and drawn above the people; doors and stairs faint or on hover; rooms unlabelled. Plex, not the display font. |
| Timeline | Add light time ticks under the histogram. Nothing else. |
| Theme | Light by default; dark stays as a toggle. Retune heat and incident colors for light. |
| Type | IBM Plex Sans everywhere, tabular figures for numbers. Bricolage Grotesque only for the "Swarmscope" wordmark. Merge the 12 font sizes into a short scale. |
| Wording | "Staff at the counter" ("+1 staff at Lucky Noodle Bar", "2 → 3 staff"). No "server", "seed", "Jev requests" or shell commands in the main view; technical detail lives in Run details. |

## Fixes from the critique (all in scope)

- Bottleneck rows and feed rows become real buttons; the map gets a keyboard path to select a person.
- The prompt input uses the same focus outline as every other control.
- Form-field borders reach 3:1 against their background.
- Skip the optional `/incidents` request when the run has none, or cancel the unread body, so the network goes idle.
- Red is reserved for one meaning (people lost). Counter numbers do not turn red for a single walk-away.
- "Served" counts are labelled so 597 visits by 312 people does not read as a bug.
- Remove `backdrop-filter`, the card-in-card in dialogs, and borders that duplicate a background change.
- The "Frustration" color option is disabled, with a reason, when the run has no frustration data.
- "So far" bars scale to the current maximum.
- Errors are shown, not swallowed (`app.js` comparison load).

## Out of scope

Money figures, testing other counters, a new visual world, mobile layouts, the Matterport tour panel's design (it stays as is).

## Verification

- `npm test` passes; new pure functions have tests.
- Drive the page in headless Chrome at 1280×832 in light and dark: opening state, playing, a person selected, View menu open, Run details open, before test, after test with the toggle on each side. Look at every screenshot.
- `impeccable detect --json web/scope/` is clean.
- Keyboard only: reach and operate every control, including selecting a person.
