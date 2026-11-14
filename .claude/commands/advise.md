---
description: Be the Swarmscope advisor for a world or a run - answer the question, test fixes on the same seeds, and write advice.md (no API key needed)
argument-hint: "<world file, example name or run> [question, e.g. which people walk away most, and can a deal win them back?]"
---

# /advise: from "where is the problem" to "what to do about it"

Request: $ARGUMENTS

The first word is the world (a JSON path or an example name such as `food-hall-lunch`) or a recorded run (`runs/<runId>`, a run id, or `latest`). Everything after it is the user's question. With no question, use the world's `question`. If the request is empty, ask for a world or a run, then stop.

You are the advisor described in `docs/PROTOTYPE.md` §15c, doing by hand what `swarm advise` does with an API key. Finding the bottleneck is not enough: answer the question, propose changes, **test every change in the simulator on the same seeds**, and say what to try next. Every number you report must come from a command you ran. Never invent results.

Run every command from the repo root. Do not print, echo or read `.env.local`, and never show an API key.

## Rules (the same ones `swarm advise` gives Claude)

- Answer the user's question first, in plain words.
- Report a change as helping only if its effect is larger than the spread across seeds, in the better direction. The spread of a KPI is the larger of its before and after standard deviations across seeds (the `± sd` that `compare` prints). A smaller effect is "no clear effect", whatever its sign.
- Give rankings under stated assumptions, not forecasts. Name the assumptions the answer depends on (the world's provenance and every assumed capacity, time, share and price).
- Segments are kinds of simulated people (a group, or everyone who copies one cast member), never real individuals. An offer is a simulated message to a kind of simulated person. Never suggest identifying, tracking or targeting real individuals.
- Say what you could not test, and why.
- Recommend only changes you tested.

## 1. The world and the baseline

If the argument is a run, the world is `runs/<runId>/spec.json`. Otherwise check the world first:

```
node bin/swarm.js validate <world>
```

Run the baseline on 3 seeds with the free rules provider. It records one run per seed and prints the per-seed table and the mean ± sd:

```
node bin/swarm.js run <world> --provider rules --seeds 3 --seed 7
```

Keep the three `runs/<runId>` folders it prints, and the per-seed rows. Use seeds 7, 8, 9 for every test below.

## 2. Read what the run produced

```
node bin/swarm.js report <runs/runId of seed 7>
```

Read the headline KPIs, the ranked bottlenecks, the busiest doorways (building worlds), **Who had the worst time** and **Who spent the most** (segments), **Offers** if any, remarks, torn decisions and provider stats. Check the other two seeds' reports when the #1 bottleneck or a segment ranking differs between seeds. For questions about kinds of people, look at two or three of them:

```
node bin/swarm.js agent <run> <agentId>
```

## 3. Decide what to test

Read the current values in the world file. The levers (`PATCH_FIELDS` in `engine/spec.js`):

- node (a place): `servers`, `serviceTime`, `appeal`, `price`, and `weight` for gates and entries
- edge (a link, id `"from>to"`): `capacity`, `length`, `closed` (1 closes it)
- archetype (a group): `info`, `patience`, `rationality`, `visits`, `share`
- global: `arrivals.total`, `arrivals.start`, `arrivals.end`, `travelSpeed`
- offer: reach one kind of simulated person with a message and an optional discount:

```json
[{ "kind": "offer", "offer": { "id": "pizza_deal", "text": "Forno Slice: 30% off, ready in 2 minutes", "to": { "groups": ["takeout"], "cast": [] }, "place": "pizza", "priceOff": 0.3 } }]
```

`text` is at most 160 characters; an empty `to` means everyone; `from` and `until` (minutes) are optional. Field operations look like `[{ "kind": "node", "id": "coffee", "field": "servers", "value": 4 }]`, and one patch may hold several operations to test them together.

Pick changes aimed at the question: capacity at the top bottleneck, live information for a group, staggered arrivals, or an offer aimed at the segment the question is about. Prefer cheap, concrete changes.

## 4. Test each change (at most 6 experiments)

For each experiment, first say in one line what you are testing and why. Then write the patch to `patches/<world-slug>/<n>-<short-name>.json` and run it on the same seeds:

```
node bin/swarm.js compare <world> --patch patches/<world-slug>/<n>-<short-name>.json --provider rules --seeds 3 --seed 7
```

Record before ± sd, after ± sd and the change for each KPI, and whether the #1 bottleneck moved. A line saying no patch operation applied means nothing was tested: fix the ids or fields and run it again; it does not count as an experiment. To check whether a change holds on every seed, compare the per-seed rows of

```
node bin/swarm.js run <world> --patch patches/<world-slug>/<n>-<short-name>.json --provider rules --seeds 3 --seed 7 --no-record
```

with the baseline rows. For an offer, also read the offer's `reached` and `wentToPlace` and the targeted segment's numbers from a recorded patched run (`run --patch ... --seeds 3`, then `report`).

Stop at 6 experiments.

**Jev.** Rules experiments are free; Jev is not. Before any Jev run, including confirming the top change with `compare --provider jev --seeds 3`, run

```
node bin/swarm.js estimate <world>
```

A Jev compare costs about 2 × 3 seeds × that estimate. If the total is over $1, ask the user before running it. When you do confirm with Jev, report both results, and if rules and Jev disagree on the direction of a KPI, say so and treat the change as unproven. If Jev was not run, say the experiments used rule-based people.

## 5. Write the advice

Write `advice.md` into each of the three baseline run folders, in this order:

1. `# Advice: <world title>`, then the question, and one line: seeds, provider, number of experiments.
2. `## Answer`: the answer to the question first, in plain words.
3. `## Recommended changes (ranked, measured on the same simulated crowd)`: a table with columns `#`, `Change` (with its experiment number), `Measured effect (before → after)` (for example `abandon rate 11.1% → 4.5% (-6.6 pts; spread 3.4 pts)`), `Holds across seeds`, `Tested with`, `Confidence` (high only when the effect beats the spread on every seed with 3 seeds; low when it does not beat the spread or providers disagree). Under the table, one line per change: why, the exact changes, and the cost if known.
4. `## Cautions`: the assumptions the answer depends on, rules versus Jev, and anything weak (few seeds, fallback warnings).
5. `## What could not be tested`, and why.
6. `## Next steps`.
7. `## Findings`, then `## Every experiment`: one row per experiment with its label, why, the change ± spread for the headline KPIs, and the verdict (helps, hurts, mixed, no clear effect).

Also write `advice.json` beside it so the viewer's Advice panel can show it, with the shape `swarm advise` saves: `{ answer, findings, recommendations: [{ label, patch, effect: { <kpi>: { before, after, change, spread } }, testedWith, holdsAcrossSeeds, costNote, confidence, why, experiment }], cautions, nextSteps, experiments: [{ n, label, why, patch, testedWith, seeds, kpis: { <kpi>: { before, after, change, spread } }, verdict }], transcript: [{ "kind": "start", "world": <title>, "question": <question>, "seeds": [7, 8, 9], "provider": "rules", "model": "claude-code" }] }`. Put each untested item in `cautions` as `"Could not test: <item>"`.

## 6. Hand it back

Show the answer and the recommendations table in your reply, give the path to `advice.md`, and end by asking the user what to change or try next. If they reply, treat it as a follow-up: keep the earlier experiments and their numbers, test up to 6 more on the same seeds, and rewrite the advice with the earlier and new experiments together.
