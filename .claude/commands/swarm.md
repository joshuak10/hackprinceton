---
description: Build a Swarmscope world from a place and a question, run it with Jev, and report ranked bottlenecks and tested fixes
argument-hint: "<place and question, e.g. Larkfield's three ERs on a Friday night, which one gets overwhelmed first?>"
---

# /swarm: describe a place, simulate the people, rank the bottlenecks

Request: $ARGUMENTS

If the request is empty or names no place, ask the user for a place and a question, then stop.

Swarmscope simulates every person in a crowd as an agent that decides through Jev (TypeSafe's structured-decision model). Your job is to do the language work around it: turn the request into a world and a cast, run it, read the results, and test fixes. The engine and Jev make every agent's decision. Never invent results the commands did not print.

Run every command from the repo root. Do not print, echo or read `.env.local`, and never show an API key.

## 1. Read the format

Read `worlds/SCHEMA.md` in full before writing anything. Pick the mode with its section 1: `visit` when people choose where to be served (lines with servers), `route` when they move through shared links (roads, corridors, doors, elevators). Open one example world of that mode (`worlds/er-network.json` or `worlds/food-hall-lunch.json` for visit, `worlds/rush-hour-roads.json` or `worlds/office-lobby-morning.json` for route) to match its style.

## 2. Write `worlds/<slug>.json`

Use a short lowercase hyphenated slug for the place, e.g. `worlds/terminal-b-security.json`. If that file already exists, pick a different slug rather than overwriting it.

The world must have:

- **`title`, `question`, `context`.** Phrase the question as a ranking ("which place loses the most people", "which fix helps most"). `context` tells agents the day, time and situation in one or two sentences.
- **Places with capacities and reputations.** Visit: every `service` node has `servers`, `serviceTime`, `tags`, `price` where relevant, an `about` line agents read (what it is known for, rumors, quirks), and an `appeal` that agrees with `about`. Route: every edge has a realistic `length` and `capacity`, and `costModel: "linear"` for doors, turnstiles, escalators and elevators (SCHEMA section 5 has typical values).
- **Explicit `id`s** on every node and archetype, and references by id only.
- **2-6 archetypes** that differ in what they need, how patient they are (`patience`), and whether they have live information (`info`). Every `needs` list must match at least one service.
- **A 10-20 person cast** (`minds`) following SCHEMA section 7: concrete situations with stakes and deadlines, constraints (money, kids, mobility, schedule), loyalties and grudges toward places named exactly as in `nodes`, who they listen to (`social`), and a mix of `informed` true and false within each group. Include a contrarian and a follower. Every archetype has at least one persona. Invented names only.
- **Arrivals sized to stress something.** Peak demand should be near or above capacity at one or more places or links, and `duration` should leave time to finish after `arrivals.end`. Keep `arrivals.total` at the smallest size that shows the effect (often 500-3000), because it drives cost.

Every capacity, time and share you choose is an assumption. Keep a short list of the important ones for the findings.

## 3. Validate and fix

```
node bin/swarm.js validate worlds/<slug>.json
```

Fix every error and re-run until it prints `OK`. Fix warnings too unless you meant them (a clamped value usually means a wrong unit).

Then check the world is under load with a free rules run:

```
node bin/swarm.js run worlds/<slug>.json --provider rules --no-record
```

If nothing queues or slows down, the world is too easy to answer the question: raise arrivals or tighten capacity, and validate again. If nearly everyone abandons, it is too hard.

## 4. Estimate the cost

```
node bin/swarm.js estimate worlds/<slug>.json
```

If `Est. cost` is over $1, stop and ask the user before any Jev run. Show the estimate, and offer to lower `arrivals.total` instead. The price is TypeSafe's published figure and is unverified; say so.

## 5. Run with Jev

```
node bin/swarm.js run worlds/<slug>.json --provider jev
```

Note the `Recorded runs/<runId>` line it prints.

- If it fails because `TYPESAFE_API_KEY` is missing or rejected, tell the user to put it in `.env.local` (never committed) and stop. You may offer a `--provider rules` run instead, but label any result from it as rules, not Jev.
- If it prints the fallback warning (over 20% of decisions fell back to rules), the run does not count as a Jev run. Say so plainly in the findings.

## 6. Read the report

```
node bin/swarm.js report runs/<runId>
```

(`latest` also works in place of `runs/<runId>`.) It has the headline KPIs, ranked bottlenecks, outcomes and frustration by group, remarks, torn decisions and provider stats. To see what individual people wanted, read two or three agents, especially ones in torn decisions or ones who left:

```
node bin/swarm.js agent runs/<runId> <agentId>
```

## 7. Write the findings

Write them in the reply, in this order:

1. **Answer, as a ranking.** Rank the places or links by bottleneck score, with the score and its driver (wait minutes, people who walked away, delay minutes). Rankings, not forecasts: never say "the wait will be 85 minutes". Say "ranked first on this seed, with about twice the score of the next place".
2. **What people wanted.** Per group: where they tried to go, what they settled for, who left and why. Use the torn decisions (choices whose top two probabilities were close) and the agent logs, and quote the persona situations that drove the choice.
3. **Social effects.** Warnings and praise that spread (remark counts and kinds), herding toward or away from a place, frustration that lowered patience, and differences between people with and without the live app or traffic.
4. **Run facts.** Provider and model, seed, number of decisions, fallback rate, and estimated cost (unverified).
5. **Caveats.** Simulated agents are not validated against real people; one seed is weak evidence; list the key assumed parameters from step 2.

## 8. Propose and test 1-3 fixes

Pick 1-3 cheap, concrete levers aimed at the top bottleneck, for example one more server, a wait-time screen (raise an archetype's `info`), staggered arrivals (`arrivals.end`), or a closed or widened link. Write each as a patch file `patches/<slug>/<lever>.json`, a JSON array of operations from SCHEMA section 10:

```json
[{ "kind": "node", "id": "main", "field": "servers", "value": 6 }]
```

Patchable fields: node `servers`, `serviceTime`, `appeal`, `price`; edge `capacity`, `length`, `closed` (id `"from>to"`); archetype `info`, `patience`, `rationality`, `visits`, `share`; global `arrivals.total`, `arrivals.start`, `arrivals.end`, `travelSpeed`. `value` must be a number.

Screen each patch for free with rules, then confirm the most promising with Jev. Both sides of a compare use the same seeds (default 7, 8, 9):

```
node bin/swarm.js compare worlds/<slug>.json --patch patches/<slug>/<lever>.json --provider rules
node bin/swarm.js compare worlds/<slug>.json --patch patches/<slug>/<lever>.json --provider jev --seeds 3
```

A Jev compare costs about 2 × seeds × the estimate from step 4. Apply the same $1 rule and ask first if it is over.

Report the fixes as a ranking by improvement in the headline KPI (abandon rate and average wait for visit, average trip and delay for route), with the before and after mean ± sd. Say whether each change is larger than the seed-to-seed spread, whether the #1 bottleneck moved somewhere else, and which provider produced the numbers.

## 9. Point to the viewer

End by telling the user they can watch the run:

```
node bin/swarm.js serve
```

then open http://127.0.0.1:4173 and pick the run to scrub through time, click any agent to see its decisions with probabilities, and read the remarks as they spread.
