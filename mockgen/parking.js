// Mock run: a busy Saturday at a retail center's parking lot. Cars queue at the entrance, circulate
// one-way aisles looking for a space (stalls are held from arrival to exit), drivers walk to the store and
// back, and the lot's exit meters cars onto the street. Output is a RunBundle (docs/PROTOTYPE.md §9b).
import {
  seedRng, clamp, waitWords, sigmoid, arrivalTimes, pick, noisyProbs, sampleKey, frustrationAnswer,
  DecisionLog, agentSummary
} from './common.js';

const S = { walk: 0, queue: 1, serve: 2, think: 3, leave: 4, drive: 5 };
const DT = 1 / 60;

const CAST = {
  errands: { name: 'Errand runners', tolerance: 6, walkPref: 30, personas: [
    { id: 'rosa', name: 'Rosa Delgado', age: 41, about: 'Picking up a prescription and groceries with two kids in the car', wants: 'a space close to the door', listens_to: 'the neighborhood group chat', app: true },
    { id: 'ben', name: 'Ben Carter', age: 35, about: 'Grabbing supplies between kids\' soccer games', wants: 'to be in and out in twenty minutes', listens_to: 'his partner', app: false }
  ] },
  weekly: { name: 'Weekly shoppers', tolerance: 9, walkPref: 55, personas: [
    { id: 'helen', name: 'Helen Park', age: 63, about: 'Does the big weekly shop every Saturday', wants: 'a space wide enough for her cart', listens_to: 'her sister', app: false },
    { id: 'marcus', name: 'Marcus Reed', age: 29, about: 'Meal-preps for the week on Saturdays', wants: 'any space, he does not mind walking', listens_to: 'friends', app: true }
  ] },
  browsers: { name: 'Browsers', tolerance: 5, walkPref: 40, personas: [
    { id: 'ava', name: 'Ava Nguyen', age: 24, about: 'Stopping by on the way to meet friends', wants: 'to look around without a hassle', listens_to: 'social media', app: true },
    { id: 'frank', name: 'Frank Moretti', age: 58, about: 'Heard there is a sale on garden tools', wants: 'to check the sale and leave if it is a zoo', listens_to: 'his neighbor', app: false }
  ] }
};
const DEFAULT_MIX = { errands: 140, weekly: 120, browsers: 90 };

export function runParking(geometry, opts = {}) {
  const {
    seed = 7, duration = 120, clockStart = 12 * 60 + 30, frameEverySec = 4, mix = DEFAULT_MIX, staffStalls = 34,
    title = 'Saturday at the retail center parking lot',
    question = 'Where does this center lose shoppers on a busy Saturday, and what is the cheapest fix?'
  } = opts;
  const L = geometry.lot;
  const mpu = geometry.metersPerUnit;
  const u = m => m / mpu;                        // metres → map units
  const spec = {
    title, question, mode: 'visit', duration, clockStart,
    context: 'A busy Saturday afternoon at a retail center. Drivers are deciding whether to pull in, where to park, and whether the store is worth the wait.',
    geometry
  };
  const log = new DecisionLog({ seed, spec });
  const pois = new Map(geometry.floors[0].pois.map(p => [p.id, p]));
  const nameOf = id => pois.get(id)?.name || (id === 'lot' ? 'the parking lot' : id);

  // ---------- one-way circulation loop ----------
  const { left, leftB, right, perimeterY, streetY, entryX, exitX } = L.lanes;
  const [a1, a2, a3] = L.aisles.map(a => a.y);
  const loopPts = [
    [entryX, perimeterY], [left, perimeterY], [left, a1], [right, a1], [right, a2], [leftB, a2], [leftB, a3], [right, a3], [right, perimeterY], [exitX, perimeterY], [entryX, perimeterY]
  ];
  const loop = polyline(loopPts);
  const sExit = loop.at.findIndex(p => p[0] === exitX && p[1] === perimeterY);
  const S_EXIT = loop.cum[sExit];
  const entryPath = polyline([[entryX - 34, streetY + 2], [entryX, streetY + 2], [entryX, perimeterY]]);   // the queue backs up along the street
  const exitPath = polyline([[exitX, perimeterY], [exitX, streetY + 2], [exitX + 14, streetY + 2]]);
  const LOOP_LEN = loop.length;
  const GAP = u(6.5);

  // Each stall's access point on the loop: the aisle segment passing it.
  const aisleSeg = [2, 4, 6];                    // loop segment index for aisle 1, 2, 3
  const stalls = L.stalls.map(st => {
    const seg = aisleSeg[st.aisle];
    const [p0] = [loop.at[seg]];
    const sAccess = loop.cum[seg] + Math.abs(st.x - p0[0]);
    const walk = Math.abs(st.x - 50) + Math.abs(st.y - L.store.door[1]) * 1.05;   // map units, along aisle + walkway
    return { ...st, sAccess, walkM: walk * mpu, holder: null, staff: false };
  });
  // Staff park in the best spaces near the store first (the classic lever: move staff parking).
  const rngW = seedRng(seed, 'world');
  [...stalls].sort((p, q) => p.walkM - q.walkM).slice(0, Math.round(staffStalls * 1.6))
    .filter(() => rngW() < 0.62).slice(0, staffStalls).forEach(st => { st.staff = true; st.holder = 'staff'; });

  // ---------- agents ----------
  const agents = [];
  const schedule = [];
  const rngA = seedRng(seed, 'arrivals');
  const shapes = {
    errands: { start: 0, end: duration - 15, peaks: [{ t: 45, sd: 18, w: 1 }], base: 0.4 },
    weekly: { start: 0, end: duration - 30, peaks: [{ t: 35, sd: 15, w: 1 }], base: 0.3 },
    browsers: { start: 0, end: duration - 10, peaks: [{ t: 60, sd: 20, w: 1 }], base: 0.5 }
  };
  for (const [arch, n] of Object.entries(mix)) for (const t of arrivalTimes(rngA, n, shapes[arch])) schedule.push({ t, arch });
  schedule.sort((a, b) => a.t - b.t);

  const entryQueue = [];      // cars on the driveway / street waiting to merge
  const exitQueue = [];       // cars on the exit driveway waiting for a gap in street traffic
  const onLoop = [];          // cars circulating
  const checkout = { queue: [], busy: new Array(7).fill(null), serviceTime: 2.4, waitMin: 0, abandons: 0, served: 0 };
  const place = { entry_drive: { waitMin: 0, abandons: 0 }, search: { waitMin: 0, abandons: 0 }, checkout, exit_drive: { waitMin: 0, abandons: 0 } };
  const counters = { served: 0, abandoned: 0, arrived: 0 };
  let nextExitAt = 0;

  function makeAgent(arch, t) {
    const id = agents.length + 1;
    const rng = seedRng(seed, 'agent', id);
    const persona = pick(rng, CAST[arch].personas);
    const a = {
      id, rng, archetypeId: arch, groupName: CAST[arch].name, persona, personaId: persona.id,
      informed: persona.app && rng() < 0.8, tolerance: CAST[arch].tolerance * (0.7 + rng() * 0.6),
      walkPrefM: CAST[arch].walkPref * (0.7 + rng() * 0.7),
      shopMin: arch === 'weekly' ? 28 + rng() * 22 : arch === 'errands' ? 12 + rng() * 12 : 10 + rng() * 25,
      mode: 'street', state: S.drive, x: entryX, y: streetY + 2, s: 0, loops: 0, born: t, doneAt: null,
      waitTotal: 0, servedCount: 0, abandons: 0, frustration: null, decisionIndex: 0, placesDone: [], trace: [],
      thinkUntil: 0, searchSince: null, stall: null, path: null, pathS: 0
    };
    agents.push(a);
    return a;
  }
  const trace = (a, t, m) => a.trace.push({ t: +t.toFixed(2), m });
  const think = (a, t) => { a.thinkUntil = t + (2 + a.rng() * 2) * DT; };

  const freeStalls = () => stalls.filter(s => !s.holder).length;
  const lotWords = () => {
    const f = freeStalls() / stalls.length;
    return f < 0.04 ? 'full, cars circling' : f < 0.12 ? 'nearly full' : f < 0.35 ? 'busy' : 'plenty of spaces';
  };

  // ---------- decisions ----------
  function entryDecision(a, t) {
    const qlen = entryQueue.length;
    const seenFull = a.informed ? 1 - freeStalls() / stalls.length : 0;
    const yesProb = clamp(sigmoid((6 - qlen) / 2.2 - seenFull * 2.2 + 1.2) * 0.94 + 0.03, 0.03, 0.97);
    const r = seedRng(seed, 'decide', a.id, a.decisionIndex);
    const yes = r() < yesProb;
    const fr = frustrationAnswer(a.rng, qlen / 4);
    a.frustration = fr.expected;
    const summary = yes ? 'turned into the lot' : 'drove past the lot without entering';
    log.record({
      t, agent: a, kind: 'line', placeId: 'entry_drive', aboutPlace: 'entry_drive',
      options: [{ key: 'leave', label: 'Drive past and shop somewhere else' }],
      asks: { choice: 'next_place', yesNo: 'join', frustration: true, tellOthers: false },
      now: `Just reached the lot entrance. ${qlen} cars are waiting to turn in.${a.informed ? ` The parking app says the lot is ${lotWords()}.` : ''}`,
      places: [{ option: 'entry_drive', name: 'Lot entrance', line: waitWords(qlen * 0.15) }], heard: log.heardBy(a, t, nameOf),
      auto: { action: qlen > 6 ? 'no' : 'yes' },
      decision: { yesProb: +yesProb.toFixed(3), choiceProbs: { leave: 1 }, frustration: fr, latencyMs: Math.round(90 + a.rng() * 140) },
      applied: { yes, action: yes ? null : 'leave', tell: false, remarkKind: null, frustration: fr.expected, summary }
    });
    trace(a, t, summary);
    think(a, t);
    return yes;
  }

  function keepSearching(a, t) {
    const searched = t - a.searchSince;
    const yesProb = clamp(sigmoid((a.tolerance * 1.2 - searched) / (0.35 * a.tolerance)) * 0.9 + 0.04, 0.03, 0.96);
    const r = seedRng(seed, 'decide', a.id, a.decisionIndex);
    const yes = r() < yesProb;
    const fr = frustrationAnswer(a.rng, 1 + searched / a.tolerance * 1.6);
    a.frustration = fr.expected;
    const tellProb = clamp(0.1 + 0.14 * fr.expected, 0, 0.8);
    r();
    const tell = r() < tellProb * (yes ? 0.3 : 1);
    const remarkProbs = { long_line: 0.82, bad_service: 0.16, good_experience: 0.02 };
    const remarkKind = tell ? sampleKey(remarkProbs, r()) : null;
    const summary = yes ? 'kept circling for a space' : 'drove off without parking';
    log.record({
      t, agent: a, kind: 'long', placeId: 'search', aboutPlace: 'search',
      options: [{ key: 'leave', label: 'Give up and drive off' }],
      asks: { choice: 'next_place', yesNo: 'keep_waiting', frustration: true, tellOthers: true },
      now: `Has circled the lot for ${Math.round(searched)} minutes without finding a space. The lot looks ${lotWords()}.`,
      places: [{ option: 'search', name: 'Parking lot', line: lotWords() }], heard: log.heardBy(a, t, nameOf),
      auto: { action: searched > a.tolerance ? 'no' : 'yes' },
      decision: { yesProb: +yesProb.toFixed(3), choiceProbs: { leave: 1 }, frustration: fr, tellProb: +tellProb.toFixed(3), remarkProbs, latencyMs: Math.round(90 + a.rng() * 140) },
      applied: { yes, action: yes ? null : 'leave', tell, remarkKind, frustration: fr.expected, summary }
    });
    if (remarkKind) log.remark({ t, agent: a, kind: remarkKind, placeId: 'search' });
    trace(a, t, summary);
    think(a, t);
    return yes;
  }

  function checkoutDecision(a, t) {
    const est = (checkout.queue.length / checkout.busy.length) * checkout.serviceTime;
    if (!(est > 3 && est > 0.5 * a.tolerance)) return true;
    const yesProb = clamp(sigmoid((a.tolerance * 1.6 - est) / (0.35 * a.tolerance)) * 0.92 + 0.05, 0.03, 0.97);
    const r = seedRng(seed, 'decide', a.id, a.decisionIndex);
    const yes = r() < yesProb;
    const fr = frustrationAnswer(a.rng, (a.frustration ?? 0) * 0.5 + est / a.tolerance * 1.5);
    a.frustration = fr.expected;
    const tellProb = clamp(0.08 + 0.12 * fr.expected, 0, 0.7);
    r();
    const tell = !yes && r() < tellProb;
    const remarkProbs = { long_line: 0.75, bad_service: 0.22, good_experience: 0.03 };
    const remarkKind = tell ? sampleKey(remarkProbs, r()) : null;
    const summary = yes ? 'joined the checkout line' : 'left the store without buying';
    log.record({
      t, agent: a, kind: 'line', placeId: 'checkout', aboutPlace: 'checkout',
      options: [{ key: 'leave', label: 'Put the items back and leave' }],
      asks: { choice: 'next_place', yesNo: 'join', frustration: true, tellOthers: true },
      now: `Ready to pay. The checkout line is ${waitWords(est)}.`,
      places: [{ option: 'checkout', name: 'Store checkout', line: waitWords(est) }], heard: log.heardBy(a, t, nameOf),
      auto: { action: est > a.tolerance ? 'no' : 'yes' },
      decision: { yesProb: +yesProb.toFixed(3), choiceProbs: { leave: 1 }, frustration: fr, tellProb: +tellProb.toFixed(3), remarkProbs, latencyMs: Math.round(90 + a.rng() * 140) },
      applied: { yes, action: yes ? null : 'leave', tell, remarkKind, frustration: fr.expected, summary }
    });
    if (remarkKind) log.remark({ t, agent: a, kind: remarkKind, placeId: 'checkout' });
    trace(a, t, summary);
    return yes;
  }

  // Which stall, if any, a driver takes as they pass `s`. Pickier on the first lap.
  function stallAt(a, s0, s1) {
    const accept = a.walkPrefM + a.loops * 45;
    let best = null;
    for (const st of stalls) {
      if (st.holder || st.sAccess < s0 || st.sAccess > s1) continue;
      if (st.walkM > accept) continue;
      if (!best || st.walkM < best.walkM) best = st;
    }
    return best;
  }

  // Pedestrians cross the aisles on the walkway; cars yield.
  const crossing = [false, false, false];
  function carMustYield(c) {
    const seg = loop.segAt(c.s);
    const ai = aisleSeg.indexOf(seg);
    if (ai < 0 || !crossing[ai]) return false;
    const [x] = loop.point(c.s);
    const dx = (50 - x) * Math.sign(loop.at[seg + 1][0] - loop.at[seg][0]);
    return dx > 0 && dx < u(9);
  }

  // ---------- frames ----------
  const frames = {
    mode: 'visit', stride: 4,
    nodes: geometry.floors[0].pois.map(p => ({ id: p.id, name: p.name, kind: p.kind, x: p.x, y: p.y, floor: 0 })),
    services: ['entry_drive', 'search', 'checkout', 'exit_drive'],
    list: []
  };

  const ticks = Math.round(duration * 60);
  const frameEvery = Math.max(1, Math.round(frameEverySec));
  const carSpeed = u(4.2), walkSpeed = u(1.3);
  let si = 0;
  for (let tick = 0; tick <= ticks; tick++) {
    const t = tick * DT;
    while (si < schedule.length && schedule[si].t <= t) {
      const a = makeAgent(schedule[si].arch, t);
      counters.arrived++;
      trace(a, t, 'arrived at the lot entrance');
      if (entryQueue.length >= 3 && !entryDecision(a, t)) {
        a.abandons++; counters.abandoned++; place.entry_drive.abandons++;
        a.mode = 'passing'; a.state = S.drive; a.pathS = 0; a.path = polyline([[entryX, streetY + 2], [entryX + 40, streetY + 2]]);
      } else {
        a.mode = 'entering'; a.state = S.queue; a.queuedAt = t;
        entryQueue.push(a);
      }
      si++;
    }

    // Pedestrian crossings this tick.
    crossing.fill(false);
    for (const a of agents) {
      if (a.mode !== 'walkIn' && a.mode !== 'walkOut') continue;
      if (Math.abs(a.x - 50) > u(4.5)) continue;
      L.aisles.forEach((ai, k) => { if (Math.abs(a.y - ai.y) < u(4)) crossing[k] = true; });
    }

    // Entry driveway: first car merges when the loop has a gap at s = 0.
    entryQueue.forEach((a, k) => {
      const [x, y] = entryPath.point(Math.max(0, entryPath.length - (k + 0.5) * u(6.5)));
      a.x = x; a.y = y;
      a.state = t < a.thinkUntil ? S.think : S.queue;
    });
    if (entryQueue.length && t >= entryQueue[0].thinkUntil) {
      const blocked = onLoop.some(c => { const d = (c.s - 0 + LOOP_LEN) % LOOP_LEN; return d < GAP || LOOP_LEN - d < GAP * 0.6; });
      if (!blocked) {
        const a = entryQueue.shift();
        const waited = t - a.queuedAt;
        a.waitTotal += waited; place.entry_drive.waitMin += waited;
        a.mode = 'search'; a.s = 0; a.loops = 0; a.searchSince = t; a.lastS = 0;
        onLoop.push(a);
        trace(a, t, 'started looking for a space');
      }
    }

    // Cars on the loop, front to back so following uses updated positions.
    onLoop.sort((p, q) => q.s - p.s);
    for (const c of [...onLoop]) {
      if (t < c.thinkUntil) { c.state = S.think; continue; }
      if (c.parkingUntil != null) {
        c.state = S.queue;
        if (t >= c.parkingUntil) {
          onLoop.splice(onLoop.indexOf(c), 1);
          c.parkingUntil = null;
          const st = c.stall;
          c.x = st.x; c.y = st.y;
          const searched = t - c.searchSince;
          place.search.waitMin += searched; c.waitTotal += searched;
          c.mode = 'walkIn'; c.state = S.walk;
          c.path = walkPath(st, true); c.pathS = 0;
          trace(c, t, `parked ${Math.round(st.walkM)} m from the door after ${Math.max(1, Math.round(searched))} min`);
        }
        continue;
      }
      // Gap to the car ahead.
      let gap = Infinity;
      for (const o of onLoop) {
        if (o === c) continue;
        const d = (o.s - c.s + LOOP_LEN) % LOOP_LEN;
        if (d > 0 && d < gap) gap = d;
      }
      let step = carSpeed;
      if (gap - GAP < step) step = Math.max(0, gap - GAP);
      if (carMustYield(c)) step = 0;
      c.state = step < carSpeed * 0.3 ? S.queue : S.drive;
      const s0 = c.s, s1 = c.s + step;
      if (c.mode === 'search') {
        const st = stallAt(c, s0, s1 + 0.01);
        if (st) {
          st.holder = c.id; c.stall = st; c.s = st.sAccess; c.parkingUntil = t + (5 + c.rng() * 4) / 60;
          [c.x, c.y] = loop.point(c.s);
          continue;
        }
      }
      // Crossing the exit junction: leaving cars exit; searching cars decide whether to keep going.
      if (s0 < S_EXIT && s1 >= S_EXIT) {
        if (c.mode === 'leaving') {
          onLoop.splice(onLoop.indexOf(c), 1);
          c.mode = 'exiting'; c.queuedAt = t; exitQueue.push(c);
          continue;
        }
        if (c.mode === 'search') {
          c.loops++;
          if (!keepSearching(c, t)) {
            c.abandons++; counters.abandoned++; place.search.abandons++;
            const searched = t - c.searchSince;
            place.search.waitMin += searched; c.waitTotal += searched;
            onLoop.splice(onLoop.indexOf(c), 1);
            c.mode = 'exiting'; c.queuedAt = t; exitQueue.push(c);
            continue;
          }
        }
      }
      c.s = s1 >= LOOP_LEN ? s1 - LOOP_LEN : s1;
      [c.x, c.y] = loop.point(c.s);
    }

    // Exit driveway: one car every few seconds onto the street.
    exitQueue.forEach((a, k) => {
      const [x, y] = exitPath.point(Math.min(exitPath.length, u(10) - k * u(6.5) > 0 ? u(10) - k * u(6.5) : 0));
      a.x = x; a.y = y; a.state = S.queue;
    });
    if (exitQueue.length && t >= nextExitAt) {
      const a = exitQueue.shift();
      const waited = t - a.queuedAt;
      a.waitTotal += waited; place.exit_drive.waitMin += waited;
      a.mode = 'passing'; a.state = S.drive; a.path = polyline([[exitX, streetY + 2], [exitX + 18, streetY + 2]]); a.pathS = 0;
      nextExitAt = t + (5 + a.rng() * 5) / 60;
    }

    // Walking, shopping and driving off along simple paths.
    for (const a of agents) {
      if (a.doneAt != null) continue;
      if (a.mode === 'passing') {
        a.pathS += carSpeed;
        [a.x, a.y] = a.path.point(a.pathS);
        if (a.pathS >= a.path.length) { a.doneAt = t; trace(a, t, 'left'); }
      } else if (a.mode === 'walkIn') {
        a.pathS += walkSpeed;
        [a.x, a.y] = a.path.point(a.pathS);
        if (a.pathS >= a.path.length) {
          a.mode = 'shopping'; a.until = t + a.shopMin; a.state = S.serve;
          a.placesDone.push('Store');
          trace(a, t, 'went into the store');
        }
      } else if (a.mode === 'shopping') {
        if (t >= a.until) {
          if (checkoutDecision(a, t)) { a.mode = 'checkout'; a.queuedAt = t; checkout.queue.push(a); }
          else {
            a.abandons++; counters.abandoned++; checkout.abandons++;
            a.mode = 'walkOut'; a.state = S.leave; a.path = walkPath(a.stall, false); a.pathS = 0;
          }
        }
      } else if (a.mode === 'paid') {
        a.mode = 'walkOut'; a.state = S.leave; a.path = walkPath(a.stall, false); a.pathS = 0;
      } else if (a.mode === 'walkOut') {
        a.pathS += walkSpeed;
        [a.x, a.y] = a.path.point(a.pathS);
        if (a.pathS >= a.path.length) {
          a.mode = 'unparking'; a.until = t + (6 + a.rng() * 6) / 60; a.state = S.queue;
          [a.x, a.y] = [a.stall.x, a.stall.y];
          trace(a, t, 'got back to the car');
        }
      } else if (a.mode === 'unparking') {
        if (t >= a.until) {
          const s = a.stall.sAccess;
          const blocked = onLoop.some(c => { const d = (c.s - s + LOOP_LEN) % LOOP_LEN; return d < GAP * 0.7 || LOOP_LEN - d < GAP; });
          if (!blocked) {
            a.stall.holder = null;
            a.mode = 'leaving'; a.s = s; a.state = S.drive;
            [a.x, a.y] = loop.point(s);
            onLoop.push(a);
          }
        }
      }
    }

    // Checkout inside the store.
    checkout.busy.forEach((b, k) => {
      if (b && t >= b.until) {
        checkout.busy[k] = null;
        b.agent.servedCount++; counters.served++; checkout.served++;
        b.agent.mode = 'paid';
        trace(b.agent, t, 'paid at checkout');
      }
    });
    for (let k = 0; k < checkout.busy.length; k++) {
      if (checkout.busy[k] || !checkout.queue.length) continue;
      const a = checkout.queue.shift();
      const waited = t - a.queuedAt;
      a.waitTotal += waited; checkout.waitMin += waited;
      checkout.busy[k] = { agent: a, until: t + checkout.serviceTime * (0.5 + a.rng()) };
    }

    if (tick % frameEvery === 0) {
      const arr = [];
      let inside = 0, active = 0;
      for (const a of agents) {
        if (a.doneAt != null) continue;
        if (a.mode === 'shopping' || a.mode === 'checkout' || a.mode === 'paid') { inside++; continue; }
        active++;
        const st = t < a.thinkUntil ? S.think : a.state;
        arr.push(a.id, Math.round(a.x * 10), Math.round(a.y * 10), st);
      }
      let hex = '';
      for (let i = 0; i < stalls.length; i += 4) {
        let nib = 0;
        for (let b = 0; b < 4; b++) if (stalls[i + b]?.holder) nib |= 1 << b;
        hex += nib.toString(16);
      }
      const searching = onLoop.filter(c => c.mode === 'search').length;
      frames.list.push({
        t: +t.toFixed(4), a: arr, h: hex,
        q: [entryQueue.length, searching, checkout.queue.length, exitQueue.length],
        c: { active, inside, served: counters.served, abandoned: counters.abandoned, arrived: counters.arrived, free: freeStalls() }
      });
    }
  }

  const pl = Object.entries(place).map(([id, p]) => ({ id, name: nameOf(id), waitMinutes: +p.waitMin.toFixed(1), abandoned: p.abandons, score: +(p.waitMin + 30 * p.abandons).toFixed(1) }))
    .sort((a, b) => b.score - a.score);
  const metrics = {
    spawned: agents.length, served: counters.served, abandoned: counters.abandoned,
    abandonRate: agents.length ? +(counters.abandoned / agents.length).toFixed(3) : 0,
    avgWait: +(agents.reduce((x, a) => x + a.waitTotal, 0) / Math.max(1, agents.length)).toFixed(2),
    stalls: stalls.length, staffStalls,
    bottlenecks: pl, remarks: { total: log.remarks.length },
    decisions: { total: log.decisions.length, byProvider: { mock: log.decisions.length } }
  };
  spec.nodes = geometry.floors[0].pois.map(p => ({ ...p, floor: 0 }));
  spec.archetypes = Object.entries(CAST).map(([id, c]) => ({ id, name: c.name, patience: c.tolerance }));
  spec.minds = Object.entries(CAST).flatMap(([arch, c]) => c.personas.map(p => ({ ...p, archetypeId: arch })));
  return {
    meta: {
      runId: `mock-parking-synthetic-s${seed}`, createdAt: null, status: 'done', title, question, mode: 'visit', duration, clockStart, seed,
      provider: 'mock', model: 'mock-1', decisions: log.decisions.length, agents: agents.length,
      providerStats: { provider: 'mock', model: 'mock-1', requests: log.decisions.length, cacheHits: 0, fallbacks: 0, errors: 0, priceNote: 'Mock run: no Jev calls were made.' },
      simOpts: { seed, dt: DT, frameEvery: frameEvery * DT }
    },
    spec, metrics, frames,
    agents: agents.map(agentSummary),
    remarks: log.remarks,
    decisions: log.decisions
  };

  // Stall → aisle → walkway → crosswalk → door (or back).
  function walkPath(st, toStore) {
    const ay = L.aisles[st.aisle].y;
    const pts = [[st.x, st.y], [st.x, ay], [50, ay], [50, 20], L.store.door];
    return polyline(toStore ? pts : pts.reverse());
  }
}

function polyline(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const length = cum[cum.length - 1];
  const segAt = s => {
    const x = clamp(s, 0, length);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < x) i++;
    return i - 1;
  };
  const point = s => {
    const x = clamp(s, 0, length);
    const i = segAt(x);
    const seg = cum[i + 1] - cum[i] || 1;
    const f = (x - cum[i]) / seg;
    return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
  };
  return { at: pts, cum, length, point, segAt };
}
