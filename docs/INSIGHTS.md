# Suggestions after a run

> **Nov 14 (spec v0.27):** the display no longer has a Suggestions button. Its verdict panel tests one fixed change (+1 staff at the worst line; a promotion at the sushi restaurant) on 3 seeds and shows whether it helped. It does not call the advisor or the quick read described below. See docs/PROTOTYPE.md §9b. The rest of this page describes the server side, which is unchanged, and how the display used it before v0.26.

The display's **Suggestions** button (top bar) explains what to change for the run on screen. Nothing is requested until someone clicks it. It then shows, in order of preference:

1. **Tested advice from the advisor** (Ryan's `run/advisor.js`, docs/PROTOTYPE.md §15c). `node bin/swarm.js advise <world>` runs a baseline on several seeds, has Claude propose changes, tests each change on the same seeds, and writes `advice.json` and `advice.md` into the baseline runs. The display reads it with `GET /api/runs/:id/advice`. Every number in a recommendation comes from an experiment the code ran. Needs `ANTHROPIC_API_KEY`, or run `/advise` in Claude Code.
2. **The quick read** (Justin's `analysis/insights.js`), when the run has no advice yet, and always for the mock cases. `POST /api/insights` collects the run's recorded numbers (outcomes, recorded choices, waits by place and by group, walk-aways, complaints) and returns findings that cite those numbers, each with an experiment to try and how to check it. Its suggestions are **untested**, and the screen says so. With `ANTHROPIC_API_KEY` set, Claude writes the findings (model `ANALYSIS_MODEL`, default `claude-opus-5-5`); without a key, or if Claude fails or cites numbers that don't exist, the findings come straight from the numbers. Only the compact numbers are sent, never positions or persona biographies.

Which run is analyzed: runs recorded by the engine are named by their run id; the mock cases by case (`building`, `parking`). Opening another run resets Suggestions and cancels a request in flight.

`POST /api/insights` takes `{ "runId": "<completed run>" }` or `{ "caseId": "building" | "parking" }`, plus an optional `question` (up to 2,000 characters). The server reads its own recordings; clients cannot pass paths or numbers. Unfinished runs are refused. Identical requests share one result, at most two analyses run at once, and recent results are cached; a run's quick read is saved as `runs/<id>/insights.json` with a hash of its inputs. Both `node bin/swarm.js serve` and the mock-only `npm run web` server answer it.

Tests: `test/insights.test.js` (quick read), `test/advisor.test.js` and `test/server-advice.test.js` (advisor), `test/scope-verdict.test.js` and `test/server-run-link.test.js` (the display's verdict and the run link, v0.27).
