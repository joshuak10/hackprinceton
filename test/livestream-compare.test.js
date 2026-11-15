// validation/livestream/compare.js: reading a hand count of arrivals and putting it beside Jev's join chance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, cleanRows, tally, joinedLine } from '../validation/livestream/compare.js';

const CSV = `clock,in_line,staff,outcome,group,note
12:01,3,2,joined,1,
12:02,4,2,walked_away,2,"looked, then left"
12:03,0,1,no_line,1,
12:04,4,3,joined,1,
12:05,2,2,joined,1,skip: restroom only
12:06,x,2,joined,1,
12:07,6,2,left_line,1,`;

test('parses quoted fields and drops rows that cannot count, saying why', () => {
  const raw = parseCsv(CSV);
  assert.equal(raw[1].note, 'looked, then left');
  const { rows, dropped } = cleanRows(raw);
  assert.equal(rows.length, 5);
  assert.deepEqual(dropped.map(d => d.row), [6, 7]);
  assert.match(dropped[0].why, /skip/);
  assert.match(dropped[1].why, /in_line/);
});

test('joining includes leaving the line later; walking away does not', () => {
  assert.equal(joinedLine({ outcome: 'left_line' }), true);
  assert.equal(joinedLine({ outcome: 'walked_away' }), false);
});

test('buckets by line length, splits by staff and reads Jev from the probe curve', () => {
  const { rows } = cleanRows(parseCsv(CSV));
  const curve = s => Array.from({ length: 16 }, (_, a) => s / 10 + a / 100);
  const probe = { summary: { people: { curve: { 1: curve(1), 2: curve(2), 3: curve(3) } } } };
  const t = Object.fromEntries(tally(rows, probe).map(b => [b.bucket, b]));
  assert.equal(t['0'].n, 1);
  assert.equal(t['3-4'].n, 3);
  assert.equal(t['3-4'].joined, 2 / 3);
  assert.deepEqual(t['3-4'].byStaff, { 2: { n: 2, joined: 0.5 }, 3: { n: 1, joined: 1 } });
  assert.ok(Math.abs(t['3-4'].jev - (0.23 + 0.24 + 0.34) / 3) < 1e-9);
  assert.equal(t['5-6'].leftLine, 1);
  assert.equal(tally(rows, null)[0].jev, null);
});
