#!/usr/bin/env node
// Compares a hand count of real arrivals at a counter (TALLY_SHEET.md) with Jev's chance of joining the line
// from the last probe run (validation/jev-line-probe.js, the "people" version: head count and staff, no minutes).
//
// Usage: node validation/livestream/compare.js <tally.csv> [--probe data/validation/jev-line-probe.json]
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BUCKETS = [[0, 0], [1, 2], [3, 4], [5, 6], [7, 9], [10, Infinity]];
export const OUTCOMES = ['joined', 'walked_away', 'left_line', 'no_line'];
const label = ([lo, hi]) => (lo === hi ? `${lo}` : hi === Infinity ? `${lo}+` : `${lo}-${hi}`);

// Plain CSV with a header row; quoted fields may hold commas.
export function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map(c => c.trim()));
  }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// Rows that count: a known outcome, a whole in_line count and staff count, and no note starting with "skip".
export function cleanRows(raw) {
  const rows = [], dropped = [];
  for (const [i, r] of raw.entries()) {
    const inLine = Number(r.in_line), staff = Number(r.staff), outcome = String(r.outcome || '').toLowerCase();
    const why = /^skip/i.test(r.note || '') ? 'note says skip'
      : !OUTCOMES.includes(outcome) ? `outcome "${r.outcome}" is not one of ${OUTCOMES.join(', ')}`
      : !Number.isInteger(inLine) || inLine < 0 ? `in_line "${r.in_line}" is not a whole number`
      : !Number.isInteger(staff) || staff < 1 ? `staff "${r.staff}" is not a whole number of 1 or more` : null;
    if (why) dropped.push({ row: i + 2, why });
    else rows.push({ inLine: outcome === 'no_line' ? 0 : inLine, staff, outcome });
  }
  return { rows, dropped };
}

// Joined = joined, left_line (joined first) or no_line; walked_away did not.
export const joinedLine = r => r.outcome !== 'walked_away';

export function tally(rows, probe) {
  const people = probe?.summary?.people ?? probe?.summary?.headcount;
  const jevAt = (ahead, staff) => {
    if (!people) return null;
    const s = people.curve[String(Math.min(3, Math.max(1, staff)))];
    return s ? s[Math.min(s.length - 1, ahead)] : null;
  };
  return BUCKETS.map(b => {
    const inB = rows.filter(r => r.inLine >= b[0] && r.inLine <= b[1]);
    const jev = inB.length ? inB.reduce((sum, r) => sum + (jevAt(r.inLine, r.staff) ?? NaN), 0) / inB.length : null;
    const byStaff = {};
    for (const r of inB) (byStaff[r.staff] ??= []).push(r);
    return {
      bucket: label(b), n: inB.length,
      joined: inB.length ? inB.filter(joinedLine).length / inB.length : null,
      leftLine: inB.length ? inB.filter(r => r.outcome === 'left_line').length / inB.length : null,
      jev: Number.isFinite(jev) ? jev : null,
      byStaff: Object.fromEntries(Object.entries(byStaff).map(([s, rs]) => [s, { n: rs.length, joined: rs.filter(joinedLine).length / rs.length }]))
    };
  });
}

const pct = x => (x == null ? '  -  ' : `${Math.round(x * 100)}%`.padStart(5));

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const i = args.indexOf('--probe');
  const probePath = resolve(ROOT, i >= 0 ? args[i + 1] : 'data/validation/jev-line-probe.json');
  if (!file) { console.error('Usage: node validation/livestream/compare.js <tally.csv> [--probe <probe.json>]'); process.exit(1); }
  const { rows, dropped } = cleanRows(parseCsv(readFileSync(resolve(file), 'utf8')));
  const probe = existsSync(probePath) ? JSON.parse(readFileSync(probePath, 'utf8')) : null;
  if (!probe) console.log(`No probe results at ${probePath}; run node validation/jev-line-probe.js for the Jev column.`);
  console.log(`${rows.length} arrivals counted${dropped.length ? `, ${dropped.length} rows left out:` : '.'}`);
  for (const d of dropped) console.log(`  row ${d.row}: ${d.why}`);
  console.log('\nIn line   Arrivals   Joined   Left the line   Jev joins');
  for (const t of tally(rows, probe)) {
    const small = t.n > 0 && t.n < 10 ? '  (under 10 arrivals: too few to read)' : '';
    console.log(`${t.bucket.padEnd(8)}  ${String(t.n).padStart(8)}   ${pct(t.joined)}   ${pct(t.leftLine).padStart(13)}   ${pct(t.jev).padStart(9)}${small}`);
  }
  console.log('\nSame line length, different staff (the deli test), buckets with two or more staff levels:');
  let any = false;
  for (const t of tally(rows, probe)) {
    const levels = Object.entries(t.byStaff);
    if (levels.length < 2) continue;
    any = true;
    console.log(`  ${t.bucket} in line: ${levels.map(([s, v]) => `${s} staff ${pct(v.joined).trim()} of ${v.n}`).join(', ')}`);
  }
  if (!any) console.log('  none: every bucket was seen with one staff level only.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
