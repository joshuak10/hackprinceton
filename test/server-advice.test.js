// GET /api/runs/:id/advice (docs/PROTOTYPE.md §15c) and a syntax check of the viewer script.
// Run folders are temporary and hold hand-made, fictional data.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/server.js';

const ADVICE = {
  answer: 'Open the walk-in clinic longer.',
  findings: ['The two big hospitals saturate.'],
  recommendations: [{
    label: 'Open Clinic A for two more hours', why: 'It absorbs the overflow.',
    effect: { avgWait: { before: 54.5, after: 31, change: -23.5, spread: 2 } },
    testedWith: 'rules, seeds 7, 8, 9', holdsAcrossSeeds: true, confidence: 'high'
  }],
  cautions: ['Rules provider only.'], nextSteps: ['Confirm with Jev.']
};

describe('GET /api/runs/:id/advice', () => {
  let root, srv;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarm-advice-'));
    await mkdir(join(root, 'runs', 'with-advice'), { recursive: true });
    await mkdir(join(root, 'runs', 'bare'), { recursive: true });
    await writeFile(join(root, 'runs', 'with-advice', 'advice.json'), JSON.stringify(ADVICE));
    await writeFile(join(root, 'runs', 'with-advice', 'advice.md'), '# Advice\n\nOpen the walk-in clinic longer.\n');
    srv = await startServer({ port: 0, root });
  });
  after(async () => {
    await srv.close();
    await rm(root, { recursive: true, force: true });
  });

  test('returns the advice and its markdown', async () => {
    const res = await fetch(`${srv.url}/api/runs/with-advice/advice`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.advice, ADVICE);
    assert.match(body.markdown, /^# Advice/);
  });

  test('404 with a JSON error when the run has no advice', async () => {
    for (const id of ['bare', 'no-such-run']) {
      const res = await fetch(`${srv.url}/api/runs/${id}/advice`);
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type'), /json/);
      assert.equal(typeof (await res.json()).error, 'string');
    }
  });

  test('rejects a bad id', async () => {
    for (const id of ['.hidden', 'a%20b', 'x'.repeat(201)]) {
      const res = await fetch(`${srv.url}/api/runs/${id}/advice`);
      assert.equal(res.status, 400, id);
      assert.equal(typeof (await res.json()).error, 'string');
    }
  });

  test('other run files still route as before', async () => {
    const res = await fetch(`${srv.url}/api/runs/bare/metrics`);
    assert.equal(res.status, 404);
  });
});

