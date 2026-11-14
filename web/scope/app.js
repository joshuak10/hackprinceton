// Swarmscope scope display: wiring. One state object; derive → draw → panels.
// URL params for reproducible views: ?case=building|parking&t=40&floor=0&theme=light&autoplay=0
import { prepareFrames, frameIndex, frameAt, agentsAt, clockText } from './lib/frames.js';
import { deriveRun } from './lib/incidents.js';
import { createHeat, calibrate, advance } from './lib/heat.js';
import { createRenderer, readPalette } from './lib/render.js';
import { createTimeline } from './lib/timeline.js';
import { renderCounters, renderRank, renderFilters, renderFeed, renderInspector, renderDrawer } from './lib/panels.js';
import { matchCase, showConfirm, showChoices, hideCard, showProgress } from './lib/prompt.js';
import { createTour } from './lib/tour.js';
import { loadCases, loadConfig, loadBundle, apiHealth, apiBuildingRuns, apiLoadRun, apiStartRun } from './lib/source.js';
import { createFeedback, hardCodedSuggestion, applySuggestion, compareRows } from './lib/feedback.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
};

const st = {
  cases: {}, caseId: null, caseInfo: null, bundle: null, F: null, run: null, heat: null, heatIncidents: [],
  t: 0, playing: false, speed: 4, floor: 0, colorBy: 'state',
  layers: { heat: true, agents: true, labels: true },
  filters: { decision: true, congestion: true, complaint: true },
  selectedAgent: null, selectedIncident: null,
  theme: params.get('theme') || store.get('scope-theme') || 'dark',
  live: null, config: {}, question: '', fly: null, lastPanels: -1, dirty: true,
  rankMode: store.get('scope-rank') === 'now' ? 'now' : 'total'
};

// ---------- theme ----------
function applyTheme() {
  document.documentElement.dataset.theme = st.theme;
  $('themeBtn').setAttribute('aria-label', st.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  R.pal = readPalette();
  R.baseKey = '';
  if (st.bundle) { T.setRun({ duration: st.run.duration, clockStart: st.bundle.meta.clockStart, bins: st.run.bins, pal: R.pal }); }
  drawThumbs();
  st.dirty = true;
}
$('themeBtn').addEventListener('click', () => {
  st.theme = st.theme === 'dark' ? 'light' : 'dark';
  store.set('scope-theme', st.theme);
  applyTheme();
  T.update(st.t, st.playing);
});

// ---------- map ----------
const R = createRenderer($('map'));
const T = createTimeline({
  root: $('timeline'),
  onSeek: (t, opts = {}) => {
    seek(t);
    if (opts.user) pause();
  },
  onPlay: () => (st.playing ? pause() : play()),
  onSpeed: s => setSpeed(s)
});
const tour = createTour({ root: $('tour'), body: $('tourBody'), title: $('tourTitle'), closeBtn: $('tourClose'), onClose: () => { st.dirty = true; } });
const feedback = createFeedback({ onRun: runSuggestion, onPick: showRun });

new ResizeObserver(() => {
  R.resize();
  R.refit();
  if (st.bundle) T.layout();
  st.dirty = true;
}).observe($('mapbox'));

function drawState() {
  return {
    caseId: st.caseId, floor: st.floor, theme: st.theme, layers: st.layers, geometry: st.bundle.geometry,
    F: st.F, t: st.t, heat: st.heat, incidents: st.run.incidents, filters: st.filters,
    selectedIncident: st.selectedIncident, selectedAgent: st.selectedAgent, frame: frameAt(st.F, st.t),
    nodes: st.bundle.frames.nodes || [], colorBy: st.colorBy, frustration: st.run.frustration.at,
    archIndex: st.archIndex, agentArch: st.agentArch, reducedMotion
  };
}

// ---------- loading a run ----------
function setBundle(bundle, caseInfo) {
  st.bundle = bundle;
  st.caseInfo = caseInfo;
  st.F = prepareFrames(bundle.frames);
  st.run = deriveRun(bundle, st.F);
  st.agentsById = new Map(bundle.agents.map(a => [a.id, a]));
  st.personas = new Map((bundle.spec.minds || []).map(p => [p.id, p]));
  st.archNames = new Map((bundle.spec.archetypes || []).map(a => [a.id, a.name]));
  st.archIndex = new Map((bundle.spec.archetypes || []).map((a, i) => [a.id, i]));
  st.agentArch = new Map(bundle.agents.map(a => [a.id, a.archetypeId]));
  st.nodeName = id => st.run.nodes.get(id)?.name || id;
  st.floorTimes = bundle.geometry.floors.map((_, fi) => st.run.incidents.filter(it => (it.floor || 0) === fi).map(it => it.t));
  st.selectedAgent = null;
  st.selectedIncident = null;
  st.t = 0;
  st.floor = 0;
  rebuildHeat();

  const geo = bundle.geometry;
  R.setBounds(geo.floors[0].bounds || geo.bounds);
  $('placeTitle').textContent = caseInfo?.place || geo.source?.name || bundle.meta.title;
  $('placeSub').textContent = st.question ? `“${st.question}”` : bundle.meta.question;
  $('emptyState').hidden = true;
  $('side').classList.remove('idle');
  $('mapTools').hidden = false;
  $('legendMini').hidden = false;
  $('timeline').hidden = false;
  $('inspector').hidden = true;
  $('callout').hidden = true;
  const prov = bundle.meta.providerStats?.provider || bundle.meta.provider;
  $('sourceBadge').textContent = providerWords(bundle.meta);
  $('sourceBadge').classList.toggle('live', prov === 'jev' || prov === 'replay');
  $('sourceBadge').title = prov === 'mock' ? 'Decisions come from the mock generator, not Jev.'
    : prov === 'jev' || prov === 'replay' ? 'Every decision in this run came from Jev (replays make no new requests).'
      : 'Decisions came from the engine\'s rule policy, not Jev.';
  renderRunPicker();
  refreshSuggestion(bundle, caseInfo);

  tour.hide();
  tour.configure({ modelId: geo.source?.provider === 'matterport' ? geo.source.modelId : null, key: st.config.matterportSdkKey });

  renderFloorTabs();
  renderFilters($('feedFilters'), st, toggleFilter);
  renderLegend();
  T.setRun({ duration: st.run.duration, clockStart: bundle.meta.clockStart, bins: st.run.bins, pal: R.pal });
  if (!$('drawer').hidden) renderDrawer($('drawerBody'), drawerState(), st.caseInfo);
  st.lastPanels = -1;
  st.dirty = true;
  update();
}

function rebuildHeat() {
  const geo = st.bundle.geometry;
  st.heatIncidents = st.run.incidents.filter(it => st.filters[it.cat]);
  st.heat = createHeat(geo.floors[0].bounds || geo.bounds, geo.floors.length, { cell: 0.6, sigma: 2.6 });
  calibrate(st.heat, st.heatIncidents);
  advance(st.heat, st.heatIncidents, st.t);
}

// "Jev jev-1.14.0", "Rules, not Jev", "Mock data": who made a run's decisions.
function providerWords(meta) {
  const p = meta?.providerStats?.provider || meta?.provider;
  if (p === 'jev') return `Jev ${meta.model || meta.providerStats?.model || ''}`.trim();
  if (p === 'replay') return 'Jev, replayed';
  if (p === 'mock') return 'Mock data';
  return 'Rules, not Jev';
}

// ---------- the hard-coded suggestion and its run ----------
// Which runs are suggestion runs: { [runId]: { base, suggestion } }, kept in this browser.
const suggestionRuns = (() => { try { return JSON.parse(store.get('scope-suggestions') || '{}') || {}; } catch { return {}; } })();
const runLabel = r => {
  const when = r.meta.createdAt ? new Date(r.meta.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return `${providerWords(r.meta).replace(', not Jev', '')}, seed ${r.meta.seed ?? '?'}${when ? `, ${when}` : ''}`;
};

// What the Suggestions button offers for the run on screen, and the comparison once its suggestion run exists.
function refreshSuggestion(bundle, c) {
  const runId = bundle.meta?.runId;
  const onServer = !!(c?.runs?.length && runId && c.runs.some(r => r.meta.runId === runId));
  if (!onServer) {
    const s = hardCodedSuggestion(bundle.spec, bundle.metrics)
      || { label: 'Add one more server at the busiest counter', why: 'The busiest counter is where most people wait or walk away.', change: 'One more server at the busiest counter' };
    feedback.reset({ suggestion: s, canRun: false, cannotRunWhy: 'This is a mock run, so it cannot be re-run. Start the engine (node bin/swarm.js serve) and open a recorded run to test the suggestion.' });
    return;
  }
  const mine = suggestionRuns[runId];
  const has = id => c.runs.some(r => r.meta.runId === id);
  const baseId = mine && has(mine.base) ? mine.base : runId;
  const sugId = mine ? runId : c.runs.map(r => r.meta.runId).find(id => suggestionRuns[id]?.base === runId);
  const suggestion = (sugId && suggestionRuns[sugId]?.suggestion) || hardCodedSuggestion(bundle.spec, bundle.metrics);
  if (!suggestion) { feedback.reset(null); return; }
  const base = c.runs.find(r => r.meta.runId === baseId);
  const jev = ['jev', 'replay'].includes(base.meta.providerStats?.provider || base.meta.provider) && st.live?.jev;
  const ctx = {
    suggestion, canRun: !!st.live && !mine,
    cannotRunWhy: mine ? 'This is the suggestion run. Open the baseline to run the suggestion again.' : 'The engine is not reachable, so a new run cannot start.',
    runNote: jev ? 'Starts a live Jev run: every decision is one Jev request to TypeSafe.' : 'Starts a rules run on the engine: no Jev requests, and it takes a few seconds.',
    compare: null
  };
  feedback.reset(ctx);
  if (!sugId || sugId === baseId) return;
  // Both runs' numbers, then the dropdown. Skipped if another run is on screen by then.
  Promise.all([loadEngineRun(baseId), loadEngineRun(sugId)]).then(([b, a]) => {
    if (st.bundle !== bundle) return;
    const sug = c.runs.find(r => r.meta.runId === sugId);
    const cross = providerWords(base.meta) !== providerWords(sug.meta);
    feedback.reset({
      ...ctx, canRun: false,
      compare: {
        selected: runId, rows: compareRows(b.metrics, a.metrics, suggestion),
        options: [{ runId: baseId, label: `Baseline (${runLabel(base)})` }, { runId: sugId, label: `With the suggestion (${runLabel(sug)})` }],
        note: cross ? `The baseline's decisions came from ${providerWords(base.meta)} and the suggestion run's from ${providerWords(sug.meta)}, so part of the difference is the decision-maker, not the change.` : ''
      }
    });
  }).catch(() => {});
}

function runSuggestion() {
  const c = st.caseInfo, base = c && selectedRun(c);
  if (!base || st.loading) return;
  const suggestion = hardCodedSuggestion(base.spec, st.bundle.metrics);
  if (!suggestion) return;
  const jev = ['jev', 'replay'].includes(base.meta.providerStats?.provider || base.meta.provider) && st.live?.jev;
  openCase(c.id, { question: st.question, newRun: jev ? 'jev' : 'rules', suggestion, autoplay: false });
}

// Switch between the baseline and the suggestion run, keeping the time on the slider.
async function showRun(runId) {
  const c = st.caseInfo;
  if (!c || st.loading || runId === st.bundle?.meta?.runId) return;
  const t = st.t;
  c.selected = runId;
  await openCase(c.id, { question: st.question, autoplay: false });
  if (st.bundle?.meta?.runId === runId) seek(Math.min(t, st.run.duration));
}

const selectedRun = c => c.runs?.find(r => r.meta.runId === c.selected) || c.runs?.[0] || null;

// Engine runs are loaded once and reused (thumbnails, reopening).
const runCache = new Map();
function loadEngineRun(runId) {
  if (!runCache.has(runId)) runCache.set(runId, apiLoadRun(runId, { modelId: st.config.modelId }).catch(err => { runCache.delete(runId); throw err; }));
  return runCache.get(runId);
}
function bundleFor(c) {
  const r = selectedRun(c);
  return r ? loadEngineRun(r.meta.runId) : loadBundle(c.file);
}

function renderRunPicker() {
  const c = st.caseInfo;
  const box = $('runPick'), sel = $('runSel');
  box.hidden = !c?.runs?.length;
  if (box.hidden) return;
  sel.replaceChildren(...c.runs.map(r => {
    const o = document.createElement('option');
    const when = r.meta.createdAt ? new Date(r.meta.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    o.value = r.meta.runId;
    const n = r.meta.decisions || 0;
    o.textContent = `${suggestionRuns[r.meta.runId] ? 'Suggestion: ' : ''}${providerWords(r.meta).replace(', not Jev', '')}, seed ${r.meta.seed ?? '?'}${when ? `, ${when}` : ''}${n ? ` (${n.toLocaleString('en-US')} decisions)` : ''}`;
    o.selected = r.meta.runId === (selectedRun(c)?.meta.runId);
    return o;
  }));
}
$('runSel').addEventListener('change', e => {
  const c = st.caseInfo;
  if (!c) return;
  c.selected = e.target.value;
  openCase(c.id, { question: st.question, autoplay: false });
});

// A new run on the engine server from the selected run's world (same spec and seed).
async function runOnServer(c, provider, suggestion = null) {
  const base = selectedRun(c);
  const spec = suggestion ? applySuggestion(base.spec, suggestion) : base.spec;
  const p = showProgress($('progress'), [{ label: suggestion ? `Starting a run with the suggestion: ${suggestion.change}` : 'Starting the run on the engine' }, { label: 'Running the swarm' }, { label: 'Opening the replay' }],
    provider === 'jev' ? 'Live Jev run: every decision is one Jev request to TypeSafe.' : 'Rules run: the engine\'s rule policy decides; no Jev requests.');
  p.set(0);
  const runId = await apiStartRun({
    spec, provider, seed: base.meta.seed ?? 7,
    onStatus: s => p.set(1, `Running the swarm: ${Math.round(((s.t || 0) / (s.duration || 1)) * 100)}% simulated${s.decisions ? `, ${s.decisions} decisions` : ''}`)
  });
  p.set(2);
  if (suggestion) {
    suggestionRuns[runId] = { base: base.meta.runId, suggestion };
    store.set('scope-suggestions', JSON.stringify(suggestionRuns));
  }
  c.runs = await apiBuildingRuns();
  c.selected = runId;
  const bundle = await loadEngineRun(runId);
  p.done();
  return bundle;
}

async function openCase(id, { question = '', progress = false, autoplay = true, newRun = null, suggestion = null } = {}) {
  const c = st.cases[id];
  if (!c || st.loading) return;
  st.loading = true;
  $('askBtn').disabled = true;
  $('askBtn').textContent = 'Loading…';
  $('mapbox').setAttribute('aria-busy', 'true');
  pause();
  st.caseId = id;
  st.question = question;
  hideCard($('askCard'));
  try {
    let bundle;
    if (newRun) {
      bundle = await runOnServer(c, newRun, suggestion);
    } else if (c.runs?.length) {
      const r = selectedRun(c);
      const p = progress ? showProgress($('progress'), [{ label: `Loading the recorded run (${providerWords(r.meta)})` }, { label: 'Opening the replay' }], 'Recorded by the engine. Replaying makes no Jev requests.') : null;
      p?.set(0);
      bundle = await bundleFor(c);
      p?.set(1);
      p?.done();
    } else {
      const load = loadBundle(c.file);
      if (progress) await mockProgress(id, load);
      bundle = await load;
    }
    setBundle(bundle, c);
    const t0 = Number(params.get('t'));
    if (Number.isFinite(t0) && t0 > 0 && !progress) seek(t0);
    const f0 = Number(params.get('floor'));
    if (Number.isFinite(f0) && f0 > 0 && !progress) setFloor(f0);
    if (autoplay) play();
  } catch (err) {
    $('progress').hidden = true;
    showChoices($('askCard'), {
      message: c.runs?.length ? `That run couldn't be loaded or started: ${err.message}` : `That run couldn't be loaded: ${err.message}. Run "npm run mock" to rebuild the mock runs, then try again.`,
      cases: Object.values(st.cases), onPick: pid => confirmCase(pid, st.cases[pid].question), onCancel: () => hideCard($('askCard'))
    });
  } finally {
    st.loading = false;
    $('askBtn').disabled = false;
    $('askBtn').textContent = 'Simulate';
    $('mapbox').setAttribute('aria-busy', 'false');
  }
}

// Staged progress for mock runs, so the flow matches what a live run will look like. Labelled as mock.
async function mockProgress(id, load) {
  const c = st.cases[id];
  const steps = id === 'parking'
    ? [{ label: 'Reading the lot layout' }, { label: 'Casting drivers' }, { label: 'Running the swarm' }, { label: 'Opening the replay' }]
    : [{ label: c.source === 'matterport' ? 'Reading the Matterport floor plan and mesh' : 'Reading the floor plan' }, { label: 'Casting people' }, { label: 'Running the swarm' }, { label: 'Opening the replay' }];
  const p = showProgress($('progress'), steps, 'Mock run: this replays a recorded mock run. No Jev requests are made.');
  const wait = ms => new Promise(r => setTimeout(r, reducedMotion ? 0 : ms));
  p.set(0); await wait(550);
  const b = await load;
  const groups = new Set(b.agents.map(a => a.archetypeId)).size;
  p.set(1, `Casting ${b.agents.length} ${id === 'parking' ? 'drivers' : 'people'} from ${groups} groups`); await wait(650);
  const n = b.decisions.length;
  for (let k = 1; k <= 8; k++) { p.set(2, `Running the swarm: ${Math.round((n * k) / 8)} of ${n} decisions`); await wait(110); }
  p.set(3); await wait(300);
  p.done();
}

// ---------- time ----------
function seek(t) {
  st.t = Math.max(0, Math.min(st.run?.duration ?? 0, t));
  st.dirty = true;
  update();
}
function play() {
  if (!st.bundle) return;
  if (st.t >= st.run.duration - 0.01) st.t = 0;
  st.playing = true;
  st.lastTick = performance.now();
  T.update(st.t, true);
}
function pause() { st.playing = false; if (st.bundle) T.update(st.t, false); }
function setSpeed(s) {
  st.speed = s;
  document.querySelectorAll('.seg button[data-speed]').forEach(b => {
    const on = Number(b.dataset.speed) === s;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function update() {
  if (!st.bundle) return;
  advance(st.heat, st.heatIncidents, st.t);
  T.update(st.t, st.playing);
  // Panels at most 4 times per simulated minute while playing; always when paused.
  const q = Math.floor(st.t * 4);
  if (!st.playing || q !== st.lastPanels) { st.lastPanels = q; renderPanels(); }
}

function renderPanels() {
  const fi = frameIndex(st.F, st.t);
  st.allAgents = agentsAt(st.F, st.t);
  const ps = {
    geometry: st.bundle.geometry, frame: frameAt(st.F, st.t), visibleAgents: st.allAgents, t: st.t,
    incidents: st.run.incidents, filters: st.filters, selectedIncident: st.selectedIncident, floor: st.floor,
    bottlenecks: st.run.bottlenecks.at(fi, st.t), bottleneckMax: st.run.bottlenecks.max(),
    bottlenecksNow: st.run.bottlenecks.now(fi), bottleneckNowMax: st.run.bottlenecks.nowMax(), rankMode: st.rankMode
  };
  renderCounters($('counters'), ps);
  renderRank($('rank'), ps, id => {
    const n = st.run.nodes.get(id);
    if (n) { if ((n.floor || 0) !== st.floor) setFloor(n.floor || 0); flyTo(n.x, n.y, 1.8); }
  });
  renderFeed($('feed'), ps, it => focusIncident(it, { fly: true }));
  updateFloorCounts();
  if (st.selectedAgent != null) renderInspector($('inspector'), inspectorState(), st.selectedAgent, closeInspector);
}

function inspectorState() {
  return {
    agentsById: st.agentsById, personas: st.personas, decisions: st.bundle.decisions, nodeName: st.nodeName,
    visibleAgents: st.allAgents || agentsAt(st.F, st.t), archNames: st.archNames, t: st.t, clockStart: st.bundle.meta.clockStart
  };
}
function drawerState() { return { bundle: st.bundle, decisions: st.bundle.decisions, geometry: st.bundle.geometry }; }

// ---------- floors ----------
function renderFloorTabs() {
  const floors = st.bundle.geometry.floors;
  const tabs = $('floorTabs');
  tabs.hidden = floors.length < 2;
  tabs.replaceChildren(...floors.map((f, fi) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(fi === st.floor));
    b.tabIndex = fi === st.floor ? 0 : -1;
    b.append(document.createTextNode(f.label), Object.assign(document.createElement('span'), { className: 'count' }));
    b.addEventListener('click', () => setFloor(fi));
    b.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? floors.length - 1
        : (fi + (e.key === 'ArrowRight' ? 1 : -1) + floors.length) % floors.length;
      setFloor(next);
      tabs.children[next].focus();
    });
    return b;
  }));
}
function updateFloorCounts() {
  if ($('floorTabs').hidden) return;
  [...$('floorTabs').children].forEach((b, fi) => {
    const times = st.floorTimes[fi] || [];
    let n = 0;
    for (const t of times) { if (t <= st.t) n++; else break; }
    b.querySelector('.count').textContent = n ? String(n) : '';
    b.setAttribute('aria-label', `${st.bundle.geometry.floors[fi].label}, ${n} incidents so far`);
  });
}
function setFloor(fi) {
  if (!st.bundle.geometry.floors[fi]) return;
  st.floor = fi;
  [...$('floorTabs').children].forEach((b, k) => {
    b.setAttribute('aria-selected', String(k === fi));
    b.tabIndex = k === fi ? 0 : -1;
  });
  st.dirty = true;
  renderPanels();
}

// ---------- selection ----------
function focusIncident(it, { fly = false } = {}) {
  st.selectedIncident = it;
  if ((it.floor || 0) !== st.floor) setFloor(it.floor || 0);
  if (fly) flyTo(it.x, it.y, Math.max(R.view.z, 1.9));
  st.dirty = true;
  renderPanels();
  showCallout();
}
function showCallout() {
  const it = st.selectedIncident;
  const box = $('callout');
  if (!it) { box.hidden = true; return; }
  const title = document.createElement('p');
  title.className = 'ct';
  title.textContent = it.text;
  const meta = document.createElement('p');
  meta.className = 'cm';
  const floorLabel = st.bundle.geometry.floors.length > 1 ? `, ${st.bundle.geometry.floors[it.floor || 0].label}` : '';
  meta.textContent = `${it.clock}${floorLabel}${it.who && !it.text.startsWith(it.who) ? `, ${it.who}` : ''}`;
  const row = document.createElement('div');
  row.className = 'row';
  if (tour.available()) {
    const b = document.createElement('button');
    b.className = 'btn primary small';
    b.type = 'button';
    b.textContent = st.bundle.geometry.sweeps?.length ? 'See this spot in 3D' : 'Open the 3D tour';
    b.addEventListener('click', () => tour.open(st.bundle.geometry, { x: it.x, y: it.y, floor: it.floor || 0, label: it.group }));
    row.append(b);
  }
  if (it.agentId != null && st.agentsById.has(it.agentId)) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.type = 'button';
    b.textContent = 'Their decisions';
    b.addEventListener('click', () => selectAgent(it.agentId));
    row.append(b);
  }
  const x = document.createElement('button');
  x.className = 'btn ghost small';
  x.type = 'button';
  x.textContent = 'Close';
  x.addEventListener('click', () => { st.selectedIncident = null; box.hidden = true; st.dirty = true; renderPanels(); });
  row.append(x);
  box.replaceChildren(title, meta, row);
  box.hidden = false;
  positionCallout();
}
function positionCallout() {
  const it = st.selectedIncident, box = $('callout');
  if (!it || box.hidden) return;
  const [sx, sy] = R.toScreen(it.x, it.y);
  const onFloor = (it.floor || 0) === st.floor;
  box.style.visibility = onFloor ? 'visible' : 'hidden';
  box.style.left = `${Math.max(170, Math.min(R.cw - 170, sx))}px`;
  box.style.top = `${sy}px`;
  box.classList.toggle('below', sy < 150);
}

function selectAgent(id) {
  st.selectedAgent = id;
  renderInspector($('inspector'), inspectorState(), id, closeInspector);
  st.dirty = true;
}
function closeInspector() { st.selectedAgent = null; $('inspector').hidden = true; st.dirty = true; }

function toggleFilter(cat) {
  st.filters[cat] = !st.filters[cat];
  if (!Object.values(st.filters).some(Boolean)) st.filters[cat] = true;
  renderFilters($('feedFilters'), st, toggleFilter);
  rebuildHeat();
  st.dirty = true;
  renderPanels();
}

// ---------- view: pan, zoom, fly ----------
function flyTo(x, y, z) {
  const tourW = $('tour').hidden ? 0 : $('tour').getBoundingClientRect().width;
  const target = { x: x + tourW / 2 / (R.fit * z), y, z };
  $('resetView').hidden = false;
  if (reducedMotion) { R.view = target; st.dirty = true; positionCallout(); return; }
  st.fly = { from: { ...R.view }, to: target, start: performance.now(), dur: 650 };
}
$('resetView').addEventListener('click', () => {
  const b = st.bundle.geometry.floors[st.floor].bounds;
  flyTo((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 1);
  $('resetView').hidden = true;
});

const map = $('map');
let drag = null;
map.addEventListener('pointerdown', e => {
  if (!st.bundle) return;
  drag = { x: e.clientX, y: e.clientY, vx: R.view.x, vy: R.view.y, moved: false };
  map.setPointerCapture(e.pointerId);
});
map.addEventListener('pointermove', e => {
  if (!st.bundle) return;
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; map.classList.add('dragging'); }
    if (drag.moved) {
      R.view.x = drag.vx - dx / R.scale();
      R.view.y = drag.vy - dy / R.scale();
      $('resetView').hidden = false;
      st.dirty = true;
      positionCallout();
    }
    return;
  }
  const r = map.getBoundingClientRect();
  map.classList.toggle('pointing', !!R.hit(drawState(), e.clientX - r.left, e.clientY - r.top));
});
map.addEventListener('pointerup', e => {
  if (!st.bundle || !drag) return;
  const wasDrag = drag.moved;
  drag = null;
  map.classList.remove('dragging');
  if (wasDrag) return;
  const r = map.getBoundingClientRect();
  const hit = R.hit(drawState(), e.clientX - r.left, e.clientY - r.top);
  if (hit?.type === 'agent') selectAgent(hit.id);
  else if (hit?.type === 'incident') focusIncident(hit.incident);
});
map.addEventListener('wheel', e => {
  if (!st.bundle) return;
  e.preventDefault();
  const r = map.getBoundingClientRect();
  const [mx, my] = R.toMap(e.clientX - r.left, e.clientY - r.top);
  const z = Math.max(1, Math.min(6, R.view.z * Math.exp(-e.deltaY * 0.0015)));
  R.view.z = z;
  const [nx, ny] = R.toMap(e.clientX - r.left, e.clientY - r.top);
  R.view.x += mx - nx; R.view.y += my - ny;
  $('resetView').hidden = z <= 1.001;
  st.dirty = true;
  positionCallout();
}, { passive: false });
map.addEventListener('dblclick', () => $('resetView').click());

// ---------- bottleneck measure: so far (cumulative) or right now ----------
const RANK_HINT = {
  total: 'Minutes waited so far, plus 30 for each person lost',
  now: 'People in line at this moment, and the wait for someone joining now'
};
function setRankMode(mode) {
  st.rankMode = mode;
  store.set('scope-rank', mode);
  document.querySelectorAll('#rankMode button').forEach(b => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('rankHint').textContent = RANK_HINT[mode];
  if (st.bundle) renderPanels();
}
document.querySelectorAll('#rankMode button').forEach(b => b.addEventListener('click', () => setRankMode(b.dataset.mode)));
setRankMode(st.rankMode);

// ---------- tools ----------
$('colorBy').addEventListener('change', e => { st.colorBy = e.target.value; renderLegend(); st.dirty = true; });
document.querySelectorAll('.toggles .chip').forEach(b => b.addEventListener('click', () => {
  const k = b.dataset.layer;
  st.layers[k] = !st.layers[k];
  b.classList.toggle('on', st.layers[k]);
  b.setAttribute('aria-pressed', String(st.layers[k]));
  st.dirty = true;
}));

function renderLegend() {
  const box = $('legendMini');
  const items = st.colorBy === 'frustration'
    ? [['#8ec5ff', 'Calm'], ['#b9a2ff', 'Annoyed'], ['#f2c14e', 'Frustrated'], ['#e5484d', 'Furious']]
    : st.colorBy === 'archetype'
      ? (st.bundle?.spec.archetypes || []).slice(0, 5).map((a, i) => [`var(--g-${i + 1})`, a.name])
      : st.bundle?.geometry.kind === 'lot'
        ? [['var(--a-car)', 'Driving'], ['var(--a-queue)', 'Stopped'], ['var(--a-walk)', 'Walking in'], ['var(--a-leave)', 'Walking back']]
        : [['var(--a-walk)', 'Walking'], ['var(--a-queue)', 'In a line'], ['var(--a-serve)', 'Served or staying'], ['var(--a-think)', 'Deciding']];
  const frag = items.map(([c, t]) => {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.style.background = c;
    s.append(i, document.createTextNode(t));
    return s;
  });
  const heat = document.createElement('span');
  const bar = document.createElement('i');
  bar.className = 'heatbar';
  bar.style.background = 'linear-gradient(90deg, transparent, var(--heat-1), var(--heat-2), var(--heat-3))';
  heat.append(document.createTextNode('Incidents so far'), bar);
  box.replaceChildren(...frag, heat);
}

$('detailsBtn').addEventListener('click', () => {
  const d = $('drawer');
  const open = d.hidden;
  d.hidden = !open;
  $('detailsBtn').setAttribute('aria-expanded', String(open));
  if (open && st.bundle) renderDrawer($('drawerBody'), drawerState(), st.caseInfo);
  else if (open) $('drawerBody').replaceChildren(Object.assign(document.createElement('p'), { className: 'note', textContent: 'Run a simulation to see who made the decisions and where the data came from.' }));
  if (open) $('drawerClose').focus();
});
$('drawerClose').addEventListener('click', () => { $('drawer').hidden = true; $('detailsBtn').setAttribute('aria-expanded', 'false'); $('detailsBtn').focus(); });

// ---------- prompt ----------
function factsFor(id) {
  const c = st.cases[id];
  const r = selectedRun(c);
  if (r) {
    const m = r.meta;
    const jevRuns = c.runs.filter(x => x.meta.provider === 'jev');
    return [
      ['Scenario', r.spec.title],
      ['People', `${m.agents} over ${Math.round(m.duration)} minutes`],
      ['When', `${clockText(m.clockStart, 0)} to ${clockText(m.clockStart, m.duration)}`],
      ['Map', `Matterport walls and doors (${r.spec.walls.length} walls, ${r.spec.doors?.length || 0} doors); counters from the proposed fit-out, assumed`],
      ['Selected run', `${providerWords(m)}, seed ${m.seed}${m.provider === 'jev' ? `, ${m.decisions} decisions` : ''}`],
      ...(st.live?.jev ? [['A new Jev run', jevRuns.length ? `about ${jevRuns[0].meta.providerStats?.requests ?? jevRuns[0].meta.decisions} requests, like the last one` : 'about 1,000 requests for this building (a few cents at TypeSafe\'s published price, unverified)']] : [])
    ];
  }
  const mock = true;
  if (id === 'parking') {
    return [
      ['Drivers', '350 over two hours'], ['When', 'Saturday, 12:30 to 2:30 pm'],
      ['Map', c.source === 'synthetic' ? 'Drawn lot, until a property and Vexcel imagery are chosen' : 'Traced from aerial imagery'],
      ['Decisions', mock ? 'Mock, shaped like Jev answers' : 'Jev, one request per decision']
    ];
  }
  return [
    ['People', '490 over 90 minutes'], ['When', 'Weekday lunch, 11:45 am to 1:15 pm'],
    ['Map', c.source === 'matterport' ? 'Matterport floor plan and mesh; counters and doors placed by hand' : 'Drawn floor plan (no scan loaded)'],
    ['Decisions', mock ? 'Mock, shaped like Jev answers' : 'Jev, one request per decision']
  ];
}

function confirmCase(id, question) {
  const c = st.cases[id];
  const go = opts => () => { hideCard($('askCard')); openCase(id, { question, ...opts }); };
  const actions = c.runs?.length
    ? [
        { label: 'Replay this run', primary: true, onClick: go({ progress: true }) },
        { label: 'Run again with rules', onClick: go({ newRun: 'rules' }) },
        ...(st.live?.jev ? [{ label: 'Run with Jev', onClick: go({ newRun: 'jev' }) }] : [])
      ]
    : [{ label: 'Run simulation', primary: true, onClick: go({ progress: true }) }];
  showConfirm($('askCard'), {
    caseInfo: { label: c.label, place: c.place }, question, facts: factsFor(id), actions,
    onCancel: () => hideCard($('askCard'))
  });
}

$('askForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('askIn').value.trim();
  const cases = Object.values(st.cases);
  if (!text) {
    showChoices($('askCard'), { message: 'Pick one of the two cases Swarmscope can run right now.', cases, onPick: id => confirmCase(id, st.cases[id].question), onCancel: () => hideCard($('askCard')) });
    return;
  }
  const m = matchCase(text);
  if (m?.id && st.cases[m.id]) confirmCase(m.id, text);
  else {
    showChoices($('askCard'), {
      message: m?.tie
        ? 'That could be either case. Which one did you mean?'
        : 'Swarmscope can simulate two things right now: crowding inside a building, and a retail parking lot. Pick the closer one, or rephrase your question.',
      cases, onPick: id => confirmCase(id, text), onCancel: () => hideCard($('askCard'))
    });
  }
});

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  if ($('feedbackDialog').open) return;
  // Text fields and tabs keep their keys. On a focused button or link, Space activates that control,
  // so it doesn't also toggle playback; the arrow keys still step the replay.
  const typing = e.target.closest('input, select, textarea, [role="tab"], [contenteditable="true"]');
  if (e.key === ' ' && e.target.closest('button, a, [role="button"]')) return;
  if (e.key === 'Escape') {
    if (!$('askCard').hidden) hideCard($('askCard'));
    else if (!$('tour').hidden) tour.hide();
    else if (!$('drawer').hidden) $('drawerClose').click();
    else if (st.selectedAgent != null) closeInspector();
    else if (st.selectedIncident) { st.selectedIncident = null; $('callout').hidden = true; st.dirty = true; }
    return;
  }
  if (typing || !st.bundle) return;
  if (e.key === ' ') { e.preventDefault(); st.playing ? pause() : play(); }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const step = e.shiftKey ? 10 : (st.F.list[1]?.t - st.F.list[0]?.t) || 1 / 15;
    pause();
    seek(st.t + dir * step);
  }
});

// ---------- loop ----------
function loop(now) {
  if (st.bundle) {
    if (st.playing) {
      const dt = Math.min(0.1, (now - st.lastTick) / 1000);
      st.lastTick = now;
      st.t += dt * st.speed;
      if (st.t >= st.run.duration) { st.t = st.run.duration; pause(); }
      update();
      st.dirty = true;
    }
    if (st.fly) {
      const u = Math.min(1, (now - st.fly.start) / st.fly.dur);
      const e = 1 - Math.pow(1 - u, 3);
      const { from, to } = st.fly;
      R.view = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z: from.z + (to.z - from.z) * e };
      if (u >= 1) st.fly = null;
      st.dirty = true;
      positionCallout();
    }
    // Paused frames still redraw a few times a second so "deciding" pulses stay alive.
    const pulse = !reducedMotion && now - (st.lastDraw || 0) > 120;
    if (st.dirty || pulse) {
      R.draw(drawState());
      st.lastDraw = now;
      if (st.dirty && st.playing) positionCallout();
      st.dirty = false;
    }
  }
  requestAnimationFrame(loop);
}

// ---------- empty state ----------
function renderEmpty() {
  const box = $('emptyState');
  const lead = document.createElement('p');
  lead.className = 'lead';
  lead.textContent = 'Ask a question above, or start from one of these.';
  const grid = document.createElement('div');
  grid.className = 'cases';
  for (const c of Object.values(st.cases)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'case';
    const cv = document.createElement('canvas');
    cv.setAttribute('aria-hidden', 'true');
    cv.dataset.case = c.id;
    const text = document.createElement('div');
    text.className = 'text';
    const h = document.createElement('h2'); h.textContent = c.label;
    const p = document.createElement('p'); p.textContent = c.question;
    const src = document.createElement('p'); src.className = 'src';
    src.textContent = c.runs?.length ? `${c.place}, recorded by the engine (${providerWords(selectedRun(c).meta)})`
      : c.source === 'matterport' ? `${c.place}, from a Matterport scan (mock run)` : c.source === 'synthetic' ? `${c.place} (drawn, mock run)` : c.place;
    text.append(h, p, src);
    b.append(cv, text);
    b.addEventListener('click', () => { $('askIn').value = c.question; confirmCase(c.id, c.question); });
    grid.append(b);
  }
  box.replaceChildren(lead, grid);
  box.hidden = false;
  drawThumbs();
}

// Thumbnails: each case at its busiest moment, heat and people included.
async function drawThumbs() {
  for (const cv of document.querySelectorAll('.case canvas')) {
    const c = st.cases[cv.dataset.case];
    if (!c) continue;
    let b;
    try { b = await bundleFor(c); } catch { continue; }
    const F = prepareFrames(b.frames);
    const run = deriveRun(b, F);
    const peak = run.moments[0]?.t ?? run.duration / 2;
    const geo = b.geometry;
    const heat = createHeat(geo.floors[0].bounds || geo.bounds, geo.floors.length, { cell: 0.6, sigma: 2.6 });
    calibrate(heat, run.incidents);
    advance(heat, run.incidents, peak);
    const r = createRenderer(cv);
    r.pad = { top: 8, bottom: 8, side: 8 };
    r.resize();
    r.setBounds(geo.floors[0].bounds || geo.bounds);
    r.pal = readPalette();
    r.draw({
      caseId: 'thumb-' + c.id, floor: 0, theme: st.theme, layers: { heat: true, agents: true, labels: false }, geometry: geo, F, t: peak, heat,
      incidents: [], filters: st.filters, selectedIncident: null, selectedAgent: null, frame: frameAt(F, peak), nodes: [], colorBy: 'state',
      frustration: () => null, archIndex: new Map(), agentArch: new Map(), reducedMotion: true
    });
  }
}

// ---------- start ----------
async function start() {
  R.resize();
  applyTheme();
  setSpeed(4);
  const [cases, config, live] = await Promise.all([loadCases(), loadConfig(), apiHealth()]);
  st.cases = cases;
  st.config = config;
  st.live = live;
  // Served by the engine (node bin/swarm.js serve): the building case plays recorded engine runs.
  if (live && cases.building) {
    const runs = await apiBuildingRuns();
    if (runs.length) {
      const jev = runs.find(r => r.meta.provider === 'jev' || r.meta.provider === 'replay');
      cases.building = { ...cases.building, runs, selected: (jev || runs[0]).meta.runId, source: 'engine', question: runs[0].meta.question || cases.building.question };
    }
  }
  if (!Object.keys(cases).length) {
    $('emptyState').replaceChildren(Object.assign(document.createElement('p'), { className: 'lead', textContent: 'No runs found. Run "node scripts/mock_runs.js" from the repo root to build the mock runs, then reload.' }));
    return;
  }
  const want = params.get('case');
  if (want && cases[want]) {
    openCase(want, { autoplay: params.get('autoplay') !== '0' && !params.get('t') });
  } else {
    renderEmpty();
  }
  requestAnimationFrame(loop);
}
start();
