// Local HTTP API and static viewer (docs/PROTOTYPE.md §9). Node built-ins only.
//
// Engine modules are imported on first use: the viewer can still browse recorded runs if a
// module fails to load, and the optional Claude SDK behind compile loads only when asked for.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { hasKey } from '../engine/env.js';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
// The viewer loads the engine's wall geometry as /walls.js (§13d): the root's copy, else the server's own.
const OWN_WALLS = fileURLToPath(new URL('../engine/walls.js', import.meta.url));
const BODY_LIMIT = 2 * 1024 * 1024;
// Names in :file and :id. Stricter than the contract's [A-Za-z0-9._-] only in refusing a leading dot.
const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RUN_FILES = new Set(['meta', 'spec', 'metrics', 'frames', 'agents', 'remarks']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};
const CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
  "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const loaded = new Map();
async function lib(path) {
  if (!loaded.has(path)) loaded.set(path, import(new URL(path, import.meta.url).href));
  try {
    return await loaded.get(path);
  } catch (err) {
    loaded.delete(path);
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new HttpError(503, `${path.slice(3)} could not be loaded: ${String(err.message).split('\n')[0]}`);
    }
    throw err;
  }
}

export function startServer({ port = 4173, host = '127.0.0.1', root = process.cwd() } = {}) {
  const base = resolve(root);
  const ctx = {
    worldsDir: join(base, 'worlds'), runsDir: join(base, 'runs'), wallsFile: join(base, 'engine', 'walls.js'),
    loopback: LOOPBACK.has(host), jobs: new Map(), jevJob: null
  };
  const server = http.createServer((req, res) => {
    handle(ctx, req, res).catch(err => sendError(res, err));
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      const addr = server.address();
      const shown = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
      done({ server, url: `http://${shown}:${addr.port}`, close: () => close(ctx, server) });
    });
  });
}

function close(ctx, server) {
  for (const job of ctx.jobs.values()) job.controller?.abort();
  return new Promise(done => {
    server.close(() => done());
    server.closeAllConnections();
  });
}

// ---------- routing ----------

const ROUTES = [
  ['GET', ['health'], getHealth],
  ['GET', ['worlds'], getWorlds],
  ['GET', ['worlds', ':file'], getWorld],
  ['POST', ['validate'], postValidate],
  ['POST', ['compile'], postCompile],
  ['GET', ['runs'], getRuns],
  ['POST', ['runs'], postRun],
  ['GET', ['runs', ':id', 'status'], getStatus],
  ['GET', ['runs', ':id', 'agents', ':agentId'], getAgent],
  ['GET', ['runs', ':id', 'advice'], getAdvice],
  ['GET', ['runs', ':id', ':file'], getRunFile]
];

async function handle(ctx, req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/walls.js') return serveWalls(ctx, req, res);
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  const parts = url.pathname.slice(5).split('/').map(decodeSegment);
  const allowed = [];
  for (const [method, pattern, handler] of ROUTES) {
    const params = match(pattern, parts);
    if (!params) continue;
    if (method !== req.method) { allowed.push(method); continue; }
    if (method === 'POST') checkPost(ctx, req);
    return handler(ctx, req, res, params);
  }
  if (allowed.length) throw new HttpError(405, `Use ${allowed.join(' or ')} for this endpoint.`, { headers: { Allow: allowed.join(', ') } });
  throw new HttpError(404, `No API endpoint at ${url.pathname}.`);
}

function match(pattern, parts) {
  if (pattern.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(':')) params[pattern[i].slice(1)] = parts[i];
    else if (pattern[i] !== parts[i]) return null;
  }
  return params;
}

function decodeSegment(s) {
  try { return decodeURIComponent(s); } catch { throw new HttpError(400, 'The URL is not valid.'); }
}

function safeName(name, what) {
  if (!NAME_RE.test(name)) throw new HttpError(400, `Invalid ${what}: use only letters, digits, dot, dash and underscore.`);
  return name;
}

// Blocks cross-site form posts and DNS rebinding: POSTs can start paid Jev runs.
function checkPost(ctx, req) {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Send the request body as JSON with Content-Type: application/json.');
  }
  const host = req.headers.host || '';
  if (ctx.loopback && !LOOPBACK.has(host.replace(/:\d+$/, ''))) throw new HttpError(403, 'Requests must be addressed to localhost.');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) throw new HttpError(403, 'Cross-origin requests are not allowed.');
}

// ---------- responses ----------

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers
  });
  res.end(text);
}

function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error('[swarmscope server]', err);
  if (res.headersSent) { res.destroy(); return; }
  const { headers, ...extra } = err.extra ?? {};
  send(res, status, { error: err?.message || 'Internal error', ...extra }, headers);
}

async function sendFile(req, res, file, type, headers = {}) {
  let info;
  try { info = await stat(file); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
  if (!info.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...headers
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  await new Promise((done, fail) => {
    const stream = createReadStream(file);
    stream.on('error', fail);
    res.on('close', done);
    stream.pipe(res);
  });
  return true;
}

function readJson(req) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > BODY_LIMIT) return fail(new HttpError(413, 'The request body is larger than 2 MB.'));
      try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {
        fail(new HttpError(400, 'The request body is not valid JSON.'));
      }
    });
    req.on('error', fail);
  });
}

async function readJsonBody(req) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'The request body must be a JSON object.');
  return body;
}

// ---------- static viewer ----------

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'The viewer only answers GET.', { headers: { Allow: 'GET, HEAD' } });
  }
  let rel = decodeSegment(pathname);
  if (rel.includes('\0')) throw new HttpError(400, 'The URL is not valid.');
  if (rel.endsWith('/')) rel += 'index.html';
  const file = resolve(WEB_DIR, '.' + rel);
  if (!file.startsWith(WEB_DIR)) throw new HttpError(403, 'That path is outside the viewer.');
  const type = TYPES[extname(file)] || 'application/octet-stream';
  const headers = type.startsWith('text/html') ? { 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer' } : {};
  if (!(await sendFile(req, res, file, type, headers))) throw new HttpError(404, `Not found: ${pathname}`);
}

async function serveWalls(ctx, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'The viewer only answers GET.', { headers: { Allow: 'GET, HEAD' } });
  }
  for (const file of new Set([ctx.wallsFile, OWN_WALLS])) {
    if (await sendFile(req, res, file, TYPES['.js'])) return;
  }
  throw new HttpError(404, 'Not found: /walls.js (engine/walls.js is missing)');
}

// ---------- worlds ----------

function getHealth(ctx, req, res) {
  send(res, 200, { ok: true, jev: hasKey('TYPESAFE_API_KEY'), claude: hasKey('ANTHROPIC_API_KEY') });
}

const isWorld = w => w && typeof w === 'object' && !Array.isArray(w) && Array.isArray(w.nodes) && !('$schema' in w);

async function getWorlds(ctx, req, res) {
  let files;
  try { files = (await readdir(ctx.worldsDir)).filter(f => f.endsWith('.json')).sort(); } catch (err) {
    if (err.code === 'ENOENT') return send(res, 200, []);
    throw err;
  }
  const out = [];
  for (const file of files) {
    let w;
    try { w = JSON.parse(await readFile(join(ctx.worldsDir, file), 'utf8')); } catch { continue; }
    if (!isWorld(w)) continue;
    out.push({
      file, title: typeof w.title === 'string' && w.title.trim() ? w.title.trim() : file,
      mode: w.mode === 'route' ? 'route' : 'visit', question: typeof w.question === 'string' ? w.question : '',
      agents: Number.isFinite(Number(w.arrivals?.total)) ? Number(w.arrivals.total) : null,
      cast: Array.isArray(w.minds) ? w.minds.length : 0
    });
  }
  send(res, 200, out);
}

function worldPath(ctx, file) {
  safeName(file, 'world file name');
  return join(ctx.worldsDir, file.endsWith('.json') ? file : file + '.json');
}

async function getWorld(ctx, req, res, { file }) {
  if (!(await sendFile(req, res, worldPath(ctx, file), TYPES['.json']))) throw new HttpError(404, `No world named ${file}.`);
}

async function readWorld(ctx, file) {
  let text;
  try { text = await readFile(worldPath(ctx, file), 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') throw new HttpError(404, `No world named ${file}.`);
    throw err;
  }
  try { return JSON.parse(text); } catch (err) { throw new HttpError(400, `worlds/${file} is not valid JSON: ${err.message}`); }
}

async function postValidate(ctx, req, res) {
  const body = await readJsonBody(req);
  if (!('spec' in body)) throw new HttpError(400, 'Send { "spec": <world JSON> }.');
  const { validateWorld } = await lib('../engine/spec.js');
  send(res, 200, validateWorld(body.spec));
}

async function postCompile(ctx, req, res) {
  const body = await readJsonBody(req);
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) throw new HttpError(400, 'Send { "description": "a place and a question" }.');
  if (description.length > 4000) throw new HttpError(400, 'Keep the description under 4000 characters.');
  if (!hasKey('ANTHROPIC_API_KEY')) {
    throw new HttpError(501, 'Compiling a world needs ANTHROPIC_API_KEY in .env.local. Without it, run /swarm in Claude Code to write the world, then paste it here.');
  }
  const { compileWorld } = await lib('../compile/compile.js');
  let result;
  try {
    result = await compileWorld(description, { apiKey: process.env.ANTHROPIC_API_KEY });
  } catch (err) {
    throw new HttpError(502, `Claude could not compile a valid world: ${err?.message || err}`);
  }
  send(res, 200, result);
}

// ---------- runs ----------

function runDir(ctx, id) { return join(ctx.runsDir, safeName(id, 'run id')); }

async function readRunJson(ctx, id, name) {
  try { return JSON.parse(await readFile(join(runDir(ctx, id), name + '.json'), 'utf8')); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new HttpError(404, `Run ${id} has no ${name}.json.`);
    throw err;
  }
}

async function getRuns(ctx, req, res) {
  const { listRuns } = await lib('../run/recorder.js');
  send(res, 200, await listRuns(ctx.runsDir));
}

async function getRunFile(ctx, req, res, { id, file }) {
  if (!RUN_FILES.has(file)) throw new HttpError(404, `Runs have no ${file} file.`);
  if (!(await sendFile(req, res, join(runDir(ctx, id), file + '.json'), TYPES['.json']))) {
    throw new HttpError(404, ctx.jobs.get(id)?.state === 'running' ? `Run ${id} is still running.` : `Run ${id} has no ${file}.json.`);
  }
}

// The advisor's saved answer (§15c): advice.json is required, advice.md is its readable twin.
async function getAdvice(ctx, req, res, { id }) {
  const dir = runDir(ctx, id);
  const readText = async name => {
    try { return await readFile(join(dir, name), 'utf8'); } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      throw err;
    }
  };
  const json = await readText('advice.json');
  if (json === null) throw new HttpError(404, `Run ${id} has no advice yet.`);
  let advice;
  try { advice = JSON.parse(json); } catch { throw new HttpError(500, `Run ${id} has an advice.json that is not valid JSON.`); }
  send(res, 200, { advice, markdown: (await readText('advice.md')) ?? '' });
}

async function getAgent(ctx, req, res, { id, agentId }) {
  if (!/^\d{1,9}$/.test(agentId)) throw new HttpError(400, 'The agent id must be a whole number.');
  const n = Number(agentId);
  const agents = await readRunJson(ctx, id, 'agents');
  const agent = Array.isArray(agents) ? agents.find(a => a.id === n) : null;
  if (!agent) throw new HttpError(404, `Run ${id} has no agent ${n}.`);
  send(res, 200, { agent, decisions: await agentDecisions(join(runDir(ctx, id), 'decisions.jsonl'), n) });
}

// Streams decisions.jsonl, which can be tens of MB for a large Jev run.
async function agentDecisions(file, agentId) {
  const stream = createReadStream(file);
  const opened = new Promise((done, fail) => { stream.once('open', done); stream.once('error', fail); });
  try { await opened; } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const needle = `"agentId":${agentId},`;
  const out = [];
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.includes(needle)) continue;
    const d = JSON.parse(line);
    if (d.agentId === agentId) out.push(d);
  }
  return out;
}

function statusOf(job) {
  const { state, t, duration, decisions, providerStats, error } = job;
  return { state, t, duration, decisions, providerStats, error };
}

async function getStatus(ctx, req, res, { id }) {
  safeName(id, 'run id');
  const job = ctx.jobs.get(id);
  if (job) return send(res, 200, statusOf(job));
  const meta = await readRunJson(ctx, id, 'meta');
  send(res, 200, {
    state: meta.status === 'error' ? 'error' : 'done', t: meta.duration, duration: meta.duration,
    decisions: meta.decisions ?? 0, providerStats: meta.providerStats ?? null, error: meta.error ?? null
  });
}

function runOptions(body) {
  const providerName = body.provider;
  if (providerName !== 'rules' && providerName !== 'jev') throw new HttpError(400, 'provider must be "rules" or "jev".');
  const seed = body.seed === undefined || body.seed === null || body.seed === '' ? 7 : Number(body.seed);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) throw new HttpError(400, 'seed must be a whole number from 0 to 2147483647.');
  const providerOpts = {};
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !MODEL_RE.test(body.model)) throw new HttpError(400, 'model must be a model id such as "jev-latest".');
    providerOpts.model = body.model;
  }
  if (body.maxRequests !== undefined) {
    const max = Number(body.maxRequests);
    if (!Number.isInteger(max) || max < 1) throw new HttpError(400, 'maxRequests must be a positive whole number.');
    providerOpts.maxRequests = max;
  }
  const simOpts = {};
  if (body.batchWindow !== undefined) {
    const bw = Number(body.batchWindow);
    if (!Number.isFinite(bw) || bw < 0) throw new HttpError(400, 'batchWindow must be a number of sim minutes, 0 or more.');
    simOpts.batchWindow = bw;
  }
  return { providerName, seed, providerOpts, simOpts };
}

async function postRun(ctx, req, res) {
  const body = await readJsonBody(req);
  const { providerName, seed, providerOpts, simOpts } = runOptions(body);
  let raw;
  if (body.spec !== undefined) raw = body.spec;
  else if (typeof body.world === 'string') raw = await readWorld(ctx, body.world);
  else throw new HttpError(400, 'Send a world file name ("world") or a world spec ("spec").');

  const { validateWorld } = await lib('../engine/spec.js');
  const checked = validateWorld(raw);
  if (!checked.ok) throw new HttpError(400, 'The world spec has errors.', { errors: checked.errors, warnings: checked.warnings });

  // Reserve the single Jev slot before any await, so two quick requests cannot both start.
  if (providerName === 'jev') {
    if (ctx.jevJob) throw new HttpError(409, 'A Jev run is already in progress. Wait for it to finish.', { runId: ctx.jevJob.runId ?? null });
    ctx.jevJob = { runId: null };
  }
  try {
    const [{ makeProvider }, { runSwarm }, { createRecorder }] = await Promise.all([
      lib('../providers/index.js'), lib('../run/runner.js'), lib('../run/recorder.js')
    ]);
    let provider;
    try { provider = await makeProvider(providerName, providerOpts); } catch (err) { throw new HttpError(400, err.message); }
    const spec = checked.spec;
    const recorder = await createRecorder({ root: ctx.runsDir, spec, seed, providerName });
    if (!recorder?.runId) throw new Error('The recorder did not report a run id.');
    const job = {
      runId: recorder.runId, provider: providerName, state: 'running', t: 0, duration: spec.duration, decisions: 0,
      providerStats: provider.stats?.() ?? null, error: null, controller: new AbortController()
    };
    ctx.jobs.set(job.runId, job);
    if (providerName === 'jev') ctx.jevJob = job;
    // Respond first: an inline rules run steps synchronously and would otherwise delay the reply.
    setImmediate(() => runJob(ctx, job, runSwarm, { spec, seed, provider, recorder, simOpts }));
    send(res, 202, { runId: job.runId });
  } catch (err) {
    if (providerName === 'jev') ctx.jevJob = null;
    throw err;
  }
}

async function runJob(ctx, job, runSwarm, args) {
  try {
    const result = await runSwarm({
      ...args, signal: job.controller.signal,
      onProgress: p => {
        job.t = p.t ?? job.t;
        job.duration = p.duration ?? job.duration;
        job.decisions = p.decisions ?? job.decisions;
        job.providerStats = p.providerStats ?? job.providerStats;
      }
    });
    job.t = job.duration;
    job.decisions = result?.metrics?.decisions?.total ?? job.decisions;
    job.providerStats = result?.providerStats ?? job.providerStats;
    job.state = 'done';
  } catch (err) {
    job.error = err?.message || String(err);
    job.state = 'error';
  } finally {
    job.controller = null;
    if (ctx.jevJob === job) ctx.jevJob = null;
  }
}
