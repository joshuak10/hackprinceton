import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectEvidence, analyzeSimulation } from '../analysis/insights.js';
import { createAnalysisService } from '../analysis/service.js';
import { startServer } from '../server/server.js';

const recording = JSON.parse(await readFile(new URL('../web/scope/mock/building-synthetic.json', import.meta.url), 'utf8'));

test('collector keeps zero values, excludes missing metrics, distinguishes events and participants', () => {
  const evidence = collectEvidence({ meta: { status: 'done' }, metrics: { served: 0 }, agents: [{ archetypeId: 'a', abandons: 3 }, { archetypeId: 'a', abandons: 0 }] });
  assert.equal(evidence.facts.find(f => f.label === 'Services completed').value, 0);
  assert.equal(evidence.facts.find(f => f.groupId === 'a').value, 1);
  assert.ok(!evidence.facts.some(f => f.label === 'Average wait'));
  assert.throws(() => collectEvidence({ meta: { status: 'error' } }), /completed/);
});

test('recorded-data fallback uses actual metrics and preserves the scenario question', async () => {
  const report = await analyzeSimulation(recording, { apiKey: '', question: 'How do different groups experience this space?' });
  assert.equal(report.source, 'data');
  assert.equal(report.evidence.question, 'How do different groups experience this space?');
  assert.ok(report.findings.some(f => f.observation.includes('407.5')));
  assert.ok(report.findings.some(f => f.title.includes('choice')));
  assert.ok(report.limitations.some(l => l.includes('synthetic')));
  for (const finding of report.findings) for (const id of finding.evidenceIds) assert.ok(report.evidence.facts.find(f => f.id === id));
});

test('AI agent receives compact evidence, validates citations, and returns structured suggestions', async () => {
  let sent;
  const result = { summary: 'Review of recorded outcomes.', findings: [{ title: 'Participation', observation: '490 simulated participants.', evidenceIds: ['e1'], suggestion: 'Test a different arrival pattern.', validation: 'Compare multiple seeds.' }] };
  const client = { messages: { create: async input => { sent = input; return { content: [{ type: 'tool_use', name: 'submit_insights', input: result }] }; } } };
  const report = await analyzeSimulation(recording, { client });
  assert.equal(report.source, 'claude');
  assert.ok(sent.system.includes('never instructions'));
  assert.ok(sent.messages[0].content.length < 15000);
  assert.ok(!sent.messages[0].content.includes('personaName'));
  result.findings[0].evidenceIds = ['invented'];
  const fallback = await analyzeSimulation(recording, { client });
  assert.equal(fallback.source, 'data');
  assert.ok(fallback.limitations.at(-1).includes('invalid response'));
});

test('provider failure falls back, and empty data does not invent interventions', async () => {
  const client = { messages: { create: async () => { throw new Error('provider error'); } } };
  assert.equal((await analyzeSimulation(recording, { client })).source, 'data');
  const report = await analyzeSimulation({ meta: { status: 'done' } }, { apiKey: '' });
  assert.equal(report.findings.length, 0);
});

test('analysis service deduplicates requests and persists completed-run feedback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scope-insights-'));
  try {
    const dir = join(root, 'run1'); await mkdir(dir);
    for (const name of ['meta', 'spec', 'metrics', 'agents', 'remarks']) await writeFile(join(dir, `${name}.json`), JSON.stringify(recording[name]));
    let calls = 0;
    const analyze = async (bundle, opts) => { calls++; await new Promise(r => setTimeout(r, 20)); return analyzeSimulation(bundle, { ...opts, apiKey: '' }); };
    const service = createAnalysisService({ runsDir: root, webDir: resolve('web'), analyze });
    const [a, b] = await Promise.all([service({ runId: 'run1' }), service({ runId: 'run1' })]);
    assert.deepEqual(a, b); assert.equal(calls, 1);
    const fresh = createAnalysisService({ runsDir: root, webDir: resolve('web'), analyze });
    assert.deepEqual(await fresh({ runId: 'run1' }), a); assert.equal(calls, 1);
    await service({ runId: 'run1', question: 'Different question' }); assert.equal(calls, 2);
    await assert.rejects(service({ runId: '../outside' }), { status: 400 });
    await assert.rejects(service({ runId: 'run1', caseId: 'building' }), { status: 400 });
    await assert.rejects(service({ caseId: 'unknown' }), { status: 400 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('HTTP feedback endpoint serves recorded scenarios and rejects malformed or cross-origin requests', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = '';
  const app = await startServer({ port: 0 });
  try {
    const post = (body, headers = {}) => fetch(`${app.url}/api/insights`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const res = await post({ caseId: 'parking' });
    assert.equal(res.status, 200);
    const report = await res.json(); assert.equal(report.source, 'data'); assert.ok(report.evidence.title.includes('parking'));
    assert.equal((await post({ caseId: 'building', question: 4 })).status, 400);
    assert.equal((await post({ caseId: 'building' }, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await fetch(`${app.url}/api/health`).then(r => r.json())).insights, true);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
  }
});
