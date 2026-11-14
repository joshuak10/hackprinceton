# Swarmscope world format

A **world** is one JSON file that describes a place, the people who come to it, and the question to answer. The engine reads it, spawns thousands of agents, and asks Jev to make each agent's decisions. This file is the reference for writing one by hand, or for Claude to write one from a plain-English description. [`schema.json`](schema.json) has the same content as JSON Schema.

The engine is lenient: unknown or out-of-range values are clamped or replaced with defaults, and `swarm validate` lists every such fix as a warning. A few problems are fatal errors (section 9). Run `node bin/swarm.js validate worlds/<name>.json` after every edit.

Contents: [1 Modes](#1-choose-a-mode) · [2 Top level](#2-top-level-fields) · [3 Arrivals](#3-arrivals) · [4 Nodes](#4-nodes) · [5 Edges](#5-edges-route-mode) · [6 Archetypes](#6-archetypes) · [7 The cast](#7-the-cast-minds) · [8 How fields drive decisions](#8-how-the-fields-drive-decisions) · [9 Validation](#9-validation-ids-and-references) · [10 What-if patches](#10-what-if-patches) · [11 Size and cost](#11-size-and-cost) · [12 Examples](#12-examples) · [13 Checklist](#13-checklist) · [14 Buildings: walls and doors](#14-buildings-walls-doors-and-floor-plans) · [15 Targeted offers](#15-targeted-offers) · [16 Results by kind of person](#16-results-by-kind-of-person-spent-visits-and-segments)

---

## 1. Choose a mode

| Mode | Use it when | People… | Bottleneck score |
|---|---|---|---|
| `visit` | People choose among **places that each have a line and a fixed number of servers**, possibly several in a row, then leave. | arrive at an entrance, pick a place, walk there, join or skip its line, get served, pick again or leave. | wait minutes + 30 × people who walked away |
| `route` | People travel **from an origin to a destination through a network** and congestion builds on the links. | start at an origin, choose one of up to 3 routes, move link by link; links slow down as load rises. | delay minutes (actual minus free-flow travel time) |

Examples:
- **visit:** theme park rides, ER and urgent care network, food hall stalls and seating, store checkouts, DMV or passport counters, airport security lanes, clinics, campus dining.
- **route:** road networks, transit transfers, and **pedestrian movement inside buildings**: entrances, corridors, doors, turnstiles, escalators, stairs and elevators as capacity-limited links between rooms or landings (section 5). Also stadium egress and evacuation exploration (exploration only, never a safety assessment).

If people mainly *choose where to be served*, use `visit`. If they mainly *move through shared paths*, use `route`. One world has one mode; model the inside and the outside of a site as two worlds.

Not modeled yet: resources held for a long time while doing other things (a parking space, a reserved desk), multi-leg trips in route mode, people returning in route mode, and money or hours enforced beyond `price` and the arrival window.

## 2. Top-level fields

| Field | Type and range | Default | Meaning |
|---|---|---|---|
| `title` | string, ≤ 80 chars | `"Untitled world"` | Short name shown in the viewer and run ids. |
| `question` | string, ≤ 400 | `"Where are the bottlenecks?"` | The decision the run informs. Make it a ranking question ("which…", "where…", "which fix…"). |
| `context` | string, ≤ 300 | the title | One or two sentences **agents are told** about the setting: day, time, place, what people are doing. Every Jev decision sees it. Example: `"Friday night in Larkfield. People are deciding where to get emergency care."` |
| `leaveLabel` | string, ≤ 60 | `"Leave and go home"` | Visit mode: label of the leave option, e.g. `"Give up and eat somewhere else"`. |
| `waiting` | object | none | Visit mode, optional: how people are asked about lines. `tellPatience` (boolean, default `true`): `false` stops telling each person in words how a line compares with their group's patience ("more than they will put up with"), so the decision model judges that from the person. `askAgainEvery` (minutes, 5 to 240, default `0`): above 0, a person who keeps waiting is asked again that often and is never made to leave; `0` asks once. Rules runs are unaffected. See docs/PROTOTYPE.md §16. |
| `mode` | `"visit"` or `"route"` | `"visit"` | Any value other than `"route"` means visit. |
| `duration` | integer minutes, 30–1440 | 600 visit, 180 route | Length of the simulated period. Leave time after `arrivals.end` for people to finish. |
| `clockStart` | integer minutes after midnight, 0–1439 | 480 (8:00 am) | Wall-clock time at minute 0. 690 = 11:30 am, 1080 = 6:00 pm. |
| `travelSpeed` | map units per minute, 0.2–600 | 4 | Visit mode only (alias `walkSpeed`). Walking time between points = distance ÷ `travelSpeed` + 0.5 min. The map is 100 × 100 units, so crossing it takes 100 ÷ `travelSpeed` minutes: 4 for a theme park (25 min), 25 for a food hall (4 min), 3 for driving across a city (33 min). A floor plan drawn at about 0.5 m per unit walks at about 135 (75 m per minute ÷ `geo.metersPerUnit`), which is why the maximum is 600. Values above 600 are clamped with a warning. |
| `arrivals` | object | see section 3 | Who arrives when. |
| `nodes` | array, ≤ 60 | required | Places (visit) or network points (route). Extra entries are dropped. |
| `edges` | array, ≤ 150 | required in route mode | Links between nodes. Ignored in visit mode. |
| `archetypes` | array, 1–6 | one group `"Everyone"` | Behavioral groups with shares. Extra entries are dropped. |
| `minds` | array, ≤ 40 | one generic persona per archetype | **The cast**: concrete people (section 7). Write 10–20. |
| `walls` | array, ≤ 4000 segments | none | Interior and exterior walls nobody can walk through (section 14). |
| `objects` | array, ≤ 400 outlines | none | Solid things inside the building (stairs, fixtures, counters), each `{ id, name, kind, source, polygon }` with 3–64 `[x, y]` points. The engine adds every outline to the walls, so nobody walks through an object and no node may sit inside one (section 14). |
| `geo` | object | none | Scale and path clearance for a floor plan (section 14). |
| `doors` | array, ≤ 500 | none | Doorway segments where foot traffic is counted (section 14). |
| `provenance` | object, ≤ 300 keys | none | Where each number came from: `data`, `vision`, `assumed` or `owner-reported` (section 14). |
| `offers` | array, ≤ 50 | none | Targeted offers: a message, and optionally a discount at one place, for some kinds of people (section 15). |

## 3. Arrivals

| Field | Type and range | Default | Meaning |
|---|---|---|---|
| `arrivals.total` | integer, 10–5000 | 800 | Number of agents over the whole run. This drives cost. |
| `arrivals.start` | minutes, 0 to `duration − 1` | 0 | First arrival, in minutes after `clockStart`. |
| `arrivals.end` | minutes, `start + 1` to `duration` | 0.6 × `duration` | Last arrival. |
| `arrivals.shape` | `uniform`, `peak`, `early`, `late`, `poisson` | `peak` | `uniform`: flat. `peak`: triangular, busiest halfway between start and end (a lunch or commute peak). `early`: front-loaded (park opening). `late`: back-loaded. `poisson`: constant-rate random gaps (queueing tests). |

Size the arrival rate against capacity. Peak rate for `peak` ≈ 2 × total ÷ (end − start) per minute. A place is overloaded when its arrival rate exceeds `servers ÷ serviceTime` per minute; a link is overloaded when its flow exceeds `capacity` (section 5).

## 4. Nodes

Common fields:

| Field | Type and range | Default | Meaning |
|---|---|---|---|
| `id` | string | slug of `name` | Lowercase letters, digits and `_`, ≤ 40 chars; other characters become `_`. Duplicates get a suffix. Every reference elsewhere uses this id. |
| `name` | string, ≤ 40 | the id | Shown to agents and in reports. |
| `kind` | visit: `gate`, `entry`, `exit`, `service`; route: `origin`, `destination`, `intersection` | `service` (visit), `intersection` (route) | See below. |
| `x`, `y` | number, 3–97 | 50 | Position on the 100 × 100 map (x right, y down). In visit mode positions set walking times, what agents can see, and what counts as nearby (section 8). In route mode they are only for drawing and for the default edge length. |

**Visit mode kinds.** `gate` is an entrance and an exit. `entry` is entrance only, `exit` is exit only. `service` is a place with a line. At least one `service` is required. With no `gate` or `entry`, a default `"Entrance"` gate is added at (50, 95). People who leave walk to the nearest `gate` or `exit` by walking distance (around walls, section 14), or to the nearest of their group's own `exits` when the archetype lists some (section 6); with none they disappear when done.

| Field (visit) | Applies to | Type and range | Default | Meaning |
|---|---|---|---|---|
| `weight` | `gate`, `entry` | number ≥ 0.01 | 1 | Relative share of arrivals that enter here. |
| `servers` | `service` | integer, 1–1000 | 10 | People served at the same time: desks, beds, cooks, ride seats, tables' seats. |
| `serviceTime` | `service` | minutes, 0.2–720 | 5 | Average minutes per person per server. Capacity per hour = `servers` ÷ `serviceTime` × 60. |
| `serviceDist` | `service` | `uniform`, `exp`, `fixed` | `uniform` | Spread of service times: uniform 0.6–1.4 × `serviceTime`; exponential with mean `serviceTime`; or exactly `serviceTime`. |
| `seats` | `service` | up to 64 points `{ x, y }`, 0–100 | none | Where the people being served are drawn, one person per seat: a person takes the first free seat when their service starts and keeps it until they finish. Display only: the walk still ends at the place, and lines form there. Give one seat per server. With more servers than seats, the people left over are drawn around the place. With walls, a seat that has a wall or object between it and the place is ignored with a warning. |
| `appeal` | `service` | 0–1 | 0.5 | Popularity and reputation as a number. Used by the rules policy (section 8). |
| `price` | `service` | dollars, ≥ 0 | 0 | What it costs one person. Agents see "free" or "about $N". |
| `tags` | `service` | up to 12 lowercase strings | `[]` | What the place offers (`"pediatric"`, `"coffee"`, `"thrill"`). Matched against archetype `needs` and `likes`; shown to agents as "offers". |
| `about` | `service` | string, ≤ 160 | `""` | **The reputation agents read**, in plain words: what it is known for, rumors, quirks. Example: `"Level 1 trauma center; best reputation in the region; famous for long ER waits"`. |

**Route mode kinds.** `origin` is where trips start, `destination` where they end, `intersection` any junction in between (a road junction, a lobby, a landing, a turnstile line). At least one `origin` and one `destination` are required. Service fields are ignored.

## 5. Edges (route mode)

| Field | Type and range | Default | Meaning |
|---|---|---|---|
| `from`, `to` | node id (or exact name) | required | Ends of the link. An unknown reference is an error; a link from a node to itself is dropped. |
| `name` | string, ≤ 40 | `"<from name> – <to name>"` | Shown to agents ("via I-9 → Liberty Bridge") and in reports. |
| `length` | minutes, 0.2–180 | half the map distance between the ends (half the `via` polyline length when it has waypoints) | **Free-flow travel time** in minutes with nobody else on it. |
| `via` | up to 12 `{ x, y }` points, 0–100 | none (a straight line) | Waypoints that shape the link: it runs from → via… → to. In a world with `walls`, no link may touch a wall, so route it through doorways with waypoints (section 14). |
| `capacity` | integer, 1–10000 | 100 | How much load the link takes before it slows; meaning depends on `costModel`. |
| `twoWay` | boolean | `true` | `false` for one-direction links (one-way streets, up-only morning elevators, entry turnstiles). |
| `costModel` | `bpr` or `linear` | `bpr` | How travel time grows with load. |

Travel time is fixed when an agent enters the link, from the load (agents currently on that link in that direction) at that moment:

- **`bpr`** (roads, corridors, stairwells): time = `length` × (1 + 0.15 × r⁴), with r = min(3, load ÷ `capacity`). `capacity` is the number of people or vehicles on the link at once before it slows noticeably: +15% at r = 1, about 3.4× at r = 2, 13× at r = 3. Road example: a 2-lane arterial segment might be 60–120, a freeway segment 300–500, a residential street 20–40.
- **`linear`** (doors, turnstiles, escalators, elevators, ticket gates, toll booths): time = `length` + load ÷ `capacity`. Here `capacity` is **throughput in people per minute** and load ÷ `capacity` is the queue wait. Set `length` to the minutes to pass through when nobody is waiting (an elevator: average ride plus a typical wait for a car).

Avoid two edges with the same `from` and `to`: links are identified as `from>to`. Add an intermediate node instead.

**Buildings and pedestrian flows.** Nodes are spaces (street door, lobby, turnstile line, elevator hall, stair landing, floor zones); origins are entrances; destinations are floors or zones. Typical values:

| Element | `costModel` | `capacity` | `length` |
|---|---|---|---|
| Revolving door | linear | 20–30 people/min per door | 0.2–0.3 |
| Swing door, 1 m | linear | 30–40 people/min | 0.1–0.2 |
| Badge turnstile | linear | 10–20 people/min per gate | 0.1–0.2 |
| Escalator | linear | 40–70 people/min | 0.5–1 |
| Elevator bank | linear | cars × car size ÷ round trip minutes (4 × 16 ÷ 3 ≈ 21) | ride + typical wait, 1.5–3 |
| Corridor or lobby side | bpr | people on it at once before it feels crowded, 30–100 | walking minutes |
| Stairwell | bpr | 30–50 | climb minutes, ~0.3–0.5 per floor |

These are rough planning numbers; mark them as assumptions in your findings.

## 6. Archetypes

2–4 archetypes usually suffice: groups that differ in what they need, how patient they are, and what information they have.

| Field | Mode | Type and range | Default | Meaning |
|---|---|---|---|---|
| `id` | both | string | slug of `name` | Referenced by the cast. |
| `name` | both | string, ≤ 40 | `"Group N"` | Shown to agents as their group. |
| `description` | both | string, ≤ 200 | `""` | One line about the group. |
| `share` | both | number > 0 | 1 | Relative share of arrivals; shares are normalized to sum to 1. |
| `info` | both | 0–1 | 0.5 | Chance that an agent of this group has live information: a wait-time app (visit) or live traffic (route). Informed agents see every line or current travel time; others see only nearby lines or usual times. |
| `rationality` | both | 0.05–10 | 2.5 visit, 0.8 route | Sharpness of the **rules policy** (used for the rules provider and API-outage fallback, and for link-by-link moves in route mode): higher means more consistently picking the best option. Jev decisions do not use it. |
| `weights` | visit | object of numbers 0–5: `appeal`, `wait`, `distance`, `price` | 1, 1, 1, 0.5 | Rules-policy utility weights (section 8). |
| `visits` | visit | integer, 1–30 | 3 | Most places a person is served at before leaving. ER: 1. Theme park: 4–8. Food hall: 2–3. |
| `patience` | visit | minutes, 1–1440 | 45 | Minutes of waiting in one line this group puts up with (section 8). |
| `likes` | visit | up to 12 tags | `[]` | Soft preference: places with these tags are more attractive. |
| `needs` | visit | up to 12 tags | `[]` | Hard filter: only places with at least one of these tags are options. Empty means every place is an option. |
| `entries` | visit | gate or entry node ids (or exact names) | every gate and entry, by `weight` | Where this group appears, e.g. office workers start at their own suite's gate while visitors come in from the street. A persona's own `entry` still wins about half the time. An unknown or wrong-kind reference is a warning and is ignored. |
| `exits` | visit | gate or exit node ids (or exact names) | every gate and exit (`[]` means the same) | Where this group leaves: when a person is done, they walk to the nearest of these by walking distance. Use it so people leave the way they would really go, e.g. lunch customers out to the street, never up the office stairs, which would miscount door traffic. If walls leave none of the group's exits reachable from where the person stands, they take the nearest reachable gate or exit of any kind. An unknown or wrong-kind reference is a warning and is ignored. |
| `origins` | route | origin node ids | all origins | Where this group's trips start. |
| `destinations` | route | destination node ids | all destinations | Where this group's trips end (one is picked at random per agent). |

## 7. The cast (`minds`)

The cast is the heart of a world. Each agent is assigned one persona: first a group by `share`, then a persona within that group by persona `weight`. Each agent keeps its own state (where it is, how long it has waited, what it has heard), so a persona is a type of person, not a single individual. **Every archetype needs at least one persona**; a group with none gets no agents.

| Field | Mode | Type and range | Default | Meaning |
|---|---|---|---|---|
| `id` | both | string | slug of `name` | Unique. |
| `name` | both | string, ≤ 40 | `"Person N"` | A realistic, invented full name. Never a real person. |
| `age` | both | integer 0–110, or `null` | `null` | |
| `archetype` | both | archetype id or name | round-robin over archetypes | The persona's group. |
| `bio` | both | string, ≤ 240 | `""` | Their situation right now: why they are here, what is at stake. Shown to agents as "about". |
| `personality` | both | string, ≤ 160 | `""` | A few traits that change choices. |
| `goal` | both | string, ≤ 160 | `""` | What they want from this visit or trip. Shown as "wants". |
| `social` | both | string, ≤ 160 | `""` | Who they listen to. Shown as "listens_to". |
| `informed` | both | boolean | `true` if the archetype's `info` ≥ 0.5 | Whether this person is written as having the app or live traffic. Keep it consistent with the archetype's `info`. |
| `weight` | both | 0.05–20 | 1 | Relative frequency within the archetype. Use 2–3 for the most common kind of person. |
| `entry` | visit | gate or entry id | none | Where this persona usually comes in (about half the time). |
| `origin`, `destination` | route | origin / destination id | none | Fixes this persona's trip. |

**How to write a good cast (10–20 people):**

1. **Cover every archetype**, roughly in proportion to `share`, and give each group 2–6 people who differ from each other.
2. **Concrete situation, not a type.** "Diabetic with an infected foot wound; must be at her night shift by 11 pm", not "moderate patient". Put stakes and deadlines in `bio` or `goal`.
3. **Constraints** that rule options in or out: money or insurance, kids along, mobility, dietary rules, a meeting at 9:00, a box to carry.
4. **Loyalties and grudges toward named places**: "St. Brigid's treated him last year", "his wife once waited nine hours at Larkfield General". Use the exact `name` of nodes or edges so agents connect them.
5. **Who they listen to** in `social`: a spouse who insists, a group chat, a nurse friend, the radio, the app, the crowd, nobody. Agents actually hear structured remarks from their own group, from people nearby, and (with the app) from reviews; `social` tells Jev how much weight this person gives them.
6. **App or no app** (`informed`): mix both in each group. Habit-driven and skeptical people are the ones who create herding and surprises.
7. **Include contrarians** (always takes the stairs, never trusts apps) and **followers** (goes wherever friends go).
8. Write short, plain phrases. No numbers the person could not know, no instructions to the model, no stereotypes.

## 8. How the fields drive decisions

Agents decide through Jev at decision moments. The engine computes the facts and turns them into words: waits, distances, prices and patience appear as phrases like "long, about 45 min" and "more than they will put up with" (the patience phrase is left out when the world sets `waiting.tellPatience: false`). Jev sees the person (cast fields, group name, app or not), `context`, the time, their history so far, the valid options, up to 4 recent remarks they heard, and up to 3 offers they received (section 15). It never sees `appeal`, `weights` or `rationality`; those drive only the rules policy.

**Visit mode moments:**
- **Choose** (arrive, finish somewhere, walk away from a line, give up): which place next, or leave. Options are places not yet visited whose `tags` match the archetype's `needs`, each with its `about`, `tags` ("offers"), price, distance and line (if visible).
- **Line**: on reaching a place whose estimated wait is over 8 minutes and over half their tolerance, do they join? (Shorter waits are joined without asking.)
- **Long wait**: after waiting longer than their tolerance and over 10 minutes, do they keep waiting? Once per line, or again every `waiting.askAgainEvery` minutes when the world sets it (then nobody is made to leave).
- After an experience, Jev also rates frustration (calm to furious) and decides whether they warn or praise the place to others.

**Patience.** Tolerance = archetype `patience` × a frustration factor (1 when calm, down to 0.6 when furious). The estimated wait is (people in line + 1) × `serviceTime` ÷ `servers` when every server is busy, and 0 otherwise. Choose patience as "the wait at which most of this group starts thinking about leaving": ER critical 300–600, moderate 120–180, minor 60–90; theme park families 30–45; lunch-break workers 10–15. The rules policy walks away at about 0.8–1.2 × tolerance and gives up in line at about 1.3 × tolerance.

**What agents can see.** With the app (`info` / `informed`) they see every line. Without it they see the line at the place they are at and at places within 30 map units. Distances read as "right here" (< 3 units), "close" (< 15), "a short walk" (< 35) or "far".

**Remarks.** When an agent warns or praises a place, a structured remark (long line, bad experience, good and quick; or heavy traffic, clear) is posted. Later agents hear remarks from the last 90 minutes from their own group ("group chat"), about places within 30 units ("overheard nearby"), or, with the app, all of them ("app reviews"). Route remarks from the last 30 minutes reach everyone ("traffic radio"). Frustration lowers patience, so bad experiences spread.

**Tags, needs and likes.** `needs` is the hard rule: an ER patient with `needs: ["general", "trauma"]` never sees an urgent care tagged only `minor`. Every archetype with `needs` must match at least one service, or it can go nowhere. `likes` is a soft pull in the rules policy, and the tags show up in what agents read.

**Appeal and price (rules policy).** Each candidate place gets utility `weights.appeal × appeal × (1 + 0.6 × liked tags) − weights.wait × wait ÷ 20 − weights.distance × distance ÷ 40 − weights.price × price ÷ 20`, where wait counts only for informed agents and price is what this person would pay after any offer (section 15). The choice is a softmax with sharpness `rationality`. Set `appeal` to match the `about` text so both policies agree.

**Route mode moments.** At trip start, when there are 2 or more sensible routes (up to 3 distinct paths whose free-flow time is within 1.6 × the best + 2 minutes), Jev picks one. Each route shows its usual time and, for informed agents, the current time. At trip end, if the trip took over 1.25 × free-flow, Jev rates frustration and whether they talk about the worst stretch. Between those moments agents follow their route.

## 9. Validation, ids and references

`swarm validate` returns `ok`, `errors` and `warnings`. **Errors** (the world does not run):
- not a JSON object;
- visit mode without any `service` node;
- route mode without edges, without an `origin`, or without a `destination`;
- an edge `from`/`to`, archetype `origins`/`destinations`, or cast `entry`/`origin`/`destination` that names a node that does not exist;
- with `walls` (section 14): more than 4000 walls, a node closer than 0.05 to a wall, a route link that touches a wall, or a visit place that cannot be reached on foot from any gate or entry or cannot reach any gate or exit.

**Warnings** (it runs, but something was changed or looks wrong): a value clamped to its range, an unknown field, a missing cast, a service node no archetype's `needs` can reach, a dropped or clamped wall, a dropped door, a door that touches a wall or is not in a gap between walls, an archetype `entries` or `exits` reference that names nothing usable (an unknown node, or a node of the wrong kind), and an offer reference that names nothing usable (an unknown group or cast member, which is dropped; an offer whose whole audience is unknown, which is dropped; or a `place` that is not a service, which becomes no place). Each message names the field path, e.g. `nodes[3].servers: 0 is below the minimum 1; using 1`. Fix warnings unless you meant them.

Reference nodes and archetypes by `id`. Give every node and archetype an explicit `id` so references never depend on slugging.

## 10. What-if patches

`swarm compare <world> --patch patch.json` reruns the same seeds with changes applied. A patch is a JSON array of operations:

```json
[
  { "kind": "node", "id": "thunder", "field": "servers", "value": 16 },
  { "kind": "edge", "id": "elm>pine", "field": "closed", "value": 1 },
  { "kind": "archetype", "id": "minor", "field": "info", "value": 0.9 },
  { "kind": "global", "field": "arrivals.end", "value": 150 },
  { "kind": "offer", "offer": { "id": "eastgate_half", "text": "Eastgate Urgent Care: seen in 20 minutes, half the ER price", "to": { "groups": ["minor"] }, "place": "eastgate", "priceOff": 0.5 } }
]
```

| `kind` | `id` | Patchable `field`s |
|---|---|---|
| `node` | node id or name | `servers`, `serviceTime`, `appeal`, `price`; `weight` on visit gates and entries (shifts how many people use each entrance) |
| `edge` | `"from>to"` (either direction) or edge name | `capacity`, `length`, `closed` (value 1 removes the edge) |
| `archetype` | archetype id or name | `info`, `patience`, `rationality`, `visits`, `share` |
| `global` | none | `arrivals.total`, `arrivals.start`, `arrivals.end`, `travelSpeed` |
| `offer` | none | not a field op: `{ "kind": "offer", "offer": { … } }` adds one offer with the fields of section 15 (`id`, `text`, `to`, `place`, `priceOff`, `from`, `until`) |

For field ops, `value` must be a number. Anything else is skipped and reported. An offer op is reported as applied, e.g. `Offer eastgate_half · 50% off at Eastgate Urgent Care · to Minor injury` (in `er-network`); it is skipped when the offer would be dropped (no text and no discount to describe, or nobody it names exists) or the world already has 50 offers. An offer op whose `id` is already used gets a suffix. Good patches are cheap, concrete levers: one more server at the top bottleneck, a wait-time screen (raise `info`), staggered arrivals (`arrivals.end`), a closed shortcut, or a message or deal for the kind of person who has the worst time or spends the most (an `offer`).

## 11. Size and cost

Every decision moment is one Jev request (identical requests are cached). Rough counts: visit mode about 1 + `visits` choices per agent plus line and long-wait questions; route mode at most 2 per agent. A request is about 900 input tokens. At TypeSafe's published $0.042 per million input tokens (unverified), 10,000 requests cost about $0.38. Run `node bin/swarm.js estimate <world>` before a Jev run; keep `arrivals.total` at the smallest size that shows the effect (often 500–3000).

## 12. Examples

These are deliberately small. A real world should have a 10–20 person cast.

**Visit mode: airport security at dawn.** `needs` keeps standard travelers out of the PreCheck lane.

```json
{
  "title": "Terminal B security at dawn",
  "question": "Which checkpoint lane loses the most travelers to long waits before the 7 am departures?",
  "context": "Weekday 5 am at Terminal B. Travelers with early flights pick a security lane.",
  "leaveLabel": "Give up and rebook a later flight",
  "mode": "visit",
  "duration": 180,
  "clockStart": 270,
  "travelSpeed": 20,
  "arrivals": { "total": 900, "start": 0, "end": 140, "shape": "peak" },
  "nodes": [
    { "id": "curb", "name": "Departures curb", "kind": "gate", "x": 50, "y": 95 },
    { "id": "main", "name": "Main checkpoint", "kind": "service", "x": 30, "y": 30, "servers": 4, "serviceTime": 0.9, "appeal": 0.6, "tags": ["standard"], "about": "Four lanes; the line often wraps past the check-in desks" },
    { "id": "north", "name": "North checkpoint", "kind": "service", "x": 80, "y": 20, "servers": 2, "serviceTime": 0.9, "appeal": 0.4, "tags": ["standard"], "about": "Two lanes at the far end; usually quieter but a long walk" },
    { "id": "precheck", "name": "PreCheck lane", "kind": "service", "x": 45, "y": 25, "servers": 2, "serviceTime": 0.5, "appeal": 0.9, "tags": ["precheck"], "about": "Shoes on, laptops in; members only" }
  ],
  "archetypes": [
    { "id": "standard", "name": "Standard travelers", "share": 0.75, "visits": 1, "patience": 35, "info": 0.4, "needs": ["standard"] },
    { "id": "member", "name": "PreCheck members", "share": 0.25, "visits": 1, "patience": 15, "info": 0.8, "needs": ["precheck", "standard"], "likes": ["precheck"] }
  ],
  "minds": [
    { "id": "ines", "name": "Inés Romero", "age": 34, "archetype": "standard", "bio": "Flying to a job interview at 6:50; checked a bag and is already nervous.", "personality": "anxious, rule-following", "goal": "Through security with time to spare", "social": "follows the airport's wait-time signs", "informed": false },
    { "id": "walt", "name": "Walt Becker", "age": 61, "archetype": "standard", "bio": "Retired, flying to see his grandkids; has never heard of the north checkpoint.", "personality": "patient, chatty", "goal": "Get to the gate eventually", "social": "asks whichever employee is nearby", "informed": false },
    { "id": "sana", "name": "Sana Qureshi", "age": 42, "archetype": "member", "bio": "Consultant who flies every Monday and knows every lane.", "personality": "efficient, impatient", "goal": "Gate in under ten minutes", "social": "trusts her airline app", "informed": true }
  ]
}
```

**Route mode: leaving a stadium.** Gates are `linear` (people per minute); concourses and ramps are `bpr`.

```json
{
  "title": "Exiting Riverside Stadium",
  "question": "After the final whistle, which gate or ramp holds people up the most on the way to the train and the parking lots?",
  "context": "Sunday 4 pm. The game just ended and fans head for the train station and the parking lots.",
  "mode": "route",
  "duration": 90,
  "clockStart": 960,
  "arrivals": { "total": 3000, "start": 0, "end": 30, "shape": "early" },
  "nodes": [
    { "id": "seats_n", "name": "North stands", "kind": "origin", "x": 30, "y": 10 },
    { "id": "seats_s", "name": "South stands", "kind": "origin", "x": 30, "y": 90 },
    { "id": "concourse", "name": "Main concourse", "kind": "intersection", "x": 45, "y": 50 },
    { "id": "plaza", "name": "East plaza", "kind": "intersection", "x": 70, "y": 50 },
    { "id": "train", "name": "Stadium train station", "kind": "destination", "x": 95, "y": 30 },
    { "id": "lots", "name": "Parking lots", "kind": "destination", "x": 95, "y": 80 }
  ],
  "edges": [
    { "from": "seats_n", "to": "concourse", "name": "North stairs", "length": 2, "capacity": 400 },
    { "from": "seats_s", "to": "concourse", "name": "South stairs", "length": 2, "capacity": 400 },
    { "from": "concourse", "to": "plaza", "name": "Gate C turnstiles", "length": 0.5, "capacity": 90, "costModel": "linear", "twoWay": false },
    { "from": "seats_s", "to": "lots", "name": "South ramp", "length": 6, "capacity": 300 },
    { "from": "plaza", "to": "train", "name": "Station walkway", "length": 4, "capacity": 500 },
    { "from": "plaza", "to": "lots", "name": "Plaza crosswalk", "length": 3, "capacity": 150 }
  ],
  "archetypes": [
    { "id": "transit", "name": "Train riders", "share": 0.6, "info": 0.5, "destinations": ["train"] },
    { "id": "drivers", "name": "Drivers", "share": 0.4, "info": 0.3, "destinations": ["lots"] }
  ],
  "minds": [
    { "id": "keisha", "name": "Keisha Brown", "age": 29, "archetype": "transit", "origin": "seats_n", "bio": "Season-ticket holder racing to catch the 4:20 express home.", "personality": "fast, knows every shortcut", "goal": "Make the 4:20 train", "social": "her section's group chat", "informed": true },
    { "id": "tony", "name": "Tony Russo", "age": 52, "archetype": "drivers", "origin": "seats_s", "bio": "Parked in Lot D with two kids and a cooler.", "personality": "patient, avoids crowds", "goal": "Get the kids to the car without losing anyone", "social": "listens to the stadium announcer", "informed": false }
  ]
}
```

Full examples: [theme-park](theme-park.json) and [er-network](er-network.json) (visit), [food-hall-lunch](food-hall-lunch.json) (visit with seating as a place), [sushi-restaurant](sushi-restaurant.json) (visit, one walled room where each person being served sits in a drawn seat), [rush-hour-roads](rush-hour-roads.json) (route, roads), [office-lobby-morning](office-lobby-morning.json) (route, a building: doors, turnstiles, elevators and stairs as links).

## 13. Checklist

- [ ] The question asks for a ranking, and the places or links that could answer it are all in the world.
- [ ] `context` tells agents the day, time and situation in one or two sentences.
- [ ] Capacities (`servers` ÷ `serviceTime`, or link `capacity`) are realistic and peak demand is near or above them somewhere.
- [ ] `arrivals` match the real rhythm (a peak, an opening rush) and leave time to finish before `duration`.
- [ ] Each service has an `about` reputation agents can react to, consistent with its `appeal`.
- [ ] Every archetype has a persona, and every `needs` list matches at least one service.
- [ ] 10–20 cast members with situations, constraints, loyalties, `social` and a mix of `informed`.
- [ ] `swarm validate` shows no errors, and you understand every warning.
- [ ] With `walls`: every place sits inside a room, every gate sits in or just outside an exterior doorway, and `swarm validate` reports no wall errors.

## 14. Buildings: walls, doors and floor plans

A world can carry the walls of a real floor plan, and then **nobody walks through a wall**. In visit mode people walk the shortest wall-free path, and its length sets walking time, the distance words agents read, and what counts as nearby. A place that no path reaches is never offered. In route mode each link follows its `via` polyline. The builders (`swarm import-matterport`, `swarm building`, `swarm fitout`) write these fields from Matterport and CoStar data; you can also draw them by hand.

Everything is in map units on the same 100 × 100 map as the nodes. Walls, doors and waypoints may use the full 0–100 range; nodes stay within 3–97.

**`walls`**: up to 4000 segments, each `{ "x1", "y1", "x2", "y2" }` or the short form `[x1, y1, x2, y2]`, with an optional `source` of `"matterport-vector"`, `"mesh-slice"` or `"drawn"`.
- A doorway is a gap: give the wall as the pieces on either side of it.
- Touching counts as crossing, so a path may not even graze a wall end.
- Out-of-range coordinates are clamped and zero-length walls are dropped, each with a warning. More than 4000 walls is an error.

**`objects`**: up to 400 solid things inside the building, each `{ "id", "name", "kind", "source", "polygon" }`, with optional `areaM2`, `sizeM` and `about`.
- `polygon` is the outline, 3 to 64 points as `[x, y]` or `{ "x", "y" }`; it closes by itself.
- The engine adds every outline edge to the walls, so the same rules apply: nobody walks through an object, and walls plus outline edges may not exceed 4000.
- A node inside an object is an error that names the object. Keep places at least 0.3 m from objects so people can stand at them.
- `swarm fitout --mesh <file.obj | auto>` fills this from the Matterport mesh (stairs, fixtures, counters, stacked material between 0.3 m and 1.5 m above the floor). The mesh does not say what each object is, so they are named by size; rename them when you know.

**`geo`**: scale and clearance of the plan.

| Field | Type and range | Default | Meaning |
|---|---|---|---|
| `metersPerUnit` | number, 0.001–10000 | `null` | Real size of one map unit. Informational: set `travelSpeed` to walking speed (about 75–80 m/min) ÷ `metersPerUnit`; the engine accepts up to 600. |
| `clearance` | map units, 0.02–1 | 0.2 | How far walking paths stay from wall ends. Keep it at most a quarter of the narrowest door. |
| `floor` | number, or a label ≤ 40 chars | `null` | Which floor the plan shows. |
| `source` | string, ≤ 80 | `""` | Where the plan came from, e.g. `"matterport-vector"`. |

**`doors`**: up to 500 doorway segments. Doors are not walls: people walk through them. In visit mode, each time a walking path crosses a door's gap, that door gets one crossing (a door end that stops just short of a wall, within 0.3 units or the clearance, counts as reaching it). The busiest doors are ranked in the report and the viewer.

| Field | Type and range | Default | Meaning |
|---|---|---|---|
| `id` | string | slug of `name` | Unique; duplicates get a suffix. |
| `name` | string, ≤ 40 | the id | Shown in "Busiest doorways", e.g. `"Lobby to Suite 110"`. |
| `x1`, `y1`, `x2`, `y2` | numbers, 0–100 | required | The doorway's gap, from one jamb to the other. A door missing a coordinate, or of zero length, is dropped with a warning. |
| `exterior` | boolean | `false` | `true` for a door to the outside. |

A door should sit exactly in a gap between walls. A door that touches a wall away from its ends, or has no wall within 0.5 units of either end, gets a warning.

**`provenance`**: an object (up to 300 keys) that maps a field path such as `"nodes[3].servers"`, `"walls"` or `"arrivals.total"` to where the value came from:
- `"data"`: read from Matterport, CoStar or another record;
- `"vision"`;
- `"assumed"`;
- `"owner-reported"`.

The engine keeps it as-is. Any other value gets one warning. Reports use it to say which numbers are assumptions.

Archetypes can also say where each group appears with `entries` and which doors it leaves by with `exits` (section 6), and route links take `via` waypoints (section 5). Leaving always takes the nearest allowed exit on foot, so door traffic counts the walk people really make.

**Rules.** These are errors, and the world does not run:
- Every node is at least 0.05 units from every wall. Put each place inside its room, and each gate in or just outside an exterior doorway.
- Route mode: no link touches a wall. A link is checked as the polyline from → `via`… → to, and the message names the link and the wall.
- Visit mode: every service can be reached on foot from at least one gate or entry, and can reach at least one gate or exit. A world with no gate or exit at all skips the exit check, because people simply vanish when done.

Messages name walls by their position in your `walls` list. In a world with walls, cleaned and recorded specs keep node positions exact (no rounding to 0.1), so a place never shifts onto a wall.

**Example: two rooms and a street door.** The rooms share a wall with a doorway in it, the street door is a gap in the bottom wall, and the gate stands just outside that door.

```json
{
  "title": "Two-room street-front floor",
  "question": "Which room backs up at lunch, and how busy is the inner doorway?",
  "context": "Weekday lunch on the ground floor of a small office and retail building.",
  "mode": "visit",
  "duration": 120,
  "clockStart": 690,
  "travelSpeed": 53,
  "arrivals": { "total": 200, "start": 0, "end": 75, "shape": "peak" },
  "nodes": [
    { "id": "street", "name": "Street door", "kind": "gate", "x": 25, "y": 88 },
    { "id": "cafe", "name": "Corner Cafe", "kind": "service", "x": 30, "y": 50, "servers": 2, "serviceTime": 3, "appeal": 0.6, "price": 9, "tags": ["food", "public"], "about": "Sandwich counter in the front room; the line reaches the door at noon" },
    { "id": "clinic", "name": "Walk-in Clinic", "kind": "service", "x": 70, "y": 50, "servers": 1, "serviceTime": 12, "appeal": 0.5, "price": 40, "tags": ["care", "public"], "about": "Small clinic in the back room, through the inner doorway" }
  ],
  "walls": [
    [10, 20, 90, 20], [10, 20, 10, 80], [90, 20, 90, 80],
    [10, 80, 20, 80], [30, 80, 90, 80],
    [50, 20, 50, 45], [50, 55, 50, 80]
  ],
  "geo": { "metersPerUnit": 1.5, "clearance": 0.2, "floor": 1, "source": "drawn" },
  "doors": [
    { "id": "front", "name": "Street door", "x1": 20, "y1": 80, "x2": 30, "y2": 80, "exterior": true },
    { "id": "inner", "name": "Cafe to clinic", "x1": 50, "y1": 45, "x2": 50, "y2": 55 }
  ],
  "provenance": { "walls": "data", "nodes[1].servers": "assumed", "nodes[2].servers": "assumed", "arrivals.total": "assumed" },
  "archetypes": [
    { "id": "lunch", "name": "Lunch crowd", "share": 0.8, "visits": 1, "patience": 12, "info": 0.3, "needs": ["food"], "entries": ["street"] },
    { "id": "patients", "name": "Clinic patients", "share": 0.2, "visits": 1, "patience": 45, "info": 0.5, "needs": ["care"] }
  ],
  "minds": [
    { "id": "dana", "name": "Dana Okafor", "age": 31, "archetype": "lunch", "bio": "Works upstairs and has 30 minutes for lunch.", "personality": "hurried", "goal": "Eat before a 1 pm call", "social": "her team chat", "informed": false },
    { "id": "lee", "name": "Lee Haddad", "age": 67, "archetype": "patients", "bio": "Needs a prescription renewed before the weekend.", "personality": "patient, polite", "goal": "See someone today", "social": "his daughter", "informed": true }
  ]
}
```

## 15. Targeted offers

An **offer** simulates reaching one kind of person with a message or a deal: a text, a flyer, an app notification, a sign at the door. It is information plus an optional price change. It never forces anyone anywhere: people still decide, and a deal only changes the price they weigh.

`offers` is an optional array of up to 50:

| Field | Type and range | Default | Meaning |
|---|---|---|---|
| `id` | string | `offer1`, `offer2`, … | Unique; duplicates get a suffix. |
| `text` | string, ≤ 160 chars | see below | **What the person is told**, in plain words: `"Eastgate Urgent Care: seen in 20 minutes, half the ER price"`. Longer text is cut to 160. When it is missing, an offer with a `place` and a `priceOff` is told `"<N>% off at <place name>"`; any other offer without text is dropped. |
| `to.groups` | archetype ids (or exact names) | `[]` | Groups that receive it. |
| `to.cast` | cast member ids (or exact names) | `[]` | Everyone who copies one of these cast members receives it. |
| `place` | visit service node id (or exact name), or `null` | `null` | The place the offer is about. |
| `priceOff` | 0–1 | 0 | Discount at `place` for the people who receive it: `0.5` is half price. Ignored without a `place`. |
| `from`, `until` | minutes after `clockStart`, 0 to `duration` | 0 and `duration` | The window when it is in effect, ends included. `until` is never before `from`. |

**Who receives it.** A person receives an offer when they are in its audience (their group is in `to.groups` or their cast member is in `to.cast`; a missing or empty `to` means everyone) and the time is inside the window. Unknown ids are warnings and are dropped. An offer whose named audience is entirely unknown is dropped with a warning, so a typo never turns a targeted offer into one for everyone.

**What changes for them.**
- **What they see.** Every decision they make inside the window shows `offers`: up to 3 offer texts in world order. A discounted place's cost reads `"about $15 with the offer (usually about $30)"`. Jev's questions about where to go (`next_place`, `join`, `keep_waiting`, `route`) name `offers` when it is there; without offers the questions are worded exactly as before.
- **What they pay.** The discounted price applies in what they are shown, in the rules policy's utility (section 8) and in what they spend. When several of their offers cover the same place, the largest discount applies; discounts do not stack. People pay the price they were shown when they chose the place, even if the window closes while they walk or wait.
- Nobody else is affected, and the same seed still gives the same people arriving at the same times.

**Route worlds** have no service places, so their offers are messages only (`place` is always `null`): a driver in the audience sees the texts when choosing a route.

**Results.** `metrics().offers` is `[{ id, reached, wentToPlace }]`, in world order (`[]` without offers). `reached` counts distinct people who received the offer at a decision moment (arriving, reaching a place, after being served or walking away, a long wait, a route choice). `wentToPlace` counts those of them who then headed to its place. Compare `reached` and `wentToPlace` before and after with `swarm compare` and an offer patch (section 10).

**Example.** Students get half price at the dearer bakery for the first two hours:

```json
"offers": [
  { "id": "student_half", "text": "Student deal: half price at Maison Crumb this morning",
    "to": { "groups": ["students"] }, "place": "maison_crumb", "priceOff": 0.5, "from": 0, "until": 120 }
]
```

## 16. Results by kind of person: spent, visits and segments

Every run reports outcomes by **kind of simulated person**: a group (archetype), or everyone who copies one cast member. A segment is a kind of simulated person, never a real individual, and reports say so.

**Per agent** (`agents.json`, visit mode): `spent` is the dollars the agent paid in total, the price at each place that served it after any offer (rounded to cents). `visits` is the ids of the places that served it, in order. `visits.length` equals `served`. Route agents have neither.

**`metrics().segments`** is `{ byGroup: [...], byCast: [...] }`: one entry per archetype, in world order, and one per cast member (plus a stand-in for a group without a cast). Counts add up to the number of agents in both lists.

| Visit field | Meaning |
|---|---|
| `id`, `name` | The archetype's or cast member's id and name. |
| `group` | The archetype id the segment belongs to (its own id in `byGroup`). |
| `count` | Agents in the segment. |
| `avgWait` | Minutes in lines per person. |
| `avgSpent` | Dollars spent per person. |
| `avgVisits` | Places served at per person. |
| `walkAwaysPerPerson` | Lines walked away from or given up on, per person. |
| `shareNeverServed` | Share of people served nowhere (0–1). |
| `avgFrustration` | 0 (calm) to 4 (furious), averaged over the people who were asked; `null` when nobody was (the inline rules provider never asks). |
| `topPlaces` | Up to 3 places where the segment was served most: `[{ id, name, visits }]`, busiest first. |

Route entries are `{ id, name, group, count, avgTrip, avgDelay, avgFrustration }`, with trip and delay minutes averaged over the people who arrived. Any average is `null` when nobody in the segment counts toward it (for example a cast member nobody copied in this run).

Use them to answer "who" questions ("which people overspend the most?", "who gives up most often?"), then test a targeted offer for that kind of person (section 15) on the same seeds.
