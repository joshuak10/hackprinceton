// Tests for engine/env.js: .env parsing and loading into process.env.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, loadEnv, hasKey } from '../engine/env.js';

describe('parseEnv', () => {
  test('parses plain pairs and ignores blanks and comments', () => {
    const out = parseEnv('# comment\n\nA=1\n  B = two  \n   # indented comment\nC=\n');
    assert.deepEqual(out, { A: '1', B: 'two', C: '' });
  });

  test('accepts an export prefix', () => {
    assert.deepEqual(parseEnv('export KEY=val\nexport   OTHER = x'), { KEY: 'val', OTHER: 'x' });
  });

  test('strips matching quotes and keeps their contents verbatim', () => {
    const out = parseEnv(`D="double quoted"\nS='single quoted'\nH="has # hash"\nE=""\nM="mismatch'`);
    assert.equal(out.D, 'double quoted');
    assert.equal(out.S, 'single quoted');
    assert.equal(out.H, 'has # hash');
    assert.equal(out.E, '');
    assert.equal(out.M, `"mismatch'`);
  });

  test('strips inline comments from unquoted values only', () => {
    const out = parseEnv('A=value # trailing\nB=no#space\nC=url=http://x/?a=b');
    assert.equal(out.A, 'value');
    assert.equal(out.B, 'no#space');
    assert.equal(out.C, 'url=http://x/?a=b');
  });

  test('handles CRLF line endings', () => {
    assert.deepEqual(parseEnv('A=1\r\nB=2\r\n'), { A: '1', B: '2' });
  });

  test('skips malformed lines and later duplicates win', () => {
    const out = parseEnv('not a pair\n1BAD=x\n=novalue\nGOOD=1\nGOOD=2');
    assert.deepEqual(out, { GOOD: '2' });
  });

  test('tolerates non-string input', () => {
    assert.deepEqual(parseEnv(undefined), {});
    assert.deepEqual(parseEnv(''), {});
  });
});

describe('loadEnv', () => {
  const NAMES = ['SWTEST_A', 'SWTEST_B', 'SWTEST_C', 'SWTEST_EMPTY', 'SWTEST_ONLY_ENV'];
  let dir, saved;

  beforeEach(() => {
    saved = {};
    for (const n of NAMES) { saved[n] = process.env[n]; delete process.env[n]; }
    dir = mkdtempSync(join(tmpdir(), 'swarmscope-env-'));
  });

  afterEach(() => {
    for (const n of NAMES) {
      if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('loads variables and returns names only, never values', () => {
    writeFileSync(join(dir, '.env'), 'SWTEST_A=secret-value-1\nSWTEST_B=secret-value-2\n');
    const loaded = loadEnv({ cwd: dir });
    assert.deepEqual(loaded.sort(), ['SWTEST_A', 'SWTEST_B']);
    assert.ok(loaded.every(x => typeof x === 'string' && !x.includes('secret')));
    assert.equal(process.env.SWTEST_A, 'secret-value-1');
    assert.equal(process.env.SWTEST_B, 'secret-value-2');
  });

  test('does not override existing variables but fills empty ones', () => {
    process.env.SWTEST_A = 'already';
    process.env.SWTEST_EMPTY = '';
    writeFileSync(join(dir, '.env'), 'SWTEST_A=fromfile\nSWTEST_EMPTY=filled\nSWTEST_B=new\n');
    const loaded = loadEnv({ cwd: dir });
    assert.equal(process.env.SWTEST_A, 'already');
    assert.equal(process.env.SWTEST_EMPTY, 'filled');
    assert.equal(process.env.SWTEST_B, 'new');
    assert.ok(!loaded.includes('SWTEST_A'));
    assert.deepEqual(loaded.sort(), ['SWTEST_B', 'SWTEST_EMPTY']);
  });

  test('.env.local wins over .env, which still supplies the rest', () => {
    writeFileSync(join(dir, '.env.local'), 'SWTEST_A=local\nSWTEST_B=local-b\n');
    writeFileSync(join(dir, '.env'), 'SWTEST_A=base\nSWTEST_C=base-c\nSWTEST_ONLY_ENV=only\n');
    const loaded = loadEnv({ cwd: dir });
    assert.equal(process.env.SWTEST_A, 'local');
    assert.equal(process.env.SWTEST_B, 'local-b');
    assert.equal(process.env.SWTEST_C, 'base-c');
    assert.equal(process.env.SWTEST_ONLY_ENV, 'only');
    assert.equal(loaded.filter(n => n === 'SWTEST_A').length, 1);
  });

  test('missing files are fine and load nothing', () => {
    assert.deepEqual(loadEnv({ cwd: dir }), []);
  });

  test('custom files list is honored', () => {
    writeFileSync(join(dir, '.env'), 'SWTEST_A=ignored\n');
    writeFileSync(join(dir, 'custom.env'), 'SWTEST_B=custom\n');
    assert.deepEqual(loadEnv({ cwd: dir, files: ['custom.env'] }), ['SWTEST_B']);
    assert.equal(process.env.SWTEST_A, undefined);
  });

  test('hasKey is true only for non-blank strings', () => {
    assert.equal(hasKey('SWTEST_A'), false);
    process.env.SWTEST_A = '   ';
    assert.equal(hasKey('SWTEST_A'), false);
    process.env.SWTEST_A = 'k';
    assert.equal(hasKey('SWTEST_A'), true);
  });
});

describe('loadEnv key aliases', () => {
  const NAMES = ['TYPESAFE_API_KEY', 'JEV_API_KEY'];
  let dir, saved;
  beforeEach(() => {
    saved = {};
    for (const n of NAMES) { saved[n] = process.env[n]; delete process.env[n]; }
    dir = mkdtempSync(join(tmpdir(), 'swarmscope-env-alias-'));
  });
  afterEach(() => {
    for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
    rmSync(dir, { recursive: true, force: true });
  });

  test('JEV_API_KEY stands in for TYPESAFE_API_KEY when that is unset or empty', () => {
    writeFileSync(join(dir, '.env.local'), 'JEV_API_KEY=jev-secret\nTYPESAFE_API_KEY=\n');
    const loaded = loadEnv({ cwd: dir });
    assert.equal(process.env.TYPESAFE_API_KEY, 'jev-secret');
    assert.ok(hasKey('TYPESAFE_API_KEY'));
    assert.ok(loaded.includes('TYPESAFE_API_KEY'));
    assert.ok(loaded.every(x => !x.includes('secret')));
  });

  test('TYPESAFE_API_KEY wins when both are set', () => {
    writeFileSync(join(dir, '.env.local'), 'JEV_API_KEY=jev-secret\nTYPESAFE_API_KEY=typesafe-secret\n');
    loadEnv({ cwd: dir });
    assert.equal(process.env.TYPESAFE_API_KEY, 'typesafe-secret');
  });

  test('neither set: nothing is invented', () => {
    writeFileSync(join(dir, '.env.local'), 'OTHER=1\n');
    loadEnv({ cwd: dir });
    assert.equal(hasKey('TYPESAFE_API_KEY'), false);
  });
});
