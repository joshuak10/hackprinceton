// POST /api/runs with a link (docs/PROTOTYPE.md §9b): a run can say which test of one change it belongs to.
// The link is validated and stored in meta.json. Without a link, runs are recorded as before.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/server.js';
import { createRecorder } from '../run/recorder.js';

const WORLD = JSON.parse(await readFile(new URL('../worlds/food-hall-lunch.json', import.meta.url), 'utf8'));
// A short world, so each rules run takes a moment.
const SPEC = { ...WORLD, duration: 20, arrivals: { ...WORLD.arrivals, total: 30 } };
const place = SPEC.nodes.find(n => n.kind === 'service' && Number(n.servers) >= 1);
const FROM = Number(place.servers);
const withStaff = n => ({ ...SPEC, nodes: SPEC.nodes.map(x => (x.id === place.id ? { ...x, servers: n } : x)) });
const change = { nodeId: place.id, from: FROM, to: FROM + 1 };

describe('POST /api/runs with a link', () => {
  let root, srv;
  const post = body => fetch(`${srv.url}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const finished = async id => {
    for (let i = 0; i < 400; i++) {
      const st = await (await fetch(`${srv.url}/api/runs/${id}/status`)).json();
      if (st.state !== 'running') return st;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('the run did not finish');
  };
  const meta = async id => (await fetch(`${srv.url}/api/runs/${id}/meta`)).json();

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarm-link-'));
    srv = await startServer({ port: 0, root });
  });
  after(async () => {
    await srv.close();
    await rm(root, { recursive: true, force: true });
  });

  test('a run without a link is recorded as before, with link null', async () => {
    const res = await post({ spec: SPEC, provider: 'rules', seed: 7 });
    assert.equal(res.status, 202);
    const { runId } = await res.json();
    assert.equal((await finished(runId)).state, 'done');
    assert.equal((await meta(runId)).link, null);
  });

  test('a baseline and its changed run store the test, the side, the base run and the change', async () => {
    const a = await post({ spec: SPEC, provider: 'rules', seed: 7, link: { test: 't-1', role: 'baseline', change } });
    assert.equal(a.status, 202);
    const baseId = (await a.json()).runId;
    await finished(baseId);
    const b = await post({
      spec: withStaff(FROM + 1), provider: 'rules', seed: 7,
      link: { test: 't-1', role: 'change', base: baseId, change: { ...change, nodeName: 'ignored: the server reads the name from the world' } }
    });
    assert.equal(b.status, 202);
    const changedId = (await b.json()).runId;
    await finished(changedId);
    const staff = { kind: 'staff', nodeId: place.id, nodeName: place.name, from: FROM, to: FROM + 1 };
    assert.deepEqual((await meta(baseId)).link, { test: 't-1', role: 'baseline', base: null, change: staff });
    assert.deepEqual((await meta(changedId)).link, { test: 't-1', role: 'change', base: baseId, change: staff });
    // The listing carries the link, so every browser can pair the two runs.
    const listed = await (await fetch(`${srv.url}/api/runs`)).json();
    assert.equal(listed.find(m => m.runId === changedId).link.base, baseId);
  });

  test('a promotion test stores its change; the world must match the side', async () => {
    const promo = { kind: 'promotion', off: 0.2 };
    const withPromo = { ...SPEC, offers: [{ id: 'promotion', text: 'Promotion today: 20% off everything for everyone who comes in.' },
      { id: `promotion_${place.id}`, text: `20% off at ${place.name} today`, place: place.id, priceOff: 0.2 }] };
    const a = await post({ spec: SPEC, provider: 'rules', seed: 7, link: { test: 'p-1', role: 'baseline', change: promo } });
    assert.equal(a.status, 202);
    const baseId = (await a.json()).runId;
    await finished(baseId);
    const b = await post({ spec: withPromo, provider: 'rules', seed: 7, link: { test: 'p-1', role: 'change', base: baseId, change: { ...promo, extra: 'dropped' } } });
    assert.equal(b.status, 202);
    const changedId = (await b.json()).runId;
    await finished(changedId);
    assert.deepEqual((await meta(baseId)).link, { test: 'p-1', role: 'baseline', base: null, change: promo });
    assert.deepEqual((await meta(changedId)).link, { test: 'p-1', role: 'change', base: baseId, change: promo });
    for (const [extra, re] of [
      [{ link: { test: 'p', role: 'change', change: promo } }, /has no offer "promotion"/],
      [{ spec: withPromo, link: { test: 'p', role: 'baseline', change: promo } }, /already has the offer "promotion"/],
      [{ link: { test: 'p', role: 'baseline', change: { kind: 'promotion', off: 2 } } }, /off must be a share/],
      [{ link: { test: 'p', role: 'baseline', change: { ...change, kind: 'discount' } } }, /kind must be "staff" or "promotion"/]
    ]) {
      const res = await post({ spec: SPEC, provider: 'rules', seed: 7, ...extra });
      assert.equal(res.status, 400, JSON.stringify(extra.link));
      assert.match((await res.json()).error, re);
    }
  });

  test('a bad link is refused and starts no run', async () => {
    const count = async () => (await (await fetch(`${srv.url}/api/runs`)).json()).length;
    const start = await count();
    const bad = [
      [{ link: 'yes' }, /link must be an object/],
      [{ link: { test: 'has space', role: 'baseline', change } }, /link\.test/],
      [{ link: { test: 't', role: 'after', change } }, /link\.role/],
      [{ link: { test: 't', role: 'baseline' } }, /link\.change must be an object/],
      [{ link: { test: 't', role: 'baseline', change: { ...change, nodeId: 'no-such-place' } } }, /must name a place/],
      [{ link: { test: 't', role: 'baseline', change: { ...change, to: FROM } } }, /different whole numbers/],
      [{ link: { test: 't', role: 'baseline', change: { ...change, to: 2.5 } } }, /different whole numbers/],
      // The world must match the side: a "change" run whose world still has the old staff count is not the change.
      [{ link: { test: 't', role: 'change', change } }, /staff in this run, but the world has/],
      [{ spec: withStaff(FROM + 1), link: { test: 't', role: 'change', base: 'no-such-run', change } }, /does not exist/],
      [{ spec: withStaff(FROM + 1), link: { test: 't', role: 'change', base: '../meta', change } }, /Invalid base run id/],
      [{ link: { test: 't', role: 'baseline', base: 'x', change } }, /only for the run with the change/]
    ];
    for (const [extra, re] of bad) {
      const res = await post({ spec: SPEC, provider: 'rules', seed: 7, ...extra });
      assert.equal(res.status, 400, JSON.stringify(extra.link));
      assert.match((await res.json()).error, re);
    }
    assert.equal(await count(), start);
  });
});

test('the recorder writes the link it is given into meta.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-link-rec-'));
  try {
    const link = { test: 't-9', role: 'baseline', base: null, change: { kind: 'staff', nodeId: 'a', nodeName: 'A', from: 1, to: 2 } };
    const rec = createRecorder({ root, spec: { title: 'T' }, seed: 1, providerName: 'rules', link });
    assert.deepEqual(rec.finish({}).link, link);
    assert.deepEqual(JSON.parse(await readFile(join(rec.dir, 'meta.json'), 'utf8')).link, link);
    assert.equal(createRecorder({ root, spec: { title: 'T' }, seed: 2, providerName: 'rules' }).finish({}).link, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
