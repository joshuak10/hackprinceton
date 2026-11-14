// Swarmscope scope display: wiring. One state object; derive → draw → panels.
// The page opens straight into the building: the latest Jev run if there is one, otherwise the latest
// rule-model run, paused at the start (docs/PROTOTYPE.md §9b).
// URL params for reproducible views: ?run=<run id>&t=40&floor=0&theme=dark&autoplay=1&test=new
//   test=new ignores tests recorded earlier, so the "before a test" state can be shown again.
import { prepareFrames, frameIndex, frameAt, agentsAt, clockText } from './lib/frames.js';
import { deriveRun } from './lib/incidents.js';
import { createHeat, calibrate, advance } from './lib/heat.js';
import { createRenderer, readPalette, FRUSTRATION } from './lib/render.js';
import { createTimeline } from './lib/timeline.js';
import { renderCounters, renderRank, renderFilters, renderFeed, renderInspector, renderDrawer, el } from './lib/panels.js';
import { showCard, hideCard, showProgress } from './lib/prompt.js';
import { createTour } from './lib/tour.js';
import { loadCases, loadConfig, loadBundle, apiHealth, apiBuildingRuns, apiLoadRun, apiStartRun, apiRunMetrics } from './lib/source.js';
import {
  chooseRun, findTest, staffChange, applyChange, worstLineWords, testResult, verdictWords, whySentence, busiestWindow,
  providerWords, placeName, runLabel, changeWords, isJev
} from './lib/verdict.js';
import { createVerdict } from './lib/verdict-panel.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
};
const TEST_SEEDS = 3;
const STATE_WORDS = ['walking', 'in a line', 'being served', 'deciding', 'leaving'];

const st = {
  sample: null, runs: [], metas: [], bundle: null, F: null, run: null, heat: null, heatIncidents: [],
  t: 0, playing: false, speed: 4, floor: 0, colorBy: 'state',
  layers: { heat: true, agents: true, labels: true },
  filters: { decision: true, congestion: true, complaint: true },
  selectedAgent: null, selectedIncident: null, cursorAgent: null, hoverNode: null, ringNode: null,
  theme: params.get('theme') || store.get('scope-theme') || 'light',
  live: null, config: {}, question: '', fly: null, lastPanels: -1, dirty: true,
  rankMode: store.get('scope-rank') === 'now' ? 'now' : 'total',
  test: null, testing: null, sessionTests: new Set(), loading: false
};

// ---------- theme ----------
function applyTheme() {
  document.documentElement.dataset.theme = st.theme;
  $('themeBtn').setAttribute('aria-label', st.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  R.pal = readPalette();
  R.baseKey = '';
  if (st.bundle) { T.setRun({ duration: st.run.duration, clockStart: st.bundle.meta.clockStart, bins: st.run.bins, pal: R.pal }); }
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
const verdict = createVerdict($('verdict'), { onTest: runTest, onCancel: () => testAbort?.abort(), onPick: id => openRun(id, { keepTime: true }) });

new ResizeObserver(() => {
  R.resize();
  R.refit();
  if (st.bundle) T.layout();
  st.dirty = true;
}).observe($('mapbox'));

function drawState() {
  return {
    caseId: st.bundle.meta.runId || 'run', floor: st.floor, theme: st.theme, layers: st.layers, geometry: st.bundle.geometry,
    F: st.F, t: st.t, heat: st.heat, incidents: st.run.incidents, filters: st.filters,
    selectedIncident: st.selectedIncident, selectedAgent: st.selectedAgent, frame: frameAt(st.F, st.t),
    nodes: st.bundle.frames.nodes || [], colorBy: st.colorBy, frustration: st.run.frustration.at,
    archIndex: st.archIndex, agentArch: st.agentArch, reducedMotion,
    ringNode: st.ringNode, hoverNode: st.hoverNode, cursorAgent: st.cursorAgent
  };
}

const announce = text => { $('live').textContent = text; };

// A problem the person should see, with a way to dismiss it. Errors are shown, not swallowed.
function showNotice(text) {
  const box = $('notice');
  const close = el('button', 'btn small', 'Dismiss');
  close.type = 'button';
  close.addEventListener('click', () => { box.hidden = true; });
  box.replaceChildren(el('p', null, text), close);
  box.hidden = false;
}

// ---------- recorded runs ----------
const onServer = runId => st.runs.some(r => r.meta.runId === runId);
const rawSpec = runId => st.runs.find(r => r.meta.runId === runId)?.spec || null;
async function refreshRuns() {
  const { runs, metas } = await apiBuildingRuns();
  st.runs = runs;
  st.metas = metas;
}
// Engine runs are loaded once and reused (switching between the baseline and the change).
const runCache = new Map();
function loadEngineRun(runId) {
  if (!runCache.has(runId)) runCache.set(runId, apiLoadRun(runId, { modelId: st.config.modelId }).catch(err => { runCache.delete(runId); throw err; }));
  return runCache.get(runId);
}

function busy(on) {
  st.loading = on;
  $('askBtn').disabled = on;
  $('mapbox').setAttribute('aria-busy', String(on));
}

// Show a recorded run. keepTime keeps the slider where it is (switching between the baseline and the change).
async function openRun(runId, { keepTime = false, autoplay = false } = {}) {
  if (st.loading) return;
  const t = st.t, wasPlaying = st.playing;
  busy(true);
  pause();
  try {
    setBundle(await loadEngineRun(runId));
    if (keepTime) seek(Math.min(t, st.run.duration));
    if (autoplay || (keepTime && wasPlaying)) play();
  } catch (err) {
    showNotice(`That run could not be opened: ${err.message}`);
  } finally {
    busy(false);
  }
}

// ---------- loading a run ----------
function setBundle(bundle) {
  st.bundle = bundle;
  st.F = prepareFrames(bundle.frames);
  st.run = deriveRun(bundle, st.F);
  st.agentsById = new Map(bundle.agents.map(a => [a.id, a]));
  st.personas = new Map((bundle.spec.minds || []).map(p => [p.id, p]));
  st.archNames = new Map((bundle.spec.archetypes || []).map(a => [a.id, a.name]));
  st.archIndex = new Map((bundle.spec.archetypes || []).map((a, i) => [a.id, i]));
  st.agentArch = new Map(bundle.agents.map(a => [a.id, a.archetypeId]));
  st.nodeName = id => st.run.nodes.get(id)?.name || id;
  st.floorTimes = bundle.geometry.floors.map((_, fi) => st.run.incidents.filter(it => (it.floor || 0) === fi).map(it => it.t));
  st.selectedIncident = null;
  st.cursorAgent = null;
  st.hoverNode = null;
  st.t = 0;
  st.floor = 0;
  st.selectedAgent = null;
  $('inspector').hidden = true;
  $('sideBody').hidden = false;
  rebuildHeat();

  const geo = bundle.geometry, meta = bundle.meta;
  R.setBounds(geo.floors[0].bounds || geo.bounds);
  st.place = placeName(bundle.spec?.title ? bundle.spec : { title: meta.title });
  $('placeTitle').textContent = st.place;
  const q = st.question ? `“${st.question}”` : meta.question || bundle.spec?.question || '';
  $('placeSub').textContent = q;
  $('placeSub').title = q;
  const label = runLabel(meta), who = providerWords(meta);
  $('runNote').textContent = [label, who].filter(Boolean).join(' · ');
  $('runNote').title = isJev(meta) ? 'Every decision in this run came from Jev.'
    : who === 'Sample data' ? 'These people come from a sample data generator, not from the engine.'
      : 'The people in this run follow the engine\'s fixed rules. No Jev decisions.';
  $('emptyState').hidden = true;
  $('side').classList.remove('idle');
  $('mapTools').hidden = false;
  $('legendMini').hidden = false;
  $('timeline').hidden = false;
  $('callout').hidden = true;
  $('resetView').hidden = true;

  // Coloring by frustration needs data the rule model does not record.
  const fr = document.querySelector('input[name="colorBy"][value="frustration"]');
  fr.disabled = !st.run.frustration.has;
  $('frustrationWhy').hidden = st.run.frustration.has;
  if (fr.disabled && st.colorBy === 'frustration') {
    st.colorBy = 'state';
    document.querySelector('input[name="colorBy"][value="state"]').checked = true;
  }

  tour.hide();
  tour.configure({ modelId: geo.source?.provider === 'matterport' ? geo.source.modelId : null, key: st.config.matterportSdkKey });

  renderFloorTabs();
  renderFilters($('feedFilters'), st, toggleFilter);
  renderLegend();
  T.setRun({ duration: st.run.duration, clockStart: meta.clockStart, bins: st.run.bins, pal: R.pal });
  if (!$('drawer').hidden) drawDrawer();
  refreshVerdict();
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

// ---------- the verdict: the worst line, the one test, and what it showed ----------
let testAbort = null;

function refreshVerdict() {
  const bundle = st.bundle, meta = bundle.meta;
  const timing = { clockStart: meta.clockStart, duration: st.run.duration };
  const recorded = onServer(meta.runId);
  if (st.testing) {
    st.ringNode = st.testing.change.nodeId;
    verdict.running(st.testing);
    return;
  }
  let test = recorded ? findTest(st.metas, { runId: meta.runId, specHash: meta.specHash }, TEST_SEEDS) : null;
  if (test && params.get('test') === 'new' && !st.sessionTests.has(test.id)) test = null;
  st.test = test;
  const change = test?.change || staffChange(bundle.spec, bundle.metrics);
  st.ringNode = change?.nodeId || null;
  st.dirty = true;
  if (!test) {
    const words = worstLineWords(bundle.spec, bundle.metrics, timing);
    if (!words) { verdict.message('This run has no counters with a line, so there is no change to test.'); return; }
    verdict.before({
      words, change, canTest: recorded && !!st.live,
      cannotWhy: 'This is sample data, so a change cannot be tested on it. Start the Swarmscope engine and record a run to test one.',
      note: isJev(meta) ? 'The numbers above are from the Jev run on screen.' : ''
    });
    return;
  }

  // Both sides' numbers for every seed, and the baseline line over time for "busiest from … to …".
  const pair = test.pairs.find(p => p.baseline === meta.runId || p.change === meta.runId) || test.pairs[0];
  verdict.message(`Loading the test of ${changeWords(change)} at ${change.nodeName}…`);
  Promise.all([
    Promise.all(test.pairs.map(async p => ({ before: await apiRunMetrics(p.baseline), after: await apiRunMetrics(p.change) }))),
    loadEngineRun(pair.baseline)
  ]).then(([metrics, base]) => {
    if (st.bundle !== bundle || st.testing) return;
    const result = testResult(metrics, change);
    const k = (base.frames.services || []).indexOf(change.nodeId);
    const window = k >= 0 ? busiestWindow(base.frames.list.map(f => f.t), base.frames.list.map(f => f.q?.[k] || 0)) : null;
    const shown = meta.runId === pair.baseline || meta.runId === pair.change;
    verdict.after({
      words: verdictWords(result, change, timing), rows: result.rows, runs: result.runs, change,
      why: whySentence(result, change, { clockStart: meta.clockStart, window }),
      toggle: {
        baseline: pair.baseline, change: pair.change, selected: meta.runId,
        note: shown ? '' : `The map shows the ${providerWords(meta) === 'Jev' ? 'Jev run' : 'run you opened'}. Pick a side to watch the test; the time on the slider is kept.`
      }
    });
  }).catch(err => {
    if (st.bundle !== bundle) return;
    verdict.message(`The test results could not be loaded: ${err.message}`);
    showNotice(`The test results could not be loaded: ${err.message}`);
  });
}

// Baseline and +1 staff, 3 seeds each, with the rule model. Every run carries the link the server stores.
async function runTest() {
  if (st.testing || !st.bundle) return;
  const meta = st.bundle.meta;
  // The world to test is the baseline's: for a run that already carries the change, its base run's world.
  const spec = rawSpec(meta.link?.role === 'change' && meta.link.base ? meta.link.base : meta.runId);
  const change = spec && staffChange(spec, st.bundle.metrics);
  if (!spec || !change) return;
  const id = `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const seed0 = Number.isInteger(meta.seed) ? meta.seed : 7;
  const total = TEST_SEEDS * 2;
  st.testing = { change, done: 0, total };
  testAbort = new AbortController();
  const signal = testAbort.signal;
  refreshVerdict();
  const step = () => { st.testing.done++; if (st.testing) verdict.running(st.testing); };
  try {
    const changed = applyChange(spec, change);
    let first = null;
    for (let k = 0; k < TEST_SEEDS; k++) {
      const base = await apiStartRun({ spec, provider: 'rules', seed: seed0 + k, link: { test: id, role: 'baseline', change }, signal });
      step();
      await apiStartRun({ spec: changed, provider: 'rules', seed: seed0 + k, link: { test: id, role: 'change', base, change }, signal });
      step();
      first = first || base;
    }
    st.sessionTests.add(id);
    await refreshRuns();
    st.testing = null;
    announce(`The test of ${changeWords(change)} at ${change.nodeName} is done.`);
    // A rule-model run on screen is the same simulation as the test's baseline with its seed: show that one,
    // so the Baseline side of the toggle is the run on the map. A Jev run stays on screen.
    const now = st.bundle.meta;
    if (!isJev(now) && now.link?.role !== 'change' && !st.loading) await openRun(first, { keepTime: true });
    else refreshVerdict();
  } catch (err) {
    st.testing = null;
    if (err.name === 'AbortError') {
      await refreshRuns().catch(() => {});
      refreshVerdict();
      announce('The test was cancelled.');
    } else {
      verdict.failed({ change, message: `${err.message} Nothing on screen has changed.` });
    }
  } finally {
    testAbort = null;
  }
}

// ---------- a new run from the prompt ----------
async function newRun(provider, question) {
  if (st.loading || !st.bundle) return;
  const meta = st.bundle.meta;
  const spec = rawSpec(meta.link?.role === 'change' && meta.link.base ? meta.link.base : meta.runId);
  if (!spec) return;
  hideCard($('askCard'));
  busy(true);
  pause();
  const p = showProgress($('progress'), [{ label: 'Starting the simulation' }, { label: 'People are arriving' }, { label: 'Opening the replay' }],
    provider === 'jev' ? 'Jev decides for every person. This can take a few minutes.' : 'The rule model decides for every person. This takes a few seconds.');
  p.set(0);
  try {
    const runId = await apiStartRun({
      spec, provider, seed: Number.isInteger(meta.seed) ? meta.seed : 7,
      onStatus: s => p.set(1, `Simulating: ${Math.round(((s.t || 0) / (s.duration || 1)) * 100)}% of the time window`)
    });
    p.set(2);
    await refreshRuns();
    st.question = question;
    setBundle(await loadEngineRun(runId));
    play();
  } catch (err) {
    showNotice(`The new simulation could not run: ${err.message}`);
  } finally {
    p.done();
    busy(false);
  }
}

$('askForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!st.bundle) return;
  const text = $('askIn').value.trim();
  const cancel = () => { hideCard($('askCard')); $('askIn').focus(); };
  if (!onServer(st.bundle.meta.runId) || !st.live) {
    showCard($('askCard'), {
      title: 'This page is showing sample data',
      lines: ['A new simulation needs the Swarmscope engine, which is not running here. You can still replay the sample.'],
      onCancel: cancel
    });
    return;
  }
  showCard($('askCard'), {
    title: `Simulate ${st.place} again?`,
    lines: [
      'This screen runs one place for now. A question does not change who comes in or what they do yet.',
      text ? `Your question will show above the map: “${text}”` : null
    ],
    actions: [
      { label: 'Run it again', solid: true, onClick: () => newRun('rules', text) },
      ...(st.live.jev ? [{ label: 'Run it with Jev', onClick: () => newRun('jev', text) }] : [])
    ],
    onCancel: cancel
  });
});

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
  document.querySelectorAll('.seg button[data-speed]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === s)));
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
    bottlenecks: st.run.bottlenecks.at(fi, st.t), bottlenecksNow: st.run.bottlenecks.now(fi), rankMode: st.rankMode
  };
  renderCounters($('counters'), ps);
  updateFloorCounts();
  if (st.selectedAgent != null) { renderInspector($('inspector'), inspectorState(), st.selectedAgent, closeInspector); return; }
  renderRank($('rank'), ps, id => {
    const n = st.run.nodes.get(id);
    if (n) { if ((n.floor || 0) !== st.floor) setFloor(n.floor || 0); flyTo(n.x, n.y, 1.8); }
  });
  renderFeed($('feed'), ps, it => focusIncident(it, { fly: true }));
}

function inspectorState() {
  return {
    agentsById: st.agentsById, personas: st.personas, decisions: st.bundle.decisions, nodeName: st.nodeName,
    visibleAgents: st.allAgents || agentsAt(st.F, st.t), archNames: st.archNames, t: st.t, clockStart: st.bundle.meta.clockStart
  };
}
function drawDrawer() {
  renderDrawer($('drawerBody'), { bundle: st.bundle, decisions: st.bundle.decisions, geometry: st.bundle.geometry, runs: st.runs, place: st.place },
    runId => openRun(runId));
}

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
  const title = el('p', 'ct', it.text);
  const floorLabel = st.bundle.geometry.floors.length > 1 ? `, ${st.bundle.geometry.floors[it.floor || 0].label}` : '';
  const meta = el('p', 'cm', `${it.clock}${floorLabel}${it.who && !it.text.startsWith(it.who) ? `, ${it.who}` : ''}`);
  const row = el('div', 'row');
  const add = (cls, text, fn) => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    row.append(b);
  };
  if (it.agentId != null && st.agentsById.has(it.agentId)) add('btn small', 'See this person', () => selectAgent(it.agentId, { focus: true }));
  if (tour.available()) {
    add('btn small', st.bundle.geometry.sweeps?.length ? 'See this spot in 3D' : 'Open the 3D tour',
      () => tour.open(st.bundle.geometry, { x: it.x, y: it.y, floor: it.floor || 0, label: it.group }));
  }
  add('btn quiet small', 'Close', closeCallout);
  box.replaceChildren(title, meta, row);
  box.hidden = false;
  positionCallout();
}
function closeCallout() {
  st.selectedIncident = null;
  $('callout').hidden = true;
  st.dirty = true;
  renderPanels();
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

// The inspector takes the place of the ranking and the feed; the verdict and the counters stay.
// returnTo: where keyboard focus goes back to when the inspector closes.
function selectAgent(id, { focus = false, returnTo = null } = {}) {
  st.selectedAgent = id;
  st.inspectorReturn = returnTo;
  $('sideBody').hidden = true;
  renderInspector($('inspector'), inspectorState(), id, closeInspector);
  if (focus) $('inspector').querySelector('.back')?.focus();
  st.dirty = true;
}
function closeInspector() {
  const had = $('inspector').contains(document.activeElement), was = st.selectedAgent;
  st.selectedAgent = null;
  $('inspector').hidden = true;
  $('sideBody').hidden = false;
  st.dirty = true;
  if (st.bundle) renderPanels();
  if (had) (st.inspectorReturn || $('rankMode').querySelector('button')).focus();
  // Back on the map, the keyboard cursor is on the person who was open, so the arrow keys carry on from them.
  if (had && st.inspectorReturn === map && was != null) setCursor(was);
  st.inspectorReturn = null;
}

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
// Reset view shows only after zooming or panning.
$('resetView').addEventListener('click', () => {
  const b = st.bundle.geometry.floors[st.floor].bounds;
  const had = document.activeElement === $('resetView');
  flyTo((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 1);
  $('resetView').hidden = true;
  if (had) $('viewBtn').focus();
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
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const ds = drawState();
  map.classList.toggle('pointing', !!R.hit(ds, x, y));
  // Doors and stairs show their name under the pointer.
  const node = R.hitNode(ds, x, y);
  if (node !== st.hoverNode) { st.hoverNode = node; st.dirty = true; }
});
map.addEventListener('pointerleave', () => { if (st.hoverNode) { st.hoverNode = null; st.dirty = true; } });
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
map.addEventListener('dblclick', () => { if (!$('resetView').hidden) $('resetView').click(); });

// Keyboard path to a person: Enter picks the person nearest the middle of the map, the arrow keys move to the
// nearest person in that direction, Enter opens them, Escape lets go.
function setCursor(id) {
  st.cursorAgent = id;
  st.dirty = true;
  if (id == null) return;
  const a = st.agentsById.get(id), now = R.lastAgents.find(p => p.id === id);
  announce(`${a?.personaName || `Person ${id}`}, ${STATE_WORDS[now?.s] || 'on the map'}. Press Enter to see what they did.`);
}
map.addEventListener('keydown', e => {
  if (!st.bundle) return;
  const people = st.layers.agents ? R.lastAgents : [];
  const cur = people.find(a => a.id === st.cursorAgent);
  if (e.key === 'Enter') {
    e.preventDefault();
    if (cur) { selectAgent(cur.id, { focus: true, returnTo: map }); return; }
    let best = null, bd = Infinity;
    for (const a of people) {
      const [x, y] = R.toScreen(a.x, a.y);
      const d = Math.hypot(x - R.cw / 2, y - R.ch / 2);
      if (d < bd) { bd = d; best = a; }
    }
    if (best) setCursor(best.id);
    else announce('Nobody is on the map at this moment. Move the time slider and try again.');
  } else if (cur && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    // The arrow keys move between people here, so they do not also step the replay.
    e.preventDefault();
    e.stopPropagation();
    const [ux, uy] = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    const [cx, cy] = R.toScreen(cur.x, cur.y);
    let best = null, bs = Infinity;
    for (const a of people) {
      if (a.id === cur.id) continue;
      const [x, y] = R.toScreen(a.x, a.y);
      const dx = x - cx, dy = y - cy, along = dx * ux + dy * uy, across = Math.abs(dx * uy - dy * ux);
      if (along <= 0.5 || across > along * 1.5) continue;
      const score = along + across * 2;
      if (score < bs) { bs = score; best = a; }
    }
    if (best) setCursor(best.id);
  } else if (e.key === 'Escape' && st.cursorAgent != null) {
    e.stopPropagation();
    setCursor(null);
  }
});
map.addEventListener('blur', () => setCursor(null));

// ---------- bottleneck measure: so far (cumulative) or right now ----------
const RANK_HINT = {
  total: 'Minutes waited so far. Red: people who walked away.',
  now: 'People in line at this moment, and the wait for someone joining now.'
};
function setRankMode(mode) {
  st.rankMode = mode;
  store.set('scope-rank', mode);
  document.querySelectorAll('#rankMode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('rankHint').textContent = RANK_HINT[mode];
  if (st.bundle) renderPanels();
}
document.querySelectorAll('#rankMode button').forEach(b => b.addEventListener('click', () => setRankMode(b.dataset.mode)));
setRankMode(st.rankMode);

// ---------- the View menu: one home for how the map is drawn ----------
function setViewMenu(open) {
  $('viewMenu').hidden = !open;
  $('viewBtn').setAttribute('aria-expanded', String(open));
}
$('viewBtn').addEventListener('click', () => setViewMenu($('viewMenu').hidden));
document.addEventListener('pointerdown', e => {
  if (!$('viewMenu').hidden && !e.target.closest('#viewMenu, #viewBtn')) setViewMenu(false);
});
document.querySelectorAll('input[name="colorBy"]').forEach(r => r.addEventListener('change', () => {
  if (!r.checked) return;
  st.colorBy = r.value;
  renderLegend();
  st.dirty = true;
}));
document.querySelectorAll('#viewMenu input[data-layer]').forEach(c => c.addEventListener('change', () => {
  st.layers[c.dataset.layer] = c.checked;
  if (c.dataset.layer === 'agents' && !c.checked) setCursor(null);
  renderLegend();
  st.dirty = true;
}));

function renderLegend() {
  const box = $('legendMini');
  const items = !st.layers.agents ? []
    : st.colorBy === 'frustration'
      ? [[FRUSTRATION[0], 'Calm'], [FRUSTRATION[1], 'Annoyed'], [FRUSTRATION[2], 'Frustrated'], [FRUSTRATION[4], 'Furious']]
      : st.colorBy === 'archetype'
        ? (st.bundle?.spec.archetypes || []).slice(0, 5).map((a, i) => [`var(--g-${i + 1})`, a.name])
        : [['var(--a-walk)', 'Walking'], ['var(--a-queue)', 'In a line'], ['var(--a-serve)', 'Being served'], ['var(--a-leave)', 'Leaving']];
  const frag = items.map(([c, t]) => {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.style.background = c;
    s.append(i, document.createTextNode(t));
    return s;
  });
  if (st.layers.heat) {
    const heat = document.createElement('span');
    const bar = document.createElement('i');
    bar.className = 'heatbar';
    heat.append(bar, document.createTextNode('Trouble so far'));
    frag.push(heat);
  }
  box.replaceChildren(...frag);
}

function setDrawer(open) {
  if (open) setViewMenu(false);
  $('drawer').hidden = !open;
  $('detailsBtn').setAttribute('aria-expanded', String(open));
  if (open && st.bundle) drawDrawer();
  else if (open) $('drawerBody').replaceChildren(el('p', 'note', 'Nothing is loaded yet.'));
  (open ? $('drawerClose') : $('detailsBtn')).focus();
}
$('detailsBtn').addEventListener('click', () => setDrawer($('drawer').hidden));
$('drawerClose').addEventListener('click', () => setDrawer(false));

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  // Text fields, tabs and the map's person cursor keep their keys. On a focused button or link, Space and
  // Enter activate that control, so Space doesn't also toggle playback; the arrow keys still step the replay.
  const typing = e.target.closest('input:not([type="range"]), select, textarea, [role="tab"], [contenteditable="true"]');
  if (e.key === ' ' && e.target.closest('button, a, [role="button"], input:not([type="range"])')) return;
  if (e.key === 'Escape') {
    if (!$('viewMenu').hidden) { setViewMenu(false); $('viewBtn').focus(); }
    else if (!$('askCard').hidden) { hideCard($('askCard')); $('askIn').focus(); }
    else if (!$('tour').hidden) tour.hide();
    else if (!$('drawer').hidden) setDrawer(false);
    else if (st.selectedAgent != null) closeInspector();
    else if (st.selectedIncident) closeCallout();
    else if (!$('notice').hidden) $('notice').hidden = true;
    return;
  }
  if (typing || !st.bundle) return;
  if (e.key === ' ') { e.preventDefault(); st.playing ? pause() : play(); }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (e.target.closest('input[type="range"]')) return;   // the slider steps itself
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

// ---------- start ----------
function showEmpty(text) {
  $('placeTitle').textContent = 'Swarmscope';
  $('emptyState').replaceChildren(el('p', 'lead', text));
  $('emptyState').hidden = false;
}

async function start() {
  R.resize();
  applyTheme();
  setSpeed(4);
  requestAnimationFrame(loop);
  const [cases, config, live] = await Promise.all([loadCases(), loadConfig(), apiHealth()]);
  st.sample = cases.building || null;
  st.config = config;
  st.live = live;
  let problem = '';
  if (live) await refreshRuns().catch(err => { problem = `The recorded runs could not be listed: ${err.message}`; });
  const want = params.get('run');
  const first = (want && st.runs.find(r => r.meta.runId === want)) || chooseRun(st.runs);
  try {
    if (first) setBundle(await loadEngineRun(first.meta.runId));
    else if (st.sample) setBundle(await loadBundle(st.sample.file));
    else { showEmpty('No simulation has been recorded yet. Record a run of the building with the Swarmscope engine, then reload this page.'); return; }
  } catch (err) {
    showEmpty(`The simulation could not be opened: ${err.message}`);
    return;
  }
  if (problem) showNotice(problem);
  const t0 = Number(params.get('t'));
  if (Number.isFinite(t0) && t0 > 0) seek(t0);
  const f0 = Number(params.get('floor'));
  if (Number.isFinite(f0) && f0 > 0) setFloor(f0);
  // Paused at the start unless the link asks for playback.
  if (params.get('autoplay') === '1') play();
}
start();
