# Swarmscope: progress

**As of Saturday, Nov 14, 2026, about 2:40 am.** For the plan and every decision, see [SWARMSCOPE_SPEC.md](SWARMSCOPE_SPEC.md) (v0.17). For how the code fits together, see [docs/PROTOTYPE.md](docs/PROTOTYPE.md).

## Where things stand

The simulator works end to end with real Jev decisions, **including on the real target building**: Floor 1 at weekday lunch has run with Jev on five seeds. An independent check found no one passing through a wall.

- **Target:** Matterport model `6FNMVoyPrL1` ("Office/Retail - 45,726SF"), a two-story building that is currently an empty shell.
- **Scenario:** a proposed fit-out, retail on the ground floor and offices upstairs, on a weekday at lunch and in the morning.
- **This repo is public.** The building's CoStar details (address, tenant history, sales) are deliberately not in it. They are on the build machine under `data/`, which is gitignored. See "Local-only data" below.

## What works (checked by running it)

| Piece | State | Evidence |
|---|---|---|
| Engine: places with lines, or a network of routes | Works | All 5 example worlds run with rules in under 0.3 s each |
| Jev per agent (`jev-latest`) | Works | ER world, 560 people: 1,276 Jev requests, 10 cache hits, 0 fallbacks to rules, 57 s, median 81 ms per request, about $0.05 at TypeSafe's published price (unverified) |
| Jev changes the outcome | Seen on two worlds | ER world: the worst bottleneck is Larkfield General with rules and St. Brigid's Regional with Jev (one seed). Real building: see the results below (five seeds). |
| Record and replay | Works | The recorded Jev run replays with identical results and zero API calls |
| Walls | Works | People walk the shortest path that touches no wall; a place with no path is never offered as an option; the run stops with an error rather than record a move through a wall |
| Matterport import | Works on the real model | 2 floors, 334 wall edges, 23 openings. Floor 1 becomes 134 wall segments and 10 doors (5 exterior); Floor 2 becomes 80 wall segments and 7 doors |
| Door traffic | Works | Every doorway counts crossings, with a peak per 5 minutes |
| Viewer | Works with rules runs | Map, time scrubber, rankings, per-person decision view, walls and doors. Checked through its API and in headless Chrome, not yet by eye on the real building |
| CoStar kit | Fully read | Digests of every guide and schema, a profile of all eight datasets, a dossier on the building and a study of its surroundings (all local-only) |
| Real building, rules run | Works | Built from the Matterport walls and the fit-out file with `swarm fitout`; validates with 0 errors and 0 warnings |
| No walking through walls | Confirmed independently | A separate checker with its own geometry code replayed the run at fine time steps: 1,032,558 consecutive positions against the 134 real walls, 0 crossings, and nobody inside the sealed room |
| Tests | 514 of 514 pass | `npm test`, 23 test files |

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

### Results on the real building (Floor 1, weekday lunch, 312 people)

Same people arriving at the same times, seed 7:

| | Rules | Jev |
|---|---|---|
| Times someone walked away from a line | 226 | 65 |
| Average wait | 5.8 min | 3.4 min |
| Worst bottleneck | Noodle bar, then taquería | Pizza counter, then taquería |
| People who went to the noodle bar | most of any counter | 35, the fewest of the food counters |
| Busiest doorways | Market main entrance, food hall south door, food hall north door | the same three, in the same order |

Jev across five seeds (7 to 11): 4,725 requests, 0 fallbacks to rules, 70 seconds, about 30 cents at TypeSafe's published price (unverified).

- **Worst bottleneck:** the pizza counter in 3 of 5 runs, the bakery in 2 of 5. The noodle bar and the taquería, which lead under rules, never do.
- **Walk-aways:** 8.3% of line arrivals on average (standard deviation 2.1%). Average wait 3.1 minutes (0.2).
- **Why Jev differs:** the noodle bar's description says "great food, slow kitchen", and Jev's people stay away from it. The cheap single-register pizza counter draws a crowd it cannot serve. People also mostly buy food before sitting down (9 of 51 table visits came first), which rules do not manage.
- **Walls:** 0 crossings in every run.

Cautions:
- **A small cast distorts results.** Each simulated person copies one cast member. With 3 market shoppers in the cast, 47 people became one woman with an optical errand, and the optical counter looked like the worst bottleneck. The cast is now 25 people, with rare errands weighted low. Check the cast before trusting a ranking.
- **A live Jev rerun of the same seed does not repeat exactly.** Seed 7 gave 65 walk-aways in one run and 52 in another. A recorded run does replay exactly.
- **Five seeds is not the 20 the spec asks for,** and no input has been nudged up or down yet.
- Every place and headcount here is a proposal. These are rankings under stated assumptions, not forecasts.

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

## Finished since the first push

- **Stress test of the pathfinding.** It ran 270 random floor plans against a separate reference method and found one real bug, where a path could slip through a hairline crack between two wall pieces. Gaps too narrow for a person are now sealed.
- **Import commands.** `swarm import-matterport` (from the API or a saved file) and `swarm import-mesh` (walls from a 3D mesh file, as a fallback). The mesh importer also had a bug where people could walk inside a thick wall at a doorway; fixed.
- **An example world with walls** that anyone can run without keys: `worlds/office-floor-walls.json`, built from a hand-made floor plan.

Nothing is running in the background right now.

## Next

1. Look at the viewer by eye on the real building.
2. Test a fix on the same seeds, for example a second register at the pizza counter.
3. Floor 2: the office morning.
4. The robustness check: 20 seeds, and the assumed inputs moved up and down by 25%.

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
node bin/swarm.js serve                                  # viewer at http://127.0.0.1:4173, scope display at /scope/
npm test
```

The real building (needs the Matterport keys in `.env.local`):

```sh
# 1. Build the world from the fit-out and the real walls (fetches the Matterport data; output is gitignored).
#    To keep the raw model data too: node bin/swarm.js import-matterport 6FNMVoyPrL1 --save-raw data/6FNMVoyPrL1.json
#    --mesh auto also downloads the 3D mesh and adds the solid objects in it (stairs, fixtures, counters) as walls.
node bin/swarm.js fitout buildings/6FNMVoyPrL1/fitout-floor1-lunch.json \
  --model 6FNMVoyPrL1 --mesh auto --out data/worlds/floor1-lunch.json
# 2. Run it. Frames are recorded every 3 s by default (--frame-seconds 2 to 5 to change it):
node bin/swarm.js run data/worlds/floor1-lunch.json --provider jev      # or --provider rules
# 3. Watch it: open http://127.0.0.1:4173/scope/ (it opens the latest run of the building)
node bin/swarm.js serve
# 4. Ask what to change: the advisor tests each proposed change on the same seeds (needs ANTHROPIC_API_KEY,
#    or run /advise in Claude Code). The display's Suggestions button shows its advice.
node bin/swarm.js advise data/worlds/floor1-lunch.json --question "Where do people get stuck at lunch, and what helps most?"
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
| CoStar kit (unzipped) | `costar-hackathon-kit/` | "Download the hackathon kit" in Discord. Gitignored. |
| Independent-business lists and their changes | `data/costar/` | `scripts/costar/` (see its README) |

## Known limits

- **Simulated people are unvalidated.** Results are rankings under stated assumptions, not forecasts.
- **One floor per world.** Stairs stand in for the other floor.
- **Objects come from the mesh and are named by size.** `--mesh` finds 26 on Floor 1 (the two staircases, restroom fixtures, a U-shaped counter in the north unit, small fixtures). An empty shell's mesh can also hold things that would be cleared before a fit-out; check the list the command prints.
- **Doors count people but do not slow them down.**
- **Every place and headcount in the fit-out is a proposal.**
- **TypeSafe's speed and price are from one measurement** on the hackathon network.
- **Paths can hug wall corners more tightly than intended.** They never touch a wall.
- **Recorded frames are half a minute apart,** so the viewer has to route each dot around walls between frames. That logic is tested, but nobody has watched it on the real building yet.
- **The gate for one staircase sits at the stair's door,** a couple of meters from the stair itself.
- **One enclosed room on Floor 1 has no opening in the Matterport data,** so nobody can enter it.
