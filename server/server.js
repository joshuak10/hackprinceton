// Local HTTP API and static viewer (docs/PROTOTYPE.md §9). Node built-ins only.
//
// Engine modules are imported on first use: the viewer can still browse recorded runs if a
// module fails to load, and the optional Claude SDK behind compile loads only when asked for.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { hasKey } from '../engine/env.js';
import { createAnalysisService } from '../analysis/service.js';
import { createEnvironmentService } from '../generalist/service.js';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
// The viewer loads the engine's wall geometry as /walls.js (§13d): the root's copy, else the server's own.
const OWN_WALLS = fileURLToPath(new URL('../engine/walls.js', import.meta.url));
const BODY_LIMIT = 2 * 1024 * 1024;
// Names in :file and :id. Stricter than the contract's [A-Za-z0-9._-] only in refusing a leading dot.
const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TEST_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_FILES = new Set(['meta', 'spec', 'metrics', 'frames', 'agents', 'remarks', 'decisions', 'incidents']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};
// Matterport is allowed for the scope display's 3D tour (docs/PROTOTYPE.md §9b): the tour iframe and the
// Embed SDK bootstrap script.
const CSP = "default-src 'self'; script-src 'self' https://api.matterport.com https://static.matterport.com; " +
  "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
  "img-src 'self' data:; connect-src 'self' https://*.matterport.com; frame-src https://my.matterport.com; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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

export function startServer({ port = 4173, host = '127.0.0.1', root = process.cwd(), environmentOptions, rootRedirect = '/scope/', scanService } = {}) {
  const base = resolve(root);
  const ctx = {
    worldsDir: join(base, 'worlds'), runsDir: join(base, 'runs'), daysDir: join(base, 'data', 'days'), wallsFile: join(base, 'engine', 'walls.js'),
    loopback: LOOPBACK.has(host), jobs: new Map(), jevJob: null, rootRedirect,
    scan: scanService ?? null, scans: new Map()
  };
  ctx.feedback = createAnalysisService({ runsDir: ctx.runsDir, webDir: WEB_DIR });
  ctx.environments = createEnvironmentService({ ...environmentOptions, root: base });
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
  return Promise.all([ctx.environments.close(), new Promise(done => {
    server.close(() => done());
    server.closeAllConnections();
  })]);
}

// ---------- routing ----------

const ROUTES = [
  ['GET', ['environment-examples'], environmentEndpoint(async ctx => ({ examples: await ctx.environments.examples() }))],
  ['GET', ['environments'], environmentEndpoint(async ctx => ({ environments: await ctx.environments.listEnvironments() }))],
  ['GET', ['environments', ':id'], environmentEndpoint((ctx, body, p) => ctx.environments.getEnvironment(p.id))],
  ['POST', ['environments'], environmentEndpoint((ctx, body) => ctx.environments.saveEnvironment({ spec: body.spec, brief: body.brief }), 201)],
  ['POST', ['environment-builds'], environmentEndpoint((ctx, body) => ctx.environments.build({ brief: body.brief, backend: body.backend, model: body.model }), 202)],
  ['GET', ['environment-jobs', ':id'], environmentEndpoint((ctx, body, p) => ctx.environments.getJob(p.id))],
  ['POST', ['environment-jobs', ':id', 'cancel'], environmentEndpoint((ctx, body, p) => ctx.environments.cancel(p.id))],
  ['GET', ['environment-runs'], environmentEndpoint(async ctx => ({ runs: await ctx.environments.listRuns() }))],
  ['POST', ['environment-runs'], environmentEndpoint((ctx, body) => ctx.environments.run({ environmentId: body.environmentId, provider: body.provider, seed: body.seed, maxRequests: body.maxRequests }), 202)],
  ['GET', ['environment-runs', ':id'], environmentEndpoint((ctx, body, p) => ctx.environments.getRun(p.id))],
  ['POST', ['insights'], postInsights],
  ['GET', ['health'], getHealth],
  ['GET', ['worlds'], getWorlds],
  ['GET', ['worlds', ':file'], getWorld],
  ['POST', ['validate'], postValidate],
  ['POST', ['scan'], postScan],
  ['POST', ['compile'], postCompile],
  ['GET', ['days'], getDays],
  ['GET', ['runs'], getRuns],
  ['POST', ['runs'], postRun],
  ['GET', ['runs', ':id', 'status'], getStatus],
  ['GET', ['runs', ':id', 'agents', ':agentId'], getAgent],
  ['GET', ['runs', ':id', 'advice'], getAdvice],
  ['GET', ['runs', ':id', ':file'], getRunFile]
];

// The same JSON-only, same-origin checks above guard model generation and simulation jobs.
function environmentEndpoint(operation, status = 200) {
  return async (ctx, req, res, params) => {
    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      send(res, status, await operation(ctx, body, params));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) throw new HttpError(error.status, error.message, error.extra);
      if (['INVALID_BRIEF', 'INVALID_ENVIRONMENT', 'INVALID_BUILDER_OPTION'].includes(error.code)) throw new HttpError(400, error.message, { errors: error.errors });
      throw error;
    }
  };
}

const REMOVED_PAGES = ['/classic', '/room', '/studio'];

async function handle(ctx, req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/walls.js') return serveWalls(ctx, req, res);
  if (!url.pathname.startsWith('/api/')) {
    if (url.pathname === '/' && ctx.rootRedirect && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(302, { Location: ctx.rootRedirect, 'Cache-Control': 'no-store' });
      return res.end();
    }
    // The dashboard is the only page. The addresses of the pages that were removed (the first viewer, Ask the
    // room and the step diagrams) land on it, so an old link or bookmark still opens something.
    const removed = REMOVED_PAGES.some(p => url.pathname === p || url.pathname.startsWith(`${p}/`))
      || (['/scope', '/scope/'].includes(url.pathname) && url.searchParams.get('mode') === 'environment');
    if (removed && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(302, { Location: '/scope/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return serveStatic(req, res, url.pathname);
  }
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

// How a description becomes a world here: the Anthropic API when a key is set, otherwise a headless Claude Code
// agent (`claude -p`) when the CLI is installed, otherwise nothing.
async function compiler() {
  if (hasKey('ANTHROPIC_API_KEY')) return 'anthropic';
  const { claudeCliAvailable } = await lib('../compile/headless.js');
  return claudeCliAvailable() ? 'claude-code' : null;
}

async function getHealth(ctx, req, res) {
  const how = await compiler().catch(() => null);
  send(res, 200, {
    ok: true, insights: true, jev: hasKey('TYPESAFE_API_KEY'), claude: Boolean(how), compiler: how, scan: scanAvailable(ctx),
    capabilities: { environments: 1, spatialWorlds: 1 }
  });
}

async function postInsights(ctx, req, res) {
  const body = await readJsonBody(req);
  try { send(res, 200, await ctx.feedback(body)); }
  catch (err) {
    if ([400, 404, 409, 429].includes(err.status)) throw new HttpError(err.status, err.message);
    throw err;
  }
}

// Share the validated feedback endpoint with the static preview without enabling live runs.
export function createPreviewFeedbackHandler({ root = process.cwd() } = {}) {
  const ctx = { loopback: true, feedback: createAnalysisService({ runsDir: join(resolve(root), 'runs'), webDir: WEB_DIR }) };
  return async (req, res) => {
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST for this endpoint.');
      checkPost(ctx, req);
      await postInsights(ctx, req, res);
    } catch (err) { sendError(res, err); }
  };
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
  // `plan: true` asks for a world drawn as a floor plan, which only the headless agent is told how to draw.
  const how = await compiler();
  const cli = (await lib('../compile/headless.js')).claudeCliAvailable();
  const headless = how === 'claude-code' || (body.plan === true && cli);
  // A scan is fitted out by the headless agent only.
  const scan = body.plan === true ? await scanFor(ctx, body) : null;
  if (scan && !cli && !ctx.scan) throw new HttpError(501, 'Fitting out a scanned building needs Claude Code on this machine (claude auth login).');
  if (!how) {
    throw new HttpError(501, 'Writing a world from words needs Claude Code on this machine (claude auth login) or ANTHROPIC_API_KEY in .env.local. Without either, run /swarm in Claude Code to write the world, then paste it here.');
  }
  // Closing the page stops the agent.
  const stop = new AbortController();
  res.on('close', () => { if (!res.writableEnded) stop.abort(new Error('The request was closed.')); });
  let result;
  const started = Date.now();
  try {
    if (scan) {
      result = await (await scans(ctx)).fitout(description, { ...scan, signal: stop.signal });
    } else if (headless) {
      const { compileWorldHeadless } = await lib('../compile/headless.js');
      result = await compileWorldHeadless(description, { signal: stop.signal });
    } else {
      const { compileWorld } = await lib('../compile/compile.js');
      result = await compileWorld(description, { apiKey: process.env.ANTHROPIC_API_KEY });
    }
  } catch (err) {
    if (stop.signal.aborted) { console.error(`[compile] stopped: the page closed the request after ${Math.round((Date.now() - started) / 1000)} s`); return; }
    console.error(`[compile] ${scan ? `fit-out of ${scan.modelId}` : 'drawing'} failed after ${Math.round((Date.now() - started) / 1000)} s: ${String(err?.message || err).split('\n').join(' ')}`);
    throw new HttpError(502, scan ? `Claude could not fit out the scanned building: ${err?.message || err}` : `Claude could not write a valid world: ${err?.message || err}`);
  }
  send(res, 200, result);
}

// ---------- a scanned building for typed words (§10a) ----------

const SCAN_TTL_MS = 30 * 60 * 1000;
const MODEL_ID = /^[A-Za-z0-9]{6,32}$/;

// Matterport search and the fit-out agent; tests replace them with startServer({ scanService }).
async function scans(ctx) {
  if (ctx.scan) return ctx.scan;
  const { findScan, compileFitoutHeadless } = await lib('../compile/scanned.js');
  const { fetchModelGeometry } = await lib('../builder/matterport.js');
  return { find: findScan, fetchGeometry: fetchModelGeometry, fitout: compileFitoutHeadless, available: () => hasKey('MATTERPORT_API_KEY') && hasKey('MATTERPORT_API_TOKEN') };
}
function scanAvailable(ctx) {
  return ctx.scan ? Boolean(ctx.scan.available?.() ?? true) : hasKey('MATTERPORT_API_KEY') && hasKey('MATTERPORT_API_TOKEN');
}

// POST /api/scan { description } → { found: { modelId, name, floor, rooms, areaM2, ... } | null, tried, reason }.
// Searches Matterport for a scan of the kind of place the words describe that has walls and doors to walk in. The
// scan's geometry stays on the server (it is hackathon data) for the compile that follows.
async function postScan(ctx, req, res) {
  const body = await readJsonBody(req);
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) throw new HttpError(400, 'Send { "description": "a place and a question" }.');
  if (description.length > 4000) throw new HttpError(400, 'Keep the description under 4000 characters.');
  if (!scanAvailable(ctx)) return send(res, 200, { found: null, tried: [], reason: 'No Matterport keys on this server.' });
  let out;
  try { out = await (await scans(ctx)).find(description); } catch (err) {
    return send(res, 200, { found: null, tried: [], reason: `Matterport could not be searched: ${err?.message || err}` });
  }
  if (!out.found) return send(res, 200, { found: null, tried: out.tried, reason: out.reason });
  const { raw, ...found } = out.found;
  const now = Date.now();
  for (const [k, v] of ctx.scans) if (now - v.at > SCAN_TTL_MS) ctx.scans.delete(k);
  ctx.scans.set(found.modelId, { raw, name: found.name, at: now });
  send(res, 200, { found, tried: out.tried, reason: null });
}

// The scan a compile asks for, { modelId, floor }: its geometry from the search just made, or fetched again.
async function scanFor(ctx, body) {
  if (body.scan === undefined || body.scan === null) return null;
  const modelId = typeof body.scan?.modelId === 'string' ? body.scan.modelId.trim() : '';
  if (!MODEL_ID.test(modelId)) throw new HttpError(400, 'scan.modelId must be a Matterport model id.');
  const floor = body.scan.floor;
  if (floor !== undefined && floor !== null && !Number.isInteger(floor)) throw new HttpError(400, 'scan.floor must be a floor number.');
  if (!scanAvailable(ctx)) throw new HttpError(501, 'Building on a scan needs MATTERPORT_API_KEY and MATTERPORT_API_TOKEN in .env.local.');
  let hit = ctx.scans.get(modelId);
  if (!hit) {
    try { hit = { raw: await (await scans(ctx)).fetchGeometry({ modelId }), name: '' }; } catch (err) {
      throw new HttpError(502, `The scan ${modelId} could not be read from Matterport: ${err?.message || err}`);
    }
  }
  return { raw: hit.raw, modelId, name: hit.name, floor: floor ?? undefined };
}

// ---------- runs ----------

function runDir(ctx, id) { return join(ctx.runsDir, safeName(id, 'run id')); }

async function readRunJson(ctx, id, name) {
  try { return JSON.parse(await readFile(join(runDir(ctx, id), name + '.json'), 'utf8')); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new HttpError(404, `Run ${id} has no ${name}.json.`);
    throw err;
  }
}

// The saved results of the multi-day loop for one pool (§21f): ?pool=pools/<name>.json. Read-only.
async function getDays(ctx, req, res) {
  const pool = new URL(req.url, 'http://localhost').searchParams.get('pool') || '';
  const { savedDays, validPool } = await lib('../run/days-saved.js');
  if (!validPool(pool)) throw new HttpError(400, 'Name the pool as ?pool=pools/<name>.json.');
  send(res, 200, await savedDays(ctx.daysDir, pool));
}

async function getRuns(ctx, req, res) {
  const { listRuns } = await lib('../run/recorder.js');
  send(res, 200, await listRuns(ctx.runsDir));
}

async function getRunFile(ctx, req, res, { id, file }) {
  if (!RUN_FILES.has(file)) throw new HttpError(404, `Runs have no ${file} file.`);
  if (file === 'decisions') {
    // decisions.jsonl as one JSON array, for the scope display's incident view (§9b).
    send(res, 200, await allDecisions(join(runDir(ctx, id), 'decisions.jsonl')));
    return;
  }
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

async function allDecisions(file) {
  const stream = createReadStream(file);
  const opened = new Promise((done, fail) => { stream.once('open', done); stream.once('error', fail); });
  try { await opened; } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) if (line.trim()) out.push(JSON.parse(line));
  return out;
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

// Optional `link` on POST /api/runs (§9b): this run is one side of a test of one change. The display starts
// a baseline and a changed run on several seeds and gives all of them the same `test` id.
//   { test, role: 'baseline' | 'change', base?: <run id of the baseline with the same seed>, change }
// `change` is one of:
//   { kind: 'staff', nodeId, from, to }   staff at one counter (the engine's field is `servers`); kind may be left out
//   { kind: 'promotion', off }            a promotion told to everyone (the sushi restaurant): the offer with id
//                                         "promotion", and `off` (a share, 0 to 1) off the price at each place
// The world in the request must already match the role: `from` staff for a baseline and `to` for the change;
// no "promotion" offer for a baseline, and that offer for the change.
async function runLink(ctx, body, spec) {
  const l = body.link;
  if (l === undefined || l === null) return null;
  if (typeof l !== 'object' || Array.isArray(l)) throw new HttpError(400, 'link must be an object.');
  if (typeof l.test !== 'string' || !TEST_RE.test(l.test)) throw new HttpError(400, 'link.test must be 1 to 64 letters, digits, dashes or underscores.');
  if (l.role !== 'baseline' && l.role !== 'change') throw new HttpError(400, 'link.role must be "baseline" or "change".');
  const c = l.change;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, 'link.change must be an object.');
  const change = c.kind === 'promotion' ? promotionLink(l.role, c, spec) : staffLink(l.role, c, spec);
  let base = null;
  if (l.base !== undefined && l.base !== null) {
    if (l.role !== 'change') throw new HttpError(400, 'link.base is only for the run with the change.');
    if (typeof l.base !== 'string') throw new HttpError(400, 'link.base must be a run id.');
    safeName(l.base, 'base run id');
    try { await readRunJson(ctx, l.base, 'meta'); } catch (err) {
      if (err.status === 404) throw new HttpError(400, `link.base names a run that does not exist: ${l.base}.`);
      throw err;
    }
    base = l.base;
  }
  return { test: l.test, role: l.role, base, change };
}

function staffLink(role, c, spec) {
  if (c.kind !== undefined && c.kind !== 'staff') throw new HttpError(400, 'link.change.kind must be "staff" or "promotion".');
  const node = (spec.nodes || []).find(n => n.id === c.nodeId && n.kind === 'service');
  if (!node) throw new HttpError(400, 'link.change.nodeId must name a place with a line in this world.');
  const { from, to } = c;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || to > 1000 || from === to) {
    throw new HttpError(400, 'link.change.from and link.change.to must be different whole numbers, 1 or more.');
  }
  const expected = role === 'change' ? to : from;
  if (Number(node.servers) !== expected) {
    throw new HttpError(400, `link says ${node.name || node.id} has ${expected} staff in this run, but the world has ${node.servers}.`);
  }
  return { kind: 'staff', nodeId: node.id, nodeName: node.name || node.id, from, to };
}

function promotionLink(role, c, spec) {
  if (typeof c.off !== 'number' || !(c.off > 0 && c.off < 1)) throw new HttpError(400, 'link.change.off must be a share between 0 and 1.');
  const has = (spec.offers || []).some(o => o.id === 'promotion');
  if (role === 'change' && !has) throw new HttpError(400, 'link says this run has the promotion, but the world has no offer "promotion".');
  if (role === 'baseline' && has) throw new HttpError(400, 'link says this run is the baseline, but the world already has the offer "promotion".');
  return { kind: 'promotion', off: c.off };
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
    const link = await runLink(ctx, body, spec);
    const recorder = await createRecorder({ root: ctx.runsDir, spec, seed, providerName, link });
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
