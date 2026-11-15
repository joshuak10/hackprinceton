// "Build this place" on a real scan (docs/PROTOTYPE.md §10a): the searches for a description, choosing a scan, what
// the fit-out agent is told about the floor, the agent loop, the server routes and the page's words.
// No network and no Claude: Matterport and the agent are fakes.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanQueries, findScan, nameFits, planBrief, compileFitoutHeadless } from '../compile/scanned.js';
import { extractFloorplan } from '../builder/matterport.js';
import { validateWorld } from '../engine/spec.js';
import { scanModelId } from '../web/scope/lib/engine.js';
import { foundLine, noScanLine, fitoutFailure } from '../web/scope/lib/scan.js';
import { startServer } from '../server/server.js';

const RAW = JSON.parse(readFileSync(new URL('./fixtures/matterport/sample-model.json', import.meta.url), 'utf8'));
const MODEL = RAW.data ?? RAW;
const plan = extractFloorplan(MODEL, { floor: 0 });

// A fit-out such as the agent would write, from the brief it is given.
function fitoutFrom(brief) {
  const spots = brief.rooms.flatMap(r => r.spots.map(s => ({ x: s.x, y: s.y }))).slice(0, 3);
  return {
    title: 'Weekday lunch: Corner Office help desk (fictional fit-out)',
    question: 'Who waits at the help desk, who goes elsewhere and who gives up?',
    context: 'A small office help desk at lunch.', leaveLabel: 'Leave', clockStart: 720, duration: 90, walkMetersPerMinute: 70,
    arrivals: { total: 60, start: 0, end: 60, shape: 'peak' }, waiting: { tellPatience: false, askAgainEvery: 5 },
    gates: brief.entrances.map((e, i) => ({ id: `gate_${i + 1}`, name: `Door ${i + 1}`, at: e.gateAt, weight: 1 })),
    places: spots.map((at, i) => ({ id: `place_${i + 1}`, name: `Desk ${i + 1}`, at, servers: 1, serviceTime: 4, appeal: 0.6, price: 0, tags: [`t${i + 1}`], about: 'A desk.' })),
    archetypes: [{ id: 'visitors', name: 'Visitors', share: 1, description: 'People with a question.', info: 0, rationality: 2, weights: { appeal: 1, wait: 1, distance: 0.3, price: 0.2 }, visits: 1, patience: 20, likes: ['t1'], needs: ['t1'], entries: ['gate_1'], exits: ['gate_1'] }],
    minds: ['Ana', 'Ben', 'Cai', 'Dee'].map((name, i) => ({ id: `m${i}`, name, age: 30 + i, archetype: 'visitors', bio: 'Has a question.', personality: 'calm', goal: 'Get an answer', social: 'none', informed: false, entry: 'gate_1', weight: 1 }))
  };
}

describe('the searches for a description', () => {
  test('kind by kind in the order the words appear: the typed words, then the general searches; shells last', () => {
    const qs = scanQueries('A tiny ramen bar next to a coffee shop');
    assert.deepEqual(qs.map(q => q.query), ['ramen', 'restaurant', 'food', 'bar', 'lounge', 'coffee shop', 'cafe', 'coffee', 'bakery', 'shop', 'store', 'market', 'retail']);
    assert.deepEqual(qs.filter(q => q.typed).map(q => q.query), ['ramen', 'bar', 'coffee shop', 'shop']);
    assert.ok(qs.filter(q => q.strength === 'shell').every(q => q.query === 'retail'));
  });
  test('a dentist office is searched as a clinic before an office', () => {
    assert.deepEqual(scanQueries('A dentist office').map(q => q.query), ['dentist', 'medical', 'dental', 'clinic', 'pharmacy', 'office', 'bank', 'lobby']);
  });
  test('typed words are searched singular and without accents', () => {
    assert.deepEqual(scanQueries('Two Cafés and the bakeries').map(q => q.query), ['cafe', 'bakery', 'coffee', 'retail']);
  });
  test('a phrase of two or more words needs its first word in the name', () => {
    assert.equal(nameFits('urgent care', 'After School Care'), false);
    assert.equal(nameFits('urgent care', 'Urgent Care Center'), true);
    assert.equal(nameFits('coffee shop', 'Coffee Lounge'), true);
    assert.equal(nameFits('restaurant', '1st Floor'), true, 'one word: Matterport matched it on more than the name');
  });
  test('words that name no kind of place give no searches', () => {
    assert.deepEqual(scanQueries('A rooftop party under the stars'), []);
  });
});

describe('choosing a scan', () => {
  const fake = models => ({
    search: async ({ query }) => ({ total: (models[query] ?? []).length, models: models[query] ?? [] }),
    fetchGeometry: async ({ modelId }) => {
      if (modelId === 'emptyScan1') return { model: { id: modelId, floors: [], rooms: [] } };
      if (modelId === 'brokenScan') throw new Error('HTTP 500');
      return MODEL;
    }
  });

  test('skips homes, scans without walls and failed reads, and returns the first usable floor', async () => {
    const calls = [];
    const f = fake({ medical: [{ id: 'homeScan01', name: '3 bd Apartment' }, { id: 'emptyScan1', name: 'Medical Office' }, { id: 'brokenScan', name: 'Medical' }, { id: 'goodScan01', name: 'Medical Suite' }] });
    const out = await findScan('A walk-in clinic on Monday', { ...f, fetchGeometry: async a => { calls.push(a.modelId); return f.fetchGeometry(a); } });
    assert.deepEqual(calls, ['emptyScan1', 'brokenScan', 'goodScan01'], 'the home is never fetched');
    assert.equal(out.found.modelId, 'goodScan01');
    assert.equal(out.found.strength, 'named');
    assert.equal(out.found.floor, 0, 'the floor with the most rooms');
    assert.ok(out.found.raw && out.found.exteriorDoors >= 1);
  });

  test('falls back to a generic shell, and says why when nothing fits', async () => {
    const shell = await findScan('A walk-in clinic on Monday', fake({ office: [{ id: 'officeScan', name: 'Office - 2,600SF' }] }));
    assert.equal(shell.found.strength, 'shell');
    assert.equal(shell.found.query, 'office');
    const none = await findScan('A walk-in clinic on Monday', fake({}));
    assert.equal(none.found, null);
    assert.match(none.reason, /No scan/);
    assert.deepEqual(none.tried.map(t => t.query), ['clinic', 'medical', 'dental', 'pharmacy', 'office']);
  });

  test('a search with many results is checked deeper than its top few', async () => {
    const models = Array.from({ length: 40 }, (_, i) => ({ id: `scan${String(i).padStart(4, '0')}`, name: 'Office' }));
    const fetched = [];
    const out = await findScan('An office lobby', {
      search: async ({ query, limit }) => ({ total: 919, models: query === 'office' ? models.slice(0, limit) : [] }),
      fetchGeometry: async ({ modelId }) => { fetched.push(modelId); return modelId === 'scan0019' ? MODEL : { model: { id: modelId, floors: [], rooms: [] } }; }
    });
    assert.equal(out.found?.modelId, 'scan0019');
    assert.equal(fetched.length, 20, 'checked in groups of five, stopping after the group with the usable scan');
  });

  test('"urgent care" does not take a scan named only for "care"', async () => {
    const out = await findScan('An urgent care clinic', {
      search: async ({ query }) => ({ total: 1, models: query === 'urgent care' ? [{ id: 'careScan01', name: 'After School Care' }] : query === 'medical' ? [{ id: 'medScan001', name: 'Medical Office' }] : [] }),
      fetchGeometry: async () => MODEL
    });
    assert.equal(out.found.modelId, 'medScan001');
    assert.equal(out.tried[0].probed, 0);
  });
});

describe('what the fit-out agent is told about the floor', () => {
  const brief = planBrief(plan);
  test('the one exterior door becomes an entrance with a gate point outside the building', () => {
    assert.equal(brief.entrances.length, 1);
    const e = brief.entrances[0];
    assert.equal(e.door, 'door6');
    assert.ok(e.gateAt.x < -10, `the gate is west of the x=-10 outer wall: ${JSON.stringify(e.gateAt)}`);
    assert.equal(e.clearOutside, true);
  });
  test('rooms reached through doors get spots; the storage room with no door gets none', () => {
    const byId = Object.fromEntries(brief.rooms.map(r => [r.id, r]));
    assert.equal(byId.r_store.reachable, false);
    assert.deepEqual(byId.r_store.spots, []);
    for (const id of ['r_corr', 'r_offa', 'r_c', 'r_d']) assert.ok(byId[id].reachable, id);
    for (const r of brief.rooms) for (const s of r.spots) assert.ok(s.clearM >= 0.8, `${r.id} spot ${JSON.stringify(s)}`);
  });
});

describe('the fit-out agent loop', () => {
  test('a refused fit-out goes back with its problems; the second is placed in the real walls', async () => {
    const brief = planBrief(plan);
    const seen = [];
    let n = 0;
    const agent = async ({ instructions, goal }) => {
      seen.push(instructions('/tmp/x/fitout.json'));
      assert.match(goal('/tmp/x/fitout.json'), /^\/goal /);
      const f = fitoutFrom(brief);
      if (++n === 1) f.places[0].at = { x: -10, y: 3 };   // on the west outer wall
      return { raw: JSON.stringify(f), turns: 3, costUsd: 0.1 };
    };
    const out = await compileFitoutHeadless('A help desk at lunch', { raw: MODEL, floor: 0, modelId: 'sampleScan1', name: 'Sample', agent });
    assert.equal(out.attempts, 2);
    assert.match(seen[0], /"entrances":\[\{"door":"door6"/, 'the brief is in the instructions');
    assert.match(seen[1], /The last fit-out was refused/);
    assert.match(seen[1], /m from a wall/);
    assert.equal(out.spec.geo.source, 'matterport-vector:sampleScan1');
    assert.equal(validateWorld(out.spec).ok, true);
    assert.ok(out.spec.walls.length >= 4 && out.spec.doors.some(d => d.exterior));
    assert.equal(out.builder.costUsd, 0.2);
    assert.deepEqual(out.scan, { modelId: 'sampleScan1', name: 'Sample', floor: 0, rooms: brief.rooms.length, areaM2: brief.areaM2 });
  });

  test('gives up after the last attempt, with the problems', async () => {
    const agent = async () => ({ raw: 'not json', turns: 1, costUsd: 0 });
    await assert.rejects(compileFitoutHeadless('A help desk', { raw: MODEL, floor: 0, modelId: 'sampleScan1', agent, maxAttempts: 2 }),
      err => err.code === 'COMPILE_FAILED' && /not valid JSON/.test(err.message));
  });
});

describe('the server', () => {
  let root, srv, fitouts = [];
  const post = async (path, body) => {
    const res = await fetch(`${srv.url}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarm-scan-'));
    srv = await startServer({
      port: 0, root,
      scanService: {
        available: () => true,
        find: async d => (/clinic/.test(d)
          ? { found: { modelId: 'sampleScan1', name: 'Medical Suite', floor: 0, rooms: 9, areaM2: 240, raw: MODEL }, tried: [{ query: 'medical' }], reason: null }
          : { found: null, tried: [], reason: 'No scan of this kind of place has walls, doors and a size that fits.' }),
        fetchGeometry: async () => MODEL,
        fitout: async (description, scan) => { fitouts.push(scan); return { spec: { title: 'x' }, attempts: 1, scan: { modelId: scan.modelId } }; }
      }
    });
  });
  after(async () => { await srv.close(); await rm(root, { recursive: true, force: true }); });

  test('health says scans can be searched', async () => {
    const h = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(h.scan, true);
  });
  test('a search returns what was found, without the raw geometry', async () => {
    const { status, body } = await post('scan', { description: 'A walk-in clinic on Monday' });
    assert.equal(status, 200);
    assert.equal(body.found.modelId, 'sampleScan1');
    assert.equal('raw' in body.found, false);
    const none = await post('scan', { description: 'A rooftop party' });
    assert.equal(none.body.found, null);
    assert.match(none.body.reason, /No scan/);
    assert.equal((await post('scan', {})).status, 400);
  });
  test('a compile with a scan fits out that scan, from the search just made', async () => {
    const { status, body } = await post('compile', { description: 'A walk-in clinic on Monday', plan: true, scan: { modelId: 'sampleScan1', floor: 0 } });
    if (status === 501) return;   // no Claude Code on this machine: the route says so before fitting out
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.scan.modelId, 'sampleScan1');
    assert.equal(fitouts.at(-1).raw, MODEL);
    assert.equal(fitouts.at(-1).name, 'Medical Suite');
    assert.equal((await post('compile', { description: 'A clinic', plan: true, scan: { modelId: '../../etc' } })).status, 400);
    assert.equal((await post('compile', { description: 'A clinic', plan: true, scan: { modelId: 'sampleScan1', floor: 'x' } })).status, 400);
  });
});

describe('the page', () => {
  test('a world fitted out on a scan names it; older worlds do not', () => {
    assert.equal(scanModelId({ geo: { source: 'matterport-vector:x37LjPx62VA' } }), 'x37LjPx62VA');
    assert.equal(scanModelId({ geo: { source: 'matterport-vector' } }), null);
    assert.equal(scanModelId({ geo: { source: 'drawn' } }), null);
  });
  test('the progress line names the scan only when its name says what it is', () => {
    assert.equal(foundLine({ name: 'Salon', rooms: 2, areaM2: 126, strength: 'named', query: 'salon' }), 'Found a scanned building, "Salon": 2 rooms, 126 m²');
    assert.equal(foundLine({ name: '1st Floor ', rooms: 17, areaM2: 511, strength: 'named', query: 'restaurant' }), 'Found a scanned restaurant building: 17 rooms, 511 m²');
    assert.equal(foundLine({ name: 'Office - 2,600SF', rooms: 1, areaM2: 240, strength: 'shell', query: 'office' }), 'No scan of this kind of place; using an empty office space: 1 room, 240 m²');
    assert.match(noScanLine({ reason: 'No Matterport keys on this server.' }), /No Matterport access/);
    assert.match(noScanLine({ reason: 'The words do not name a kind of place' }), /Not a kind of place/);
    assert.match(fitoutFailure('Claude could not fit out the scanned building: Claude Code build timed out after 420000 ms.'), /ran out of time/);
    assert.match(fitoutFailure('Claude could not fit out the scanned building: Could not fit out the scan in 3 attempts. Last problems:\n- x'), /three tries/);
    assert.equal(fitoutFailure('Claude could not fit out the scanned building: HTTP 500'), 'The scan could not be used (HTTP 500).');
  });
});
