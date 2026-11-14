import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RulesProvider, fallbackDecision, ruleAction } from '../providers/rules.js';

// Minimal DecisionRequests (docs/PROTOTYPE.md §4): only the fields the rules provider reads matter,
// but the shapes follow the contract.
const req = (id, kind, auto, extra = {}) => ({
  id, t: 10, clock: '08:10', kind, why: kind === 'choose' ? 'start' : null, agentId: 1, decisionIndex: 0,
  personaId: 'p', personaName: 'P', archetypeId: 'a', placeId: null, aboutPlace: null, aboutEdge: null,
  asks: { choice: kind === 'route' ? 'route' : kind === 'arrive' ? null : 'next_place', yesNo: kind === 'line' ? 'join' : null, frustration: false, tellOthers: false },
  options: kind === 'arrive' ? [] : [{ key: 'a', label: 'Go to A' }, { key: 'leave', label: 'Leave and go home' }],
  remarkKinds: null, observation: {}, auto, ...extra
});

test('inline by default; external answers req.auto.action', async () => {
  const inline = new RulesProvider();
  assert.equal(inline.name, 'rules');
  assert.equal(inline.external, false);

  const p = new RulesProvider({ external: true });
  assert.equal(p.external, true);
  const reqs = [req('d1', 'choose', { action: 'a' }), req('d2', 'line', { action: 'yes' }), req('d3', 'route', { action: 'r0' }), req('d4', 'arrive', null)];
  const ds = await p.decideMany(reqs, { seed: 7, spec: {} });
  assert.deepEqual(ds, [
    { provider: 'rules', action: 'a' },
    { provider: 'rules', action: 'yes' },
    { provider: 'rules', action: 'r0' },
    { provider: 'rules', action: undefined }
  ]);
});

test('stats count decision requests by kind', async () => {
  const p = new RulesProvider({ external: true });
  await p.decideMany([req('d1', 'choose', { action: 'a' }), req('d2', 'choose', { action: 'leave' })]);
  await p.decideMany([req('d3', 'line', { action: 'no' })]);
  const s = p.stats();
  assert.equal(s.provider, 'rules');
  assert.equal(s.requests, 3);
  assert.equal(s.decisions, 3);
  assert.deepEqual(s.byKind, { choose: 2, line: 1 });
  assert.equal(s.fallbacks, 0);
  assert.equal(s.estCostUSD, 0);
});

test('fallbackDecision and ruleAction', () => {
  assert.deepEqual(fallbackDecision(req('d1', 'choose', { action: 'a' }), 'HTTP 500'), { provider: 'rules-fallback', action: 'a', error: 'HTTP 500' });
  assert.deepEqual(fallbackDecision(req('d2', 'arrive', null), 'x', { requestHash: 'abc' }), { provider: 'rules-fallback', action: undefined, error: 'x', requestHash: 'abc' });
  assert.equal(ruleAction({}), undefined);
});
