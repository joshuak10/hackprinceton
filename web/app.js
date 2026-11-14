// Swarmscope viewer (docs/PROTOTYPE.md §9, §12b). Plain DOM + canvas, one ES module, no framework.
//
// The server's CSP forbids inline style attributes, so every dynamic style below goes through
// the CSSOM (element.style), never through markup.

// ---------- map and chart modules ----------
// Loaded dynamically so the run bar, stats and inspector still work if either module fails to load.
let createMap = null, archetypeColors = null, createChart = null, moduleError = null, wallsLibLoaded = true;
try {
  ({ createMap, archetypeColors, wallsLibLoaded } = await import('./map.js'));
  ({ createChart } = await import('./chart.js'));
} catch (err) {
  moduleError = err;
}

const $ = sel => document.querySelector(sel);
const ui = {
  logo: $('#logo'), healthJev: $('#healthJev'), healthClaude: $('#healthClaude'), themeBtn: $('#themeBtn'),
  worldSel: $('#worldSel'), seedIn: $('#seedIn'), runBtn: $('#runBtn'), runSel: $('#runSel'), refreshRuns: $('#refreshRuns'),
  editBtn: $('#editBtn'), pasteBox: $('#pasteBox'), pasteIn: $('#pasteIn'), validateBtn: $('#validateBtn'), useBtn: $('#useBtn'),
  pasteStatus: $('#pasteStatus'), issues: $('#issues'), describeIn: $('#describeIn'), compileBtn: $('#compileBtn'),
  compileNote: $('#compileNote'), live: $('#live'), liveBar: $('#liveBar'), liveText: $('#liveText'), status: $('#status'),
  runTitle: $('#runTitle'), modePill: $('#modePill'), provPill: $('#provPill'), runQuestion: $('#runQuestion'), clock: $('#clock'),
  mapbox: $('#mapbox'), map: $('#map'), mapEmpty: $('#mapEmpty'), playBtn: $('#playBtn'), scrub: $('#scrub'),
  nowLine: $('#nowLine'), legend: $('#legend'), heatLo: $('#heatLo'), heatHi: $('#heatHi'), tiles: $('#tiles'), rankTitle: $('#rankTitle'),
  rank: $('#rank'), chartTitle: $('#chartTitle'), chart: $('#chart'), chartLegend: $('#chartLegend'),
  agentBody: $('#agentBody'), inspector: $('#inspector'), stats: $('#stats'), statsWarn: $('#statsWarn'),
  remarks: $('#remarks'), remarkCount: $('#remarkCount'),
  wallLegend: $('#wallLegend'), lgWall: $('#lgWall'), lgDoor: $('#lgDoor'), lgEntrance: $('#lgEntrance'),
  doorBox: $('#doorBox'), doorRank: $('#doorRank'), doorNote: $('#doorNote')
};

const PASTED = '__pasted__';
const FALLBACK_LIMIT = 0.2;
const PLAY_SECONDS = 45;        // 1x plays the whole run in 45 s, like the prototype
const POLL_MS = 600;
const MAX_STREAM = 150;
const MAX_DOORS = 8;            // rows in the busiest-doorways panel
const THEMES = ['auto', 'light', 'dark'];

const state = {
  worlds: [], runs: [], health: null, provider: 'rules', pasted: null, validated: null,
  run: null, t: 0, playing: false, speed: 1, lastTs: 0, dirty: true,
  agentReq: 0, agentData: null, decisionCards: [], remarksShown: -1, nowSlots: null,
  pollTimer: null, following: null, colors: null, door: null
};

// ---------- small helpers ----------
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const fmt = (v, d = 0) => (isNum(v) ? v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');
const pct = v => (isNum(v) ? fmt(v * 100, v < 0.1 ? 1 : 0) + '%' : '–');
const mins = m => (isNum(m) ? (m < 60 ? fmt(m, m < 10 ? 1 : 0) + ' min' : fmt(m / 60, 1) + ' h') : '–');
const ms = v => (isNum(v) ? `${Math.round(v)} ms` : '–');
const usd = v => (isNum(v) ? `$${v > 0 && v < 0.01 ? v.toFixed(5) : v.toFixed(2)}` : '–');
const enc = s => encodeURIComponent(s);
const pad2 = n => String(n).padStart(2, '0');
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function clockText(spec, t) {
  const m = Math.floor((((Number(spec?.clockStart) || 0) + (Number(t) || 0)) % 1440 + 1440) % 1440);
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

const FEELINGS = ['calm', 'mildly annoyed', 'frustrated', 'very frustrated', 'furious'];
const feelingWords = x => (isNum(x) ? FEELINGS[Math.min(4, Math.max(0, Math.round(x)))] : null);

// Builds an element. `style` is applied through the CSSOM; `on*` props become listeners.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function setStatus(msg, err = false) {
  ui.status.textContent = msg || '';
  ui.status.classList.toggle('err', !!err);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const err = new Error(data?.error || `${method} ${path} failed with HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function store(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// ---------- theme colors ----------
function hexRgb(s) {
  let x = String(s || '').trim().replace('#', '');
  if (x.length === 3) x = x.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(x)) return [136, 136, 136];
  const n = parseInt(x, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = k => cs.getPropertyValue(k).trim() || '#888888';
  state.colors = {
    accent: g('--accent'), muted: g('--muted'),
    heat: ['--heat0', '--heat1', '--heat2'].map(k => hexRgb(g(k))),
    arch: ['--a1', '--a2', '--a3', '--a4', '--a5', '--a6'].map(g),
    series: ['--heat2', '--heat1', '--a1', '--a4', '--a3', '--a2'].map(g)
  };
}

function heat(x) {
  const [a, b, c] = state.colors.heat;
  const v = Math.max(0, Math.min(1, x));
  const [p, q, f] = v < 0.55 ? [a, b, v / 0.55] : [b, c, (v - 0.55) / 0.45];
  return `rgb(${p.map((n, i) => Math.round(n + (q[i] - n) * f)).join(',')})`;
}

function colorsFor(spec) {
  if (archetypeColors) return archetypeColors(spec);
  return new Map((spec?.archetypes ?? []).map((a, i) => [a.id, state.colors.arch[i % 6]]));
}

// ---------- map and chart instances ----------
const NOOP_MAP = { setRun() {}, render() {}, resize() {}, destroy() {}, highlightDoor() {} };
const NOOP_CHART = { setSeries() {}, render() {}, resize() {} };
const map = createMap ? createMap(ui.map, { onAgentClick: id => inspectAgent(id) }) : NOOP_MAP;
const chart = createChart ? createChart(ui.chart) : NOOP_CHART;

// ---------- theme toggle ----------
function applyTheme(mode) {
  const m = THEMES.includes(mode) ? mode : 'auto';
  if (m === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', m);
  ui.themeBtn.textContent = `Theme: ${m}`;
  ui.themeBtn.dataset.mode = m;
  store('swarmscope.theme', m === 'auto' ? null : m);
}

function onThemeChange() {
  readColors();
  if (!state.run) return;
  state.run.colors = colorsFor(state.run.spec);
  if (state.run.frames) { map.setRun(mapRun(state.run)); map.highlightDoor?.(state.door); }
  renderLegend();
  renderRank();
  renderDoors();
  setChart();
  if (state.agentData) renderAgent(state.agentData);
  state.remarksShown = -1;
  state.dirty = true;
}

// ---------- health ----------
async function loadHealth() {
  try {
    const hl = await api('/api/health');
    state.health = hl;
    ui.healthJev.textContent = hl.jev ? 'Jev key configured' : 'No Jev key: rules only';
    ui.healthJev.className = `pill ${hl.jev ? 'ok' : 'off'}`;
    ui.healthJev.title = hl.jev ? 'TYPESAFE_API_KEY is set on the server.' : 'Set TYPESAFE_API_KEY in .env.local and restart the server to run with Jev.';
    ui.healthClaude.hidden = false;
    ui.healthClaude.textContent = hl.claude ? 'Claude compile on' : 'Claude compile off';
    ui.healthClaude.className = `pill ${hl.claude ? 'ok' : ''}`;
    const jevBtn = document.querySelector('[data-provider="jev"]');
    jevBtn.disabled = !hl.jev;
    jevBtn.title = hl.jev ? '' : 'Needs TYPESAFE_API_KEY on the server';
    if (!hl.jev && state.provider === 'jev') setProvider('rules');
    ui.compileBtn.disabled = !hl.claude;
    ui.compileNote.textContent = hl.claude
      ? 'Claude writes the world JSON here; check it, validate, then run it.'
      : 'Compiling needs ANTHROPIC_API_KEY on the server. Without it, run /swarm in Claude Code to write the world, then paste it above.';
  } catch {
    ui.healthJev.textContent = 'server unreachable';
    ui.healthJev.className = 'pill off';
  }
}

// ---------- provider and run bar ----------
function setProvider(name) {
  state.provider = name === 'jev' ? 'jev' : 'rules';
  for (const b of document.querySelectorAll('[data-provider]')) {
    const on = b.dataset.provider === state.provider;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  ui.runBtn.textContent = state.provider === 'jev' ? 'Run with Jev' : 'Run with rules';
  store('swarmscope.provider', state.provider);
}

async function loadWorlds() {
  try {
    state.worlds = await api('/api/worlds');
  } catch (err) {
    state.worlds = [];
    setStatus(`Could not list worlds: ${err.message}`, true);
  }
  const keep = ui.worldSel.value;
  ui.worldSel.replaceChildren(
    ...state.worlds.map(w => h('option', { value: w.file, title: w.question || '' },
      `${w.title} · ${w.mode}${isNum(w.agents) ? ` · ${fmt(w.agents)} people` : ''}${w.cast ? ` · cast of ${w.cast}` : ''}`)),
    state.pasted ? h('option', { value: PASTED }, `Pasted: ${state.pasted.title || 'untitled world'}`) : null
  );
  if (!state.worlds.length && !state.pasted) ui.worldSel.append(h('option', { value: '' }, 'No worlds found in worlds/'));
  if ([...ui.worldSel.options].some(o => o.value === keep)) ui.worldSel.value = keep;
  else {
    const saved = recall('swarmscope.world');
    if (saved && state.worlds.some(w => w.file === saved)) ui.worldSel.value = saved;
  }
}

async function refreshRuns() {
  try {
    state.runs = await api('/api/runs');
  } catch (err) {
    state.runs = [];
    setStatus(`Could not list runs: ${err.message}`, true);
  }
  const when = iso => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  ui.runSel.replaceChildren(
    h('option', { value: '' }, state.runs.length ? `Choose one of ${state.runs.length} recorded runs…` : 'No recorded runs yet'),
    ...state.runs.map(r => h('option', { value: r.runId, title: r.runId },
      `${r.title ?? r.runId} · ${r.provider}${r.model ? ` (${r.model})` : ''} · seed ${r.seed} · ${when(r.createdAt)}${r.status === 'error' ? ' · error' : ''}`))
  );
  if (state.run && state.runs.some(r => r.runId === state.run.id)) ui.runSel.value = state.run.id;
}

async function startRun() {
  const seed = Number(ui.seedIn.value);
  if (!Number.isInteger(seed) || seed < 0) {
    setStatus('The seed must be a whole number, 0 or more.', true);
    return;
  }
  const body = { provider: state.provider, seed };
  if (ui.worldSel.value === PASTED) {
    if (!state.pasted) { setStatus('Paste and validate a world first.', true); return; }
    body.spec = state.pasted;
  } else if (ui.worldSel.value) {
    body.world = ui.worldSel.value;
  } else {
    setStatus('Pick a world first.', true);
    return;
  }
  ui.runBtn.disabled = true;
  setStatus(`Starting a ${state.provider === 'jev' ? 'Jev' : 'rules'} run…`);
  try {
    const { runId } = await api('/api/runs', { method: 'POST', body });
    follow(runId, state.provider);
  } catch (err) {
    ui.runBtn.disabled = false;
    if (err.status === 409 && err.body?.runId) {
      setStatus('A Jev run is already in progress. Following it instead.');
      follow(err.body.runId, 'jev');
      return;
    }
    if (Array.isArray(err.body?.errors)) {
      showIssues(err.body.errors, err.body.warnings ?? []);
      ui.pasteBox.open = true;
    }
    setStatus(`Could not start the run: ${err.message}`, true);
  }
}

// ---------- live progress ----------
function follow(runId, provider) {
  clearTimeout(state.pollTimer);
  const started = performance.now();
  state.following = runId;
  ui.live.hidden = false;
  ui.runBtn.disabled = true;
  ui.liveBar.style.width = '0%';
  ui.liveText.textContent = `Starting ${runId}…`;
  let misses = 0;

  const tick = async () => {
    if (state.following !== runId) return;
    let s;
    try {
      s = await api(`/api/runs/${enc(runId)}/status`);
      misses = 0;
    } catch (err) {
      if (++misses < 5) { state.pollTimer = setTimeout(tick, POLL_MS * 2); return; }
      stopFollowing();
      setStatus(`Lost track of ${runId}: ${err.message}`, true);
      return;
    }
    const frac = isNum(s.t) && isNum(s.duration) && s.duration > 0 ? Math.min(1, s.t / s.duration) : 0;
    ui.liveBar.style.width = `${(frac * 100).toFixed(1)}%`;
    const ps = s.providerStats;
    const bits = [
      `${provider === 'jev' ? 'Jev' : 'Rules'} run ${s.state}`,
      `minute ${fmt(s.t)} of ${fmt(s.duration)} (${pct(frac)})`,
      `${fmt(s.decisions)} decisions`
    ];
    if (ps?.provider === 'jev') {
      bits.push(`${fmt(ps.requests)} requests`, `${fmt(ps.cacheHits)} cache hits`, `${fmt(ps.fallbacks)} fallbacks`, `p50 ${ms(ps.latency?.p50)}`);
    }
    bits.push(`${fmt((performance.now() - started) / 1000)} s`);
    ui.liveText.textContent = bits.join(' · ');

    if (s.state === 'running') {
      state.pollTimer = setTimeout(tick, POLL_MS);
      return;
    }
    stopFollowing();
    await refreshRuns();
    if (s.state === 'error') {
      setStatus(`The run failed: ${s.error || 'unknown error'}`, true);
      try { await loadRun(runId, { autoplay: false, quiet: true }); } catch { /* the failed run may have no files */ }
      return;
    }
    try {
      await loadRun(runId);
      setStatus(`Run finished: ${runId}. Playing it back now.`);
    } catch (err) {
      setStatus(`The run finished but could not be loaded: ${err.message}`, true);
    }
  };
  tick();
}

function stopFollowing() {
  clearTimeout(state.pollTimer);
  state.following = null;
  ui.live.hidden = true;
  ui.runBtn.disabled = false;
}

// ---------- paste, validate, compile ----------
function showIssues(errors, warnings) {
  ui.issues.replaceChildren(
    ...errors.map(m => h('li', { class: 'err' }, m)),
    ...warnings.map(m => h('li', { class: 'warn' }, m))
  );
}

function parsePasted() {
  const text = ui.pasteIn.value.trim();
  if (!text) throw new Error('Paste a world JSON first.');
  try { return JSON.parse(text); } catch (err) { throw new Error(`That is not valid JSON: ${err.message}`); }
}

function setPasteStatus(msg, err = false) {
  ui.pasteStatus.textContent = msg;
  ui.pasteStatus.classList.toggle('err', err);
}

async function validatePasted() {
  ui.useBtn.disabled = true;
  state.validated = null;
  let raw;
  try { raw = parsePasted(); } catch (err) { setPasteStatus(err.message, true); ui.issues.replaceChildren(); return; }
  setPasteStatus('Validating…');
  try {
    const result = await api('/api/validate', { method: 'POST', body: { spec: raw } });
    showIssues(result.errors ?? [], result.warnings ?? []);
    if (result.ok) {
      state.validated = raw;
      ui.useBtn.disabled = false;
      const w = (result.warnings ?? []).length;
      setPasteStatus(`Valid: ${result.spec?.title ?? 'untitled'} (${result.spec?.mode ?? '?'} world)${w ? `, ${w} warning${w > 1 ? 's' : ''} fixed silently` : ''}.`);
    } else {
      setPasteStatus(`${(result.errors ?? []).length} error(s) to fix before this world can run.`, true);
    }
  } catch (err) {
    setPasteStatus(`Validation failed: ${err.message}`, true);
  }
}

async function usePasted() {
  if (!state.validated) return;
  state.pasted = state.validated;
  await loadWorlds();
  ui.worldSel.value = PASTED;
  setStatus(`Using your pasted world "${state.pasted.title || 'untitled'}". Press Run.`);
}

async function editCopy() {
  ui.pasteBox.open = true;
  if (ui.worldSel.value === PASTED && state.pasted) {
    ui.pasteIn.value = JSON.stringify(state.pasted, null, 2);
  } else if (ui.worldSel.value) {
    try {
      const w = await api(`/api/worlds/${enc(ui.worldSel.value)}`);
      ui.pasteIn.value = JSON.stringify(w, null, 2);
    } catch (err) {
      setPasteStatus(`Could not load the world: ${err.message}`, true);
      return;
    }
  }
  ui.useBtn.disabled = true;
  ui.issues.replaceChildren();
  setPasteStatus('Edit the JSON, then validate.');
  ui.pasteIn.focus();
}

async function compileDescription() {
  const description = ui.describeIn.value.trim();
  if (!description) { ui.compileNote.textContent = 'Describe a place and a question first.'; return; }
  ui.compileBtn.disabled = true;
  ui.compileNote.textContent = 'Claude is writing the world. This can take a minute…';
  try {
    const result = await api('/api/compile', { method: 'POST', body: { description } });
    ui.pasteIn.value = JSON.stringify(result.spec, null, 2);
    ui.compileNote.textContent = `Written in ${result.attempts ?? 1} attempt(s). Check it, then validate and use it.`;
    await validatePasted();
  } catch (err) {
    ui.compileNote.textContent = err.message;
  } finally {
    ui.compileBtn.disabled = !state.health?.claude;
  }
}

// ---------- loading a run ----------
function nameMaps(spec, frames) {
  const place = new Map();
  for (const n of frames?.nodes ?? []) place.set(n.id, n.name);
  for (const n of spec?.nodes ?? []) place.set(n.id, n.name);
  const edge = new Map();
  for (const e of spec?.edges ?? []) edge.set(`${e.to}>${e.from}`, e.name);
  for (const e of frames?.edges ?? []) edge.set(e.id, e.name);
  for (const e of spec?.edges ?? []) edge.set(`${e.from}>${e.to}`, e.name);
  return { place, edge };
}

const mapRun = run => ({ spec: run.spec, frames: run.frames, archetypeOf: run.archetypeOf, colors: run.colors });

async function loadRun(id, { autoplay = true, quiet = false } = {}) {
  if (!quiet) setStatus(`Loading ${id}…`);
  const base = `/api/runs/${enc(id)}/`;
  const meta = await api(base + 'meta');
  const [spec, frames, metrics, agents, remarks] = await Promise.all(
    ['spec', 'frames', 'metrics', 'agents', 'remarks'].map(f => api(base + f).catch(() => null))
  );
  if (!spec) throw new Error(`Run ${id} has no spec.json.`);

  pause();
  const list = frames?.list ?? [];
  const lastT = list.length ? list[list.length - 1].t : 0;
  const run = {
    id, meta, spec, frames, metrics, remarks: Array.isArray(remarks) ? remarks : [],
    agents: Array.isArray(agents) ? agents : [],
    duration: Math.max(Number(meta.duration ?? spec.duration) || 0, lastT) || 1,
    names: nameMaps(spec, frames),
    archetypeOf: new Map((Array.isArray(agents) ? agents : []).map(a => [a.id, a.archetypeId])),
    groupName: new Map((spec.archetypes ?? []).map(a => [a.id, a.name])),
    colors: null
  };
  run.colors = colorsFor(spec);
  state.run = run;
  state.t = 0;
  state.remarksShown = -1;
  state.agentData = null;
  state.agentReq++;
  state.door = null;

  if (frames && list.length) {
    map.setRun(mapRun(run));
    ui.mapEmpty.hidden = true;
  } else {
    map.setRun({ spec, frames: { mode: spec.mode, nodes: [], edges: [], services: [], list: [] }, archetypeOf: new Map(), colors: run.colors });
    ui.mapEmpty.hidden = false;
    ui.mapEmpty.replaceChildren(h('p', {}, meta.error
      ? `This run stopped with an error and recorded no frames: ${meta.error}`
      : 'This run recorded no frames to play back.'));
  }

  ui.scrub.max = String(run.duration);
  ui.scrub.value = '0';
  ui.scrub.disabled = !list.length;
  ui.playBtn.disabled = !list.length;
  renderHeader();
  renderLegend();
  renderTiles();
  renderRank();
  renderDoors();
  setChart();
  renderStats();
  resetInspector();
  ui.runSel.value = state.runs.some(r => r.runId === id) ? id : '';
  try { history.replaceState(null, '', `#run=${enc(id)}`); } catch { /* sandboxed */ }
  if (!quiet) {
    const noNav = (frames?.walls?.length ?? 0) > 0 && !wallsLibLoaded;
    setStatus(`Loaded ${meta.title ?? id}: ${fmt(meta.agents)} agents, ${fmt(meta.decisions)} recorded decisions.` +
      (noNav ? ' The map could not load /walls.js, so a dot whose move would cross a wall waits in place until the next frame.' : ''));
  }
  state.dirty = true;
  if (autoplay && list.length) play();
}

// ---------- header, legend, tiles, ranking ----------
function renderHeader() {
  const { meta, spec } = state.run;
  ui.runTitle.textContent = meta.title ?? spec.title ?? meta.runId;
  ui.runQuestion.textContent = meta.question ?? spec.question ?? '';
  ui.modePill.hidden = false;
  ui.modePill.textContent = spec.mode === 'route' ? 'route world' : 'visit world';
  ui.provPill.hidden = false;
  ui.provPill.textContent = `${meta.provider}${meta.model ? ` · ${meta.model}` : ''} · seed ${meta.seed}`;
  ui.provPill.className = `pill${meta.provider === 'jev' ? ' ok' : ''}`;
  ui.heatLo.textContent = spec.mode === 'route' ? 'free flow' : 'calm';
  ui.heatHi.textContent = spec.mode === 'route' ? 'jammed' : 'saturated';
}

function renderLegend() {
  const { spec, colors, agents } = state.run;
  const counts = new Map();
  for (const a of agents) counts.set(a.archetypeId, (counts.get(a.archetypeId) ?? 0) + 1);
  ui.legend.replaceChildren(...(spec.archetypes ?? []).map(a => h('span', { title: a.description || '' },
    h('i', { class: 'dot', style: { background: colors.get(a.id) || state.colors.muted } }),
    `${a.name}${counts.has(a.id) ? ` (${fmt(counts.get(a.id))})` : ''}`)));
  const walls = (state.run.frames?.walls ?? spec.walls ?? []).length > 0;
  const doors = state.run.frames?.doors ?? spec.doors ?? [];
  ui.wallLegend.hidden = !walls && !doors.length;
  ui.lgWall.hidden = !walls;
  ui.lgDoor.hidden = !doors.length;
  ui.lgEntrance.hidden = !doors.some(d => d?.exterior);
}

function frameAt(t) {
  const list = state.run?.frames?.list;
  if (!list?.length) return null;
  let lo = 0, hi = list.length - 1;
  if (t <= list[0].t) return list[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return list[lo];
}

function renderTiles() {
  const { metrics: m, spec } = state.run;
  const route = spec.mode === 'route';
  const tile = (value, label, now = false) => {
    const b = h('b', {}, value);
    ui.tiles.append(h('div', { class: `tile${now ? ' now' : ''}` }, b, h('span', {}, label)));
    return b;
  };
  ui.tiles.replaceChildren();
  const slots = {};
  if (route) {
    slots.active = tile('–', 'vehicles on the road now', true);
    slots.done = tile('–', 'trips finished so far', true);
    tile(m?.arrived ? mins(m.avgTrip) : '–', 'average trip, whole run');
    tile(m?.arrived ? `+${mins(m.avgDelay)}` : '–', 'delay vs empty roads');
    tile(fmt(m?.arrived), 'trips completed');
  } else {
    slots.active = tile('–', 'people in the system now', true);
    slots.done = tile('–', 'services completed so far', true);
    tile(mins(m?.avgWait), 'average wait per stop');
    tile(pct(m?.abandonRate), 'arrivals that walked away');
    tile(fmt(m?.spawned), 'people who came');
  }
  const f = m?.frustration?.avg;
  tile(isNum(f) ? `${fmt(f, 1)}/4` : '–', isNum(f) ? `average frustration (${feelingWords(f)})` : 'frustration (Jev runs only)');
  state.nowSlots = slots;
}

function updateNowTiles(frame) {
  const s = state.nowSlots;
  if (!s) return;
  const c = frame?.c ?? {};
  s.active.textContent = fmt(c.active);
  s.done.textContent = fmt(state.run.spec.mode === 'route' ? c.arrived : c.served);
}

function severity(item, route) {
  if (route) return item.peakRatio >= 1.5 ? ['jammed', 2] : item.peakRatio >= 0.9 ? ['heavy', 1] : ['flowing', 0];
  if (item.abandoned > item.arrivals * 0.05 || item.avgWait > 25) return ['saturated', 2];
  return item.avgWait > 8 || item.utilization > 0.75 ? ['busy', 1] : ['ok', 0];
}

function renderRank() {
  const m = state.run.metrics;
  const route = state.run.spec.mode === 'route';
  ui.rankTitle.textContent = route ? 'Bottlenecks (delay minutes)' : 'Bottlenecks (wait minutes + 30 × walked away)';
  if (!m) { ui.rank.replaceChildren(h('li', { class: 'muted' }, 'No metrics were recorded for this run.')); return; }
  const score = i => (route ? i.delayMinutes : i.score) || 0;
  const items = [...((route ? m.edges : m.nodes) ?? [])].sort((a, b) => score(b) - score(a)).slice(0, 6);
  if (!items.length) { ui.rank.replaceChildren(h('li', { class: 'muted' }, 'Nothing to rank.')); return; }
  const max = Math.max(1, ...items.map(score));
  const sevColor = [state.colors.muted, heat(0.55), heat(1)];
  ui.rank.replaceChildren(...items.map(i => {
    const [label, lvl] = severity(i, route);
    const meta = route
      ? `+${fmt(i.delayMinutes / 60, 1)} vehicle-h delay · peak ${fmt(i.peakRatio, 2)}× capacity · ${fmt(i.traversals)} trips`
      : `${fmt(i.waitMinutes / 60, 1)} person-h in line · avg ${mins(i.avgWait)} · ${pct(i.utilization)} busy${i.abandoned ? ` · ${fmt(i.abandoned)} walked away` : ''}`;
    return h('li', {},
      h('span', { class: 'nm', title: i.name }, i.name),
      h('span', { class: 'sev', style: { color: sevColor[lvl] } }, label),
      h('span', { class: 'bar' }, h('i', { style: { width: `${Math.max(2, (score(i) / max) * 100)}%`, background: heat(score(i) / max) } })),
      h('span', { class: 'meta' }, meta));
  }));
}

// ---------- busiest doorways (§14d) ----------
// metrics.doors is the ranking (busiest first). A run without it falls back to the last frame's totals.
function runDoors(run) {
  if (Array.isArray(run.metrics?.doors) && run.metrics.doors.length) return run.metrics.doors;
  const fd = run.frames?.doors ?? [];
  if (!fd.length) return [];
  const list = run.frames.list ?? [];
  let last = null;
  for (let i = list.length - 1; i >= 0 && !last; i--) if (Array.isArray(list[i].d)) last = list[i].d;
  return fd.map((d, i) => ({ id: d.id, name: d.name ?? d.id, exterior: !!d.exterior, crossings: Number(last?.[i]) || 0 }))
    .sort((a, b) => b.crossings - a.crossings);
}

function renderDoors() {
  const doors = runDoors(state.run);
  ui.doorBox.hidden = !doors.length;
  if (!doors.length) { ui.doorRank.replaceChildren(); ui.doorNote.textContent = ''; return; }
  const shown = doors.slice(0, MAX_DOORS);
  const max = Math.max(1, ...shown.map(d => d.crossings || 0));
  ui.doorRank.replaceChildren(...shown.map(d => {
    const on = d.id === state.door;
    const share = (d.crossings || 0) / max;
    const peak = isNum(d.peakPer5Min) ? ` · peak ${fmt(d.peakPer5Min)} per 5 min${d.peakClock ? ` at ${d.peakClock}` : ''}` : '';
    return h('li', {}, h('button', {
      type: 'button', class: `door-row${on ? ' on' : ''}`, 'aria-pressed': String(on),
      title: on ? 'Clear the highlight on the map' : 'Show this doorway on the map', onclick: () => selectDoor(d.id)
    },
    h('span', { class: 'nm' }, d.name ?? d.id),
    d.exterior ? h('span', { class: 'sev entrance' }, 'entrance') : h('span', {}),
    h('span', { class: 'bar' }, h('i', { style: { width: `${Math.max(2, share * 100)}%`, background: heat(share) } })),
    h('span', { class: 'meta' }, `${fmt(d.crossings)} crossings${peak}`)));
  }));
  ui.doorNote.textContent = `${doors.length > shown.length ? `Top ${shown.length} of ${fmt(doors.length)} doorways. ` : ''}Click a doorway to find it on the map.`;
}

function selectDoor(id) {
  state.door = state.door === id ? null : id;
  map.highlightDoor?.(state.door);
  renderDoors();
  state.dirty = true;
}

// ---------- chart ----------
function chartSeries(run) {
  const frames = run.frames;
  const list = frames?.list ?? [];
  const route = (frames?.mode ?? run.spec.mode) === 'route';
  let raw;
  if (route) {
    const edges = frames?.edges ?? [];
    const nameCount = new Map();
    for (const e of edges) nameCount.set(e.name, (nameCount.get(e.name) ?? 0) + 1);
    raw = edges.map((e, i) => ({
      name: nameCount.get(e.name) > 1 ? `${e.name} → ${run.names.place.get(e.to) ?? e.to}` : e.name,
      values: list.map(f => f.load?.[i] ?? 0)
    }));
  } else {
    raw = (frames?.services ?? []).map((id, i) => ({ name: run.names.place.get(id) ?? id, values: list.map(f => f.q?.[i] ?? 0) }));
  }
  const top = raw.map(s => ({ ...s, peak: s.values.reduce((a, v) => (v > a ? v : a), 0) }))
    .sort((a, b) => b.peak - a.peak).slice(0, 6);
  return {
    t: list.map(f => f.t),
    series: top.map((s, i) => ({ name: s.name, color: state.colors.series[i % state.colors.series.length], values: s.values, peak: s.peak })),
    yLabel: route ? '% of road capacity' : 'people in line',
    route
  };
}

function setChart() {
  const data = chartSeries(state.run);
  ui.chartTitle.textContent = data.route ? 'Road load over time' : 'Queue length over time';
  const spec = state.run.spec;
  chart.setSeries({
    t: data.t, series: data.series.map(({ name, color, values }) => ({ name, color, values })), yLabel: data.yLabel,
    xFormat: t => clockText(spec, t), ref: data.route ? 100 : null
  });
  ui.chartLegend.replaceChildren(...data.series.map(s => h('span', {},
    h('i', { style: { background: s.color } }),
    `${s.name} · peak ${fmt(s.peak)}${data.route ? '%' : ''}`)));
  state.dirty = true;
}

// ---------- run stats ----------
function fallbackShare(metrics, ps) {
  const d = metrics?.decisions;
  if (d?.total) return (d.byProvider?.['rules-fallback'] ?? 0) / d.total;
  if (ps && isNum(ps.fallbacks)) {
    const total = (ps.requests ?? 0) + (ps.cacheHits ?? 0) + (ps.fallbacks ?? 0);
    return total ? ps.fallbacks / total : null;
  }
  return null;
}

function renderStats() {
  const { meta, metrics } = state.run;
  const ps = meta.providerStats ?? {};
  const d = metrics?.decisions;
  const rows = [];
  const add = (k, v, title) => rows.push(h('dt', {}, k), h('dd', title ? { title } : {}, v));
  const inline = meta.provider === 'rules' && !d?.total;
  add('Provider', inline ? 'rules (inline rule policy)' : meta.provider);
  add('Model', ps.model ?? meta.model ?? '–');
  add('Decisions', d?.total
    ? `${fmt(d.total)} (${Object.entries(d.byProvider ?? {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${fmt(n)}`).join(', ')})`
    : inline ? 'none recorded: rules decided inline' : fmt(meta.decisions));
  if (ps.provider === 'jev' || meta.provider === 'jev') {
    add('Requests', fmt(ps.requests));
    add('Cache hits', fmt(ps.cacheHits));
  }
  if (ps.provider === 'replay') {
    add('Matched', `${fmt(ps.hashHits)} by hash, ${fmt(ps.idHits)} by id, ${fmt(ps.misses)} misses`);
  }
  const fb = fallbackShare(metrics, ps);
  add('Fallback', fb == null ? '–' : `${pct(fb)}${isNum(ps.fallbacks) ? ` (${fmt(ps.fallbacks)})` : ''}`);
  if (isNum(ps.inputTokens) || isNum(ps.outputTokens)) add('Tokens', `${fmt(ps.inputTokens)} in / ${fmt(ps.outputTokens)} out`);
  if (isNum(ps.estCostUSD)) add('Est. cost', `${usd(ps.estCostUSD)} (unverified)`, ps.priceNote || '$0.042 per million input tokens, unverified');
  if (ps.latency) add('Latency', `p50 ${ms(ps.latency.p50)} · p95 ${ms(ps.latency.p95)}`);
  const wl = metrics?.walls;
  if (wl) add('Walls', `walls: ${fmt(wl.count)}, moves checked: ${fmt(wl.checkedMoves)}, violations: ${fmt(wl.violations)}`);
  add('Seed', String(meta.seed ?? '–'));
  add('Spec hash', meta.specHash ?? '–');
  add('Recorded', meta.createdAt ? new Date(meta.createdAt).toLocaleString() : '–');
  add('Run id', meta.runId ?? state.run.id);
  if (ps.firstError) add('First error', ps.firstError);
  if (meta.error) add('Run error', meta.error);
  ui.stats.replaceChildren(...rows);
  const warns = [];
  if (fb != null && fb > FALLBACK_LIMIT) warns.push(`${pct(fb)} of decisions fell back to rules, so this run does not count as a Jev run.`);
  if (wl?.violations > 0) warns.push(`${fmt(wl.violations)} moves touched a wall. A completed run should have none: this is an engine bug.`);
  ui.statsWarn.hidden = !warns.length;
  ui.statsWarn.textContent = warns.join(' ');
}

// ---------- remarks ----------
const REMARK_SENTENCE = {
  long_line: (who, x) => `${who} warned others about a long line at ${x}.`,
  bad_service: (who, x) => `${who} told others about a bad experience at ${x}.`,
  good_experience: (who, x) => `${who} told others ${x} was good and quick.`,
  heavy_traffic: (who, x) => `${who} reported heavy traffic on ${x}.`,
  clear_roads: (who, x) => `${who} reported that ${x} was clear.`
};
const REMARK_SHORT = {
  long_line: 'long line', bad_service: 'bad service', good_experience: 'good experience',
  heavy_traffic: 'heavy traffic', clear_roads: 'clear roads'
};
const REMARK_TEXT = {
  long_line: x => `long line at ${x}`, bad_service: x => `bad experience at ${x}`, good_experience: x => `${x} was good and quick`,
  heavy_traffic: x => `heavy traffic on ${x}`, clear_roads: x => `${x} was clear`
};

function remarkAbout(r) {
  const n = state.run.names;
  if (r.placeId != null) return n.place.get(r.placeId) ?? r.placeId;
  if (r.edgeId != null) return n.edge.get(r.edgeId) ?? r.edgeId;
  return 'somewhere';
}
const remarkSentence = r => (REMARK_SENTENCE[r.kind] ?? ((who, x) => `${who} said something (${r.kind}) about ${x}.`))(r.personaName || `Agent ${r.agentId}`, remarkAbout(r));
const remarkText = r => (REMARK_TEXT[r.kind] ?? (x => `${r.kind} about ${x}`))(remarkAbout(r));

function visibleRemarkCount(t) {
  const list = state.run.remarks;
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid].t ?? 0) <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function renderRemarks() {
  const run = state.run;
  const n = visibleRemarkCount(state.t);
  if (n === state.remarksShown) return;
  state.remarksShown = n;
  const total = run.remarks.length;
  ui.remarkCount.textContent = total ? `${fmt(n)} of ${fmt(total)}` : '';
  if (!total) {
    ui.remarks.replaceChildren(h('li', { class: 'muted' },
      run.meta.provider === 'jev' || run.metrics?.decisions?.total ? 'Nobody told anyone anything in this run.' : 'Rule-based runs carry no remarks. Run with Jev to hear what people tell each other.'));
    return;
  }
  if (!n) { ui.remarks.replaceChildren(h('li', { class: 'muted' }, 'No remarks yet at this time. Press play or move the scrubber.')); return; }
  const items = [];
  for (let i = n - 1; i >= 0 && items.length < MAX_STREAM; i--) {
    const r = run.remarks[i];
    items.push(h('li', {},
      h('div', { class: 'th-head' },
        h('i', { class: 'dot', style: { background: run.colors.get(r.archetypeId) || state.colors.muted } }),
        h('button', { type: 'button', class: 'linkish', title: 'Inspect this person', onclick: () => inspectAgent(r.agentId) }, r.personaName || `Agent ${r.agentId}`),
        h('span', { class: 'when' }, clockText(run.spec, r.t)),
        h('span', { class: 'tag' }, REMARK_SHORT[r.kind] ?? r.kind),
        r.informed ? h('span', { class: 'tag mood' }, run.spec.mode === 'route' ? 'live traffic' : 'has the app') : null),
      h('div', {}, remarkSentence(r)),
      h('div', { class: 'muted small' }, run.groupName.get(r.archetypeId) ?? r.archetypeId)));
  }
  ui.remarks.replaceChildren(...items);
}

// ---------- agent inspector ----------
function resetInspector() {
  state.decisionCards = [];
  ui.agentBody.className = 'empty';
  ui.agentBody.replaceChildren(h('p', {}, 'Click a dot on the map, or a name in the remarks, to see who that person is, what they could see, the probabilities each option got, and what they actually did.'));
}

async function inspectAgent(agentId) {
  const run = state.run;
  if (!run || agentId == null) return;
  const token = ++state.agentReq;
  ui.agentBody.className = 'empty';
  ui.agentBody.replaceChildren(h('p', {}, `Loading agent ${agentId}…`));
  if (window.innerWidth < 960) ui.inspector.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  try {
    const data = await api(`/api/runs/${enc(run.id)}/agents/${enc(String(agentId))}`);
    if (token !== state.agentReq || state.run !== run) return;
    state.agentData = data;
    renderAgent(data);
  } catch (err) {
    if (token !== state.agentReq) return;
    ui.agentBody.replaceChildren(h('p', { class: 'err-line' }, `Could not load agent ${agentId}: ${err.message}`));
  }
}

const KIND_TEXT = {
  choose: { start: 'Arrived, choosing where to go', next: 'Finished, choosing what next', balked: 'Walked away, choosing again', gaveup: 'Gave up, choosing again' },
  line: 'Reached a line', long: 'Long wait in line', route: 'Choosing a route', arrive: 'Arrived'
};
const kindText = line => {
  const k = KIND_TEXT[line.kind];
  if (typeof k === 'object') return k[line.why] ?? `Choosing (${line.why ?? line.kind})`;
  return k ?? line.kind;
};
const YESNO = {
  join: { q: 'Join the line?', yes: 'Get in line and wait', no: 'Skip this line' },
  keep_waiting: { q: 'Keep waiting?', yes: 'Stay in line', no: 'Give up on this line' }
};
const LEVELS = ['Calm', 'Annoyed', 'Frustrated', 'Very', 'Furious'];

function bars(rows, picked) {
  return h('ul', { class: 'bars' }, rows.map(r => h('li', { class: r.key === picked ? 'picked' : null },
    h('span', { class: 'lbl', title: r.label }, r.label, r.key === picked ? h('span', { class: 'picked-tag' }, 'sampled') : null),
    h('span', { class: 'pct' }, isNum(r.p) ? `${Math.round(r.p * 100)}%` : '–'),
    h('span', { class: 'track' }, h('i', { style: { width: `${isNum(r.p) ? Math.max(0, Math.min(1, r.p)) * 100 : 0}%` } })))));
}

function choiceBlock(line, title, picked, unused) {
  const d = line.decision ?? {};
  const options = line.options ?? [];
  const label = key => options.find(o => o.key === key)?.label ?? state.run.names.place.get(key) ?? key;
  if (!d.choiceProbs) {
    if (picked == null) return null;
    return h('div', { class: 'q' }, h('div', { class: 'q-title' }, title), h('p', { class: 'small' }, `Rule policy chose: ${label(picked)}`));
  }
  const keys = new Set(options.map(o => o.key));
  const valid = Object.entries(d.choiceProbs).filter(([k, p]) => keys.has(k) && isNum(p) && p >= 0);
  const total = valid.reduce((s, [, p]) => s + p, 0) || 1;
  let rows = valid.map(([k, p]) => ({ key: k, label: label(k), p: p / total })).sort((a, b) => b.p - a.p);
  const shown = rows.slice(0, 8);
  if (picked != null && !shown.some(r => r.key === picked)) {
    const pr = rows.find(r => r.key === picked);
    if (pr) shown.push(pr);
  }
  const hidden = rows.length - shown.length;
  rows = shown;
  return h('div', { class: `q${unused ? ' unused' : ''}` },
    h('div', { class: 'q-title' }, title),
    bars(rows, unused ? null : picked),
    hidden > 0 ? h('p', { class: 'muted small' }, `${hidden} more option${hidden > 1 ? 's' : ''} with less probability`) : null);
}

function yesNoBlock(line) {
  const d = line.decision ?? {};
  const a = line.applied ?? {};
  const q = YESNO[line.asks.yesNo] ?? { q: line.asks.yesNo, yes: 'Yes', no: 'No' };
  const picked = a.yes == null ? null : a.yes ? 'yes' : 'no';
  if (!isNum(d.yesProb)) {
    return h('div', { class: 'q' }, h('div', { class: 'q-title' }, q.q), h('p', { class: 'small' }, `Rule policy: ${picked === 'yes' ? q.yes : q.no}`));
  }
  return h('div', { class: 'q' }, h('div', { class: 'q-title' }, q.q),
    bars([{ key: 'yes', label: q.yes, p: d.yesProb }, { key: 'no', label: q.no, p: 1 - d.yesProb }], picked));
}

function frustrationBlock(line) {
  const f = line.decision?.frustration;
  if (!f) return null;
  const probs = f.probs ?? {};
  const vals = LEVELS.map((_, i) => Number(probs[String(i)]) || 0);
  const max = Math.max(0.0001, ...vals);
  return h('div', { class: 'q' },
    h('div', { class: 'q-title' }, `Frustration: ${isNum(f.expected) ? `${fmt(f.expected, 1)} of 4, ${feelingWords(f.expected)}` : '–'}`),
    h('div', { class: 'levels', role: 'img', 'aria-label': LEVELS.map((l, i) => `${l} ${Math.round(vals[i] * 100)}%`).join(', ') },
      LEVELS.map((l, i) => h('div', { title: `${l}: ${Math.round(vals[i] * 100)}%` },
        h('i', { style: { height: `${(vals[i] / max) * 100}%`, background: heat(i / 4) } }),
        h('span', {}, l)))));
}

function tellBlock(line, remark) {
  const d = line.decision ?? {};
  const a = line.applied ?? {};
  if (!line.asks?.tellOthers) return null;
  const p = isNum(d.tellProb) ? `${Math.round(d.tellProb * 100)}% likely to tell others` : 'Tell others';
  const outcome = a.tell
    ? `told others: ${remark ? remarkText(remark) : REMARK_SHORT[a.remarkKind] ?? a.remarkKind ?? 'something'}`
    : 'kept it to themselves';
  const kids = [h('div', { class: 'q-title' }, `${p} → ${outcome}`)];
  if (a.tell && d.remarkProbs) {
    const rows = Object.entries(d.remarkProbs).filter(([, v]) => isNum(v))
      .map(([k, v]) => ({ key: k, label: REMARK_SHORT[k] ?? k, p: v })).sort((x, y) => y.p - x.p);
    kids.push(bars(rows, a.remarkKind));
  }
  if (a.tell && remark) kids.push(h('p', { class: 'remark' }, `“${remarkText(remark)}”`));
  return h('div', { class: 'q' }, kids);
}

function decisionCard(line, remark) {
  const d = line.decision ?? {};
  const a = line.applied ?? {};
  const provider = d.provider ?? a.provider ?? '?';
  const via = [d.model, isNum(d.latencyMs) ? `${d.latencyMs} ms` : null].filter(Boolean).join(' · ');
  const situation = line.observation?.now ?? line.observation?.trip ?? null;
  const yesNoKind = !!line.asks?.yesNo;
  const declined = yesNoKind && a.yes === false;
  let choice = null;
  if (yesNoKind) {
    // line/long: next_place is speculative, used only when the yes/no answer came out "no".
    if (d.choiceProbs || a.action != null) {
      choice = choiceBlock(line, declined ? 'Then where?' : 'Where they would have gone instead (not used)', a.action, !declined);
    }
  } else if (line.asks?.choice) {
    choice = choiceBlock(line, line.asks.choice === 'route' ? 'Which route?' : 'Where next?', a.action, false);
  }
  const el = h('li', { class: 'dec' },
    h('div', { class: 'dec-head' },
      h('span', { class: 'when' }, line.clock ?? clockText(state.run.spec, line.t)),
      h('span', { class: 'kind' }, kindText(line)),
      h('span', { class: `tag ${provider}` }, provider),
      via ? h('span', { class: 'mono muted small' }, via) : null),
    situation ? h('p', { class: 'situation' }, situation) : null,
    yesNoKind ? yesNoBlock(line) : null,
    choice,
    frustrationBlock(line),
    tellBlock(line, remark),
    a.summary ? h('p', { class: 'dec-sum' }, `→ ${a.summary}`) : null,
    d.error ? h('p', { class: 'err-line' }, `Fell back to rules: ${d.error}`) : null,
    line.observation ? h('details', { class: 'saw' }, h('summary', {}, 'What they could see (the Jev state)'),
      h('pre', {}, JSON.stringify(line.observation, null, 2))) : null);
  return el;
}

function renderAgent({ agent, decisions }) {
  const run = state.run;
  const spec = run.spec;
  const persona = (spec.minds ?? []).find(m => m.id === agent.personaId) ?? null;
  const group = run.groupName.get(agent.archetypeId) ?? agent.archetypeId;
  const feeling = feelingWords(agent.frustration);
  const facts = [['Personality', persona?.personality], ['Wants', persona?.goal], ['Listens to', persona?.social]]
    .filter(([, v]) => v).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]);
  const clock = t => (isNum(t) ? clockText(spec, t) : '–');
  const outcome = spec.mode === 'route'
    ? `Agent ${agent.id} · set off ${clock(agent.born)} · arrived ${clock(agent.done)}`
    : `Agent ${agent.id} · served ${fmt(agent.served)} · ${mins(agent.waitTotal)} in lines · walked away ${fmt(agent.abandons)}× · came ${clock(agent.born)} · left ${clock(agent.done)}`;

  const card = h('div', { class: 'persona' },
    h('i', { class: 'dot', style: { background: run.colors.get(agent.archetypeId) || state.colors.muted } }),
    h('div', { class: 'who' },
      h('b', {}, agent.personaName ?? persona?.name ?? `Agent ${agent.id}`),
      persona?.age != null ? h('span', { class: 'muted' }, String(persona.age)) : null,
      h('span', { class: 'tag' }, group),
      agent.informed ? h('span', { class: 'tag mood' }, spec.mode === 'route' ? 'live traffic' : 'has the wait app') : null,
      feeling ? h('span', { class: 'tag mood' }, `${feeling} (${fmt(agent.frustration, 1)})`) : null),
    persona?.bio ? h('p', { class: 'bio' }, persona.bio) : null,
    facts.length ? h('dl', { class: 'facts' }, facts) : null,
    h('p', { class: 'outcome' }, outcome));

  // Each `tell` adds exactly one remark, in resolve order, so told decisions and this agent's remarks line up.
  const mine = run.remarks.filter(r => r.agentId === agent.id);
  let next = 0;
  state.decisionCards = [];
  const items = decisions.map(line => {
    const remark = line.applied?.tell ? mine[next++] ?? null : null;
    const el = decisionCard(line, remark);
    state.decisionCards.push({ el, t: line.t ?? 0 });
    return el;
  });

  const trace = agent.trace ?? [];
  ui.agentBody.className = '';
  ui.agentBody.replaceChildren(h('div', { class: 'stack' },
    card,
    h('h3', {}, decisions.length ? `${decisions.length} decision${decisions.length > 1 ? 's' : ''}` : 'Decisions'),
    decisions.length
      ? h('ol', { class: 'decisions' }, items)
      : h('p', { class: 'muted small' }, run.metrics?.decisions?.total
        ? 'This person never reached a decision moment.'
        : 'This run used the inline rule policy, so no decisions were recorded. The trace shows what happened.'),
    h('details', { class: 'trace-box', open: trace.length && !decisions.length ? true : null },
      h('summary', {}, `Trace (${trace.length} step${trace.length === 1 ? '' : 's'})`),
      trace.length ? h('pre', { class: 'trace' }, trace.map(s => `${clock(s.t)}  ${s.m}`).join('\n')) : h('p', { class: 'muted small' }, 'No trace entries.'))));
  updateFutureCards();
}

function updateFutureCards() {
  for (const c of state.decisionCards) c.el.classList.toggle('future', c.t > state.t + 1e-9);
}

// ---------- playback ----------
function play() {
  if (!state.run?.frames?.list?.length) return;
  if (state.t >= state.run.duration - 1e-6) state.t = 0;
  state.playing = true;
  state.lastTs = 0;
  ui.playBtn.textContent = 'Pause';
}

function pause() {
  state.playing = false;
  ui.playBtn.textContent = 'Play';
}

function setSpeed(v) {
  state.speed = v;
  for (const b of document.querySelectorAll('[data-speed]')) {
    const on = Number(b.dataset.speed) === v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

function renderTime() {
  const run = state.run;
  const t = state.t;
  map.render(t);
  chart.render(t);
  ui.clock.textContent = clockText(run.spec, t);
  if (document.activeElement !== ui.scrub || state.playing) ui.scrub.value = String(t);
  const f = frameAt(t);
  const c = f?.c ?? {};
  ui.nowLine.textContent = run.spec.mode === 'route'
    ? `minute ${fmt(t)} of ${fmt(run.duration)} · ${fmt(c.active)} on the road · ${fmt(c.arrived)} arrived`
    : `minute ${fmt(t)} of ${fmt(run.duration)} · ${fmt(c.active)} in the system · ${fmt(c.served)} served · ${fmt(c.abandoned)} walked away`;
  updateNowTiles(f);
  renderRemarks();
  updateFutureCards();
}

function loop(ts) {
  if (state.run && state.playing) {
    const dt = state.lastTs ? Math.min(0.1, (ts - state.lastTs) / 1000) : 0;
    state.t += dt * (state.run.duration / PLAY_SECONDS) * state.speed;
    if (state.t >= state.run.duration) {
      state.t = state.run.duration;
      pause();
    }
    state.dirty = true;
  }
  state.lastTs = ts;
  if (state.run && state.dirty) {
    state.dirty = false;
    renderTime();
  }
  requestAnimationFrame(loop);
}

// ---------- logo: a tiny swarm ----------
function logo() {
  const ctx = ui.logo.getContext('2d');
  const pts = Array.from({ length: 42 }, (_, i) => ({ a: i * 2.39996, r: 6 + Math.sqrt(i) * 5.2 }));
  const paint = tm => {
    ctx.clearRect(0, 0, 88, 88);
    ctx.fillStyle = state.colors.accent;
    for (const p of pts) {
      const a = p.a + tm * 0.00025 * (40 / p.r);
      ctx.beginPath();
      ctx.arc(44 + Math.cos(a) * p.r, 44 + Math.sin(a) * p.r, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = heat(1);
    ctx.beginPath();
    ctx.arc(44, 44, 6, 0, Math.PI * 2);
    ctx.fill();
    if (!reducedMotion()) requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);
}

// ---------- events ----------
for (const b of document.querySelectorAll('[data-provider]')) b.addEventListener('click', () => setProvider(b.dataset.provider));
for (const b of document.querySelectorAll('[data-speed]')) b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
ui.runBtn.addEventListener('click', startRun);
ui.worldSel.addEventListener('change', () => { if (ui.worldSel.value !== PASTED) store('swarmscope.world', ui.worldSel.value); });
ui.runSel.addEventListener('change', () => {
  if (!ui.runSel.value) return;
  loadRun(ui.runSel.value).catch(err => setStatus(`Could not load the run: ${err.message}`, true));
});
ui.refreshRuns.addEventListener('click', () => refreshRuns());
ui.editBtn.addEventListener('click', editCopy);
ui.validateBtn.addEventListener('click', validatePasted);
ui.useBtn.addEventListener('click', usePasted);
ui.pasteIn.addEventListener('input', () => { ui.useBtn.disabled = true; state.validated = null; setPasteStatus(''); });
ui.compileBtn.addEventListener('click', compileDescription);
ui.describeIn.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) compileDescription(); });
ui.playBtn.addEventListener('click', () => (state.playing ? pause() : play()));
ui.scrub.addEventListener('input', () => { state.t = Number(ui.scrub.value) || 0; state.dirty = true; });
ui.themeBtn.addEventListener('click', () => {
  const cur = ui.themeBtn.dataset.mode || 'auto';
  applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
});
document.addEventListener('keydown', e => {
  if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, button, summary, [contenteditable]')) return;
  if (!state.run) return;
  e.preventDefault();
  state.playing ? pause() : play();
});
new MutationObserver(onThemeChange).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', onThemeChange);
const resizer = new ResizeObserver(() => { map.resize(); chart.resize(); state.dirty = true; });
resizer.observe(ui.mapbox);
resizer.observe(ui.chart.parentElement);

// ---------- start ----------
applyTheme(recall('swarmscope.theme') || 'auto');
readColors();
logo();
setSpeed(1);
setProvider(recall('swarmscope.provider') || 'jev');
if (moduleError) setStatus(`The map or chart module failed to load (${moduleError.message}). Runs, stats and the inspector still work.`, true);
await Promise.all([loadHealth(), loadWorlds(), refreshRuns()]);
{
  const fromHash = decodeURIComponent((location.hash.match(/run=([^&]+)/) ?? [])[1] ?? '');
  const first = fromHash || state.runs.find(r => r.status !== 'error')?.runId;
  if (first) {
    loadRun(first).catch(err => setStatus(`Could not load run ${first}: ${err.message}`, true));
  } else if (!moduleError) {
    setStatus('No recorded runs yet. Pick a world and press Run.');
  }
}
requestAnimationFrame(loop);
