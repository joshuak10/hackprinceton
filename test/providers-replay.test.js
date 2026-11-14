// ReplayProvider tests against hand-written run directories in the recorder's decisions.jsonl
// format (docs/PROTOTYPE.md §7). No network.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayProvider } from '../providers/replay.js';
import { JevProvider, buildJevRequest } from '../providers/jev.js';

const SPEC = { title: 'ER night', mode: 'visit', nodes: [{ id: 'st_brigid', name: "St. Brigid's ER" }, { id: 'quickcare', name: 'QuickCare' }], edges: [] };
const CTX = { seed: 7, spec: SPEC };

const person = { name: 'Samuel Reyes', age: 71, about: 'Retired teacher with a bad knee.', personality: 'patient', wants: 'get the knee looked at', listens_to: 'his daughter', group: 'Seniors', has_live_wait_app: false };

function chooseReq(id, agentId, now = 'Just arrived. Choosing where to go first.') {
  return {
    id, t: 5, clock: '20:05', kind: 'choose', why: 'start', agentId, decisionIndex: 0,
    personaId: 'samuel', personaName: 'Samuel Reyes', archetypeId: 'senior',
    placeId: null, aboutPlace: null, aboutEdge: null,
    asks: { choice: 'next_place', yesNo: null, frustration: false, tellOthers: false },
    options: [{ key: 'st_brigid', label: "Go to St. Brigid's ER" }, { key: 'quickcare', label: 'Go to QuickCare' }, { key: 'leave', label: 'Leave and go home' }],
    remarkKinds: null,
    observation: {
      setting: 'Friday night in Larkfield.', time: 'around 8:00 pm', person,
      so_far: { time_here: 'just arrived', time_in_lines: 'just arrived', places_done: [] },
      now,
      places: [
        { option: 'st_brigid', name: "St. Brigid's ER", known_for: 'full trauma center', offers: 'er, trauma', cost: 'free', distance: 'a short walk', line: "unknown (can't see it from here)" },
        { option: 'quickcare', name: 'QuickCare', known_for: 'fast for minor injuries', offers: 'urgent care', cost: 'about $40', distance: 'close', line: 'short, about 5 min' }
      ],
      heard: []
    },
    auto: { action: 'quickcare' }
  };
}

function lineReq(id, agentId) {
  const r = chooseReq(id, agentId, "Just reached St. Brigid's ER. The line is long, about 45 min: more than they will put up with.");
  return {
    ...r, kind: 'line', why: null, placeId: 'st_brigid', aboutPlace: 'st_brigid',
    asks: { choice: 'next_place', yesNo: 'join', frustration: true, tellOthers: true },
    options: r.options.filter(o => o.key !== 'st_brigid'),
    remarkKinds: [
      { key: 'long_line', label: "Warn about a long line or wait at St. Brigid's ER" },
      { key: 'bad_service', label: "Complain about bad service at St. Brigid's ER" },
      { key: 'good_experience', label: "Say St. Brigid's ER was good and quick" }
    ],
    auto: { action: 'yes' }
  };
}

const record = (req, decision) => ({
  id: req.id, t: req.t, clock: req.clock, agentId: req.agentId, personaId: req.personaId, kind: req.kind, why: req.why,
  placeId: req.placeId, options: req.options, asks: req.asks, observation: req.observation, auto: req.auto,
  decision, applied: { id: req.id, agentId: req.agentId, kind: req.kind }
});

const dirs = [];
function runDir(records, meta = null) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-replay-test-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'decisions.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  if (meta) writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}
after(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));

const jevDecision = (req, choiceProbs, model = 'jev-latest') => ({
  provider: 'jev', choiceProbs, model: 'jev-1.14.0', latencyMs: 150, usage: { input_tokens: 900, output_tokens: 90 },
  requestHash: buildJevRequest(req, { model, spec: SPEC }).requestHash,
  answers: { next_place: { type: 'choice', choice: 'quickcare', confidence: 0.5, probabilities: choiceProbs } }
});

describe('ReplayProvider', () => {
  test('matches by requestHash, then by id (same agent and kind), else falls back and counts a miss', async () => {
    const a = chooseReq('d1', 1);
    const c = chooseReq('d3', 3, 'Just finished at QuickCare. Choosing what to do next.');
    const recordedC = { ...c, observation: { ...c.observation, time: 'around 9:00 pm' } };   // different state, same id
    const dir = runDir([
      record(a, jevDecision(a, { st_brigid: 0.3, quickcare: 0.6, leave: 0.1 })),
      record(recordedC, jevDecision(recordedC, { st_brigid: 0.1, quickcare: 0.8, leave: 0.1 })),
      record(chooseReq('d4', 4, 'Just gave up waiting at QuickCare. Choosing what to do now.'), { provider: 'rules', action: 'st_brigid' })
    ]);
    const p = new ReplayProvider({ runDir: dir });
    assert.equal(p.name, 'replay');
    assert.equal(p.external, true);

    // Same state as d1 under a new id: found by hash.
    const movedA = chooseReq('d50', 1);
    const wrongAgent = chooseReq('d4', 99, 'Just walked away from the line at QuickCare. Choosing what to do now.');
    const unknown = chooseReq('d9', 9, 'Just finished at the pharmacy. Choosing what to do next.');
    const ds = await p.decideMany([a, movedA, c, wrongAgent, unknown], CTX);

    assert.equal(ds[0].provider, 'replay');
    assert.equal(ds[0].replayOf, 'jev');
    assert.deepEqual(ds[0].choiceProbs, { st_brigid: 0.3, quickcare: 0.6, leave: 0.1 });
    assert.deepEqual(ds[1].choiceProbs, ds[0].choiceProbs);
    assert.equal(ds[2].provider, 'replay');
    assert.deepEqual(ds[2].choiceProbs, { st_brigid: 0.1, quickcare: 0.8, leave: 0.1 });
    assert.equal(ds[3].provider, 'rules-fallback');
    assert.equal(ds[3].action, 'quickcare');
    assert.equal(ds[4].provider, 'rules-fallback');
    assert.match(ds[4].error, /replay miss: no recorded decision for d9/);

    const s = p.stats();
    assert.equal(s.provider, 'replay');
    assert.equal(s.decisions, 5);
    assert.equal(s.hashHits, 2);
    assert.equal(s.idHits, 1);
    assert.equal(s.misses, 2);
    assert.equal(s.fallbacks, 2);
    assert.equal(s.requests, 0);
    assert.match(s.firstError, /d4/);
  });

  test('a rules run replays by id with its recorded actions', async () => {
    const reqs = [chooseReq('d1', 1), lineReq('d2', 1)];
    const dir = runDir([record(reqs[0], { provider: 'rules', action: 'st_brigid' }), record(reqs[1], { provider: 'rules', action: 'no' })]);
    const ds = await new ReplayProvider({ runDir: dir }).decideMany(reqs, CTX);
    assert.deepEqual(ds, [
      { provider: 'replay', replayOf: 'rules', action: 'st_brigid' },
      { provider: 'replay', replayOf: 'rules', action: 'no' }
    ]);
  });

  test('among records sharing a hash, the same id wins; otherwise a real Jev answer', async () => {
    const first = chooseReq('d1', 1);
    const second = chooseReq('d2', 2);   // identical state → identical hash
    const hash = buildJevRequest(first, { spec: SPEC }).requestHash;
    const dir = runDir([
      record(first, { provider: 'rules-fallback', action: 'leave', error: 'max-requests reached', requestHash: hash }),
      record(second, jevDecision(second, { st_brigid: 0.5, quickcare: 0.5, leave: 0 }))
    ]);
    const p = new ReplayProvider({ runDir: dir });
    const [d1, d2, d3] = await p.decideMany([first, second, chooseReq('d7', 7)], CTX);
    assert.equal(d1.action, 'leave');
    assert.equal(d1.replayOf, 'rules-fallback');
    assert.equal(d2.replayOf, 'jev');
    assert.equal(d3.replayOf, 'jev');
  });

  test('uses the model name from meta.json to rebuild the hash', async () => {
    const a = chooseReq('d1', 1);
    const recordedUnderOtherId = { ...a, id: 'd77', agentId: 77 };
    const dir = runDir(
      [record(recordedUnderOtherId, jevDecision(a, { st_brigid: 1, quickcare: 0, leave: 0 }, 'jev-preview'))],
      { model: 'jev-1.14.0', providerStats: { requestedModel: 'jev-preview' } }
    );
    const p = new ReplayProvider({ runDir: dir });
    const [d] = await p.decideMany([a], CTX);
    assert.equal(d.provider, 'replay');
    assert.equal(p.stats().hashHits, 1);
    assert.equal(p.stats().model, 'jev-1.14.0');
  });

  test('round trip: a JevProvider run replays to the same decisions with zero fetch calls', async () => {
    const reqs = [chooseReq('d1', 1), lineReq('d2', 2), chooseReq('d3', 3, 'Just finished at QuickCare. Choosing what to do next.')];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const answers = {};
      for (const [name, q] of Object.entries(body.questions)) {
        if (q.type === 'noul') answers[name] = { type: 'noul', noul: 0.42 };
        else if (q.type === 'score') answers[name] = { type: 'score', score: 1, confidence: 1, legend: {}, probabilities: { 0: 0, 1: 1, 2: 0, 3: 0, 4: 0 } };
        else {
          const keys = Object.keys(q.criteria);
          answers[name] = { type: 'choice', choice: keys[0], confidence: 1, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0])) };
        }
      }
      return new Response(JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 800, output_tokens: 80 } }), { status: 200 });
    };
    const live = new JevProvider({ apiKey: 'k', fetch });
    const decisions = await live.decideMany(reqs, CTX);
    const dir = runDir(reqs.map((r, i) => record(r, decisions[i])), { model: 'jev-1.14.0', providerStats: live.stats() });

    const replayed = await new ReplayProvider({ runDir: dir }).decideMany(reqs, CTX);
    replayed.forEach((d, i) => {
      const { provider, replayOf, ...rest } = d;
      const { provider: origProvider, ...orig } = decisions[i];
      assert.equal(provider, 'replay');
      assert.equal(replayOf, origProvider);
      assert.deepEqual(rest, orig);
    });
  });

  test('clear errors for a missing runDir or a directory without decisions.jsonl', () => {
    assert.throws(() => new ReplayProvider({}), /runDir/);
    const empty = mkdtempSync(join(tmpdir(), 'swarm-replay-empty-'));
    dirs.push(empty);
    assert.throws(() => new ReplayProvider({ runDir: empty }), /decisions\.jsonl/);
  });
});
