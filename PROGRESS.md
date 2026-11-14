# Swarmscope: progress

**As of Saturday, Nov 14, 2026, about 2:30 am.** For the plan and every decision, see [SWARMSCOPE_SPEC.md](SWARMSCOPE_SPEC.md) (v0.17). For how the code fits together, see [docs/PROTOTYPE.md](docs/PROTOTYPE.md).

## Where things stand

The simulator works end to end with real Jev decisions. It also runs on the real target building with rules, and an independent check found no one passing through a wall. The Jev run of the real building is next.

- **Target:** Matterport model `6FNMVoyPrL1` ("Office/Retail - 45,726SF"), a two-story building that is currently an empty shell.
- **Scenario:** a proposed fit-out, retail on the ground floor and offices upstairs, on a weekday at lunch and in the morning.
- **This repo is public.** The building's CoStar details (address, tenant history, sales) are deliberately not in it. They are on the build machine under `data/`, which is gitignored. See "Local-only data" below.

## What works (checked by running it)

| Piece | State | Evidence |
|---|---|---|
| Engine: places with lines, or a network of routes | Works | All 5 example worlds run with rules in under 0.3 s each |
| Jev per agent (`jev-latest`) | Works | ER world, 560 people: 1,276 Jev requests, 10 cache hits, 0 fallbacks to rules, 57 s, median 81 ms per request, about $0.05 at TypeSafe's published price (unverified) |
| Jev changes the outcome | Seen once | On the ER world the worst bottleneck is Larkfield General with rules and St. Brigid's Regional with Jev. One seed only. |
| Record and replay | Works | The recorded Jev run replays with identical results and zero API calls |
| Walls | Works | People walk the shortest path that touches no wall; a place with no path is never offered as an option; the run stops with an error rather than record a move through a wall |
| Matterport import | Works on the real model | 2 floors, 334 wall edges, 23 openings. Floor 1 becomes 134 wall segments and 10 doors (5 exterior); Floor 2 becomes 80 wall segments and 7 doors |
| Door traffic | Works | Every doorway counts crossings, with a peak per 5 minutes |
| Viewer | Works with rules runs | Map, time scrubber, rankings, per-person decision view, walls and doors. Checked through its API and in headless Chrome, not yet by eye on the real building |
| CoStar kit | Fully read | Digests of every guide and schema, a profile of all eight datasets, a dossier on the building and a study of its surroundings (all local-only) |
| Real building, rules run | Works | Built from the Matterport walls and the fit-out file with `swarm fitout`; validates with 0 errors and 0 warnings |
| No walking through walls | Confirmed independently | A separate checker with its own geometry code replayed the run at fine time steps: 1,032,558 consecutive positions against the 134 real walls, 0 crossings, and nobody inside the sealed room |
| Tests | 498 of 498 pass | `npm test`, 23 test files |

Also built: a world compiler for plain-English descriptions (`swarm compile`, needs an Anthropic key), a `/swarm` command for Claude Code, and an MCP server (`mcp/server.js`).

## What we learned about the building

- **It is an empty shell.** The scan photos show bare floors, columns and unfinished drywall. CoStar's record agrees: it lists no current tenant.
- **Floor 1 is two separate units**, about 5,250 SF (north) and 6,400 SF (south) by Matterport's room estimates. Each has its own doors on the east side. Nothing connects them inside, so walking between them means going outside along the storefront.
- **Two staircases** join the floors. CoStar records no escalator.
- **The stated size does not match the scan.** Two scanned floors come to roughly 24,000 to 27,000 SF. CoStar's 45,726 SF probably counts a basement and other space. The simulation uses Matterport's measured areas.
- **Mostly reached on foot.** It has little parking for its size.
- **The CoStar kit has no foot-traffic data** of any kind: no pedestrian counts, no traffic counts, no opening hours. Crowd size is therefore an assumption, bounded by how many workers and residents the kit records nearby.

## The fit-out being simulated (Floor 1, weekday lunch)

File: [buildings/6FNMVoyPrL1/fitout-floor1-lunch.json](buildings/6FNMVoyPrL1/fitout-floor1-lunch.json). Every place in it is a proposal, tagged `assumed`. Only the walls, doors and stair positions are measured.

- **North unit:** a food hall with four counters, a coffee bar and shared tables.
- **South unit:** a small market with a deli, a bakery, an optical counter and a parcel desk.
- **People:** four groups (office workers from upstairs, the neighborhood lunch crowd, market shoppers, couriers) and a cast of 14 named people.
- **Placement check:** all 20 gates and places are at least 0.9 m from a real wall and reachable on foot.

### Rules runs so far (seed 7)

| | Draft numbers | CoStar-based numbers (current file) |
|---|---|---|
| People arriving | 460 | 312 |
| Visits completed | 756 | 593 |
| Times someone walked away from a line | 1,261 | 274 |
| Average wait | 6.3 min | 5.8 min |
| Worst bottlenecks | Noodle bar, taquería, pizza | Noodle bar, taquería, deli |
| Busiest doorways | Food hall south door 481, market main entrance 430 | Market main entrance 225, food hall south door 220, food hall north door 209 |

- The draft sent 154 office workers downstairs and staffed each counter for only 25 to 30 orders an hour, so its lines were not believable.
- These are rules runs. The Jev run is next, and Jev changed the ranking on the ER example.
- Known gap: nothing yet makes people buy food before sitting at the tables.

### What the CoStar data changed

| Input | Draft | CoStar-based (applied) |
|---|---|---|
| People arriving over lunch | 460 | 312 (low case 153, busy day 503) |
| Office workers coming downstairs | 154 | about 29, from about 51 people upstairs |
| Mix: office / lunch crowd / shoppers / couriers | 30 / 40 / 22 / 8 % | 9 / 45 / 38 / 8 % |
| Office space per worker | 200 SF (guess) | 240 SF (median of about 1,800 current Los Angeles office tenancies in the kit) |
| Pharmacy counter | included | swapped for an optical counter: no pharmacy appears nearby in the kit, and an optometrist is in the building's own history |
| Counter speeds | 25 to 30 orders an hour each | 30 to 60 orders an hour each (an assumption, not from CoStar) |

The shares of nearby workers and residents who show up are still assumptions. The reasoning for each number is in the fit-out file's `assumptions` list.

## Still running

- **Stress test of the pathfinding.** Thousands of random floor plans against a separate reference method. It has already found and fixed one bug, where a path could slip through a hairline crack between two walls.
- **After it:** the `import-matterport` and `import-mesh` commands and an example world with walls.

## Next

1. Run Floor 1 lunch with Jev. The dry run estimates about 3,200 requests and 12 cents for the draft crowd; the corrected crowd is smaller.
2. Look at the viewer by eye on the real building.
3. Make people buy food before they sit down.
4. Floor 2: the office morning.

Parked until the building runs:
- the queueing-formula and Braess validation scripts;
- an independent review pass;
- the optimizer;
- the deepagents orchestrator;
- Vexcel imagery (the key is saved, nothing uses it yet).

## How to run it

```sh
npm install
# put TYPESAFE_API_KEY in .env.local (never commit it)

node bin/swarm.js run er-network --provider rules        # instant, no API
node bin/swarm.js run er-network --provider jev          # about 1 minute, about 5 cents
node bin/swarm.js serve                                  # viewer at http://127.0.0.1:4173
npm test
```

The real building (needs the Matterport keys in `.env.local`):

```sh
# 1. Fetch the model's wall and door data into data/ (gitignored). This command is still being built:
node bin/swarm.js import-matterport 6FNMVoyPrL1 --save-raw data/6FNMVoyPrL1.json
# 2. Build the world from the fit-out and the real walls:
node bin/swarm.js fitout buildings/6FNMVoyPrL1/fitout-floor1-lunch.json \
  --plan-raw data/6FNMVoyPrL1.json --out data/worlds/floor1-lunch.json
# 3. Run it:
node bin/swarm.js run data/worlds/floor1-lunch.json --provider rules
```

## Local-only data

None of this is in the repo. Each teammate needs their own copy.

| What | Where it goes | How to get it |
|---|---|---|
| API keys: TypeSafe (Jev), Matterport, Vexcel | `.env.local` | The team's Discord channel. Names are in `.env.example`. |
| Matterport raw model data | `data/6FNMVoyPrL1.json` | Step 1 above |
| CoStar kit | anywhere outside the repo | "Download the hackathon kit" in Discord |
| CoStar records for the building, the dossier, the neighborhood study, the simulation inputs | `data/costar/6FNMVoyPrL1/` | Generated from the kit on the build machine. Ask the teammate who ran the build for a copy. |
| Real-building worlds (they contain the floor plan) | `data/worlds/` | Step 2 above |
| Recorded runs | `runs/` | Created by `swarm run` |

## Known limits

- **Simulated people are unvalidated.** Results are rankings under stated assumptions, not forecasts.
- **One floor per world.** Stairs stand in for the other floor.
- **Doors count people but do not slow them down.**
- **Every place and headcount in the fit-out is a proposal.**
- **TypeSafe's speed and price are from one measurement** on the hackathon network.
- **Paths can hug wall corners more tightly than intended.** They never touch a wall.
- **Recorded frames are half a minute apart,** so the viewer has to route each dot around walls between frames. That logic is tested, but nobody has watched it on the real building yet.
- **The gate for one staircase sits at the stair's door,** a couple of meters from the stair itself.
- **One enclosed room on Floor 1 has no opening in the Matterport data,** so nobody can enter it.
