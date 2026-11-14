# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

An independent business owner deciding a change. Counter-service food and drink comes first.

Hackathon judges watch the owner's view on a 13-inch MacBook, in Chrome at full screen, about 1280×832. There is no projector.

## Product Purpose

Try a change on simulated customers before trying it on real ones. The use case is specified in [INDEPENDENT_BUSINESS_SPEC.md](INDEPENDENT_BUSINESS_SPEC.md).

The screen's first answer is "Did the change help?". It is measured in customers kept, which means fewer walk-aways.

## Operating Context

The scope dashboard (`web/scope/`) is the owner's view. It replays a simulated lunch on a floor plan and tests one change against a baseline.

The surface is in Operate mode. Design work on it is refinement, not a new visual world.

## Capabilities and Constraints

- Plain HTML, CSS, ES modules and canvas. There is no build step.
- The display tests one change: one more staff at the counter with the worst line. It runs the baseline and the change with the rule model on 3 seeds each and shows a range.
- The link between a baseline run and its changed run is stored on the server, in the run's `meta.json`.
- Words: "staff at the counter", "rule model", "Jev". Technical detail belongs in Run details, not in the main view.
- No money figures.
- Not in scope: testing other counters, mobile layouts, a new design for the Matterport tour panel.

## Brand Commitments

- Keep the survey-linework floor plan, the incident timeline and the incident glyphs.
- IBM Plex Sans everywhere, with tabular figures for numbers. Bricolage Grotesque only for the "Swarmscope" wordmark.
- Light theme by default. Dark stays as a toggle.
- Red has one meaning: people lost.

## Evidence on Hand

- The design critique of the dashboard: `.impeccable/critique/2026-11-14T22-29-45Z__web-scope-index-html.md` (23 of 40 before this redesign).
- Recorded runs are under `runs/`, which is not in the repository. There may be no Jev run on a given machine.
- There are no customer quotes, sales figures or prices to show. Do not invent them.

## Product Principles

1. No numbers without the why.
2. It must not look like a generic SaaS dashboard: no tile grids, no pills, no accent buttons that would fit any product.
3. No clutter. Every control has one home, grouped with what it controls.
4. Say who decided. A result from the rule model is labelled as tested with the rule model.

## Accessibility & Inclusion

- Every control can be reached and used with the keyboard, including selecting a person on the map.
- One focus outline for every control.
- Form-field borders reach 3:1 against their background.
