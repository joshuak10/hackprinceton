// The server serves engine/walls.js at /walls.js (docs/PROTOTYPE.md §13d, §14d). The first viewer's map,
// which used it, was removed with that page.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.js';

// ---------- server ----------

describe('server serves engine/walls.js at /walls.js', () => {
  const STAND_IN = '// stand-in for engine/walls.js\nexport const standIn = true;\n';
  let root, bare, srv, bareSrv;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarm-walls-'));
    await mkdir(join(root, 'engine'));
    await writeFile(join(root, 'engine', 'walls.js'), STAND_IN);
    bare = await mkdtemp(join(tmpdir(), 'swarm-walls-bare-'));
    srv = await startServer({ port: 0, root });
    bareSrv = await startServer({ port: 0, root: bare });
  });
  after(async () => {
    await srv?.close();
    await bareSrv?.close();
    await rm(root, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  });

  test("GET /walls.js returns the root's engine/walls.js as JavaScript", async () => {
    const res = await fetch(`${srv.url}/walls.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/javascript\b/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await res.text(), STAND_IN);
  });

  test('HEAD answers with the headers only; other methods are refused', async () => {
    const head = await fetch(`${srv.url}/walls.js`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('content-type'), /javascript/);
    assert.equal(await head.text(), '');
    const post = await fetch(`${srv.url}/walls.js`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 405);
  });

  test("a root without engine/walls.js gets the server's own copy", async () => {
    const own = fileURLToPath(new URL('../engine/walls.js', import.meta.url));
    const res = await fetch(`${bareSrv.url}/walls.js`);
    if (existsSync(own)) {
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/javascript\b/);
      assert.equal(await res.text(), await readFile(own, 'utf8'));
    } else {
      assert.equal(res.status, 404);
    }
  });

  test('the rest of the static viewer is unchanged', async () => {
    const res = await fetch(`${srv.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const missing = await fetch(`${srv.url}/nope.js`);
    assert.equal(missing.status, 404);
  });
});
