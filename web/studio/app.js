// Environments built from a written brief, in the dashboard's frame (web/scope/index.html and style.css).
// The page builds, saves, runs and replays an environment; the look, the theme and the language button are the
// dashboard's. Everything generated or typed enters the page as text; no generated markup or code is run.
// URL: /scope/?mode=environment, with #run=<run id> to open a recorded run and ?theme=dark as on the dashboard.
import { createWorkflowRenderer } from './render.js';
import { readPalette } from '../scope/lib/palette.js';
import * as builders from './builders.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
};
const ui = Object.fromEntries([
  'examples', 'notice', 'jobPanel', 'jobSteps', 'jobText', 'jobProgress', 'cancelBtn', 'briefForm',
  'description', 'objectives', 'guidelines', 'constraints', 'backend', 'model', 'builderHelp', 'buildBtn',
  'environmentSelect', 'refreshBtn', 'modelEmpty', 'modelOverview', 'environmentTitle', 'environmentDescription',
  'modelNumbers', 'definitionDetails', 'assumptions', 'warnings', 'specEditor', 'editorDetails', 'saveBtn', 'saveNote',
  'savedTag', 'provider', 'seed', 'maxRequests', 'providerHelp', 'runBtn', 'runSelect', 'replayEmpty',
  'runTitle', 'runMeta', 'runDetails', 'runFacts', 'downloadRun', 'runWarning', 'metrics', 'results', 'resultsBlock',
  'roleFilter', 'resources', 'agentSelect', 'events', 'feedFilters', 'worldState', 'sideEmpty', 'sideBody', 'inspector',
  'askForm', 'askIn', 'askBtn', 'environmentDrawer', 'environmentBtn', 'drawerClose', 'themeBtn',
  'sourceBadge', 'editEnvironmentBtn', 'resetView', 'viewBtn', 'viewMenu', 'mapTools', 'legendMini', 'map', 'mapbox',
  'timeline', 'exampleSelect'
].map(id => [id, $(id)]));

const builderSelection = builders.createBuilderSelection(ui.backend.value);
const builderName = backend => builders.builderName?.(backend) || 'Claude';
const state = {
  artifact: null, dirty: false, run: null, job: null, poll: null, playing: null, health: null,
  ready: false, pending: false, agentId: '', frame: 0, download: null, opening: 0, speed: 1, briefSnapshot: '',
  autoRun: false, chained: false, preview: null, examples: [],
  theme: params.get('theme') || store.get('scope-theme') || 'light',
  colorBy: 'state', role: '', filters: { started: true, completed: true, blocked: true },
  who: null, names: new Map(), actions: new Map(), roles: new Map()
};

// ---------- small helpers ----------
function el(tag, text = '', className = '') {
  const node = document.createElement(tag);
  if (text !== '') node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function button(className, text, onClick) {
  const node = el('button', text, className);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}
const option = (value, label) => { const node = el('option', label); node.value = value; return node; };
const number = value => (Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'n/a');
const enc = encodeURIComponent;
const stringify = value => JSON.stringify(value, null, 2);
const sentence = text => String(text).charAt(0).toUpperCase() + String(text).slice(1);
const stepName = id => sentence(String(id).replace(/_/g, ' '));
// "Today, 3:14 pm" or "Nov 14, 3:14 pm", as Run details writes it on the dashboard.
function when(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? 'Today' : d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
// Who decides, in the words the dashboard uses.
const whoWords = provider => (provider === 'jev' ? 'Jev' : 'Rule model');
function decidedBy(provider) {
  switch (provider) {
    case 'jev': return 'Jev';
    case 'jev-cache': return 'Jev, repeated answer';
    case 'replay': return 'Jev, replayed';
    case 'rules-fallback': return 'Rule model (Jev did not answer)';
    default: return 'Rule model';
  }
}
const STATUS_WORDS = { done: 'Finished', cancelled: 'Stopped early', error: 'Failed', running: 'Still running', queued: 'Waiting to start' };
const nameOf = id => state.names.get(id) || id;
const actionLabel = id => state.actions.get(id) || stepName(id);

// A problem or a short status, said in place over the map with a way to dismiss it. Problems stay until
// dismissed; a status leaves by itself.
let noticeTimer = null;
function message(text = '', error = false) {
  clearTimeout(noticeTimer);
  if (!text) { ui.notice.hidden = true; ui.notice.replaceChildren(); return; }
  ui.notice.setAttribute('role', error ? 'alert' : 'status');
  ui.notice.replaceChildren(el('p', text), button('btn small', 'Dismiss', () => message()));
  ui.notice.hidden = false;
  if (!error) noticeTimer = setTimeout(() => message(), 6000);
}
function safely(fn) {
  return (...args) => Promise.resolve().then(() => fn(...args)).catch(error => message(error.message || String(error), true));
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : {}; } catch { throw new Error(`The server sent an answer this page could not read (${response.status}).`); }
  if (!response.ok) {
    const details = result.errors?.length ? `\n${result.errors.join('\n')}` : '';
    throw new Error(`${result.error || `The request failed (${response.status})`}${details}`);
  }
  return result;
}

// ---------- theme and language: the dashboard's, with the same stored choice ----------
let palette = null;
const pal = () => palette || (palette = readPalette());
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  ui.themeBtn.setAttribute('aria-label', state.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  palette = null;
  redraw();
}
ui.themeBtn.addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  store.set('scope-theme', state.theme);
  applyTheme();
});

// ---------- the map ----------
const renderer = createWorkflowRenderer(ui.map, {
  onSelect: id => selectAgent(id),
  onView: moved => { ui.resetView.hidden = !moved; }
});
const drawOptions = () => ({ role: state.role, selectedAgent: state.agentId, colorBy: state.colorBy });
// Draw the map again as it is: after a theme change, or a change in the View menu.
function redraw() {
  const frame = currentFrame() || state.preview;
  if (frame) renderer.draw(frame, drawOptions());
  if (state.run) timeline.draw();
}
ui.resetView.addEventListener('click', () => {
  const had = document.activeElement === ui.resetView;
  renderer.resetView();
  if (had) ui.viewBtn.focus();
});

// The View menu: how the people are colored and which role shows.
function setViewMenu(open) {
  ui.viewMenu.hidden = !open;
  ui.viewBtn.setAttribute('aria-expanded', String(open));
}
ui.viewBtn.addEventListener('click', () => setViewMenu(ui.viewMenu.hidden));
document.addEventListener('pointerdown', e => {
  if (!ui.viewMenu.hidden && !e.target.closest('#viewMenu, #viewBtn')) setViewMenu(false);
});
ui.viewMenu.addEventListener('change', e => {
  if (!e.target.checked) return;
  if (e.target.name === 'colorBy') state.colorBy = e.target.value;
  if (e.target.name === 'role') state.role = e.target.value;
  renderLegend();
  redraw();
});
function renderRoleFilter(roles) {
  if (!roles.some(role => role.id === state.role)) state.role = '';
  const choice = (value, label) => {
    const row = el('label'), input = el('input');
    input.type = 'radio'; input.name = 'role'; input.value = value; input.checked = state.role === value;
    row.append(input, document.createTextNode(` ${label}`));
    return row;
  };
  ui.roleFilter.replaceChildren(el('legend', 'Show'), choice('', 'Everyone'), ...roles.map(role => choice(role.id, role.name || stepName(role.id))));
}
function renderLegend() {
  const spec = state.run?.spec || state.artifact?.spec;
  const items = state.colorBy === 'role'
    ? (spec?.roles || []).slice(0, 5).map((role, index) => [`var(--g-${index + 1})`, role.name || stepName(role.id)])
    : [['var(--a-queue)', 'Idle'], ['var(--a-walk)', 'Busy'], ['var(--a-serve)', 'Finished']];
  const parts = items.map(([color, text]) => {
    const item = el('span'), dot = el('i');
    dot.style.background = color;
    item.append(dot, document.createTextNode(text));
    return item;
  });
  parts.push(el('span', 'Boxes are steps in the work, not places.', 'aside'));
  ui.legendMini.replaceChildren(...parts);
}

// ---------- the timeline: the dashboard's, counted in ticks instead of clock time ----------
const KINDS = [['started', 'Started', 'a-walk'], ['completed', 'Finished', 'a-serve'], ['blocked', 'Blocked', 'i-congestion']];
const kindOf = event => (event.type === 'completed' ? 'completed' : event.type === 'blocked' || event.type === 'rejected' ? 'blocked' : 'started');

function createTickTimeline({ root, onSeek, onPlay, onSpeed }) {
  const hist = root.querySelector('#hist'), scrub = root.querySelector('#scrub');
  const playBtn = root.querySelector('#playBtn'), playIcon = root.querySelector('#playIcon');
  const clock = root.querySelector('#clock'), span = root.querySelector('#span');
  const T = { ticks: 1, bins: [], tick: 0, w: 0, h: 0, dpr: 1 };
  const LABELS = 18;      // height of the band of tick numbers under the bars, in CSS pixels

  scrub.addEventListener('input', () => onSeek(Number(scrub.value)));
  playBtn.addEventListener('click', () => onPlay());
  root.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => onSpeed(Number(b.dataset.speed))));

  T.setRun = ({ ticks, bins }) => {
    T.ticks = Math.max(1, ticks);
    T.bins = bins;
    scrub.max = String(T.ticks);
    scrub.step = '1';
    span.textContent = `Tick 0 to ${T.ticks}`;
    T.layout();
  };
  T.layout = () => {
    const r = hist.getBoundingClientRect();
    T.dpr = Math.min(2, window.devicePixelRatio || 1);
    hist.width = Math.round(r.width * T.dpr);
    hist.height = Math.round(r.height * T.dpr);
    T.w = r.width; T.h = r.height;
    T.draw();
  };
  T.update = (tick, playing) => {
    T.tick = tick;
    scrub.value = String(tick);
    clock.textContent = `Tick ${tick}`;
    scrub.setAttribute('aria-valuetext', `Tick ${tick} of ${T.ticks}`);
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playIcon.setAttribute('d', playing ? 'M5 4h3.6v12H5zM11.4 4H15v12h-3.6z' : 'M6 4l10 6-10 6z');
    T.draw();
  };
  T.draw = () => {
    if (!T.w) return;
    const g = hist.getContext('2d'), p = pal();
    g.setTransform(T.dpr, 0, 0, T.dpr, 0, 0);
    g.clearRect(0, 0, T.w, T.h);
    const thumb = 9, x0 = thumb, x1 = T.w - thumb;
    const xAt = tick => x0 + (tick / T.ticks) * (x1 - x0);
    const base = T.h - LABELS, top = base - 4;
    const max = Math.max(4, ...T.bins.map(bin => bin.total));
    g.fillStyle = p['line-2'];
    g.fillRect(x0, base - 1, x1 - x0, 1);
    // Tick numbers on round steps, as many as there is room for.
    const room = Math.max(2, (x1 - x0) / 64);
    const every = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find(s => T.ticks / s <= room) || 10000;
    g.font = '400 12px "IBM Plex Sans", sans-serif';
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    for (let tick = 0; tick <= T.ticks; tick += every) {
      const x = Math.round(xAt(tick)), label = String(tick), w = g.measureText(label).width;
      g.fillStyle = p['line-2'];
      g.fillRect(x, base, 1, 4);
      g.fillStyle = p.faint;
      g.fillText(label, Math.max(x0, Math.min(x1 - w, x - w / 2)), T.h - 2);
    }
    // One bar per tick, standing on the line at that tick: blocked, then started, then finished.
    const bw = Math.max(1, Math.min(14, ((x1 - x0) / T.ticks) * 0.7));
    T.bins.forEach((bin, tick) => {
      let y = base - 1;
      g.globalAlpha = tick <= T.tick ? 1 : 0.28;
      for (const kind of ['blocked', 'started', 'completed']) {
        const count = bin[kind] || 0;
        if (!count) continue;
        const h = (count / max) * top;
        g.fillStyle = p[KINDS.find(k => k[0] === kind)[2]];
        g.fillRect(xAt(tick) - bw / 2, y - h, bw, h);
        y -= h;
      }
    });
    g.globalAlpha = 1;
    g.fillStyle = p.text;
    g.fillRect(Math.round(xAt(T.tick)) - 1, 0, 2, base);
  };
  return T;
}

const timeline = createTickTimeline({
  root: ui.timeline,
  onPlay: () => (state.playing ? pause() : play()),
  onSeek: tick => {
    pause();
    const frames = state.run?.result?.frames || [];
    let nearest = 0;
    for (let i = 1; i < frames.length; i++) if (Math.abs(frames[i].tick - tick) < Math.abs(frames[nearest].tick - tick)) nearest = i;
    state.frame = nearest;
    renderFrame();
  },
  onSpeed: speed => {
    const wasPlaying = Boolean(state.playing);
    pause();
    state.speed = speed;
    ui.timeline.querySelectorAll('[data-speed]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === speed)));
    if (wasPlaying) play();
  }
});
new ResizeObserver(() => { if (state.run) timeline.layout(); }).observe(ui.mapbox);

function updateTimeline() {
  if (state.run) timeline.update(currentFrame()?.tick || 0, Boolean(state.playing));
}
function setTimeline() {
  const ticks = state.run.spec.ticks;
  const bins = Array.from({ length: ticks + 1 }, () => ({ total: 0, started: 0, completed: 0, blocked: 0 }));
  for (const event of state.run.result?.events || []) {
    const bin = bins[event.tick];
    if (!bin) continue;
    bin[kindOf(event)]++;
    bin.total++;
  }
  timeline.setRun({ ticks, bins });
  updateTimeline();
}
function pause() {
  clearInterval(state.playing);
  state.playing = null;
  updateTimeline();
}
function play() {
  const last = (state.run?.result?.frames?.length || 1) - 1;
  if (last < 1) return;
  if (state.frame >= last) state.frame = 0;
  state.playing = setInterval(() => {
    state.frame++;
    renderFrame();
    if (state.frame >= last) pause();
  }, Math.max(35, 350 / state.speed));
  renderFrame();
}

// ---------- the Environment drawer ----------
function setDrawer(open) {
  const had = ui.environmentDrawer.contains(document.activeElement);
  if (open) setViewMenu(false);
  ui.environmentDrawer.hidden = !open;
  ui.environmentBtn.setAttribute('aria-expanded', String(open));
  if (open) ui.drawerClose.focus();
  else if (had) ui.environmentBtn.focus();
}
function brief() {
  return {
    description: ui.description.value.trim(), objectives: ui.objectives.value.trim(),
    guidelines: ui.guidelines.value.split('\n').map(line => line.trim()).filter(Boolean), constraints: ui.constraints.value.trim()
  };
}
function fillBrief(value = {}) {
  ui.description.value = value.description || '';
  ui.objectives.value = value.objectives || '';
  ui.guidelines.value = Array.isArray(value.guidelines) ? value.guidelines.join('\n') : value.guidelines || '';
  ui.constraints.value = value.constraints || '';
  ui.askIn.value = ui.description.value;
}
// Who made the run on screen, or who will make the next one.
function updateBadge() {
  const badge = ui.sourceBadge;
  badge.hidden = !state.ready;
  if (state.run && state.who) {
    badge.textContent = state.who.badge;
    badge.title = state.who.title;
  } else {
    const jev = ui.provider.value === 'jev';
    badge.textContent = jev ? 'Next run: Jev' : 'Next run: rule model';
    badge.title = jev ? 'Jev will decide for every person in the next run. You can change this under Environment.'
      : 'The rule model will decide for every person in the next run. You can change this under Environment.';
  }
}
function controls() {
  const busy = Boolean(state.job) || state.pending || !state.ready;
  const briefChanged = Boolean(state.artifact) && JSON.stringify(brief()) !== state.briefSnapshot;
  const saved = Boolean(state.artifact?.id) && !state.dirty;
  const jev = ui.provider.value === 'jev';
  ui.buildBtn.disabled = busy;
  ui.askBtn.disabled = busy;
  ui.saveBtn.disabled = busy || !ui.specEditor.value.trim();
  ui.runBtn.disabled = busy || !saved || briefChanged;
  ui.environmentSelect.disabled = busy;
  ui.exampleSelect.disabled = busy;
  ui.backend.disabled = busy;
  ui.refreshBtn.disabled = busy;
  ui.maxRequests.disabled = !jev || busy;
  // Ink marks the one next step in the drawer: build from the description, save the definition, or run it.
  const next = !state.artifact || briefChanged ? ui.buildBtn : saved ? ui.runBtn : ui.saveBtn;
  for (const b of [ui.buildBtn, ui.saveBtn, ui.runBtn]) b.classList.toggle('solid', b === next);
  ui.savedTag.textContent = !state.artifact ? '' : saved ? 'Saved' : state.artifact.id ? 'Changed, not saved' : 'Not saved yet';
  ui.saveNote.textContent = briefChanged ? 'The description changed. Simulate builds it again.'
    : state.artifact && state.dirty ? 'Save this version before you run it.'
      : saved ? 'This version is ready to run.' : 'Paste a definition or choose an example.';
  ui.providerHelp.textContent = jev
    ? `${state.health?.jev === false ? 'Jev needs a key on this server: set TYPESAFE_API_KEY in .env.local and restart it. ' : ''}Jev decides for every person and reads your guidelines. It makes live requests, up to the number above. If Jev does not answer, the rule model decides and the record says so.`
    : 'The rule model picks each action by the weights in the definition. It does not read your guidelines.';
  ui.builderHelp.textContent = builders.builderHelp(ui.backend.value, state.health || {});
  ui.model.placeholder = ui.backend.value === 'claude-code' ? 'Claude Code default' : 'Default API model';
  ui.askBtn.title = jev ? 'Jev decides for every person in the next run.' : 'The rule model decides for every person in the next run.';
  updateBadge();
}
function disclosure(title, rows) {
  const details = el('details');
  details.append(el('summary', title));
  const list = el('div', '', 'definition-list');
  for (const row of rows) {
    const item = el('div');
    item.append(el('strong', row.title));
    if (row.description) item.append(el('p', row.description));
    if (row.meta) item.append(el('span', row.meta));
    list.append(item);
  }
  details.append(list);
  return details;
}
const plural = (n, one, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;
const peopleIn = spec => (spec.roles || []).reduce((sum, role) => sum + role.count, 0);

// A definition that has not run yet: everyone at their starting step.
function previewDefinition(spec) {
  const agents = spec.roles.flatMap(role => Array.from({ length: role.count }, (_, index) => ({
    id: role.id + '_' + (index + 1), role: role.id, state: role.initialState, status: 'idle', action: null
  })));
  state.preview = { tick: 0, agents, world: spec.world || {}, resources: [] };
  if (state.run) return;
  ui.map.hidden = false;
  renderer.resize();
  renderer.setRun(spec, { agents });
  renderer.draw(state.preview, drawOptions());
  ui.replayEmpty.hidden = true;
  ui.mapTools.hidden = false;
  ui.legendMini.hidden = false;
  ui.runTitle.textContent = spec.title;
  ui.runMeta.textContent = 'Not simulated yet. The map shows where everyone starts. Press Simulate to run it.';
  ui.runMeta.title = '';
}
// The examples show while nothing is loaded and nothing is being built or run.
function showEmpty() { ui.replayEmpty.hidden = Boolean(state.job) || Boolean(state.artifact); }
function showSide() {
  const run = Boolean(state.run), person = run && Boolean(state.agentId) && state.names.has(state.agentId) && Boolean(currentFrame());
  ui.sideEmpty.hidden = run;
  ui.metrics.hidden = !run;
  ui.sideBody.hidden = !run || person;
  ui.inspector.hidden = !person;
  return person;
}
function loadArtifact(artifact, { useBrief = true } = {}) {
  pause();
  state.run = null; state.who = null; state.agentId = '';
  state.names = new Map();
  state.actions = new Map((artifact.spec.actions || []).map(action => [action.id, action.label || stepName(action.id)]));
  state.roles = new Map((artifact.spec.roles || []).map(role => [role.id, role]));
  ui.timeline.hidden = true;
  ui.runDetails.hidden = true;
  showSide();
  state.artifact = artifact;
  state.dirty = !artifact.id;
  renderRoleFilter(artifact.spec.roles || []);
  renderLegend();
  ui.environmentSelect.value = artifact.id || '';
  ui.exampleSelect.value = '';
  ui.runSelect.value = '';
  ui.specEditor.value = stringify(artifact.spec);
  if (useBrief) fillBrief(artifact.brief || { description: artifact.spec.description, guidelines: artifact.spec.guidelines });
  let selectedBuilder = builderSelection.restore(artifact.builder, ui.model.value);
  ui.backend.value = selectedBuilder.backend;
  if (ui.backend.value !== selectedBuilder.backend) {
    // A record made by a builder this page no longer offers: the first builder in the list takes its place.
    selectedBuilder = builderSelection.select(ui.backend.options[0].value);
    ui.backend.value = selectedBuilder.backend;
  }
  ui.model.value = selectedBuilder.model;
  const spec = artifact.spec;
  state.briefSnapshot = JSON.stringify(brief());
  ui.askIn.value = ui.description.value;
  previewDefinition(spec);
  ui.modelEmpty.hidden = true;
  ui.modelOverview.hidden = false;
  ui.environmentTitle.textContent = spec.title;
  ui.environmentDescription.textContent = spec.description;
  ui.modelNumbers.replaceChildren(...[
    [peopleIn(spec), 'People'], [spec.roles?.length, 'Roles'], [spec.actions?.length, 'Actions'], [spec.ticks, 'Ticks']
  ].map(([value, label]) => { const fig = el('div', '', 'fig'); fig.append(el('b', number(value)), el('span', label)); return fig; }));
  ui.definitionDetails.replaceChildren(
    disclosure('Roles and goals', (spec.roles || []).map(role => ({
      title: role.name, description: role.goal,
      meta: `${plural(role.count, 'person', 'people')}, starting at ${stepName(role.initialState)}${role.arrive ? `, arriving from tick ${role.arrive.from} to tick ${role.arrive.to}` : ''}`
    }))),
    disclosure('Actions and steps', (spec.actions || []).map(action => ({
      title: action.label, description: `From ${(action.from || []).map(stepName).join(' or ')} to ${stepName(action.to)}`,
      meta: `${plural(action.duration ?? 1, 'tick')}, ${plural((action.requirements || []).length, 'condition')}, ${plural((action.resources || []).length, 'shared resource')}`
    }))),
    disclosure('Shared resources', (spec.resources || []).length ? spec.resources.map(resource => ({ title: resource.name, meta: `Room for ${number(resource.capacity)} at a time` }))
      : [{ title: 'No shared resources', description: 'No action in this definition has to wait for one.' }]),
    disclosure('Guidelines', (spec.guidelines || []).length ? spec.guidelines.map(line => ({ title: line })) : [{ title: 'No guidelines' }])
  );
  ui.assumptions.replaceChildren(el('h4', 'Assumptions to check'));
  const assumptions = el('ul');
  for (const assumption of spec.assumptions?.length ? spec.assumptions : ['No assumptions were written down. Read the definition before you draw conclusions.']) {
    assumptions.append(el('li', typeof assumption === 'string' ? assumption : stringify(assumption)));
  }
  ui.assumptions.append(assumptions);
  ui.warnings.hidden = !artifact.warnings?.length;
  ui.warnings.replaceChildren(...(artifact.warnings || []).map(line => el('p', line, 'warn')));
  controls();
}
// One recorded run in the picker: when, who decided, and what. The title comes last because it is above the map already.
const runLine = item => [when(item.createdAt), whoWords(item.provider), item.status === 'done' ? '' : (STATUS_WORDS[item.status] || item.status).toLowerCase(), item.title].filter(Boolean).join(' · ');
async function refreshLibraries() {
  const [environments, runs] = await Promise.all([api('environments'), api('environment-runs')]);
  const environmentId = state.artifact?.id || ui.environmentSelect.value;
  ui.environmentSelect.replaceChildren(option('', 'Choose a saved environment'), ...(environments.environments || []).map(item => option(item.id, [item.title, when(item.createdAt)].filter(Boolean).join(' · '))));
  ui.environmentSelect.value = environmentId || '';
  const runId = state.run?.id || ui.runSelect.value;
  ui.runSelect.replaceChildren(option('', 'Recorded runs'), ...(runs.runs || []).map(item => option(item.id, runLine(item))));
  ui.runSelect.value = runId || '';
}
async function save() {
  let spec;
  try { spec = JSON.parse(ui.specEditor.value); } catch (error) { throw new Error(`The definition is not valid JSON: ${error.message}`); }
  const enteredBrief = brief();
  // Editing JSON saves that definition; a description that was not built must not become its build record.
  const definitionBrief = state.artifact && state.briefSnapshot ? JSON.parse(state.briefSnapshot) : enteredBrief;
  state.pending = true;
  controls();
  try {
    const saved = await api('environments', { spec, ...(definitionBrief.description ? { brief: definitionBrief } : {}) });
    loadArtifact(saved, { useBrief: false });
    state.briefSnapshot = JSON.stringify(definitionBrief);
    await refreshLibraries();
    message(`Saved “${saved.spec.title}”. It is ready to simulate.`);
    return saved;
  } finally {
    state.pending = false;
    controls();
  }
}

// ---------- building and running: the dashboard's progress steps, with a way to cancel ----------
function showJob(steps, at, note) {
  ui.jobSteps.replaceChildren(...steps.map((label, index) => {
    const li = el('li', '', index < at ? 'done' : index === at ? 'now' : '');
    li.append(el('i'), el('span', label));
    return li;
  }));
  ui.jobText.textContent = note || '';
  ui.jobPanel.hidden = false;
}
function describeProgress(job) {
  if (job.status === 'queued') return 'Waiting to start.';
  const progress = job.progress;
  if (typeof progress === 'string') return progress;
  if (progress?.tick !== undefined) return `Tick ${progress.tick} of ${progress.ticks}. ${plural(progress.decisions ?? 0, 'choice')} made, ${plural(progress.completedActions ?? 0, 'action')} done.`;
  if (progress?.message) return progress.message;
  if (progress?.stage) return `${sentence(progress.stage)}${progress.attempt ? `, try ${progress.attempt}` : ''}`;
  if (job.type !== 'run') return `${builderName(job.backend || ui.backend.value)} is writing your environment and checking it. This can take a few minutes.`;
  return job.provider === 'jev' ? 'Jev decides for every person. This can take a few minutes.' : 'The rule model decides for every person. This takes a few seconds.';
}
async function followJob(job) {
  clearTimeout(state.poll);
  state.job = job;
  showEmpty();
  setDrawer(false);
  const running = job.type === 'run';
  const steps = running ? [...(state.chained ? ['Building the environment'] : []), 'Running the simulation', 'Opening the replay']
    : ['Building the environment', ...(state.autoRun ? ['Running the simulation', 'Opening the replay'] : ['Opening the definition'])];
  const at = running && state.chained ? 1 : 0;
  showJob(steps, at, describeProgress(job));
  ui.cancelBtn.disabled = false;
  ui.jobProgress.hidden = true;
  controls();
  const poll = async () => {
    if (!state.job || state.job.id !== job.id) return;
    try {
      const current = await api(`environment-jobs/${enc(job.id)}`);
      if (!state.job || state.job.id !== job.id) return;
      state.job = { ...job, ...current };
      ui.jobText.textContent = describeProgress(state.job);
      const progress = current.progress;
      if (progress?.ticks && progress.tick !== undefined) {
        ui.jobProgress.max = progress.ticks;
        ui.jobProgress.value = progress.tick;
        ui.jobProgress.hidden = false;
      }
      if (['done', 'error', 'cancelled'].includes(current.status)) {
        ui.cancelBtn.disabled = true;
        const chain = job.type === 'build' && current.status === 'done' && state.autoRun;
        if (current.status === 'done') showJob(steps, chain ? 1 : steps.length - 1, chain ? 'Starting the run.' : 'Opening what was recorded.');
        ui.jobProgress.hidden = true;
        await refreshLibraries();
        if (current.status === 'done') {
          if (job.type === 'build' && current.environmentId) {
            loadArtifact(await api(`environments/${enc(current.environmentId)}`));
            message('The environment is built and saved.');
            if (!state.autoRun) setDrawer(true);
          }
          if (current.runId) {
            await openRun(current.runId);
            message('The simulation is recorded. Press play, or click a dot to see what one person chose.');
          }
        } else {
          if (current.runId) await openRun(current.runId);
          message(current.status === 'cancelled' ? 'Cancelled. A run that was stopped part way is kept in the record.'
            : current.error || (running ? 'The simulation could not run.' : 'The environment could not be built.'), current.status === 'error');
        }
        state.job = null;
        state.autoRun = false;
        showEmpty();
        if (!chain) {
          ui.jobPanel.hidden = true;
          controls();
          return;
        }
        // Simulate from a description: the build is done, now the run. The steps stay on screen in between.
        controls();
        state.chained = true;
        try { await startRun(); } catch (error) { message(error.message, true); setDrawer(true); }
        state.chained = false;
        if (!state.job) ui.jobPanel.hidden = true;
      } else state.poll = setTimeout(poll, 700);
    } catch (error) {
      // Keep the job and the Cancel button in reach when one status check fails.
      ui.jobText.textContent = `The status could not be read: ${error.message}. Trying again.`;
      state.poll = setTimeout(poll, 2500);
    }
  };
  await poll();
}

// ---------- a recorded run ----------
async function openRun(id) {
  const opening = ++state.opening;
  const record = await api(`environment-runs/${enc(id)}`);
  if (opening !== state.opening) return;
  pause();
  loadArtifact({ id: record.environmentId, spec: record.spec, brief: record.brief, builder: record.builder, warnings: record.warnings || [] });
  state.preview = null;
  state.run = record; state.frame = 0; state.agentId = '';
  const result = record.result || {}, stats = result.providerStats || {};
  state.names = new Map((result.agents || []).map(agent => [agent.id, agent.name || agent.id]));
  // "Decisions by" is not taken from the record: it stays Jev when the server has a key, or what was picked here.
  // The seed is, so that running again repeats the run; the request limit only means something on a Jev run.
  ui.seed.value = record.seed;
  if (record.provider === 'jev' && Number.isFinite(record.maxRequests)) ui.maxRequests.value = record.maxRequests;
  ui.runSelect.value = record.id;
  ui.replayEmpty.hidden = true;
  ui.timeline.hidden = false;
  ui.mapTools.hidden = false;
  ui.legendMini.hidden = false;
  setDrawer(false);
  ui.map.hidden = false;
  renderer.resize();
  renderer.setRun(record.spec, result);

  // Who decided, said plainly: Jev, the rule model, or both when Jev did not always answer.
  const jev = record.provider === 'jev';
  const decisions = stats.decisions || result.decisions?.length || stats.requests || 0, fallbacks = jev ? stats.fallbacks || 0 : 0;
  const mixed = `The rule model made ${number(fallbacks)} of ${plural(decisions, 'decision')} because Jev did not answer.`;
  state.who = {
    badge: !jev ? 'Rule model' : fallbacks ? 'Jev and rule model' : 'Jev',
    title: !jev ? 'The people in this run follow the engine\'s fixed rules. No Jev decisions.' : fallbacks ? mixed : 'Every decision in this run came from Jev.'
  };
  ui.runTitle.textContent = record.title || record.spec.title;
  const question = record.brief?.objectives || record.spec.description || '';
  const sub = record.status === 'cancelled' ? 'This run was stopped early, so what you see is only part of it.'
    : record.status !== 'done' ? 'This run did not finish, so what you see is only part of it.'
      : fallbacks / Math.max(1, decisions) > 0.2 ? mixed : question;
  ui.runMeta.textContent = sub;
  ui.runMeta.title = sub;

  // Everything technical about the run goes in the drawer.
  const warnings = [...(record.warnings || [])];
  if (record.status !== 'done') warnings.push('This record is not complete, so the results may be partial.');
  if (fallbacks) warnings.push(mixed);
  if (record.error) warnings.push(record.error);
  ui.runWarning.replaceChildren(...warnings.map(line => el('p', line, 'warn')));
  if (!jev) ui.runWarning.append(el('p', 'The rule model made this run. It picks actions by the weights in the definition and does not read the guidelines.', 'note'));
  ui.runWarning.hidden = !ui.runWarning.childElementCount;
  ui.runFacts.replaceChildren(...[
    ['Decisions by', jev ? `Jev, ${stats.model || 'model not recorded'}` : 'The engine\'s rule model (not Jev)'],
    ['Status', STATUS_WORDS[record.status] || record.status],
    ['Recorded', when(record.createdAt)],
    ['People', number((result.agents || []).length)],
    ['Run id', record.id],
    ['Seed', String(record.seed ?? 'n/a')],
    ['Decisions recorded', number((result.decisions || []).length)],
    ['Jev requests', number(jev ? stats.requests ?? 0 : 0)],
    ['Fell back to rules', jev && decisions ? `${((fallbacks / decisions) * 100).toFixed(1)}%` : '0%']
  ].flatMap(([term, value]) => [el('dt', term), el('dd', value)]));
  ui.runDetails.hidden = false;

  const custom = result.metrics?.custom || [];
  ui.resultsBlock.hidden = !custom.length;
  ui.results.replaceChildren(...custom.map(metric => {
    const row = el('tr'), label = el('th', metric.label);
    label.scope = 'row';
    row.append(label, el('td', number(metric.value)));
    return row;
  }));
  ui.agentSelect.replaceChildren(option('', 'Choose a person'), ...(result.agents || []).map(agent => option(agent.id, agent.name || agent.id)));
  renderFilters();
  setTimeline();
  ui.timeline.querySelector('#playBtn').disabled = !(result.frames?.length > 1);
  ui.timeline.querySelector('#scrub').disabled = !(result.frames?.length > 1);
  if (state.download) URL.revokeObjectURL(state.download);
  state.download = URL.createObjectURL(new Blob([stringify(record)], { type: 'application/json' }));
  ui.downloadRun.href = state.download;
  ui.downloadRun.download = `${record.id}.json`;
  history.replaceState(null, '', `#run=${enc(record.id)}`);
  controls();
  renderFrame();
}
function currentFrame() { return state.run?.result?.frames?.[state.frame]; }

// Replace a list's rows and keep keyboard focus on the row at the same position (rows are rebuilt as time moves).
function swap(root, nodes) {
  const active = document.activeElement;
  const index = active && root.contains(active) ? [...root.children].findIndex(child => child === active || child.contains(active)) : -1;
  root.replaceChildren(...nodes);
  if (index < 0) return;
  const child = root.children[Math.min(index, root.children.length - 1)];
  (child?.matches('button') ? child : child?.querySelector('button'))?.focus();
}
function renderFilters() {
  swap(ui.feedFilters, KINDS.map(([id, label]) => {
    const b = button('', '', () => {
      state.filters[id] = !state.filters[id];
      if (!Object.values(state.filters).some(Boolean)) state.filters[id] = true;
      renderFilters();
      renderFrame();
    });
    b.setAttribute('aria-pressed', String(state.filters[id]));
    b.append(el('i', '', `glyph ${id}`), document.createTextNode(label));
    return b;
  }));
}
function eventWords(event) {
  const who = event.agentId ? nameOf(event.agentId) : 'The environment';
  const verb = { started: 'started', completed: 'finished', blocked: 'could not start', rejected: 'could not finish' }[event.type] || event.type;
  return event.action ? `${who} ${verb}: ${actionLabel(event.action)}` : `${who} ${verb}`;
}
function renderFrame() {
  const frame = currentFrame();
  if (!frame) {
    if (state.preview) renderer.draw(state.preview, drawOptions());
    else if (state.run) {
      // A record with nothing to replay (it stopped before the first tick).
      ui.metrics.replaceChildren();
      ui.resources.replaceChildren(el('li', 'Nothing was recorded.', 'empty-row'));
      ui.events.replaceChildren(el('li', 'Nothing was recorded.', 'empty-row'));
      ui.worldState.textContent = '';
      showSide();
    }
    return;
  }
  updateTimeline();
  renderer.draw(frame, drawOptions());
  const soFar = (state.run.result.events || []).filter(event => event.tick <= frame.tick);

  // Four figures in one row, as on the dashboard. Where people arrive over time, the first counts who is here.
  const arriving = (state.run.spec.roles || []).some(role => role.arrive);
  ui.metrics.replaceChildren(...[
    [frame.agents.length, arriving ? 'People here' : 'People', arriving ? 'People who have arrived so far.' : ''],
    [soFar.filter(event => event.type === 'completed').length, 'Actions done', 'Actions finished so far.'],
    [frame.agents.filter(agent => agent.status === 'terminal').length, 'Finished', 'People who have reached the end of their work.'],
    [soFar.filter(event => event.type === 'blocked').length, 'Blocked', 'Times someone chose an action and could not start it, so far.']
  ].map(([value, label, title]) => {
    const fig = el('div', '', 'fig');
    if (title) fig.title = title;
    fig.append(el('b', number(value)), el('span', label));
    return fig;
  }));

  ui.worldState.textContent = stringify(frame.world);
  const resources = frame.resources || [];
  ui.resources.replaceChildren(...resources.map(resource => {
    const li = el('li'), row = el('div', '', 'res'), bar = el('span', '', 'bar'), fill = el('i', '', 'wait');
    fill.style.width = `${Math.min(100, (resource.used / Math.max(1, resource.capacity)) * 100)}%`;
    bar.setAttribute('aria-hidden', 'true');
    bar.append(fill);
    row.append(el('span', resource.name || resource.id, 'name'), el('span', `${number(resource.used)} of ${number(resource.capacity)} in use`, 'val'), bar);
    li.append(row);
    return li;
  }));
  if (!resources.length) ui.resources.append(el('li', 'This environment has no shared resources.', 'empty-row'));

  // Newest first. A row opens the person it is about.
  const events = soFar.filter(event => state.filters[kindOf(event)]).slice(-80).reverse();
  swap(ui.events, events.map(event => {
    const li = el('li'), text = el('span', eventWords(event), 'txt');
    if (event.reason) text.append(el('span', sentence(event.reason), 'where'));
    const parts = [el('i', '', `glyph ${kindOf(event)}`), text, el('time', `Tick ${event.tick}`)];
    const row = event.agentId && state.names.has(event.agentId) ? button('row', '', () => selectAgent(event.agentId, { focus: true })) : el('div', '', 'still');
    row.append(...parts);
    li.append(row);
    return li;
  }));
  if (!events.length) ui.events.append(el('li', soFar.length ? 'Nothing yet with these filters.' : 'Nothing has happened yet. Press play or drag the slider.', 'empty-row'));
  renderAgent();
}

// ---------- one person: takes the place of the lists, as on the dashboard ----------
const BACK_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function selectAgent(id, { focus = false } = {}) {
  const had = ui.inspector.contains(document.activeElement);
  state.agentId = id || '';
  ui.agentSelect.value = state.agentId;
  renderFrame();
  if (focus && state.agentId) ui.inspector.querySelector('.back')?.focus();
  else if (!state.agentId && had) ui.agentSelect.focus();
}
function probRow(label, probability, picked) {
  const row = el('div', '', `prob${picked ? ' picked' : ''}`);
  row.append(el('span', picked ? `${label} (chosen)` : label, 'lab'), el('span', Number.isFinite(probability) ? `${Math.round(probability * 100)}%` : '', 'pct'));
  if (Number.isFinite(probability)) {
    const bar = el('span', '', 'pbar'), fill = el('i');
    fill.style.width = `${Math.max(1, probability * 100)}%`;
    bar.append(fill);
    row.append(bar);
  }
  return row;
}
let inspectorKey = '';
function renderAgent() {
  if (!showSide()) { inspectorKey = ''; ui.inspector.replaceChildren(); return; }
  const run = state.run, frame = currentFrame();
  // Rebuilt only when the person or the tick changes, so an opened detail stays open.
  const key = `${run.id}|${state.agentId}|${frame.tick}`;
  if (key === inspectorKey) return;
  inspectorKey = key;
  const keepFocus = ui.inspector.contains(document.activeElement) && document.activeElement.classList.contains('back');
  const agent = run.result.agents.find(entry => entry.id === state.agentId);
  const now = frame.agents.find(entry => entry.id === agent.id), role = state.roles.get(agent.role);

  const back = button('btn quiet small back', '', () => selectAgent(''));
  back.innerHTML = BACK_ICON;
  back.append(document.createTextNode('Back to activity'));

  const head = el('div', '', 'insp-head');
  head.append(el('h2', agent.name || agent.id), el('p', role?.name || stepName(agent.role), 'who'));
  const where = now ? stepName(now.state) : '';
  // Idle is between actions, busy is in the middle of one, finished is at a step with nothing left to do.
  head.append(el('p', !now ? (agent.arrivesAt > frame.tick ? `Arrives at tick ${agent.arrivesAt}` : 'Not here at this tick')
    : now.status === 'terminal' ? 'Finished' : now.status === 'running' ? `Busy: ${actionLabel(now.action)}` : 'Idle', 'state'));

  const facts = el('dl', '', 'persona');
  for (const [term, value] of [['Wants', agent.goal || role?.goal], ['Step', where]]) {
    if (value) facts.append(el('dt', term), el('dd', value));
  }

  const decisions = (run.result.decisions || []).filter(decision => decision.agentId === agent.id && decision.t <= frame.tick);
  const list = el('div');
  list.append(decisions.length ? el('h3', `Their choices (${decisions.length})`, 'insp-sec') : el('p', 'This person has made no choices up to this tick.', 'hint insp-note'));
  for (const decision of decisions.slice(-50).reverse()) {
    const item = el('div', '', 'dec-item'), top = el('div', '', 'dh');
    top.append(el('span', `Tick ${decision.t}`), el('span', decidedBy(decision.decision?.provider || run.provider)));
    item.append(top, el('p', 'What next?', 'qq'));
    const picked = decision.applied?.action ?? decision.decision?.action ?? null;
    const odds = decision.decision?.choiceProbs || decision.decision?.probabilities || {};
    const options = [...(decision.options || [])].sort((a, b) => (odds[b.key] ?? -1) - (odds[a.key] ?? -1));
    for (const choice of options) item.append(probRow(choice.label || choice.key, odds[choice.key], choice.key === picked));
    const outcome = !picked ? 'Did nothing this tick.' : decision.applied?.accepted ? 'Started it.'
      : `Could not start it${decision.applied?.reason ? `: ${decision.applied.reason}` : ''}.`;
    item.append(el('p', outcome, 'dec-notes'));
    const told = el('details');
    told.append(el('summary', 'What this person was told'), el('pre', stringify(decision.observation)));
    item.append(told);
    list.append(item);
  }
  ui.inspector.replaceChildren(back, head, facts, list);
  if (keepFocus) back.focus();
}

// ---------- start a build or a run ----------
async function startBuild(autoRun = false) {
  if (!state.ready || state.job || state.pending) return;
  if (!ui.description.value.trim()) {
    setDrawer(true);
    ui.description.focus();
    throw new Error('Describe what you want to simulate first.');
  }
  state.autoRun = autoRun;
  state.pending = true;
  controls();
  message();
  const backend = ui.backend.value;
  try {
    const job = await api('environment-builds', { brief: brief(), backend, ...(ui.model.value.trim() ? { model: ui.model.value.trim() } : {}) });
    state.pending = false;
    await followJob({ ...job, type: 'build', backend });
  } catch (error) {
    state.autoRun = false;
    throw error;
  } finally {
    state.pending = false;
    controls();
  }
}
async function startRun() {
  if (!state.ready || state.job || state.pending || !state.artifact?.id || state.dirty) return;
  for (const input of [ui.seed, ui.maxRequests]) if (!input.reportValidity()) { setDrawer(true); return; }
  state.pending = true;
  controls();
  message();
  const provider = ui.provider.value;
  try {
    const job = await api('environment-runs', { environmentId: state.artifact.id, provider, seed: Number(ui.seed.value), maxRequests: Number(ui.maxRequests.value) });
    state.pending = false;
    await followJob({ ...job, type: 'run', provider });
  } finally {
    state.pending = false;
    controls();
  }
}
function chooseExample(example) {
  if (!example || state.job || state.pending || !state.ready) return;
  loadArtifact({ spec: example.spec, source: 'example', warnings: [] });
  ui.exampleSelect.value = example.id;
  setDrawer(true);
  ui.environmentDrawer.querySelector('.drawer-body').scrollTop = 0;
  message('Example loaded. Check its rules, then press Simulate.');
}

ui.briefForm.addEventListener('submit', event => { event.preventDefault(); safely(() => startBuild(false))(); });
ui.askForm.addEventListener('submit', event => {
  event.preventDefault();
  safely(async () => {
    if (state.job || state.pending || !state.ready) return;
    const prompt = ui.askIn.value.trim();
    if (prompt) ui.description.value = prompt;
    const changedBrief = JSON.stringify(brief()) !== state.briefSnapshot;
    if (state.artifact && !changedBrief) {
      if (state.dirty || !state.artifact.id) await save();
      await startRun();
    } else await startBuild(true);
  })();
});
ui.saveBtn.addEventListener('click', safely(save));
ui.runBtn.addEventListener('click', safely(startRun));
ui.environmentBtn.addEventListener('click', () => setDrawer(ui.environmentDrawer.hidden));
ui.editEnvironmentBtn.addEventListener('click', () => setDrawer(true));
ui.drawerClose.addEventListener('click', () => setDrawer(false));
ui.description.addEventListener('input', () => { ui.askIn.value = ui.description.value; });
for (const input of [ui.description, ui.objectives, ui.guidelines, ui.constraints]) input.addEventListener('input', controls);
ui.cancelBtn.addEventListener('click', safely(async () => {
  if (!state.job) return;
  ui.cancelBtn.disabled = true;
  try {
    await api(`environment-jobs/${enc(state.job.id)}/cancel`, {});
    ui.jobText.textContent = 'Cancelling.';
  } catch (error) {
    ui.cancelBtn.disabled = false;
    throw error;
  }
}));
ui.specEditor.addEventListener('input', () => { state.dirty = true; controls(); });
ui.environmentSelect.addEventListener('change', safely(async () => {
  if (!ui.environmentSelect.value) return;
  const id = ui.environmentSelect.value;
  const artifact = await api(`environments/${enc(id)}`);
  if (ui.environmentSelect.value === id) { loadArtifact(artifact); message(); }
}));
ui.exampleSelect.addEventListener('change', () => chooseExample(state.examples.find(example => example.id === ui.exampleSelect.value)));
ui.refreshBtn.addEventListener('click', safely(refreshLibraries));
ui.runSelect.addEventListener('change', safely(async () => { if (ui.runSelect.value) { message(); await openRun(ui.runSelect.value); } }));
ui.provider.addEventListener('change', controls);
ui.backend.addEventListener('change', () => {
  const selected = builderSelection.select(ui.backend.value, ui.model.value);
  ui.model.value = selected.model;
  controls();
});
ui.agentSelect.addEventListener('change', () => selectAgent(ui.agentSelect.value, { focus: true }));

// The keyboard, as on the dashboard: Escape closes what is open, Space plays, the arrow keys step one tick.
document.addEventListener('keydown', e => {
  const target = e.target instanceof Element ? e.target : document.body;
  if (e.key === 'Escape') {
    if (!ui.viewMenu.hidden) { setViewMenu(false); ui.viewBtn.focus(); }
    else if (!ui.environmentDrawer.hidden) setDrawer(false);
    else if (state.agentId) selectAgent('');
    else if (!ui.notice.hidden) message();
    return;
  }
  if (!state.run || !ui.environmentDrawer.hidden || target.closest('input:not([type="range"]), select, textarea, summary')) return;
  if (e.key === ' ') {
    if (target.closest('button, a')) return;
    e.preventDefault();
    state.playing ? pause() : play();
  } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && target !== ui.map && !target.closest('input[type="range"]')) {
    // On the map the arrow keys move between people, and the slider steps itself.
    e.preventDefault();
    pause();
    const last = (state.run.result?.frames?.length || 1) - 1;
    state.frame = Math.max(0, Math.min(last, state.frame + (e.key === 'ArrowRight' ? 1 : -1)));
    renderFrame();
  }
});
window.addEventListener('pagehide', () => {
  pause();
  clearTimeout(state.poll);
  if (state.download) URL.revokeObjectURL(state.download);
  renderer.destroy();
});

// ---------- start ----------
// The language button, wired as on the dashboard: what is drawn on the canvases is drawn again in the new language.
applyTheme();
renderLegend();

await safely(async () => {
  controls();
  state.health = await api('health');
  if (!state.health.capabilities?.environments) {
    message('This server is an older version and cannot run environments. Restart it, then reload this page.', true);
    ui.examples.replaceChildren(el('li', 'Restart the server to load the examples.', 'empty-row'));
    return;
  }
  state.ready = true;
  // Jev decides when the server has a Jev key. Without one, the rule model does.
  ui.provider.value = state.health.jev ? 'jev' : 'rules';
  const results = await Promise.allSettled([api('environment-examples'), refreshLibraries()]);
  if (results[0].status === 'fulfilled') {
    state.examples = results[0].value.examples || [];
    ui.exampleSelect.replaceChildren(option('', 'Choose an example'), ...state.examples.map(example => option(example.id, example.title)));
    ui.examples.replaceChildren(...state.examples.map(example => {
      const li = el('li');
      const row = button('row', '', () => {
        if (state.job || state.pending) { message('Wait for the current build or run to finish, or cancel it first.'); return; }
        chooseExample(example);
      });
      const spec = example.spec || {};
      row.append(el('span', example.title, 'name'), el('span', `${plural(peopleIn(spec), 'person', 'people')}, ${plural((spec.roles || []).length, 'role')}, ${plural(spec.ticks, 'tick')}`, 'val'));
      li.append(row);
      return li;
    }));
    if (!state.examples.length) ui.examples.replaceChildren(el('li', 'There are no examples on this server.', 'empty-row'));
  } else ui.examples.replaceChildren(el('li', 'The examples could not be loaded.', 'empty-row'));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) message(failures.map(result => result.reason.message).join('\n'), true);
  controls();
  const match = location.hash.match(/^#run=(.+)$/);
  if (match) await openRun(decodeURIComponent(match[1]));
})();
