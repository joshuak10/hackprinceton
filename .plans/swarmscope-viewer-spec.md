# Swarmscope viewer: spatial replay with a time slider (spec + plan)

## Context

Swarmscope simulates thousands of Jev agents moving through a real property (see `SWARMSCOPE_SPEC.md`). A teammate owns the backend: the engine, the Jev provider, the run recorder and `server/server.js`, all following `docs/PROTOTYPE.md`. We own the display, `web/`. It must:

- replay a run over time with a slider and show where incidents happen on a real map;
- let someone type what they want simulated, limited to the two supported cases for now;
- run on mock data today and connect to the Jev backend later without a rewrite.

The two cases are **separate worlds**:

1. **Building congestion:** Matterport model `6FNMVoyPrL1` ("Office/Retail - 45,726SF"). It has 2 floors and about 2,227 m². Each floor has two large rooms, with holes for columns and obstacles. There are 19 openings, all generic: none is typed as a doorway, so entrances must be inferred from openings in exterior walls. Room labels are unreliable. An OBJ mesh is available at 50k and 500k resolution.
2. **Retail parking lot:** a synthetic lot for now. The user will choose the property later, and aerial imagery waits for Vexcel access. The key named `VERCEL_API_KEY` in `.env.local` is not a Vercel key; build without it.

The spec copy will be saved to `/Users/joshuakim/Downloads/Projects/hackprinceton/.plans/swarmscope-viewer-spec.md` (the interview skill's location) as the first step of execution.

## Decisions from the interview

| Topic | Decision |
|---|---|
| Worlds | Two separate worlds, each with its own map and run |
| Incidents | Decision outcomes, physical congestion and complaints. No safety near-misses |
| Over time | Heat builds up from the start to the slider time, and new incidents pulse as they happen |
| Floor plan | Real Matterport geometry kept locally (gitignored), with a committed synthetic fallback |
| Prompt | Keyword-match to one of the two cases, then a confirm card. Off-topic prompts get a plain message listing the two cases |
| Stack | Plain HTML, canvas and ES modules for now, with no build step. Code is structured so a React + Vite port later is mechanical |
| Live runs | Progress, then replay (fits the contract's status polling) |
| 3D | 2D plan for the simulation. Clicking an incident or room opens the Matterport 3D tour at the nearest scan point |
| Lot map | Slot for an aerial photo plus traced stalls. Vector-only until there is imagery |
| Audience | Projector for judges: dark by default, large type, map-dominant |
| Slider | Incident histogram behind the track, plus auto-labeled key moments you can click to jump to |
| Always visible | Live counters, bottleneck ranking, incident feed. Run stats, world info and the legend are in a drawer |
| Dot color | Switchable between activity, frustration and archetype. Default: activity |
| Inspector | Yes: persona plus mock Jev probability bars per decision, in the contract's decisions shape |
| Fixes | Not yet, but keep the data shapes and layout ready for a second run |
| Walk graph | We write it as a shared plain-JS module that the world builder can import later |
| Mesh | Slice the 50k OBJ at walking height into an obstacle grid. Agents can never walk through mesh |
| Congestion | Detected in the viewer from frames. If a run includes `incidents.json`, use that instead |
| Floors | Floor tabs, one floor at a time, each tab with a live incident count |
| Screens | Laptop and projector only (1280 px and up). This overrides the contract's 390 px |

## Design direction

**Concept: survey drawing on a lightbox.** The plan is drawn as crisp, light architectural linework on a mid-dark slate ground, which projects better than near-black. People are small cool-toned dots, and trouble glows through the drawing as warm heat. The one bold element is the **timeline**: a tall histogram strip of the run with named key moments. Everything else stays quiet.

- **Color (dark, default):** ground `#18232F`, room fill `#213041`, mesh obstacles `#34485D` with a hatch, walls and linework `#C9D6E3`, text `#E8EEF4` / muted `#93A6BA`, interactive accent teal `#3CC6B5` (kept from the prototype). Heat ramp: amber `#F2C14E` → orange `#F08A4B` → red `#E5484D`. Warm colors are reserved for incidents, so agents use cool colors: walking `#8EC5FF`, in line `#B9A2FF`, being served `#3CC6B5`, deciding (waiting on Jev) white with a slow pulse, leaving `#5D7186`. A light theme mirrors these tokens on `#EEF2F5`.
- **Type:** Bricolage Grotesque for the place title and the key-moment labels. IBM Plex Sans for everything else, with `tabular-nums` for the clock and counters. Base size is 16 px, counters 30 px and the title 28 px for the projector. No all-caps labels and no mono data labels.
- **Layout (1440×900):**
```
┌────────────────────────────────────────────────────────────────────────┐
│ Swarmscope  [ What do you want to simulate? ..................] [Run] Mock│
├──────────────────────────────────────────────────┬─────────────────────┤
│ Office/Retail, 45,726 SF    Floor 1 (14)  Floor 2 (3) │ In building  In line  │
│                                                  │ Served  Walked away │
│          PLAN  (rooms, mesh, walls, doors)        ├─────────────────────┤
│          + heat  + agents  + pulsing incidents    │ Bottlenecks (bars)  │
│                                     [Color by ▾]  ├─────────────────────┤
│                                     [Layers ▾]    │ Incident feed       │
├──────────────────────────────────────────────────┤ (click → fly to it) │
│ Front door crowding peaks at 12:40 pm ▾                                  │
│ ▁▂▃▅▇█▇▅▃▂▁▂▅▆▃▁  histogram (stacked by category)                        │
│ ━━━━━━━━━●──────────  ▶  1× 4× 16×   12:40 pm                            │
└────────────────────────────────────────────────────────────────────────┘
```
- **Empty state:** the map area shows the two cases as two choices, each with a small plan thumbnail and an example question. Clicking one fills the prompt.
- **Motion:** pulses on new incidents, and a fly-to when you click an incident. Both are off under `prefers-reduced-motion`.

## Data contract (viewer input)

The viewer reads one **RunBundle**: `{ meta, spec, geometry, frames, metrics, agents, remarks, decisions }`. The contract defines all of these except `geometry` and `decisions`, which are additions (below). Mock runs and API runs produce the same shape.

**Geometry** (new, written by `geometry/` and later by the world builder). Coordinates are map units, with the longer side scaled to 0–100 so the engine's distance words still apply, plus `metersPerUnit`:
```
{ kind: 'interior'|'lot', source: {provider, modelId?}, metersPerUnit,
  floors: [{ id, label, sequence, bounds, transform /* back to Matterport metres */,
    rooms: [{ id, kind, poly, holes, area }],            // nonArea/hide voids dropped
    walls: [[x1,y1,x2,y2,thickness]],
    openings: [{ id, x, y, angle, width, type, exterior, rooms }],
    obstacles: { cell, w, h, origin, rle },               // mesh slice
    pois: [{ id, name, kind: entry|exit|service|stairs, x, y, provenance }] }],
  lot?: { stalls, aisles, driveways, storefront, crosswalks, image: null },
  sweeps?: [{ id, floor, x, y }],                         // for 3D tour fly-to
  provenance: {...} }
```
**Frame extensions** (additive to PROTOTYPE §7):
- `frames.stride` sets the length of each agent record. The default is 4. It is 5 for multi-floor worlds, where the record is `[id, x10, y10, s, floor]`.
- `list[].h` is the array of occupied stall indices, for held parking.
- Interior and lot worlds need frames at least every 5 s of simulated time, or interpolated dots cut through walls. Consequence: building runs cover a 90-minute peak window and the lot covers 2 hours.

**Incidents** (derived in `web/lib/incidents.js`): `{ id, t, cat: decision|congestion|complaint, kind, x, y, floor, placeId, agentId?, severity, text }`.
- **Decision:** a `line` decision answered no means "walked away from the line at X". A `long` decision answered no means "gave up waiting". A `choose` to leave after balking means "left without being served". In the lot, giving up the search means "drove off without parking".
- **Complaint:** remarks of kind `long_line` and `bad_service`. Good experiences appear in the feed only.
- **Congestion:** detected per frame.
  - Doorways: people within 1.5 m of an opening exceed 2.5 × its width in metres.
  - Rooms: more than 2 people/m².
  - Lot: more than N cars queued at a driveway.
  - The condition must hold for 2 or more frames. One incident is emitted per episode, with its duration and peak.
- **Key moments:** incidents per minute, peaks above the mean + 1σ that are at least 15 minutes apart, top 4. Each is labeled with its dominant kind and place.

**Bottleneck score up to t:** wait minutes + 30 × abandons for each service point or doorway. These are precomputed as cumulative series per frame, so a lookup at any t is O(1).

## Files

**New, shared and plain JS (no DOM, no Node built-ins), so the viewer, the scripts and the teammate's world builder can all import them:**
- `geometry/matterport.js`: `normalizeMatterport(json)`. Handles edges and vertices to walls, places each opening along its edge using `relativeCenter`, flags exterior openings (an edge bordering one non-void room), scales to map units and keeps the inverse transform.
- `geometry/obj-slice.js`: `parseObj`, plus `sliceToGrid(mesh, { floorZ, zMin: 0.3, zMax: 1.5, cell: 0.25 })`. Finds floor elevations from a histogram of horizontal triangles and checks the up axis against the plan's bounding box.
- `geometry/walkgrid.js`: `buildWalkGrid` (inside rooms, not holes, not walls except opening spans, not mesh, dilated by agent radius), `distanceField(grid, targets)` (8-connected Dijkstra), `nextStep`, `findEntrances`.

**New mock generators (Node), reusing `engine/util.js` (`seedRng`, `hash32`, `clamp`, `clockText`, `feelingWords`, `waitWords`):**
- `mockgen/building.js`: weekday lunch peak (90 min, about 450 people, 2 floors).
  - Cast: office workers heading to floor 2 by the stairs, retail shoppers, couriers, visitors.
  - Movement: agents descend distance fields on the walk grid, with a per-cell occupancy cap so doorway queues form on their own.
  - Service points: checkout, café counter, reception, restrooms.
  - Decisions in the contract shape: `choose`, `line` and `long`, with `choiceProbs`, `yesProb`, `frustration`, `tellProb` and `remarkProbs`, and `provider: 'mock'`.
- `mockgen/parking.js`: Saturday peak (2 h, about 320 cars), on a lot of about 150 stalls with two driveways, a crosswalk and a storefront.
  - Steps: driveway queue → search the aisles nearest the store first → park (held stall) → walk across the crosswalk → shop (shown as a count on the store) → checkout `line` → return → exit queue.
  - Decisions: entry choice, keep searching, join the checkout line.
- `mockgen/synthetic.js`: the synthetic building fallback and the lot geometry.
- `scripts/extract_building.js <modelId>`:
  - Loads keys with `loadEnv()` from `engine/env.js`.
  - Queries GraphQL for floors, rooms, edges, openings and `panoLocations`.
  - Downloads the 50k OBJ to `data/matterport/`.
  - Writes `web/data/building-<id>.geometry.json` and `web/data/config.json` (`{ matterportSdkKey, modelId }`).
  - POIs are placed by hand in `web/data/building-<id>.pois.json` and tagged `assumed`.
- `scripts/mock_runs.js`:
  - Writes the committed synthetic runs `web/mock/{building,parking}-synthetic.json` (target under 4 MB each) and `web/mock/index.json`.
  - When real geometry exists, also writes `web/data/mock-building-<id>.json` and `web/data/index.json`.
- `scripts/serve_web.js`: a 30-line `node:http` static server for `web/` on port 4173, plus `"web": "node scripts/serve_web.js"` in `package.json`.

**Viewer (`web/`).** Each module exports pure derive functions and separate draw functions, so each maps one-to-one onto a hook and a component later:
- `index.html`, `style.css` (tokens; dark default, light toggle stored in try/catch localStorage), `app.js` (single state object with `setState` and subscribers, case registry, run lifecycle).
- `lib/source.js`: `MockSource` reads `data/index.json` and falls back to `mock/index.json`. `ApiSource` uses the contract's §9 endpoints. If `GET /api/health` responds, the API path is enabled; otherwise a "Mock data" badge shows.
- `lib/frames.js`: frame lookup by t, interpolation by agent id, the stride and floor field.
- `lib/incidents.js`: as defined above, plus cumulative series and key moments.
- `lib/heat.js`: a coarse grid with Gaussian stamps and a colour lookup table. Incremental when t moves forward, recomputed when it moves back.
- `lib/render.js`: cached base layer per floor (rooms, hatched mesh obstacles, walls, opening gaps, POIs, lot stalls and aisles, optional aerial underlay), then heat, agents (colour-by mode, a store count badge in the lot), pulsing incidents, the selected agent's trail, and hit-testing.
- `lib/timeline.js`: histogram canvas behind a real `<input type=range>` (with clock `aria-valuetext`), key-moment buttons, play/pause, 1×/4×/16× speeds (1× = 1 simulated minute per second). Keys: Space plays or pauses, ←/→ step one frame, Shift+←/→ step 10 minutes.
- `lib/panels.js`: counters, bottleneck bars, incident feed (click to fly there), drawer (Jev run stats marked unverified, world provenance, legend), and the inspector (persona card, each decision with probability bars, the sampled option highlighted, a provider badge, remark and trace).
- `lib/prompt.js`: keyword scoring for the two cases, the confirm card (case, place, the user's question, crowd size, time window, data provenance), the off-topic message with case chips, and the staged progress overlay (mock stages, or polling `/api/runs/:id/status`).
- `lib/tour.js`: Matterport Showcase iframe plus the SDK. It reads the SDK key from `data/config.json`, finds the nearest sweep to the clicked point on the same floor, and calls `Sweep.moveTo`. Without a key it opens the plain tour URL. The pinned SDK version is checked against the Matterport docs during the build.

**Spec and contract edits (spec first, per rule 12), all additive:**
- `SWARMSCOPE_SPEC.md` §10b gets the user's mesh note. CoStar/Matterport indoor data includes a mesh, and mesh surfaces at walking height act as walls that Jev agents must never walk through: the backend must enforce this, and `geometry/obj-slice.js` provides the obstacle grid. Also add the chosen building model and its findings, update the Viewer row in §4, and add change-log entry v0.15.
- `docs/PROTOTYPE.md`:
  - §1: add the new files.
  - §7: add the frame extensions and the 5 s frame cadence for interior and lot worlds.
  - §9: add `GET /api/runs/:id/decisions`, the optional `incidents.json`, `spec.geometry`, the laptop-only override, and one stated exception to "never send a key to the browser" for the Matterport SDK key, which is public and locked to a domain by design.

## Execution order

1. Save the spec to `.plans/swarmscope-viewer-spec.md`, then make the spec and contract edits.
2. Write `geometry/` with unit tests: opening placement, exterior detection, point-in-polygon walk grid, slicing a synthetic cube OBJ.
3. Write `extract_building.js` and run it on `6FNMVoyPrL1`. Check the room, opening, entrance and obstacle-cell counts. Run `git check-ignore web/data/x data/x` to confirm both stay out of git. Place the POIs.
4. Write the synthetic geometry and both mock generators, run `mock_runs.js`, and check that the same seed gives the same hash.
5. Build the viewer modules, then `serve_web.js`.
6. Verify and critique (below). Don't commit unless asked.

## Verification

- `npm test` covers the geometry tests, the incident tests (balk, gave up, remark mapping, door-crowding episodes on synthetic frames, peak detection) and mock determinism.
- `npm run web`, then headless Chrome screenshots at 1440×900 of `?case=building&t=40&floor=0`, `?case=parking&t=70` and the empty state, using URL params for reproducible views. Read each PNG and fix what looks wrong.
- Manual checks:
  - drag the slider forwards and back, and confirm heat builds and resets;
  - play at all three speeds;
  - a key moment jumps to its time;
  - floor tab counts match the feed;
  - clicking an agent opens the inspector with probability bars;
  - clicking an incident flies the map there and opens the 3D tour at the nearest sweep;
  - a building prompt and a lot prompt each show the right confirm card;
  - an off-topic prompt shows the two-case message;
  - the theme toggle works;
  - reduced motion turns off the pulses.

## Risks

- The Matterport OBJ's up axis, units and per-floor elevations aren't confirmed. The slicer checks them against the plan's bounding box and fails loudly.
- The SDK key may be registered for a domain other than `localhost`, in which case the plain tour URL is the fallback.
- Mock JSON size: frames every 5 s for about 150 active agents. If a file goes over 4 MB, use 6–8 s frames or omit agents inside the store.
- API mode is wired up but untested until the teammate's server and worlds for these two cases exist.

## Implementation notes (Nov 14, after the build)

**Where things landed (differs from the plan above):**
- The display lives in `web/scope/`, not `web/`. The teammate's commit `c040bdd` added a generic contract viewer (`web/index.html`, `web/style.css`), so the scope display sits next to it. `server/server.js` would serve it at `/scope/`.
- Dev server: `npm run web` starts `http://localhost:4174/scope/`. Port 4174 avoids clashing with `swarm serve` on 4173.
- Hand-placed points of interest are committed in `mockgen/pois/building-6FNMVoyPrL1.json`. They are our assumptions, not scan data. The extracted geometry and runs stay in gitignored `web/scope/data/`.
- Mock frames are captured every 4 s of simulated time.
- The teammate's server sends a CSP that blocks the Matterport iframe and SDK. The needed additions are in `docs/PROTOTYPE.md` §9b. The dev server sends no CSP.

**Commands:**
```
node scripts/extract_building.js 6FNMVoyPrL1   # Matterport → web/scope/data (needs .env.local keys)
npm run mock                                   # mock runs: web/scope/mock (committed) + web/scope/data (local)
npm run web                                    # http://localhost:4174/scope/   (?case=building&t=30&floor=1&theme=light&autoplay=0)
node --test test/scope-geometry.test.js test/scope-mock.test.js
```

**Linking the Jev backend later:**
1. The world builder writes `spec.geometry` in the §9b shape. It can reuse `geometry/*.js` and the walk grid, which applies the mesh-as-wall rule.
2. The recorder serves `decisions` (and optionally `incidents`) through the new endpoints.
3. Add a `world` field to each case in `web/scope/data/index.json`. When `/api/health` answers, the display then runs through `POST /api/runs` and replays the result. `lib/source.js` `apiRun` is written against the contract but untested.

**Findings during the build:**
- Matterport room boundaries include dangling wall stubs. `outerLoop` prunes them and traces faces.
- Openings narrower than 0.6 m are scan artifacts, so they are ignored.
- `distanceField` must store distances as Float64. Float32 rounding silently dropped cells from the field.
