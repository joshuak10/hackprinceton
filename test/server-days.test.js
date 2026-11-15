// GET /api/days?pool=pools/<name>.json (docs/PROTOTYPE.md §21f): the saved results of the multi-day loop for a pool.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/server.js';

const POOL = 'pools/sushi-restaurant.json';
const effect = (before, after) => ({ before, after, mean: after - before, min: after - before, max: after - before, agrees: after !== before });
const saved = (createdAt, pool, results) => ({
  createdAt, pool, provider: 'jev', days: 8, seeds: [7, 8, 9],
  baselines: [{ seed: 7, run: { meta: { daysPerWeek: 1, dayName: 'Friday evening', regular: { visits: 2, days: 4 }, shopName: 'the sushi restaurant' }, people: [{ secret: 'not sent' }] } }],
  results: results.map(([label, served]) => ({ change: { label, from: 0, to: 8 }, arms: [{ run: { people: [] } }], effects: { servedPerWeek: effect(24, served) } }))
});

describe('GET /api/days', () => {
  let root, srv;
  const get = async query => {
    const res = await fetch(`${srv.url}/api/days${query}`);
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarm-days-'));
    srv = await startServer({ port: 0, root });
  });
  after(async () => {
    await srv.close();
    await rm(root, { recursive: true, force: true });
  });

  test('nothing saved on this computer', async () => {
    const { status, body } = await get(`?pool=${POOL}`);
    assert.equal(status, 200);
    assert.deepEqual(body, { pool: POOL, found: false, meta: null, results: [] });
  });

  test('results are merged across files, and the newest wins for a repeated label', async () => {
    const dir = join(root, 'data', 'days');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sushi.json'), JSON.stringify(saved('2026-11-14T20:00:00.000Z', POOL, [['2 more seats (Counter seats)', 27], ['20% off for the first week', 24]])));
    await writeFile(join(dir, 'sushi-more.json'), JSON.stringify(saved('2026-11-14T23:00:00.000Z', POOL, [['2 more seats (Counter seats)', 28], ['Meals 15% quicker (Counter seats)', 26]])));
    await writeFile(join(dir, 'cafe.json'), JSON.stringify(saved('2026-11-14T23:30:00.000Z', 'pools/alder-pine-cafe.json', [['1 more staff', 99]])));
    await writeFile(join(dir, 'broken.json'), '{ not json');

    const { status, body } = await get(`?pool=${encodeURIComponent(POOL)}`);
    assert.equal(status, 200);
    assert.equal(body.found, true);
    assert.deepEqual(body.results.map(r => [r.label, r.effects.servedPerWeek.after, r.file]), [
      ['2 more seats (Counter seats)', 28, 'sushi-more.json'],
      ['Meals 15% quicker (Counter seats)', 26, 'sushi-more.json'],
      ['20% off for the first week', 24, 'sushi.json']
    ]);
    assert.deepEqual([body.results[0].days, body.results[0].runs, body.results[0].provider], [8, 3, 'jev']);
    assert.deepEqual(body.meta, { daysPerWeek: 1, dayName: 'Friday evening', regular: { visits: 2, days: 4 }, shopName: 'the sushi restaurant' });
    assert.ok(!JSON.stringify(body).includes('not sent'), 'the runs themselves stay on the server');
  });

  test('the pool is a name, not a path to read', async () => {
    for (const bad of ['', '?pool=', '?pool=../../etc/passwd', '?pool=pools/../.env.local', '?pool=/etc/passwd', '?pool=pools/a/b.json', '?pool=data/days/sushi.json']) {
      const { status, body } = await get(bad);
      assert.equal(status, 400, bad);
      assert.match(body.error, /pools\/<name>\.json/);
    }
    const res = await fetch(`${srv.url}/api/days?pool=${POOL}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 405);
  });
});
