// Mock run: lunch rush inside a two-floor office/retail building. Agents walk the walkable grid built from
// the floor plan and the mesh (they can't pass walls or mesh obstacles), queue at service points, and make
// mock decisions in the contract's shape. Output is a RunBundle (docs/PROTOTYPE.md §9b).
import { buildWalkGrid, distanceField, nearestFree, cellIndex, cellCenter, neighbours } from '../geometry/walkgrid.js';
import {
  seedRng, clamp, clockText, waitWords, sigmoid, normal, arrivalTimes, pick, pickWeighted, noisyProbs,
  sampleKey, frustrationAnswer, REMARK_TEXT, DecisionLog, agentSummary
} from './common.js';

const S = { walk: 0, queue: 1, serve: 2, think: 3, leave: 4 };
const DT = 1 / 60;                      // one tick = 1 s, in minutes

const CAST = {
  office: { name: 'Office workers', tolerance: 10, personas: [
    { id: 'maya', name: 'Maya Okafor', age: 31, about: 'Product manager on the second floor with back-to-back meetings', wants: 'a quick lunch she can eat at her desk', listens_to: 'her team chat', app: true },
    { id: 'derek', name: 'Derek Lin', age: 45, about: 'Accountant who takes a proper lunch break every day', wants: 'a seat and something hot', listens_to: 'coworkers at the next desk', app: false },
    { id: 'sana', name: 'Sana Iqbal', age: 26, about: 'Designer, new to the building', wants: 'to try the café everyone mentions', listens_to: 'the office group chat', app: true },
    { id: 'tom', name: 'Tom Becker', age: 52, about: 'Facilities manager who knows every corner of the building', wants: 'to be back before his 1 pm call', listens_to: 'nobody much', app: false }
  ] },
  cafe: { name: 'Café customers', tolerance: 9, personas: [
    { id: 'lucia', name: 'Lucia Ortega', age: 38, about: 'Nurse from the clinic across the street on a 30-minute break', wants: 'coffee and a sandwich fast', listens_to: 'reviews on her phone', app: true },
    { id: 'jamal', name: 'Jamal Wright', age: 22, about: 'Student who studies in cafés', wants: 'a table for an hour', listens_to: 'friends', app: true },
    { id: 'grace', name: 'Grace Kim', age: 67, about: 'Retired teacher meeting a friend', wants: 'a calm place to sit', listens_to: 'her friend', app: false }
  ] },
  shopper: { name: 'Market shoppers', tolerance: 10, personas: [
    { id: 'priya', name: 'Priya Shah', age: 34, about: 'Parent picking up groceries between errands', wants: 'to get in and out', listens_to: 'the neighborhood group chat', app: true },
    { id: 'walt', name: 'Walt Hughes', age: 71, about: 'Regular who shops here three times a week', wants: 'his usual items and a chat at checkout', listens_to: 'the cashier', app: false },
    { id: 'nina', name: 'Nina Petrova', age: 29, about: 'Office worker from next door on a snack run', wants: 'something quick before a meeting', listens_to: 'coworkers', app: true }
  ] },
  visitor: { name: 'Visitors', tolerance: 6, personas: [
    { id: 'omar', name: 'Omar Haddad', age: 40, about: 'Client arriving for a 12:30 meeting upstairs', wants: 'to sign in and find the meeting room', listens_to: 'his host', app: false }
  ] },
  courier: { name: 'Couriers', tolerance: 4, personas: [
    { id: 'kev', name: 'Kevin Tran', age: 24, about: 'Food delivery courier on a tight schedule', wants: 'to drop off and get to the next order', listens_to: 'the courier app', app: true }
  ] }
};

const DEFAULT_MIX = { office: 160, cafe: 140, shopper: 150, visitor: 24, courier: 16 };

// Patience depends on the place: a coffee or a sandwich isn't worth the wait a full basket is.
const PLACE_PATIENCE = { cafe_counter: 0.6 };
// People judge a line by how many people they see, not by dividing by the number of registers.
// Head-count limit = patience at the place × this factor (café: about 7–14 people).
const HEAD_LIMIT = { cafe_counter: 2.0, market_checkout: 1.3, reception: 1.5, restroom: 1.2 };

export function runBuilding(geometry, opts = {}) {
  const {
    seed = 7, duration = 90, clockStart = 11 * 60 + 45, frameEverySec = 4, mix = DEFAULT_MIX,
    title = 'Lunch rush inside the building', question = 'Where do people get stuck moving through this building at lunchtime, and which change helps most?'
  } = opts;
  const mpu = geometry.metersPerUnit;
  const m = 1 / mpu;                                  // map units per metre
  const spec = {
    title, question, mode: 'visit', duration, clockStart,
    context: `Weekday lunchtime at ${geometry.source?.name?.trim() || 'an office and retail building'}. People are moving between the offices upstairs, the café and the market downstairs.`,
    geometry
  };
  const log = new DecisionLog({ seed, spec });

  // ---------- world setup ----------
  const floors = geometry.floors.map((floor, fi) => {
    const seeds = (geometry.sweeps || []).filter(s => s.floor === fi).map(s => [s.x, s.y]);
    const grid = buildWalkGrid(floor, { metersPerUnit: mpu, seeds });
    return { floor, fi, grid, occ: new Uint8Array(grid.w * grid.h) };
  });
  const fieldCache = new Map();
  const field = (fi, cell) => {
    const key = fi + ':' + cell;
    if (!fieldCache.has(key)) fieldCache.set(key, distanceField(floors[fi].grid, [cell]));
    return fieldCache.get(key);
  };

  const pois = new Map();
  const services = [];
  const rng0 = seedRng(seed, 'world');
  floors.forEach(F => {
    for (const p of F.floor.pois || []) {
      const poi = { ...p, fi: F.fi };
      if (p.kind === 'entry') {
        const ext = F.grid.openings.filter(o => o.side === 'exterior');
        const o = ext.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
        if (!o) continue;
        poi.opening = o.id;
        poi.cell = nearestFree(F.grid, o.spawn[0], o.spawn[1]);
        [poi.x, poi.y] = cellCenter(F.grid, poi.cell);
        poi.doorX = o.x; poi.doorY = o.y; poi.doorWidthM = o.widthM;
      } else if (p.kind === 'service') {
        poi.cell = nearestFree(F.grid, p.x, p.y);
        [poi.x, poi.y] = cellCenter(F.grid, poi.cell);
        const [dx, dy] = p.queueDir || [-1, 0];
        const px = -dy, py = dx;
        poi.slots = queueSlots(F.grid, poi.x, poi.y, dx, dy, 0.85 * m, 28);
        poi.serverCells = [];
        for (let k = 0; k < (p.servers || 1); k++) {
          const off = (k - ((p.servers || 1) - 1) / 2) * 1.1 * m;
          const sx = p.serveAt ? p.serveAt[0] + off * px : poi.x + off * px - dx * 0.6 * m;
          const sy = p.serveAt ? p.serveAt[1] + off * py : poi.y + off * py - dy * 0.6 * m;
          poi.serverCells.push(nearestFree(F.grid, sx, sy));
        }
        poi.queue = [];
        poi.busy = new Array(p.servers || 1).fill(null);
        poi.waitMin = 0; poi.abandons = 0; poi.served = 0;
        services.push(poi);
      } else if (p.kind === 'area') {
        const [x0, y0, x1, y1] = p.box;
        const spots = [];
        for (let k = 0; k < 400 && spots.length < 24; k++) {
          const i = cellIndex(F.grid, x0 + rng0() * (x1 - x0), y0 + rng0() * (y1 - y0));
          if (i >= 0 && F.grid.free[i] && !spots.includes(i)) spots.push(i);
        }
        poi.spots = spots;
        poi.x = (x0 + x1) / 2; poi.y = (y0 + y1) / 2;
      }
      pois.set(p.id, poi);
    }
  });
  const need = id => { const p = pois.get(id); if (!p) throw new Error(`Point of interest "${id}" is missing from the geometry.`); return p; };
  const nameOf = id => pois.get(id)?.name || id;
  const tolAt = (a, poi) => a.tolerance * (PLACE_PATIENCE[poi.id] ?? 1);
  const headLimit = (a, poi) => Math.max(3, tolAt(a, poi) * (HEAD_LIMIT[poi.id] ?? 1.5));
  const linkSeconds = (a, b) => {
    const l = (geometry.links || []).find(k => (k.from === a && k.to === b) || (k.from === b && k.to === a));
    return l ? l.seconds : 60;
  };

  // ---------- agents ----------
  const agents = [];
  let nextId = 1;
  const schedule = [];
  const arrivals = {
    office: { start: 3, end: 40, peaks: [{ t: 13, sd: 4.5, w: 1 }, { t: 28, sd: 4, w: 0.35 }], base: 0.1 },
    cafe: { start: 0, end: duration - 8, peaks: [{ t: 24, sd: 10, w: 1 }, { t: 52, sd: 9, w: 0.6 }], base: 0.35 },
    shopper: { start: 0, end: duration - 10, peaks: [{ t: 30, sd: 14, w: 1 }], base: 0.5 },
    visitor: { start: 5, end: duration - 15, peaks: [{ t: 40, sd: 6, w: 1 }], base: 0.4 },
    courier: { start: 5, end: duration - 5, peaks: [{ t: 30, sd: 12, w: 1 }], base: 0.5 }
  };
  const rngA = seedRng(seed, 'arrivals');
  for (const [arch, n] of Object.entries(mix)) {
    for (const t of arrivalTimes(rngA, n, arrivals[arch])) schedule.push({ t, arch });
  }
  schedule.sort((a, b) => a.t - b.t);

  function makeAgent(arch, t) {
    const id = nextId++;
    const rng = seedRng(seed, 'agent', id);
    const persona = pick(rng, CAST[arch].personas);
    const a = {
      id, rng, archetypeId: arch, groupName: CAST[arch].name, persona, personaId: persona.id,
      informed: persona.app && rng() < 0.85, tolerance: CAST[arch].tolerance * (0.7 + rng() * 0.6),
      speed: (1.15 + rng() * 0.35) * m / floors[0].grid.cell,  // cells per second
      jx: (rng() - 0.5) * 0.5, jy: (rng() - 0.5) * 0.5,
      fi: 0, cell: -1, x: 0, y: 0, budget: 0, stuck: 0,
      tasks: [], state: S.walk, visible: false, born: t, doneAt: null,
      waitTotal: 0, servedCount: 0, abandons: 0, frustration: null, decisionIndex: 0,
      placesDone: [], trace: [], thinkUntil: 0, leaving: false
    };
    agents.push(a);
    return a;
  }

  const trace = (a, t, msg) => a.trace.push({ t: +t.toFixed(2), m: msg });

  function place(a, fi, cell) {
    if (a.visible && a.cell >= 0) floors[a.fi].occ[a.cell] = Math.max(0, floors[a.fi].occ[a.cell] - 1);
    a.fi = fi; a.cell = cell; a.visible = true;
    floors[fi].occ[cell]++;
    [a.x, a.y] = cellCenter(floors[fi].grid, cell);
  }
  // Agents in a line or at a counter slide freely and hold no grid cell; they claim one again when they move on.
  function release(a) {
    if (a.visible && a.cell >= 0) floors[a.fi].occ[a.cell] = Math.max(0, floors[a.fi].occ[a.cell] - 1);
    a.cell = -1;
  }
  function claim(a, cell) {
    a.cell = cell >= 0 ? cell : nearestFree(floors[a.fi].grid, a.x, a.y);
    floors[a.fi].occ[a.cell]++;
  }
  function hide(a) {
    if (a.visible && a.cell >= 0) floors[a.fi].occ[a.cell] = Math.max(0, floors[a.fi].occ[a.cell] - 1);
    a.visible = false;
  }

  function spot(areaId, rng) { const p = need(areaId); return { fi: p.fi, cell: pick(rng, p.spots) }; }

  // Plans are task lists; each archetype gets one at arrival, and decisions rewrite the rest.
  function planFor(a, t) {
    const r = a.rng;
    switch (a.archetypeId) {
      case 'office': {
        const desk = spot('offices', r);
        place(a, desk.fi, desk.cell);
        a.home = desk;
        return [{ k: 'choose_lunch' }];
      }
      case 'cafe': {
        const e = need('cafe_front');
        place(a, e.fi, e.cell);
        return [{ k: 'service', poi: 'cafe_counter', atDoor: true }, { k: 'after_cafe', entry: 'cafe_front' }];
      }
      case 'shopper': {
        const e = need(pickWeighted(r, ['market_front', 'market_side', 'west_door'], id => ({ market_front: 0.55, market_side: 0.3, west_door: 0.15 })[id]));
        place(a, e.fi, e.cell);
        const tasks = [];
        const n = 3 + Math.floor(r() * 3);
        for (let k = 0; k < n; k++) tasks.push({ k: 'goto', area: 'market_aisles' }, { k: 'dwell', min: 0.8 + r() * 2.2 });
        if (r() < 0.15) tasks.push({ k: 'service', poi: 'restroom' });
        tasks.push({ k: 'service', poi: 'market_checkout' }, { k: 'exit', entry: r() < 0.7 ? 'market_front' : 'market_side' });
        return tasks;
      }
      case 'visitor': {
        const e = need('stair_door');
        place(a, e.fi, e.cell);
        return [{ k: 'service', poi: 'reception' }, { k: 'goto', area: 'offices' }, { k: 'done' }];
      }
      case 'courier': {
        const e = need('stair_door');
        place(a, e.fi, e.cell);
        return [{ k: 'service', poi: 'reception' }, { k: 'exit', entry: 'stair_door' }];
      }
    }
    return [{ k: 'done' }];
  }

  // ---------- decisions ----------
  function think(a, t) { a.thinkUntil = t + (2 + a.rng() * 2) * DT; }

  function estWait(poi) {
    const inService = poi.busy.filter(Boolean).length;
    const ahead = poi.queue.length + Math.max(0, inService - poi.busy.length + 1);
    return (ahead / poi.busy.length) * poi.serviceTime;
  }

  function placesFor(a, ids) {
    return ids.map(id => {
      const p = pois.get(id);
      return { option: id, name: p?.name || id, line: p?.queue ? (a.informed ? waitWords(estWait(p)) : "unknown (can't see it from here)") : 'no line', ...(p?.queue ? { people_ahead: p.queue.length } : {}) };
    });
  }

  function chooseLunch(a, t) {
    const cafe = need('cafe_counter');
    const heard = log.heardBy(a, t, nameOf);
    const cafeLine = estWait(cafe);
    const crowdPenalty = a.informed ? clamp(cafeLine / tolAt(a, cafe), 0, 2) : 0;
    const w = { cafe_counter: 1.6 - 0.6 * crowdPenalty - 0.15 * heard.length, market_checkout: 0.7 + 0.3 * crowdPenalty, leave: 0.25 + 0.2 * crowdPenalty };
    const probs = noisyProbs(a.rng, w);
    const u = seedRng(seed, 'decide', a.id, a.decisionIndex)();
    const action = sampleKey(probs, u);
    const options = [
      { key: 'cafe_counter', label: 'Get lunch at the café downstairs' },
      { key: 'market_checkout', label: 'Grab something from the market downstairs' },
      { key: 'leave', label: 'Eat somewhere else outside the building' }
    ];
    const summary = action === 'cafe_counter' ? 'went down to the café for lunch' : action === 'market_checkout' ? 'went to the market for lunch' : 'left the building for lunch elsewhere';
    log.record({
      t, agent: a, kind: 'choose', why: 'start', options,
      asks: { choice: 'next_place', yesNo: null, frustration: false, tellOthers: false },
      now: 'Just stepped away from their desk. Choosing where to get lunch.',
      places: placesFor(a, ['cafe_counter', 'market_checkout']), heard,
      auto: { action: 'cafe_counter' },
      decision: { choiceProbs: probs, latencyMs: Math.round(90 + a.rng() * 120) },
      applied: { yes: null, action, tell: false, remarkKind: null, frustration: null, summary }
    });
    trace(a, t, summary);
    think(a, t);
    const desk = a.home;
    if (action === 'cafe_counter') {
      return [{ k: 'exit', entry: 'stair_door' }, { k: 'transfer', from: 'stair_door', to: 'cafe_front' },
        { k: 'service', poi: 'cafe_counter', atDoor: true }, { k: 'after_cafe', entry: 'cafe_front', returnTo: desk }];
    }
    if (action === 'market_checkout') {
      return [{ k: 'exit', entry: 'stair_door' }, { k: 'transfer', from: 'stair_door', to: 'market_front' },
        { k: 'goto', area: 'market_aisles' }, { k: 'dwell', min: 0.5 + a.rng() }, { k: 'service', poi: 'market_checkout' },
        { k: 'exit', entry: 'market_front' }, { k: 'transfer', from: 'market_front', to: 'stair_door' }, { k: 'gohome' }];
    }
    return [{ k: 'exit', entry: 'stair_door' }, { k: 'done' }];
  }

  function afterCafe(a, t, task) {
    const heard = log.heardBy(a, t, nameOf);
    const late = a.waitTotal / a.tolerance;
    const w = { cafe_seating: a.archetypeId === 'office' ? 1.1 - 0.4 * late : 1.4, leave: 0.8 + 0.5 * late };
    const probs = noisyProbs(a.rng, w);
    const u = seedRng(seed, 'decide', a.id, a.decisionIndex)();
    const action = sampleKey(probs, u);
    const fr = a.waitTotal > 3 ? frustrationAnswer(a.rng, a.waitTotal / a.tolerance * 2) : null;
    if (fr) a.frustration = fr.expected;
    const summary = action === 'cafe_seating' ? 'sat down to eat in the café' : 'took lunch to go';
    log.record({
      t, agent: a, kind: 'choose', why: 'next', aboutPlace: 'cafe_counter',
      options: [{ key: 'cafe_seating', label: 'Find a seat in the café' }, { key: 'leave', label: 'Take it to go' }],
      asks: { choice: 'next_place', yesNo: null, frustration: !!fr, tellOthers: false },
      now: 'Just got their order at the Café counter. Choosing what to do next.',
      places: [{ option: 'cafe_seating', name: 'Café seating', line: 'no line' }], heard,
      auto: { action: 'leave' },
      decision: { choiceProbs: probs, ...(fr ? { frustration: fr } : {}), latencyMs: Math.round(90 + a.rng() * 120) },
      applied: { yes: null, action, tell: false, remarkKind: null, frustration: fr?.expected ?? null, summary }
    });
    trace(a, t, summary);
    think(a, t);
    const rest = [];
    if (action === 'cafe_seating') rest.push({ k: 'goto', area: 'cafe_seating' }, { k: 'dwell', min: 12 + a.rng() * 16 });
    rest.push({ k: 'exit', entry: task.entry });
    if (task.returnTo) rest.push({ k: 'transfer', from: task.entry, to: 'stair_door' }, { k: 'gohome' });
    return rest;
  }

  // Join a line? Judged by the head count a person can see (the app adds minutes for those who have it).
  // atDoor: the line is visible from the entrance, so they decide as they walk in.
  function lineDecision(a, t, poi, atDoor = false) {
    const n = poi.queue.length;
    const est = estWait(poi);
    const limit = headLimit(a, poi);
    const heard = log.heardBy(a, t, nameOf);
    const aboutHere = heard.filter(h => h.endsWith(poi.name)).length;
    const yesProb = clamp(sigmoid((limit - n) / 1.8) * 0.94 + 0.03 - 0.07 * aboutHere, 0.02, 0.98);
    const u = seedRng(seed, 'decide', a.id, a.decisionIndex);
    const yes = u() < yesProb;
    const fr = frustrationAnswer(a.rng, (a.frustration ?? 0) * 0.5 + n / limit * 1.6);
    a.frustration = fr.expected;
    const tellProb = clamp(0.08 + 0.12 * fr.expected, 0, 0.7);
    u();
    const tell = !yes && u() < tellProb;
    const remarkProbs = { long_line: 0.78, bad_service: 0.17, good_experience: 0.05 };
    const remarkKind = tell ? sampleKey(remarkProbs, u()) : null;
    const summary = yes ? `joined the line at ${poi.name}` : atDoor ? `saw the line at ${poi.name} and left` : `walked away from the line at ${poi.name}`;
    const feel = n < 0.6 * limit ? 'well within what they will put up with' : n < 1.1 * limit ? 'about the most they will put up with' : 'more than they will put up with';
    const ahead = `${n} ${n === 1 ? 'person is' : 'people are'} in line${a.informed ? ` (the app says about ${Math.max(1, Math.round(est))} min)` : ''}`;
    log.record({
      t, agent: a, kind: 'line', why: atDoor ? 'door' : null, placeId: poi.id, aboutPlace: poi.id,
      options: [{ key: 'leave', label: 'Skip it and leave' }],
      asks: { choice: 'next_place', yesNo: 'join', frustration: true, tellOthers: true },
      now: atDoor ? `Just walked in. ${ahead} at ${poi.name}: ${feel}.` : `Just reached ${poi.name}. ${ahead}: ${feel}.`,
      places: placesFor(a, [poi.id]), heard,
      auto: { action: n > limit ? 'no' : 'yes' },
      decision: { yesProb: +yesProb.toFixed(3), choiceProbs: { leave: 1 }, frustration: fr, tellProb: +tellProb.toFixed(3), remarkProbs, latencyMs: Math.round(90 + a.rng() * 140) },
      applied: { yes, action: yes ? null : 'leave', tell, remarkKind, frustration: fr.expected, summary }
    });
    if (remarkKind) log.remark({ t, agent: a, kind: remarkKind, placeId: poi.id });
    trace(a, t, summary);
    think(a, t);
    return yes;
  }

  function longDecision(a, t, poi, waited) {
    const left = Math.max(0.5, estWait(poi) * (poi.queue.indexOf(a) + 1) / Math.max(1, poi.queue.length));
    const tol = tolAt(a, poi);
    const yesProb = clamp(sigmoid((tol * 1.4 - waited - left) / (0.3 * tol)) * 0.9 + 0.05, 0.03, 0.97);
    const u = seedRng(seed, 'decide', a.id, a.decisionIndex);
    const yes = u() < yesProb;
    const fr = frustrationAnswer(a.rng, 1 + waited / tol * 1.5);
    a.frustration = fr.expected;
    const tellProb = clamp(0.12 + 0.13 * fr.expected, 0, 0.8);
    u();
    const tell = u() < tellProb * (yes ? 0.4 : 1);
    const remarkProbs = { long_line: 0.7, bad_service: 0.28, good_experience: 0.02 };
    const remarkKind = tell ? sampleKey(remarkProbs, u()) : null;
    const summary = yes ? `kept waiting at ${poi.name}` : `gave up waiting at ${poi.name}`;
    log.record({
      t, agent: a, kind: 'long', placeId: poi.id, aboutPlace: poi.id,
      options: [{ key: 'leave', label: 'Give up and leave' }],
      asks: { choice: 'next_place', yesNo: 'keep_waiting', frustration: true, tellOthers: true },
      now: `Has waited ${Math.round(waited)} minutes in line at ${poi.name}. About ${Math.max(1, Math.round(left))} more minutes expected.`,
      places: placesFor(a, [poi.id]), heard: log.heardBy(a, t, nameOf),
      auto: { action: waited > tol * 1.3 ? 'no' : 'yes' },
      decision: { yesProb: +yesProb.toFixed(3), choiceProbs: { leave: 1 }, frustration: fr, tellProb: +tellProb.toFixed(3), remarkProbs, latencyMs: Math.round(90 + a.rng() * 140) },
      applied: { yes, action: yes ? null : 'leave', tell, remarkKind, frustration: fr.expected, summary }
    });
    if (remarkKind) log.remark({ t, agent: a, kind: remarkKind, placeId: poi.id });
    trace(a, t, summary);
    think(a, t);
    return yes;
  }

  // After walking away or giving up: leave through the nearest way out on this floor.
  function bailOut(a) {
    const exits = [...pois.values()].filter(p => p.kind === 'entry' && p.fi === a.fi);
    const fieldDist = e => field(a.fi, e.cell)[a.cell];
    const e = exits.sort((p, q) => fieldDist(p) - fieldDist(q))[0];
    const rest = [{ k: 'exit', entry: e.id }];
    if (a.home && e.fi !== a.home.fi) rest.push({ k: 'transfer', from: e.id, to: 'stair_door' }, { k: 'gohome' });
    a.leaving = true;
    return rest;
  }

  // ---------- movement ----------
  function walkToward(a, f) {
    const F = floors[a.fi];
    if (!Number.isFinite(f[a.cell])) {
      // Target unreachable from here (a gap in the scan): hop to the nearest reachable cell instead of freezing.
      let best = -1, bestD = Infinity;
      for (let i = 0; i < f.length; i++) if (Number.isFinite(f[i]) && F.grid.free[i]) {
        const [x, y] = cellCenter(F.grid, i);
        const d = Math.hypot(x - a.x, y - a.y);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) return true;
      F.occ[a.cell] = Math.max(0, F.occ[a.cell] - 1);
      a.cell = best; F.occ[best]++;
      [a.x, a.y] = cellCenter(F.grid, best);
    }
    a.budget = Math.min(a.budget + a.speed, 3);
    while (a.budget >= 1) {
      if (f[a.cell] === 0) { a.budget = 0; return true; }
      const cap = a.stuck > 5 ? 99 : a.stuck > 2 ? 2 : 1;
      let best = -1, bestD = f[a.cell], bestW = 1;
      for (const [j, w] of neighbours(F.grid, a.cell)) {
        if (f[j] < bestD - 1e-6 && F.occ[j] < cap) { bestD = f[j]; best = j; bestW = w; }
      }
      if (best < 0) { a.stuck++; a.budget = Math.min(a.budget, 1); return false; }
      a.stuck = 0;
      F.occ[a.cell] = Math.max(0, F.occ[a.cell] - 1);
      F.occ[best]++;
      a.cell = best;
      a.budget -= bestW;
    }
    [a.x, a.y] = cellCenter(F.grid, a.cell);
    return f[a.cell] === 0;
  }

  function slideTo(a, tx, ty) {
    const step = a.speed * floors[a.fi].grid.cell;
    const d = Math.hypot(tx - a.x, ty - a.y);
    if (d <= step) { a.x = tx; a.y = ty; return true; }
    a.x += (tx - a.x) / d * step; a.y += (ty - a.y) / d * step;
    return false;
  }

  // ---------- frames ----------
  const frames = {
    mode: 'visit', stride: 5,
    nodes: [...pois.values()].map(p => ({ id: p.id, name: p.name, kind: p.kind, x: +p.x.toFixed(2), y: +p.y.toFixed(2), floor: p.fi })),
    services: services.map(s => s.id),
    list: []
  };
  const counters = { served: 0, abandoned: 0, arrived: 0 };

  // ---------- main loop ----------
  const ticks = Math.round(duration * 60);
  const frameEvery = Math.max(1, Math.round(frameEverySec));
  let si = 0;
  for (let tick = 0; tick <= ticks; tick++) {
    const t = tick * DT;
    while (si < schedule.length && schedule[si].t <= t) {
      const a = makeAgent(schedule[si].arch, t);
      a.tasks = planFor(a, t);
      counters.arrived++;
      trace(a, t, a.archetypeId === 'office' ? 'left their desk' : `arrived at ${nameOf(a.archetypeId === 'cafe' ? 'cafe_front' : a.archetypeId === 'shopper' ? 'market_front' : 'stair_door')}`);
      si++;
    }

    // Service points: start serving whoever is at the head of the line.
    for (const poi of services) {
      poi.busy.forEach((b, k) => {
        if (b && t >= b.until) {
          const a = b.agent;
          poi.busy[k] = null;
          claim(a, poi.serverCells[k]);
          a.servedCount++; counters.served++; poi.served++;
          a.placesDone.push(poi.name);
          a.svc = null;
          a.tasks.shift();
          trace(a, t, `was served at ${poi.name}`);
        }
      });
      for (let k = 0; k < poi.busy.length; k++) {
        if (poi.busy[k] || !poi.queue.length) continue;
        const a = poi.queue.find(q => q.svc?.phase === 'queued' && t >= q.thinkUntil);
        if (!a) continue;
        poi.queue.splice(poi.queue.indexOf(a), 1);
        const waited = t - a.svc.since;
        a.waitTotal += waited; poi.waitMin += waited;
        a.svc.phase = 'serving';
        a.svc.server = k;
        const dur = poi.serviceTime * (0.6 + a.rng() * 0.8);
        poi.busy[k] = { agent: a, until: t + dur };
      }
    }

    for (const a of agents) {
      if (a.doneAt != null) continue;
      if (t < a.thinkUntil) { a.state = S.think; continue; }
      const task = a.tasks[0];
      if (!task) { a.doneAt = t; hide(a); continue; }
      switch (task.k) {
        case 'choose_lunch': a.tasks = chooseLunch(a, t); break;
        case 'after_cafe': a.tasks = afterCafe(a, t, task); break;
        case 'goto': {
          if (task.cell == null) { const s = spot(task.area, a.rng); task.cell = s.cell; task.fi = s.fi; }
          a.state = a.leaving ? S.leave : S.walk;
          if (walkToward(a, field(a.fi, task.cell)) || field(a.fi, task.cell)[a.cell] < 1.5) a.tasks.shift();
          break;
        }
        case 'dwell': {
          if (task.until == null) task.until = t + task.min;
          a.state = S.serve;
          if (t >= task.until) a.tasks.shift();
          break;
        }
        case 'exit': {
          const e = need(task.entry);
          a.state = a.leaving || a.servedCount ? S.leave : S.walk;
          if (walkToward(a, field(a.fi, e.cell))) {
            trace(a, t, `left through the ${e.name}`);
            a.tasks.shift();
            if (!a.tasks.length || a.tasks[0].k === 'done') { a.doneAt = t; hide(a); }
          }
          break;
        }
        case 'transfer': {
          if (task.until == null) { hide(a); task.until = t + linkSeconds(task.from, task.to) / 60 * (0.85 + a.rng() * 0.3); }
          if (t >= task.until) {
            const e = need(task.to);
            const cell = floors[e.fi].occ[e.cell] < 2 ? e.cell : nearestFree(floors[e.fi].grid, e.x + (a.rng() - 0.5) * 3, e.y + (a.rng() - 0.5) * 3);
            place(a, e.fi, cell);
            a.tasks.shift();
          }
          break;
        }
        case 'gohome': {
          a.state = S.walk;
          if (walkToward(a, field(a.home.fi, a.home.cell))) { trace(a, t, 'got back to their desk'); a.doneAt = t; hide(a); }
          break;
        }
        case 'done': a.doneAt = t; hide(a); break;
        case 'service': {
          const poi = need(task.poi);
          if (!a.svc) a.svc = { phase: 'approach', poi: poi.id };
          const sv = a.svc;
          if (sv.phase === 'approach') {
            a.state = a.leaving ? S.leave : S.walk;
            if (task.atDoor && !sv.decided) {
              sv.decided = true;
              if (poi.queue.length >= 3 && !lineDecision(a, t, poi, true)) {
                a.abandons++; counters.abandoned++; poi.abandons++;
                a.svc = null;
                a.tasks = bailOut(a);
                break;
              }
            }
            const f = field(a.fi, poi.cell);
            const tail = poi.slots[Math.min(poi.queue.length, poi.slots.length - 1)];
            const tailD = f[tail] ?? 0;
            walkToward(a, f);
            if (f[a.cell] <= tailD + 3) {
              const ask = !sv.decided && poi.queue.length >= 4;
              if (ask && !lineDecision(a, t, poi)) {
                a.abandons++; counters.abandoned++; poi.abandons++;
                a.svc = null;
                a.tasks = bailOut(a);
                break;
              }
              sv.phase = 'queued'; sv.since = t; sv.asked = false;
              release(a);
              poi.queue.push(a);
              if (!ask && !sv.decided) trace(a, t, `joined the line at ${poi.name}`);
            }
          } else if (sv.phase === 'queued') {
            a.state = S.queue;
            const idx = poi.queue.indexOf(a);
            const slot = poi.slots[Math.min(idx, poi.slots.length - 1)];
            const [sx, sy] = cellCenter(floors[a.fi].grid, slot);
            slideTo(a, sx, sy);
            const waited = t - sv.since;
            if (!sv.asked && waited > tolAt(a, poi) && waited > 4) {
              sv.asked = true;
              if (!longDecision(a, t, poi, waited)) {
                poi.queue.splice(idx, 1);
                a.waitTotal += waited; poi.waitMin += waited;
                a.abandons++; counters.abandoned++; poi.abandons++;
                a.svc = null;
                claim(a, -1);
                a.tasks = bailOut(a);
              }
            }
          } else if (sv.phase === 'serving') {
            a.state = S.serve;
            const [sx, sy] = cellCenter(floors[a.fi].grid, poi.serverCells[sv.server]);
            slideTo(a, sx, sy);
          }
          break;
        }
        default: a.tasks.shift();
      }
    }

    if (tick % frameEvery === 0) {
      const arr = [];
      let active = 0;
      for (const a of agents) {
        if (a.doneAt != null || !a.visible) continue;
        active++;
        arr.push(a.id, Math.round((a.x + a.jx * (a.state === S.queue ? 0.3 : 1)) * 10), Math.round((a.y + a.jy * (a.state === S.queue ? 0.3 : 1)) * 10), a.state, a.fi);
      }
      frames.list.push({
        t: +t.toFixed(4), a: arr, q: services.map(s => s.queue.length),
        c: { active, served: counters.served, abandoned: counters.abandoned, arrived: counters.arrived }
      });
    }
  }

  // ---------- results ----------
  for (const s of services) for (const a of s.queue) { const w = duration - a.svc.since; a.waitTotal += w; s.waitMin += w; }
  const doneAgents = agents.filter(a => a.servedCount || a.abandons);
  const metrics = {
    spawned: agents.length, served: counters.served, abandoned: counters.abandoned,
    abandonRate: agents.length ? +(counters.abandoned / agents.length).toFixed(3) : 0,
    avgWait: doneAgents.length ? +(doneAgents.reduce((x, a) => x + a.waitTotal, 0) / doneAgents.length).toFixed(2) : 0,
    bottlenecks: services.map(s => ({ id: s.id, name: s.name, waitMinutes: +s.waitMin.toFixed(1), abandoned: s.abandons, served: s.served, score: +(s.waitMin + 30 * s.abandons).toFixed(1) }))
      .sort((a, b) => b.score - a.score),
    remarks: { total: log.remarks.length },
    decisions: { total: log.decisions.length, byProvider: { mock: log.decisions.length } }
  };
  spec.nodes = [...pois.values()].map(p => ({ id: p.id, name: p.name, kind: p.kind, x: p.x, y: p.y, floor: p.fi, servers: p.servers, serviceTime: p.serviceTime }));
  spec.archetypes = Object.entries(CAST).map(([id, c]) => ({ id, name: c.name, patience: c.tolerance, share: (mix[id] || 0) / Object.values(mix).reduce((x, y) => x + y, 0) }));
  spec.minds = Object.entries(CAST).flatMap(([arch, c]) => c.personas.map(p => ({ ...p, archetypeId: arch })));

  return {
    meta: {
      runId: `mock-building-${geometry.source?.modelId || 'synthetic'}-s${seed}`, createdAt: null, status: 'done',
      title, question, mode: 'visit', duration, clockStart, seed, provider: 'mock', model: 'mock-1',
      decisions: log.decisions.length, agents: agents.length,
      providerStats: { provider: 'mock', model: 'mock-1', requests: log.decisions.length, cacheHits: 0, fallbacks: 0, errors: 0, priceNote: 'Mock run: no Jev calls were made.' },
      simOpts: { seed, dt: DT, frameEvery: frameEvery * DT }
    },
    spec, metrics, frames,
    agents: agents.map(agentSummary),
    remarks: log.remarks,
    decisions: log.decisions
  };
}

// Queue positions behind a service point: march along (dx, dy), snaking back when blocked.
function queueSlots(g, x, y, dx, dy, spacing, max) {
  const slots = [];
  const seen = new Set();
  let cx = x + dx * spacing, cy = y + dy * spacing;
  let dirX = dx, dirY = dy;
  const px = -dy, py = dx;
  for (let k = 0; k < max * 3 && slots.length < max; k++) {
    const i = cellIndex(g, cx, cy);
    if (i >= 0 && g.free[i] && !seen.has(i)) { slots.push(i); seen.add(i); cx += dirX * spacing; cy += dirY * spacing; continue; }
    // Blocked: shift one row sideways and reverse direction.
    cx += px * spacing * 1.6 - dirX * spacing; cy += py * spacing * 1.6 - dirY * spacing;
    dirX = -dirX; dirY = -dirY;
    if (k > max * 2) break;
  }
  if (!slots.length) slots.push(nearestFree(g, x, y));
  return slots;
}
