---
target: scope dashboard (web/scope/)
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/joshuakim/Downloads/Projects/hackprinceton/web/scope/index.html"
target_fingerprint: "sha256:27a998242226e00d3c6230dcf5bb6995a844101e268e5c7da92037336b402c98"
target_path: /Users/joshuakim/Downloads/Projects/hackprinceton/web/scope/index.html
timestamp: 2026-11-14T22-29-45Z
slug: web-scope-index-html
---
Method: dual-agent (A: design review · B: detector + browser)

## Design specificity
Half authored, half template. Authored: survey-linework floor plan; incident histogram that doubles as the scrubber (solid past, dimmed future); one glyph set for incidents everywhere; heat from incidents; person inspector with probabilities; honest provenance. Template: slate navy + teal, Bricolage + Plex, big prompt bar with teal button, 2x2 KPI tiles, pills everywhere, translucent floating toolbar, card inside a modal. Structurally the screen never states the answer to its own question; the largest text is the listing name "Office/Retail - 45,726SF".

## Design health score (23/40, Acceptable)
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | "Mock data" badge while engine is live; Frustration color all gray in rules runs; suggestion runs known only to this browser |
| 2 | Match system / real world | 2 | seed, Jev, TypeSafe, server, wait min, Geo.metersPerUnit; "Served 597" vs 312 people |
| 3 | User control and freedom | 3 | No cancel during a suggestion run; inspector covers the side panel |
| 4 | Consistency and standards | 2 | Three run selectors; three toggle styles; red carries four meanings |
| 5 | Error prevention | 2 | Prompt routes any question to a canned case; fresh browser treats suggestion run as baseline (offers 3→4); parking offers "server at Front aisle" |
| 6 | Recognition rather than recall | 3 | Histogram has no label/axis; comparison has no change column |
| 7 | Flexibility and efficiency | 3 | Shortcuts unshown; URL never written; key moments computed but unused |
| 8 | Aesthetic and minimalist design | 2 | Prompt bar persists in replay; label collisions; feed not grouped; empty idle panel |
| 9 | Error recovery | 2 | Shell commands as recovery advice; comparison load errors swallowed (app.js:197) |
| 10 | Help and documentation | 2 | Nothing explains Jev, seeds, histogram, shortcuts |

## Priority issues
1. [P1] The answer is buried: no element ranks the finding (worst line, tested fix and its effect) above telemetry; the payoff sits behind a top-bar button and a modal table with no change column or verdict.
2. [P1] The suggestion/comparison flow is fragile: suggestion identity lives in localStorage; three selectors for one choice; whole-run numbers in the dialog vs at-time numbers in the panel without saying so.
3. [P1] Credibility leaks: parking "server at Front aisle"; apologetic dialog intro; shell commands in UI copy; prompt silently routes unrelated questions; listing names as titles.
4. [P2] Map legibility: canvas labels collide with dots and walls (12.5-13px, display font); plan underfills; Frustration layer silently gray; "So far" bars scaled to whole-run max.
5. [P2] Page frame competes with content: prompt + saturated Simulate during replay; badge looks clickable; run controls spread over three regions; blank idle side panel.

## Detector and measured evidence
- impeccable detect: clean (exit 0) on web/scope; with --no-config one suppressed cramped-padding on .seg. Overlay on 3 views (CSP bypassed in the test browser only): no anti-patterns.
- Keyboard: map selection, bottleneck rows and feed rows are click-only (app.js:537, panels.js:65/90/125).
- #askIn removes its outline; its focus ring is 1.56:1 (style.css:160).
- Form field borders 1.72-1.83:1, below 3:1 (style.css:155/248/282).
- Placeholder cut mid-word at 1440 and 1280.
- Optional /incidents request 404s and leaves the body unread (source.js:10), so the network never idles.
- Red counter text 3.82:1, passes only at 30px.
- 12 font sizes, six between 12.5 and 15px; Bricolage 700 requested but not loaded.
- Unslop: glassmorphism on .map-tools (blur 6px) and .progress; card in card in the dialog and ask card; blue-gray people colors nearly indistinguishable; borders on top of background differences.

## Persona red flags
- Judge on a projector: 12.5-14px gray text and map labels vanish; panel and ground merge; clicking a person shows "Decisions (0)" in the default rules run; payoff needs button → modal → table.
- Café owner: jargon; no money anywhere (no lost sales, no staff cost); suggestion has no time window; "9.3 → 9.2 min" reads as no effect without explaining walk-aways fell; no guidance on how big a difference counts.

## Strengths
1. The incident timeline: dense, product-specific, solid past and dimmed future, also the scrubber.
2. Honest provenance and spoiler-aware detail.
3. Plain human-scale core copy and a solid interaction model (real range input, Escape layering, reduced motion respected).
