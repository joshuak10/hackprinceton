// Swarmscope scope display: wiring. One state object; derive → draw → panels.
// The page opens straight into the building: the latest Jev run if there is one, otherwise the latest
// rule-model run, paused at the start (docs/PROTOTYPE.md §9b). ?case=sushi opens the sushi restaurant instead
// (§18), ?case=parking the parking lot sample, and ?place=<title> another walled world recorded on this machine.
// The card under the prompt box lists them all; Run details links to the cases under "Other places".
// URL params for reproducible views: ?case=sushi&run=<run id>&t=40&floor=0&theme=dark&autoplay=1&test=new
//   test=new ignores tests recorded earlier, so the "before a test" state can be shown again.
import { prepareFrames, frameIndex, frameAt, agentsAt } from './lib/frames.js';
import { deriveRun } from './lib/incidents.js';
import { createHeat, calibrate, advance } from './lib/heat.js';
import { createRenderer, readPalette, FRUSTRATION } from './lib/render.js';
import { createTimeline } from './lib/timeline.js';
import { renderCounters, renderRank, renderFilters, renderFeed, renderInspector, renderDrawer, el } from './lib/panels.js';
import { targetChoice } from './lib/ask-again.js';
import { createAskPanel } from './lib/ask-panel.js';
import { clockText } from './lib/frames.js';
import { showCard, hideCard, showProgress } from './lib/prompt.js';
import { createTour } from './lib/tour.js';
import { loadCases, loadConfig, loadBundle, apiHealth, apiBuildingRuns, apiLoadRun, apiStartRun, apiRunMetrics, apiCompile, apiScan, apiDays, apiAskAgain } from './lib/source.js';
import { foundLine, noScanLine, buildNote, fitoutFailure } from './lib/scan.js';
import { LOYALTY, suggestionWords, savedResult, loyaltyRows, loyaltyWords, regularWords, captionWords, cautionWords, missingWords } from './lib/loyalty.js';
import { OWNER_CHANGES, ownerChange, resultFor, periodsFor, compareFor, figureRows, dayBars, ownerHeadline, cautionWords as ownerCaution } from './lib/owner.js';
import { createOwner, renderPeriodChart } from './lib/owner-panel.js';
import {
  chooseRun, findTest, findOfferTest, changeFor, applyChange, worstLineWords, promotionWords, testResult, testWords,
  verdictWords, whySentence, busiestWindow, providerWords, placeName, runLabel, isJev, windowNoun, hasPromotion
} from './lib/verdict.js';
import { createVerdict } from './lib/verdict-panel.js';
import { createEditor } from './lib/edit.js';
import { seatedPlaces, sameLayout, sameWorld, describeChanges, pairRuns } from './lib/layout.js';

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
  cases: {}, caseId: null, caseInfo: null, runs: [], metas: [], bundle: null, F: null, run: null, heat: null, heatIncidents: [],
  t: 0, playing: false, speed: 4, floor: 0, colorBy: 'state',
  layers: { heat: true, agents: true, labels: true },
  filters: { decision: true, congestion: true, complaint: true },
  selectedAgent: null, selectedIncident: null, cursorAgent: null, hoverNode: null, ringNode: null,
  theme: params.get('theme') || store.get('scope-theme') || 'light',
  live: null, config: {}, fly: null, lastPanels: -1, dirty: true,
  rankMode: store.get('scope-rank') === 'now' ? 'now' : 'total',
  test: null, testing: null, sessionTests: new Set(), loading: false, room: null,
  // The loyalty buttons (§21f): the saved results, the change that is open, and whether the changes are shown
  // in place of a promotion test's result.
  loyalty: { saved: undefined, open: null, home: false, runId: null },
  // The owner's view (§21g): the period for the whole screen in days, the change being tried, whether the
  // evening's detail is shown, and whether the promotion test has taken the panel.
  owner: { n: 1, change: 'seats', details: false, promo: false }, newcomers: new Set(),
  worlds: { building: [], others: [], buildingName: '' }
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
const verdict = createVerdict($('verdict'), {
  onTest: runTest, onCancel: () => testAbort?.abort(), onPick: id => openRun(id, { keepTime: true, side: true }),
  onChoose: id => { st.loyalty.open = id; refreshVerdict(); },
  onBack: () => { st.loyalty.open = null; st.loyalty.home = true; refreshVerdict(); }
});

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
    isNew: id => st.newcomers.has(st.agentsById.get(id)?.personaId),
    ringNode: st.ringNode, hoverNode: st.hoverNode, cursorAgent: st.cursorAgent,
    edit: editor.active ? editor.drawState() : null
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
const rawSpec = runId => st.runs.find(r => r.meta.runId === runId)?.spec || null;
// A case that is sample data only (the parking lot): not the building, and no recorded world of its own.
const sampleOnly = c => Boolean(c && c.id !== 'building' && !c.runTitle);
// ?place=<a recorded world's exact title> opens that world's runs in place of the building's: any other walled
// world on this machine. A case with runs or a sample of its own keeps them.
const placeParam = () => (st.caseInfo?.runTitle || sampleOnly(st.caseInfo) ? null : params.get('place'));
// A place's runs: a case with a runTitle (the sushi restaurant) takes every run of the world with that title, and
// the building takes the rest, so one place's runs never show under another. A sample has no runs.
// st.worlds keeps which recorded walled worlds are the building's and which are other places (the card's list).
async function refreshRuns() {
  const c = st.caseInfo;
  const notTitles = Object.values(st.cases).map(x => x.runTitle).filter(Boolean);
  const place = placeParam();
  const filter = sampleOnly(c) ? { notTitles, max: 0 } : c?.runTitle ? { title: c.runTitle, max: 200, notTitles }
    : place ? { title: place, max: 200, notTitles } : { notTitles };
  const { runs, metas, worlds } = await apiBuildingRuns({ ...filter, home: st.cases.building?.homeTitle || null });
  st.runs = runs;
  st.metas = sampleOnly(c) ? [] : metas;
  // The building's name for the list, where another place is on screen: the world its page would open with.
  const titles = new Set(worlds.building.map(w => w.title));
  const newest = metas.filter(m => m.status === 'done' && m.mode === 'visit' && titles.has(m.title))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 18);
  const pick = chooseRun(newest.map(meta => ({ meta })));
  st.worlds = { ...worlds, buildingName: pick ? placeName(worlds.building.find(w => w.title === pick.meta.title)) : '' };
}
// The world of the run on screen as the engine takes it, without a tested change: the server's copy, or the packed
// engine run's own (the sushi restaurant's file). Null for sample data, which cannot be run again.
function baseWorld() {
  const meta = st.bundle.meta;
  if (meta.link?.role === 'change') return meta.link.base ? rawSpec(meta.link.base) : null;
  return rawSpec(meta.runId) || st.bundle.rawSpec || null;
}
// The run the page opens with (chooseRun). At a place drawn from a sketch, only runs of the room as sketched with
// no offers count, and its packed Jev run counts as a recorded Jev run: null means "open the packed file".
async function openingRun() {
  const c = st.caseInfo;
  if (!c?.sketch) return chooseRun(st.runs);
  const run = chooseRun(st.runs.filter(r => sameWorld(r.spec, c.sketch)));
  if (run && isJev(run.meta)) return run;
  const packed = await loadBundle(c.file).catch(() => null);
  return packed && isJev(packed.meta) ? null : run;
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
// side: the run was picked with a toggle in the verdict panel, so a changed room's comparison stays on screen.
async function openRun(runId, { keepTime = false, autoplay = false, side = false } = {}) {
  if (st.loading) return;
  const t = st.t, wasPlaying = st.playing;
  if (!side) st.room = null;
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
  st.seated = seatedPlaces(bundle.spec).length > 0;
  st.floorTimes = bundle.geometry.floors.map((_, fi) => st.run.incidents.filter(it => (it.floor || 0) === fi).map(it => it.t));
  st.selectedIncident = null;
  st.cursorAgent = null;
  st.hoverNode = null;
  st.t = 0;
  st.floor = 0;
  st.selectedAgent = null;
  $('inspector').hidden = true;
  $('sideBody').hidden = false;
  $('verdict').hidden = false;
  rebuildHeat();

  const geo = bundle.geometry, meta = bundle.meta;
  R.setBounds(geo.floors[0].bounds || geo.bounds);
  st.place = st.caseInfo?.placeName || placeName(bundle.spec?.title ? bundle.spec : { title: meta.title });
  $('placeTitle').textContent = st.place;
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

  // Edit the room (§18): a world with seats, run by the engine.
  if (editor.active) leaveEdit();
  $('editBtn').hidden = !editor.available(bundle);
  $('editBtn').disabled = !st.live;
  $('editBtn').title = st.live ? 'Move, add or remove seats, then run the changed room' : 'A changed room needs the Swarmscope engine, which is not running here.';

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

// Who decides a test's runs: the rule model for +1 staff (§9b). For the promotion, the same decision-maker as the
// run on screen, or as the test on screen when it is tested again, when it can (§18): the rule model sees the
// lower price but not the message.
function testProvider(change) {
  if (change.kind !== 'promotion' || !st.live?.jev) return 'rules';
  const ref = st.test ? st.metas.find(m => m.runId === st.test.pairs[0].baseline) : st.bundle.meta;
  return isJev(ref) ? 'jev' : 'rules';
}
const byWords = provider => (provider === 'jev' ? 'Jev' : 'the rule model');
const wordsFor = (change, provider) => testWords(change, {
  by: byWords(provider), seeds: TEST_SEEDS, noun: windowNoun(st.bundle.meta.clockStart, st.run.duration)
});
const sameProvider = p => (p === 'replay' ? 'jev' : p);
// A run of the sushi restaurant whose seats differ from the room as sketched (§18).
const changedRoom = bundle => Boolean(st.caseInfo?.sketch && bundle.rawSpec && !sameLayout(st.caseInfo.sketch, bundle.rawSpec));

function refreshVerdict() {
  const bundle = st.bundle, meta = bundle.meta;
  const timing = { clockStart: meta.clockStart, duration: st.run.duration };
  if (st.testing) {
    st.ringNode = st.testing.change.nodeId || null;
    showRunning();
    return;
  }
  if (changedRoom(bundle) || (st.room && st.room.sketched === meta.runId)) { refreshRoom(bundle); return; }
  // A test recorded with its link; or, at the promotion's place, a promotion run from before the link, known by
  // the offers in its world and paired with its twin (§18).
  let test = st.metas.length ? findTest(st.metas, { runId: meta.runId, specHash: meta.specHash }, TEST_SEEDS) : null;
  if (!test && st.caseInfo?.suggestion === 'promotion') test = findOfferTest(st.runs, meta.runId);
  if (test && params.get('test') === 'new' && !st.sessionTests.has(test.id)) test = null;
  st.test = test;
  const change = test?.change || changeFor(st.caseInfo, bundle.spec, bundle.metrics);
  st.ringNode = change?.nodeId || null;
  st.dirty = true;
  // The loyalty buttons (§21f): the place opens on three changes to try; a promotion test's result keeps its
  // place and leads to them.
  // The owner's view (§21g): a place with a pool of customers opens on today next to one change, over one period.
  // The promotion test keeps its panel, one step away.
  ownerLayout(false);
  const back = st.caseInfo?.pool ? { label: 'Back to the comparison', onClick: () => { st.owner.promo = false; refreshVerdict(); } } : null;
  if (st.caseInfo?.pool && !st.owner.promo) { showOwner(test, change); return; }
  if (!change) { verdict.message('This run has no counters with a line, so there is no change to test.'); return; }
  if (!test) {
    const words = change.kind === 'promotion' ? promotionWords(bundle.spec, bundle.metrics, change, timing) : worstLineWords(bundle.spec, bundle.metrics, timing);
    if (!words) { verdict.message('This run has no counters with a line, so there is no change to test.'); return; }
    verdict.before({
      words, test: wordsFor(change, testProvider(change)), canTest: Boolean(st.live && baseWorld()),
      cannotWhy: providerWords(meta) === 'Sample data'
        ? 'This is sample data, so a change cannot be tested on it. Start the Swarmscope engine and record a run to test one.'
        : 'The Swarmscope engine is not running here, so a change cannot be tested on this recorded run.',
      note: isJev(meta) ? 'The numbers above are from the Jev run on screen.' : '',
      more: back
    });
    return;
  }

  // Both sides' numbers for every seed, and for +1 staff the baseline line over time for "busiest from … to …".
  const pair = test.pairs.find(p => p.baseline === meta.runId || p.change === meta.runId) || test.pairs[0];
  const provider = isJev(st.metas.find(m => m.runId === pair.baseline)) ? 'jev' : 'rules';
  const words = wordsFor(change, provider);
  verdict.message(words.loading);
  Promise.all([
    Promise.all(test.pairs.map(async p => ({ before: await apiRunMetrics(p.baseline), after: await apiRunMetrics(p.change) }))),
    change.kind === 'staff' ? loadEngineRun(pair.baseline) : null
  ]).then(([metrics, base]) => {
    if (st.bundle !== bundle || st.testing) return;
    const result = testResult(metrics, change);
    const k = base ? (base.frames.services || []).indexOf(change.nodeId) : -1;
    const window = k >= 0 ? busiestWindow(base.frames.list.map(f => f.t), base.frames.list.map(f => f.q?.[k] || 0)) : null;
    const shown = meta.runId === pair.baseline || meta.runId === pair.change;
    verdict.after({
      words: verdictWords(result, change, { ...timing, by: byWords(provider) }), rows: result.rows, runs: result.runs,
      why: whySentence(result, change, { clockStart: meta.clockStart, window }), caution: words.caution,
      // The promotion can be tested as often as you like: Jev answers differently each time (§18).
      again: change.kind === 'promotion' && Boolean(st.live && baseWorld()),
      more: back,
      toggle: {
        baseline: pair.baseline, change: pair.change, labels: words.toggle, selected: meta.runId,
        note: shown ? '' : `The map shows the ${providerWords(meta) === 'Jev' ? 'Jev run' : 'run you opened'}. Pick a side to watch the test; the time on the slider is kept.`
      }
    });
  }).catch(err => {
    if (st.bundle !== bundle) return;
    verdict.message(`The test results could not be loaded: ${err.message}`);
    showNotice(`The test results could not be loaded: ${err.message}`);
  });
}

// ---------- the owner's view (§21g) ----------
const owner = createOwner($('verdict'), {
  onPeriod: n => { st.owner.n = n; refreshVerdict(); },
  onChange: id => { st.owner.change = id; refreshVerdict(); },
  onDetails: () => { st.owner.details = !st.owner.details; refreshVerdict(); },
  onPromo: () => { st.owner.promo = true; refreshVerdict(); }
});
// on: the owner's view has the side panel. many: the period is longer than one day, so a chart takes the map's place.
function ownerLayout(on, many = false) {
  $('side').classList.toggle('owner', on);
  $('side').classList.toggle('details', on && st.owner.details);
  document.querySelector('.stage').classList.toggle('period-many', on && many);
  $('periodView').hidden = !(on && many);
}
async function showOwner(test, change) {
  const pool = st.caseInfo.pool, bundle = st.bundle;
  ownerLayout(true);
  if (st.loyalty.saved === undefined) {
    verdict.message('Loading the saved results…');
    st.loyalty.saved = st.live ? await apiDays(pool).catch(() => null) : null;
    if (st.bundle !== bundle) return;
    // Who is new to the place comes with the results: colour people by it from the start.
    st.newcomers = new Set(st.loyalty.saved?.newcomers || []);
    $('colorCustomer').hidden = !st.newcomers.size;
    if (st.newcomers.size) {
      st.colorBy = 'customer';
      document.querySelector('input[name="colorBy"][value="customer"]').checked = true;
      renderLegend();
      st.dirty = true;
    }
  }
  const saved = st.loyalty.saved, c = ownerChange(st.owner.change), result = resultFor(saved, c.id);
  const periods = periodsFor(saved?.meta, result?.days || 0);
  if (!periods.some(p => p.n === st.owner.n)) st.owner.n = periods[0]?.n || 1;
  const period = periods.find(p => p.n === st.owner.n) || { n: 1, label: '1 evening' };
  const cmp = result ? compareFor(result, st.owner.n) : null;
  const canPromo = Boolean(test) || (Boolean(st.live && baseWorld()) && change?.kind === 'promotion');
  const title = `With ${c.name}`;
  owner.show({
    periods: periods.length ? periods : [period], n: st.owner.n, changes: OWNER_CHANGES, change: c.id, title,
    headline: cmp ? ownerHeadline(cmp, c, period.label) : '', rows: figureRows(cmp), caution: ownerCaution(result),
    missing: cmp ? null : {
      text: `No saved result for ${c.name} on this computer.`,
      command: `node bin/swarm.js days ${pool} --days 8 --seeds 3 --provider jev --change ${c.flag} --out data/days/${c.id}.json`
    },
    details: st.owner.details, promo: canPromo ? (test ? 'See the promotion test' : 'Test a promotion') : ''
  });
  const many = Boolean(cmp) && st.owner.n > 1;
  ownerLayout(true, many);
  if (!many) return;
  pause();
  const day = String(saved.meta?.dayName || 'Day').split(' ')[0];
  renderPeriodChart($('periodView'), {
    bars: dayBars(result, st.owner.n), labels: Array.from({ length: st.owner.n }, (_, i) => `${day} ${i + 1}`),
    names: ['Today', title], title: `${period.label.charAt(0).toUpperCase()}${period.label.slice(1)} at ${inSentence(st.place)}`
  });
}

// The opening state at a place with a pool of diners (§21f): who did not get a seat on the run on screen, and
// three changes to try. The promotion test stays as a quieter step: its result when one exists, or the test.
function showChoices(bundle, test, change) {
  const words = suggestionWords(bundle.metrics);
  if (!words) return false;
  const canTest = Boolean(st.live && baseWorld()) && change?.kind === 'promotion';
  const promo = canTest ? wordsFor(change, testProvider(change)) : null;
  verdict.choices({
    words, choices: LOYALTY.map(c => ({ id: c.id, label: c.button })),
    second: test ? { label: 'See the promotion test', onClick: () => { st.loyalty.home = false; refreshVerdict(); } }
      : promo ? { label: promo.action, onClick: runTest, hint: promo.plan } : null,
    note: isJev(bundle.meta) ? 'The count above is from the Jev run on screen.' : ''
  });
  return true;
}

// One change's saved two months. The results are read once from the server; without the engine there are none.
async function showSaved(id) {
  const pool = st.caseInfo.pool, runId = st.bundle.meta.runId;
  if (st.loyalty.saved === undefined) {
    verdict.message('Loading the saved results…');
    st.loyalty.saved = st.live ? await apiDays(pool).catch(() => null) : null;
    if (st.bundle?.meta.runId !== runId || st.loyalty.open !== id || st.testing) return;
  }
  const saved = st.loyalty.saved, result = savedResult(saved, id);
  if (!result) { verdict.saved({ missing: missingWords(id, pool) }); return; }
  verdict.saved({
    words: loyaltyWords(id, result, saved.meta), rows: loyaltyRows(result), caption: captionWords(result, saved.meta),
    regularIs: regularWords(saved.meta), caution: cautionWords(result)
  });
}

function showRunning() {
  const { change, provider, done, total } = st.testing;
  const words = wordsFor(change, provider);
  verdict.running({ title: words.title, step: words.step(Math.min(total, done + 1), total, done % 2 === 1), done, total });
}

// A changed room against the room as sketched, on the same seeds and decision-maker (§18), with a toggle between
// the two runs of the seed on screen. st.room keeps the pair while its sketched side is on the map.
async function refreshRoom(bundle) {
  const c = st.caseInfo;
  const mine = st.room?.sketched === bundle.meta.runId ? st.room.spec : bundle.rawSpec;
  st.ringNode = null;
  verdict.message('Comparing your room with the room as sketched…');
  const provider = sameProvider(bundle.meta.provider);
  const wanted = st.runs.filter(r => sameProvider(r.meta.provider) === provider && (sameLayout(r.spec, c.sketch) || sameWorld(r.spec, mine)));
  const runs = await Promise.all(wanted.map(async r => ({ ...r, metrics: await apiRunMetrics(r.meta.runId).catch(() => null) })));
  if (st.bundle !== bundle) return;
  const pairs = pairRuns(c.sketch, mine, runs);
  const pair = pairs.find(p => p.after.meta.runId === bundle.meta.runId || p.before.meta.runId === bundle.meta.runId);
  st.room = pair ? { sketched: pair.before.meta.runId, mine: pair.after.meta.runId, spec: mine } : null;
  const changes = describeChanges(c.sketch, mine).join('. ');
  verdict.room({
    change: changes ? `Your change: ${changes}. Decided by ${byWords(provider)}.` : 'This is a changed room.',
    toggle: st.room && { ...st.room, selected: bundle.meta.runId }
  });
}

// The baseline and the change, 3 seeds each: +1 staff with the rule model, the promotion with the run's own
// decision-maker. Every run carries the link the server stores.
async function runTest() {
  if (st.testing || !st.bundle) return;
  const meta = st.bundle.meta;
  const spec = baseWorld();
  const change = spec && changeFor(st.caseInfo, spec, st.bundle.metrics);
  if (!spec || !change) return;
  const provider = testProvider(change), words = wordsFor(change, provider);
  const id = `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // Tested again: the same seeds as the test on screen, so the newest test replaces it like for like.
  const seed0 = st.test ? Math.min(...st.test.pairs.map(p => p.seed)) : Number.isInteger(meta.seed) ? meta.seed : 7;
  st.testing = { change, provider, done: 0, total: TEST_SEEDS * 2 };
  testAbort = new AbortController();
  const signal = testAbort.signal;
  refreshVerdict();
  const step = () => { st.testing.done++; showRunning(); };
  try {
    const changed = applyChange(spec, change);
    let first = null;
    for (let k = 0; k < TEST_SEEDS; k++) {
      const base = await apiStartRun({ spec, provider, seed: seed0 + k, link: { test: id, role: 'baseline', change }, signal });
      step();
      await apiStartRun({ spec: changed, provider, seed: seed0 + k, link: { test: id, role: 'change', base, change }, signal });
      step();
      first = first || base;
    }
    st.sessionTests.add(id);
    await refreshRuns();
    st.testing = null;
    announce(words.done);
    // A rule-model run on screen is the same simulation as the test's baseline with its seed, and a run of an
    // earlier test is replaced by the newest: show the new baseline, so the Baseline side of the toggle is the run
    // on the map. A Jev run that is not part of a test stays on screen.
    const now = st.bundle.meta;
    if ((!isJev(now) || now.link) && !st.loading) await openRun(first, { keepTime: true });
    else refreshVerdict();
  } catch (err) {
    st.testing = null;
    if (err.name === 'AbortError') {
      await refreshRuns().catch(() => {});
      refreshVerdict();
      announce('The test was cancelled.');
    } else {
      verdict.failed({ again: words.again, message: `${err.message} Nothing on screen has changed.` });
    }
  } finally {
    testAbort = null;
  }
}

// ---------- a new run from the prompt ----------
async function newRun(provider) {
  if (st.loading || !st.bundle) return;
  const meta = st.bundle.meta;
  const spec = baseWorld();
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
    setBundle(await loadEngineRun(runId));
    play();
  } catch (err) {
    showNotice(`The new simulation could not run: ${err.message}`);
  } finally {
    p.done();
    busy(false);
  }
}

// A place name inside a sentence: a common name loses its capital ("Sushi restaurant" -> "sushi restaurant"), a proper
// name keeps it ("MTea Princeton"): one with a capital after its first letter, or more than one capitalized word.
function inSentence(name) {
  const s = String(name ?? '');
  const proper = /^\S+[A-Z]/.test(s) || s.split(/\s+/).filter(w => /^[A-Z]/.test(w)).length > 1;
  return proper ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

// ---------- a new place from the prompt ----------
// First a real scanned building of the kind the words describe (Matterport): if one has walls and doors to walk in,
// Claude fits it out inside those walls. Otherwise, or if the fit-out fails, Claude draws the place from the words.
// The engine runs it, and the page opens it like any other recorded place.
async function buildPlace(text) {
  if (st.loading || !st.live) return;
  hideCard($('askCard'));
  busy(true);
  pause();
  const jev = Boolean(st.live.jev);
  const p = showProgress($('progress'), [
    { label: 'Looking for a scanned building like this' }, { label: 'Claude is drawing the place' },
    { label: 'People are arriving' }, { label: 'Opening the place' }
  ], 'Swarmscope first looks for a real scanned building of this kind. If none fits, Claude draws one from your words.');
  p.set(0);
  let clock = null;
  const tick = label => {
    clearInterval(clock);
    const started = performance.now();
    const show = () => p.set(1, `${label} (${Math.round((performance.now() - started) / 1000)} s)`);
    show();
    clock = setInterval(show, 1000);
  };
  try {
    const search = st.live.scan ? await apiScan(text) : { found: null, reason: 'No Matterport keys on this server.' };
    const found = search.found;
    p.set(0, found ? foundLine(found) : noScanLine(search));
    p.note(buildNote(found));
    let spec = null;
    if (found) {
      tick('Claude is fitting out the scanned building');
      try {
        ({ spec } = await apiCompile(text, { scan: found }));
      } catch (err) {
        // The scan could not be fitted out: draw the place instead, and say why.
        console.warn('[build] the scan could not be fitted out:', err.message);
        p.set(0, 'The scanned building could not be fitted out, so Claude draws the place');
        p.note(`${fitoutFailure(err.message)} ${buildNote(null)}`);
      }
    }
    if (!spec) {
      tick('Claude is drawing the place');
      ({ spec } = await apiCompile(text));
    }
    clearInterval(clock);
    p.set(2, jev ? 'Jev is deciding for every person' : 'The rule model is deciding for every person');
    const runId = await apiStartRun({
      spec, provider: jev ? 'jev' : 'rules', seed: 7,
      onStatus: s => p.set(2, `Simulating: ${Math.round(((s.t || 0) / (s.duration || 1)) * 100)}% of the time window`)
    });
    p.set(3);
    // The recorded title is the one the place opens by.
    const title = (await loadEngineRun(runId)).meta.title;
    const carry = ['theme'].filter(k => params.get(k)).map(k => `${k}=${encodeURIComponent(params.get(k))}`);
    location.assign(`./?${[`place=${encodeURIComponent(title)}`, ...carry].join('&')}`);
  } catch (err) {
    showNotice(`The place could not be built: ${err.message}`);
    p.done();
    busy(false);
  } finally {
    clearInterval(clock);
  }
}

// ---------- the places the card under the prompt box can open ----------
// Every place this page can show: the cases (?case=<id>) and the other walled worlds recorded on this machine
// (?place=<title>), which includes the places built from typed words. The place on screen is marked and is not a link.
function placeItems() {
  const cases = Object.values(st.cases);
  const { building, others } = st.worlds;
  // ?place= names a recorded world: one of the cases' worlds, the building's, or another place. When nothing was
  // recorded under that title the page shows the building's sample, which is none of the places listed.
  const place = placeParam();
  const opened = st.runs.length ? place : null;
  const openedCase = opened ? (cases.find(c => c.runTitle === opened)?.id || (building.some(w => w.title === opened) ? 'building' : null)) : null;
  const onCase = place ? openedCase : st.caseId;
  const onWorld = opened && !openedCase ? opened : null;
  // A link keeps the theme the address asked for.
  const carry = ['theme'].filter(k => params.get(k)).map(k => `${k}=${encodeURIComponent(params.get(k))}`);
  const href = query => `./?${[query, ...carry].join('&')}`;
  const item = (label, query, current, sample) => ({ label, href: href(query), current, note: current ? 'On screen' : sample ? 'Sample data' : '' });
  const items = cases.map(c => {
    const current = c.id === onCase;
    // The building goes by the name above its map. Without a recorded run it opens its sample.
    const label = c.id !== 'building' ? c.placeName || c.label : current ? st.place : st.worlds.buildingName || c.placeName || c.label;
    return item(label, `case=${encodeURIComponent(c.id)}`, current, sampleOnly(c) || (c.id === 'building' && !building.length));
  });
  const worlds = onWorld && !others.some(w => w.title === onWorld) ? [...others, { title: onWorld, placeName: st.place }] : others;
  for (const w of worlds) items.push(item(placeName(w), `place=${encodeURIComponent(w.title)}`, w.title === onWorld, false));
  return items;
}

$('askForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!st.bundle) return;
  const text = $('askIn').value.trim();
  const cancel = () => { hideCard($('askCard')); $('askIn').focus(); };
  const places = { heading: 'Places', items: placeItems() };
  // Typed words can become a new place: Claude draws it on the server, where the engine and Claude Code run.
  const canBuild = Boolean(st.live?.claude) && text.length >= 12;
  const build = canBuild ? [{ label: 'Build this place', solid: true, onClick: () => buildPlace(text) }] : [];
  const buildLine = canBuild
    ? `Build this place: ${st.live.scan ? 'Swarmscope looks for a real scanned building of this kind and Claude fits it out, or Claude draws one' : 'Claude draws its floor plan and its people'} from your words, then ${st.live.jev ? 'Jev' : 'the rule model'} decides for each person. About three minutes${st.live.jev ? ', and a few cents' : ''}.`
    : null;
  if (!baseWorld() || !st.live) {
    const sample = providerWords(st.bundle.meta) === 'Sample data';
    showCard($('askCard'), {
      title: canBuild ? 'Build a new place from your words?' : sample ? 'This page is showing sample data' : 'This page is showing a recorded run',
      lines: [buildLine, sample && st.live ? 'This is sample data, so it cannot be simulated again. You can still replay it.'
        : `A new simulation needs the Swarmscope engine, which is not running here. You can still replay the ${sample ? 'sample' : 'run'}.`],
      places,
      actions: build,
      onCancel: cancel
    });
    return;
  }
  showCard($('askCard'), {
    title: canBuild ? 'Build a new place from your words?' : `Simulate ${st.place} again?`,
    lines: [
      buildLine,
      canBuild ? `Or keep ${st.place} and run it again. Your words do not change who comes in or what they do.`
        : 'This screen shows one place at a time. Pick another from the list below. A question does not change who comes in or what they do yet.'
    ],
    places,
    actions: [
      ...build,
      { label: canBuild ? 'Run this one again' : 'Run it again', solid: !canBuild, onClick: () => newRun('rules') },
      ...(st.live.jev ? [{ label: canBuild ? 'Run this one with Jev' : 'Run it with Jev', onClick: () => newRun('jev') }] : [])
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
    bottlenecks: st.run.bottlenecks.at(fi, st.t), bottlenecksNow: st.run.bottlenecks.now(fi), rankMode: st.rankMode,
    seated: st.seated
  };
  renderCounters($('counters'), ps);
  updateFloorCounts();
  if (st.selectedAgent != null) { drawInspector(st.selectedAgent); return; }
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
// The person view, with the box that asks Jev one of their choices again with a sentence about what just happened (§9c).
// The box is one node kept across redraws, so typing in it survives the replay moving on.
const askPanel = createAskPanel({
  onAsk: (decision, today) => apiAskAgain(st.bundle.meta.runId, st.selectedAgent, decision, today),
  onAskAll: askEveryone
});
// The same sentence asked of one of each kind of diner, each at their own moment at the time on the slider. The
// person who is open stands for their own kind. Tonight's question only: two Jev requests each.
async function askEveryone(today) {
  const runId = st.bundle.meta.runId, picked = new Map();
  const open = st.agentsById.get(st.selectedAgent);
  for (const a of [open, ...st.agentsById.values()]) {
    if (!a || picked.has(a.personaId)) continue;
    const d = targetChoice(st.bundle.decisions, a.id, st.t);
    if (d) picked.set(a.personaId, { agent: a, decision: d });
  }
  const jobs = [...picked.values()].slice(0, 16).map(async ({ agent, decision }) => {
    const result = await apiAskAgain(runId, agent.id, decision.id, today).catch(() => null);
    return result && { name: agent.personaName || `Person ${agent.id}`, about: st.personas.get(agent.personaId)?.about || '', result };
  });
  const list = (await Promise.all(jobs)).filter(Boolean);
  if (!list.length) throw new Error('Jev could not be asked.');
  return list;
}
askPanel.input.addEventListener('focus', () => pause());
function drawInspector(id) {
  const meta = st.bundle.meta;
  const d = targetChoice(st.bundle.decisions, id, st.t);
  const recordedHere = Boolean(st.live) && providerWords(meta) !== 'Sample data';
  askPanel.update({
    key: d ? `${meta.runId}/${id}/${d.id}` : null, decision: d,
    name: st.agentsById.get(id)?.personaName || '', when: d ? clockText(meta.clockStart, d.t) : '', situation: d?.observation?.now || '',
    why: !d ? '' : !recordedHere ? 'Asking again needs a run recorded by the Swarmscope engine on this computer.'
      : !st.live.jev ? 'Asking again needs a Jev key on the server.' : ''
  });
  const typing = document.activeElement === askPanel.input, at = typing ? [askPanel.input.selectionStart, askPanel.input.selectionEnd] : null;
  renderInspector($('inspector'), inspectorState(), id, closeInspector, askPanel.node);
  if (typing) { askPanel.input.focus(); askPanel.input.setSelectionRange(at[0], at[1]); }
}
// Run details: the recorded runs of this place (a changed room says so), and the other places the display opens.
function drawDrawer() {
  const sketch = st.caseInfo?.sketch;
  // A run without a test link still says what it is: a promotion run (by its offers), a changed room (by its seats).
  const runs = st.runs.map(r => (runLabel(r.meta) ? r : {
    ...r,
    label: [hasPromotion(r.spec) ? 'Promotion' : '',
      sketch && !sameLayout(r.spec, sketch) ? `Changed room, ${seatedPlaces(r.spec).reduce((k, p) => k + p.seats.length, 0)} seats` : ''].filter(Boolean).join(', ')
  }));
  const places = Object.values(st.cases).filter(c => c.id !== st.caseId)
    .map(c => ({ label: c.placeName || c.label, question: c.question, href: c.id === 'building' ? './' : `./?case=${encodeURIComponent(c.id)}` }));
  renderDrawer($('drawerBody'), { bundle: st.bundle, decisions: st.bundle.decisions, geometry: st.bundle.geometry, runs, place: st.place, places },
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
  // A person takes the whole side panel: the verdict steps aside while they are open, so their choices and the
  // ask-again box are in view without scrolling.
  $('verdict').hidden = true;
  drawInspector(id);
  if (focus) $('inspector').querySelector('.back')?.focus();
  st.dirty = true;
}
function closeInspector() {
  const had = $('inspector').contains(document.activeElement), was = st.selectedAgent;
  st.selectedAgent = null;
  $('inspector').hidden = true;
  $('sideBody').hidden = false;
  $('verdict').hidden = false;
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
let seatDrag = false;
const mapPoint = e => { const r = map.getBoundingClientRect(); return R.toMap(e.clientX - r.left, e.clientY - r.top); };
const seatReach = () => 16 / R.scale();          // a seat is grabbed within 16 px of its middle
const endSeatDrag = () => { seatDrag = false; editor.pointerUp(); map.classList.remove('grabbing'); };
map.addEventListener('pointerdown', e => {
  if (!st.bundle) return;
  // Edit the room: a press on a seat drags it; anywhere else pans the map as usual.
  if (editor.active && editor.pointerDown(...mapPoint(e), seatReach())) {
    seatDrag = true;
    map.setPointerCapture(e.pointerId);
    map.classList.add('grabbing');
    return;
  }
  drag = { x: e.clientX, y: e.clientY, vx: R.view.x, vy: R.view.y, moved: false };
  map.setPointerCapture(e.pointerId);
});
map.addEventListener('pointermove', e => {
  if (!st.bundle) return;
  if (seatDrag) { editor.pointerMove(...mapPoint(e)); return; }
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
  if (editor.active) {
    const [mx, my] = mapPoint(e);
    map.classList.toggle('grab', seatedPlaces(editor.spec).some(p => p.seats.some(q => Math.hypot(q.x - mx, q.y - my) <= seatReach())));
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
map.addEventListener('pointercancel', () => { if (seatDrag) endSeatDrag(); drag = null; map.classList.remove('dragging'); });
map.addEventListener('pointerup', e => {
  if (seatDrag) { endSeatDrag(); return; }
  if (!st.bundle || !drag) return;
  const wasDrag = drag.moved;
  drag = null;
  map.classList.remove('dragging');
  if (wasDrag) return;
  if (editor.active) { editor.select(null); return; }      // a click on the floor lets go of the selected seat
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
  if (!st.bundle || editor.active) return;          // while editing, the editor takes the keys (document handler)
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
      : st.colorBy === 'customer'
        ? [['var(--c-returning)', 'Returning customers'], ['var(--c-new)', 'New customers']]
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
  // Edit the room: the editor takes Escape, Delete and the arrow keys; nothing drives the replay meanwhile.
  if (editor.active && $('askCard').hidden && $('drawer').hidden && $('viewMenu').hidden) {
    if (!typing && editor.key(e)) e.preventDefault();
    return;
  }
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

// ---------- edit the room (§18) ----------
const editor = createEditor({ panel: $('editPanel'), onChange: () => { st.dirty = true; }, onRun: runEdited, onClose: leaveEdit });

// The edit panel takes the side column, and the map shows only the room and its seats.
function enterEdit() {
  if (!st.bundle || editor.active || !st.live || !st.bundle.rawSpec) return;
  pause();
  if (st.selectedAgent != null) closeInspector();
  if (st.selectedIncident) closeCallout();
  setViewMenu(false);
  // An edit changes seats only. Opened from a promotion run, it starts from that room without the promotion.
  const sketch = st.caseInfo?.sketch || st.bundle.rawSpec;
  editor.open({ spec: { ...st.bundle.rawSpec, offers: sketch.offers || [] }, sketch, hasJev: Boolean(st.live.jev) });
  setEditing(true);
  $('editPanel').querySelector('button')?.focus();
}
function leaveEdit() {
  const had = $('editPanel').contains(document.activeElement);
  editor.close();
  setEditing(false);
  st.lastPanels = -1;
  if (st.bundle) update();
  if (had) $('editBtn').focus();
}
function setEditing(on) {
  $('side').classList.toggle('editing', on);
  $('editBtn').setAttribute('aria-pressed', String(on));
  $('editBtn').textContent = on ? 'Stop editing' : 'Edit the room';
  $('legendMini').hidden = on;
  $('timeline').hidden = on;
  map.classList.toggle('editing', on);
  if (!on) map.classList.remove('grab', 'grabbing');
  st.dirty = true;
}
$('editBtn').addEventListener('click', () => (editor.active ? leaveEdit() : enterEdit()));

// Run the edited room on the seeds the room as sketched already has runs of with this decision-maker (three at
// most), one after another, then open the first new run. A seed with no run of the sketched room gets one first.
async function runEdited(provider, spec) {
  const sketch = editor.sketch;
  const have = [...new Set(st.runs.filter(r => sameProvider(r.meta.provider) === provider && sameWorld(r.spec, sketch)).map(r => r.meta.seed))]
    .filter(Number.isFinite).sort((a, b) => a - b).slice(0, TEST_SEEDS);
  const seeds = have.length ? have : [Number.isInteger(st.bundle.meta.seed) ? st.bundle.meta.seed : 7];
  const jobs = [];
  for (const seed of seeds) {
    if (!have.includes(seed)) jobs.push({ spec: sketch, seed, what: 'the room as sketched' });
    jobs.push({ spec, seed, what: 'your room', mine: true });
  }
  const p = showProgress($('progress'), [...jobs.map((j, i) => ({ label: `Run ${i + 1} of ${jobs.length}: ${j.what}` })), { label: 'Opening the replay' }],
    provider === 'jev' ? 'Jev decides for every person. This takes about 20 seconds.' : 'The rule model decides for every person. This takes a few seconds.');
  let first = null;
  try {
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      p.set(i);
      const id = await apiStartRun({
        spec: j.spec, provider, seed: j.seed,
        onStatus: s => p.set(i, `Run ${i + 1} of ${jobs.length}: ${j.what}, ${Math.round(((s.t || 0) / (s.duration || 1)) * 100)}% simulated`)
      });
      if (j.mine && first == null) first = id;
    }
    p.set(jobs.length);
    await refreshRuns();
  } finally {
    p.done();
  }
  leaveEdit();
  await openRun(first, { autoplay: true });
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
  st.cases = cases;
  st.caseId = cases[params.get('case')] ? params.get('case') : cases.building ? 'building' : Object.keys(cases)[0] || null;
  st.caseInfo = cases[st.caseId] || null;
  st.config = config;
  st.live = live;
  // A place drawn from a sketch (the sushi restaurant): its packed file's world is the room as sketched, which
  // every changed room is compared with.
  if (st.caseInfo?.runTitle) st.caseInfo.sketch = await loadBundle(st.caseInfo.file).then(b => b.rawSpec || null).catch(() => null);
  let problem = '';
  if (live) await refreshRuns().catch(err => { problem = `The recorded runs could not be listed: ${err.message}`; });
  const want = params.get('run');
  const first = (want && st.runs.find(r => r.meta.runId === want)) || await openingRun();
  try {
    if (first) setBundle(await loadEngineRun(first.meta.runId));
    else if (st.caseInfo) setBundle(await loadBundle(st.caseInfo.file));
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
