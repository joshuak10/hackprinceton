// swarm matterport-search (docs/PROTOTYPE.md §13e): finding models by name and saying which have a floor plan.
// No network: searchModels is tested with a fake fetch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SEARCH_QUERY, searchModels, floorSummaries } from '../builder/matterport.js';

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });

describe('searching Matterport models', () => {
  test('sends the words and returns ids and names', async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url, init }); return reply(200, { data: { models: { totalResults: 691, results: [{ id: 'abc123', name: 'Medical Office' }, { id: 'def456', name: 'Office' }, { name: 'no id' }] } } }); };
    const out = await searchModels({ query: '  medical office ', limit: 2, tokenId: 'token-id', tokenSecret: 'token-secret', fetch });
    assert.deepEqual(out, { total: 691, models: [{ id: 'abc123', name: 'Medical Office' }, { id: 'def456', name: 'Office' }] });
    assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('token-id:token-secret').toString('base64')}`);
    assert.deepEqual(JSON.parse(calls[0].init.body), { query: SEARCH_QUERY, variables: { q: 'medical office', n: 2 } });
    const all = await searchModels({ query: '', tokenId: 'token-id', tokenSecret: 'token-secret', fetch });
    assert.equal(JSON.parse(calls[1].init.body).variables.q, '*', 'no words lists everything');
    assert.equal(all.total, 691);
  });

  test('errors never carry the credentials', async () => {
    await assert.rejects(searchModels({ query: 'office', tokenId: '', tokenSecret: '' }), /credentials are missing/);
    const denied = async () => reply(401, { errors: [{ message: 'bad token token-secret for token-id' }] });
    await assert.rejects(searchModels({ query: 'office', tokenId: 'token-id', tokenSecret: 'token-secret', fetch: denied }), err => {
      assert.match(err.message, /HTTP 401/);
      assert.ok(!err.message.includes('token-secret') && !err.message.includes('token-id'), err.message);
      return true;
    });
    const empty = async () => reply(200, { data: {} });
    await assert.rejects(searchModels({ query: 'office', tokenId: 'token-id', tokenSecret: 'token-secret', fetch: empty }), /has no models/);
  });

  test('a floor with walls and doors is usable; a model without rooms has no floors to offer', async () => {
    const raw = JSON.parse(await readFile(new URL('./fixtures/matterport/sample-model.json', import.meta.url), 'utf8'));
    const floors = floorSummaries(raw.data ?? raw);
    assert.ok(floors.length >= 1);
    assert.ok(floors.some(f => f.usable && f.walls >= 4 && f.doors >= 1 && f.rooms >= 1 && f.areaM2 > 0), JSON.stringify(floors));
    assert.deepEqual(floorSummaries({ model: { floors: [{ id: 'f1', sequence: 0, label: 'Floor 1' }], rooms: [] } }), []);
  });
});
