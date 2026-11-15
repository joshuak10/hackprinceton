// User-defined environments in the original Scope shell.
// All generated/user content enters the DOM as text; no generated markup or code is executed.
import { createWorkflowRenderer } from './render.js';
import { createTimeline } from '../scope/lib/timeline.js';
import { readPalette } from '../scope/lib/palette.js';
import { createBuilderSelection, builderHelp, builderName } from './builders.js';
const $ = id => document.getElementById(id);
const ui = Object.fromEntries([
  'examples', 'status', 'jobPanel', 'jobType', 'jobText', 'jobProgress', 'cancelBtn', 'briefForm',
  'description', 'objectives', 'guidelines', 'constraints', 'backend', 'model', 'builderHelp', 'buildBtn',
  'environmentSelect', 'refreshBtn', 'modelEmpty', 'modelOverview', 'environmentTitle', 'environmentDescription',
  'modelNumbers', 'definitionDetails', 'assumptions', 'warnings', 'specEditor', 'editorDetails', 'saveBtn', 'saveNote',
  'savedTag', 'provider', 'seed', 'maxRequests', 'providerHelp', 'runBtn', 'runSelect', 'replayEmpty',
  'replayContent', 'runTitle', 'runMeta', 'downloadRun', 'runWarning', 'metrics', 'playBtn',
  'roleFilter', 'resources', 'agentSelect', 'agentInfo', 'decisions', 'events', 'worldState',
  'askForm', 'askIn', 'askBtn', 'environmentDrawer', 'environmentBtn', 'drawerClose', 'themeBtn',
  'sourceBadge', 'editEnvironmentBtn', 'mapTools', 'legendMini', 'map', 'mapbox', 'timeline', 'sideEmpty',
  'colorBy', 'eventCount', 'exampleSelect'
].map(id => [id, $(id)]));
ui.scrubber = $('scrub'); ui.tickLabel = $('clock');
const builderSelection = createBuilderSelection(ui.backend.value);
const state = { artifact: null, dirty: false, run: null, job: null, poll: null, playing: null, health: null,
  ready: false, pending: false, agentId: '', frame: 0, download: null, opening: 0, speed: 1, briefSnapshot: '',
  autoRun: false, theme: 'dark', preview: null, examples: [] };
try { state.theme = new URLSearchParams(location.search).get('theme') || localStorage.getItem('scope-theme') || 'dark'; } catch {}
document.documentElement.dataset.theme = state.theme;
ui.themeBtn.setAttribute('aria-label', state.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
const renderer = createWorkflowRenderer(ui.map, { onSelect: id => { state.agentId = id; ui.agentSelect.value = id; renderFrame(); } });
const timeline = createTimeline({ root: ui.timeline, onPlay: () => state.playing ? pause() : play(),
  onSeek: tick => {
    pause();
    const frames = state.run?.result?.frames || [];
    let nearest = 0;
    for (let i = 1; i < frames.length; i++) if (Math.abs(frames[i].tick - tick) < Math.abs(frames[nearest].tick - tick)) nearest = i;
    state.frame = nearest; renderFrame();
  },
  onSpeed: speed => { const wasPlaying = Boolean(state.playing); pause(); state.speed = speed;
    ui.timeline.querySelectorAll('[data-speed]').forEach(button => { const selected = Number(button.dataset.speed) === speed; button.classList.toggle('on', selected); button.setAttribute('aria-pressed', String(selected)); });
    if (wasPlaying) play();
  }
});
new ResizeObserver(() => { if (state.run) { timeline.layout(); updateTimeline(); } }).observe(ui.mapbox);
function drawer(open) { ui.environmentDrawer.hidden = !open; ui.environmentBtn.setAttribute('aria-expanded', String(open)); }
function updateTimeline() {
  if (!state.run) return;
  const tick = currentFrame()?.tick || 0;
  timeline.update(tick, Boolean(state.playing));
  ui.tickLabel.textContent = 'Tick ' + tick;
  ui.scrubber.setAttribute('aria-valuetext', 'Tick ' + tick + ' of ' + state.run.spec.ticks);
  $('span').textContent = '0 to ' + state.run.spec.ticks + ' ticks · recorded actions';
}
function setTimeline() {
  const bins = Array.from({ length: state.run.spec.ticks + 1 }, () => ({ total: 0, decision: 0, congestion: 0, complaint: 0 }));
  for (const event of state.run.result?.events || []) {
    const bin = bins[event.tick]; if (!bin) continue;
    const category = event.type === 'completed' ? 'complaint' : event.type === 'blocked' || event.type === 'rejected' ? 'congestion' : 'decision';
    bin[category]++; bin.total++;
  }
  const palette = readPalette(); palette['i-complaint'] = palette['a-serve'];
  timeline.setRun({ duration: state.run.spec.ticks, clockStart: 0, bins, pal: palette });
  ui.scrubber.step = '1'; updateTimeline();
}
function previewDefinition(spec) {
  const agents = spec.roles.flatMap(role => Array.from({ length: role.count }, (_, index) => ({
    id: role.id + '_' + (index + 1), role: role.id, state: role.initialState, status: 'idle', action: null
  })));
  state.preview = { tick: 0, agents, world: spec.world || {}, resources: [] };
  if (!state.run) {
    ui.map.hidden = false; renderer.resize();
    renderer.setRun(spec, { agents });
    renderer.draw(state.preview, { colorBy: ui.colorBy.value, role: ui.roleFilter.value });
    ui.replayEmpty.hidden = true; ui.mapTools.hidden = false; ui.legendMini.hidden = false;
    ui.runTitle.textContent = spec.title; ui.runMeta.textContent = 'Environment definition · initial states · not yet simulated';
  }
}
const number = value => Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
const enc = encodeURIComponent;
const date = value => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const stringify = value => JSON.stringify(value, null, 2);

function el(tag, text = '', className = '') {
  const node = document.createElement(tag);
  if (text !== '') node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function option(value, label) { const node = el('option', label); node.value = value; return node; }
function message(text = '', error = false) { ui.status.textContent = text; ui.status.classList.toggle('error', error); }
function safely(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(error => message(error.message || String(error), true)); }
async function api(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : {}; } catch { throw new Error(`The server returned an unreadable response (${response.status}).`); }
  if (!response.ok) {
    const details = result.errors?.length ? `\n${result.errors.join('\n')}` : '';
    throw new Error(`${result.error || `Request failed (${response.status})`}${details}`);
  }
  return result;
}
function brief() {
  return { description: ui.description.value.trim(), objectives: ui.objectives.value.trim(),
    guidelines: ui.guidelines.value.split('\n').map(line => line.trim()).filter(Boolean), constraints: ui.constraints.value.trim() };
}
function fillBrief(value = {}) {
  ui.description.value = value.description || '';
  ui.objectives.value = value.objectives || '';
  ui.guidelines.value = Array.isArray(value.guidelines) ? value.guidelines.join('\n') : value.guidelines || '';
  ui.constraints.value = value.constraints || '';
  ui.askIn.value = ui.description.value;
}
function controls() {
  const busy = Boolean(state.job) || state.pending || !state.ready;
  const briefChanged = Boolean(state.artifact) && JSON.stringify(brief()) !== state.briefSnapshot;
  ui.buildBtn.disabled = busy; ui.askBtn.disabled = busy;
  ui.saveBtn.disabled = busy || !ui.specEditor.value.trim();
  ui.runBtn.disabled = busy || !state.artifact?.id || state.dirty || briefChanged;
  ui.environmentSelect.disabled = busy;
  ui.exampleSelect.disabled = busy;
  ui.backend.disabled = busy;
  ui.refreshBtn.disabled = busy;
  if (!state.run && !state.job) ui.sourceBadge.textContent = ui.provider.value === 'jev' ? 'Jev agents' : 'Rules baseline';
  ui.savedTag.textContent = state.dirty ? 'Unsaved changes' : state.artifact?.id ? 'Saved' : state.artifact ? 'Example' : 'No model';
  ui.savedTag.classList.toggle('saved', Boolean(state.artifact?.id) && !state.dirty);
  ui.saveNote.textContent = briefChanged ? 'Brief changed. Simulate will rebuild the environment.' : state.dirty ? 'Save this version before running.' : state.artifact?.id ? 'This version is ready to run.' : state.artifact ? 'Save the example to run it.' : 'Paste JSON or choose an example.';
  ui.maxRequests.disabled = ui.provider.value !== 'jev' || busy;
  ui.providerHelp.textContent = ui.provider.value === 'jev'
    ? `${state.health?.jev ? 'Jev is configured.' : 'Requires TYPESAFE_API_KEY in .env.local.'} Starts live API requests up to your budget. Any fallback decisions are labeled in the record.`
    : 'Rules sample the action weights in your definition. They do not interpret prose guidelines.';
  ui.builderHelp.textContent = builderHelp(ui.backend.value, state.health || {});
  ui.model.placeholder = ui.backend.value === 'codex' ? 'Codex configured default' : ui.backend.value === 'claude-code' ? 'Claude configured default' : 'Default API model';
}
function disclosure(title, rows) {
  const details = el('details'); details.append(el('summary', title));
  const list = el('div', '', 'definition-list');
  for (const row of rows) {
    const item = el('div'); item.append(el('strong', row.title));
    if (row.description) item.append(el('p', row.description));
    if (row.meta) item.append(el('span', row.meta, 'small-tag'));
    list.append(item);
  }
  details.append(list); return details;
}
function loadArtifact(artifact, { useBrief = true } = {}) {
  pause(); state.run = null; state.agentId = '';
  ui.timeline.hidden = true; ui.replayContent.hidden = true; ui.sideEmpty.hidden = false;
  ui.sourceBadge.classList.remove('live');
  ui.roleFilter.replaceChildren(option('', 'All roles'), ...(artifact.spec.roles || []).map(role => option(role.id, role.name)));
  state.artifact = artifact; state.dirty = !artifact.id;
  ui.environmentSelect.value = artifact.id || '';
  ui.specEditor.value = stringify(artifact.spec);
  if (useBrief) fillBrief(artifact.brief || { description: artifact.spec.description, guidelines: artifact.spec.guidelines });
  const selectedBuilder = builderSelection.restore(artifact.builder, ui.model.value);
  ui.backend.value = selectedBuilder.backend; ui.model.value = selectedBuilder.model;
  const spec = artifact.spec;
  state.briefSnapshot = JSON.stringify(brief());
  ui.askIn.value = ui.description.value;
  previewDefinition(spec);
  ui.modelEmpty.hidden = true; ui.modelOverview.hidden = false;
  ui.environmentTitle.textContent = spec.title;
  ui.environmentDescription.textContent = spec.description;
  ui.modelNumbers.replaceChildren(...[
    [spec.roles?.reduce((sum, role) => sum + role.count, 0), 'Agents'], [spec.roles?.length, 'Roles'],
    [spec.actions?.length, 'Actions'], [spec.ticks, 'Ticks']
  ].map(([value, label]) => { const item = el('div', '', 'model-number'); item.append(el('b', number(value)), el('span', label)); return item; }));
  ui.definitionDetails.replaceChildren(
    disclosure('Roles & goals', (spec.roles || []).map(role => ({ title: role.name, description: role.goal, meta: `${role.count} agents · initial state: ${role.initialState}` }))),
    disclosure('Actions & transitions', (spec.actions || []).map(action => ({ title: action.label, description: `${(action.from || []).join(', ')} → ${action.to}`, meta: `${action.duration ?? 1} ticks · ${(action.requirements || []).length} conditions · ${(action.resources || []).length} resource claims` }))),
    disclosure('Shared resources', (spec.resources || []).length ? spec.resources.map(resource => ({ title: resource.name, meta: `Capacity ${resource.capacity}` })) : [{ title: 'No shared resources', description: 'Actions do not reserve capacity in this definition.' }]),
    disclosure('Agent guidelines', (spec.guidelines || []).length ? spec.guidelines.map(line => ({ title: line })) : [{ title: 'No additional guidelines' }])
  );
  ui.assumptions.replaceChildren(el('h4', 'Assumptions to review'));
  const assumptions = el('ul');
  for (const assumption of spec.assumptions?.length ? spec.assumptions : ['No assumptions were recorded. Review the definition before drawing conclusions.']) assumptions.append(el('li', typeof assumption === 'string' ? assumption : stringify(assumption)));
  ui.assumptions.append(assumptions);
  ui.warnings.hidden = !artifact.warnings?.length;
  ui.warnings.textContent = (artifact.warnings || []).join('\n');
  controls();
}
async function refreshLibraries() {
  const [environments, runs] = await Promise.all([api('environments'), api('environment-runs')]);
  const environmentId = state.artifact?.id || ui.environmentSelect.value;
  ui.environmentSelect.replaceChildren(option('', 'Choose a saved environment'), ...(environments.environments || []).map(item => option(item.id, `${item.title} · ${date(item.createdAt)}`)));
  ui.environmentSelect.value = environmentId || '';
  const runId = state.run?.id || ui.runSelect.value;
  ui.runSelect.replaceChildren(option('', 'Choose a recorded run'), ...(runs.runs || []).map(item => option(item.id, `${item.title} · ${item.provider} · seed ${item.seed} · ${item.status}${item.createdAt ? ` · ${date(item.createdAt)}` : ''}`)));
  ui.runSelect.value = runId || '';
}
async function save() {
  let spec;
  try { spec = JSON.parse(ui.specEditor.value); } catch (error) { throw new Error(`Definition is not valid JSON: ${error.message}`); }
  const enteredBrief = brief();
  // Editing JSON saves that definition; uncompiled prose edits must not become its build provenance.
  const definitionBrief = state.artifact && state.briefSnapshot ? JSON.parse(state.briefSnapshot) : enteredBrief;
  state.pending = true; controls();
  try {
    const saved = await api('environments', { spec, ...(definitionBrief.description ? { brief: definitionBrief } : {}) });
    loadArtifact(saved, { useBrief: false });
    state.briefSnapshot = JSON.stringify(definitionBrief);
    await refreshLibraries(); message(`Saved “${saved.spec.title}”. Ready to simulate.`);
    return saved;
  } finally { state.pending = false; controls(); }
}
function describeProgress(job) {
  if (job.status === 'queued') return 'Queued. Waiting to start.';
  const progress = job.progress;
  if (typeof progress === 'string') return progress;
  if (progress?.tick !== undefined) return `Tick ${progress.tick} / ${progress.ticks} · ${number(progress.decisions)} decisions · ${number(progress.completedActions)} actions completed`;
  if (progress?.message) return progress.message;
  if (progress?.stage) return `${progress.stage}${progress.attempt ? ` · attempt ${progress.attempt}` : ''}`;
  return job.type === 'run' ? 'Running agents…' : builderName(job.backend || ui.backend.value) + ' is building and validating your environment…';
}
async function followJob(job) {
  clearTimeout(state.poll); state.job = job; drawer(false);
  ui.jobPanel.hidden = false; ui.jobType.textContent = job.type === 'run' ? 'Simulation running' : 'Building environment';
  ui.jobText.textContent = describeProgress(job); ui.cancelBtn.disabled = false;
  ui.jobProgress.removeAttribute('value'); controls();
  const poll = async () => {
    if (!state.job || state.job.id !== job.id) return;
    try {
      const current = await api(`environment-jobs/${enc(job.id)}`);
      if (!state.job || state.job.id !== job.id) return;
      state.job = { ...job, ...current };
      ui.jobText.textContent = describeProgress(state.job);
      const progress = current.progress;
      if (progress?.ticks && progress.tick !== undefined) { ui.jobProgress.max = progress.ticks; ui.jobProgress.value = progress.tick; }
      if (['done', 'error', 'cancelled'].includes(current.status)) {
        ui.cancelBtn.disabled = true;
        ui.jobText.textContent = 'Loading the completed record…';
        await refreshLibraries();
        if (current.status === 'done') {
          if (job.type === 'build' && current.environmentId) {
            loadArtifact(await api(`environments/${enc(current.environmentId)}`));
            message('Environment built and saved.');
            if (!state.autoRun) drawer(true);
          }
          if (current.runId) { await openRun(current.runId); message('Simulation recorded. Scrub through the workflow and inspect any agent.'); }
        } else {
          if (current.runId) await openRun(current.runId);
          message(current.status === 'cancelled' ? 'Operation cancelled. Any partial run remains in the record.' : current.error || 'The operation failed.', current.status === 'error');
        }
        state.job = null; controls(); ui.jobPanel.hidden = true;
        if (job.type === 'build' && current.status === 'done' && state.autoRun) {
          state.autoRun = false;
          try { await startRun(); } catch (error) { message(error.message, true); drawer(true); }
        } else state.autoRun = false;
      } else state.poll = setTimeout(poll, 700);
    } catch (error) {
      // Keep the active job and the cancel control accessible when polling temporarily fails.
      ui.jobText.textContent = `Status unavailable: ${error.message}. Retrying…`;
      state.poll = setTimeout(poll, 2500);
    }
  };
  await poll();
}
function pause() { clearInterval(state.playing); state.playing = null; updateTimeline(); }
function play() {
  const last = (state.run?.result?.frames?.length || 1) - 1;
  if (last < 1) return;
  if (state.frame >= last) state.frame = 0;
  state.playing = setInterval(() => { state.frame++; renderFrame(); if (state.frame >= last) pause(); }, Math.max(35, 350 / state.speed));
  renderFrame();
}
async function openRun(id) {
  const opening = ++state.opening;
  const record = await api(`environment-runs/${enc(id)}`);
  if (opening !== state.opening) return;
  pause();
  loadArtifact({ id: record.environmentId, spec: record.spec, brief: record.brief,
    builder: record.builder, warnings: record.warnings || [] });
  state.preview = null;
  state.run = record; state.frame = 0; state.agentId = '';
  ui.provider.value = record.provider === 'jev' ? 'jev' : 'rules';
  ui.seed.value = record.seed;
  if (Number.isFinite(record.maxRequests)) ui.maxRequests.value = record.maxRequests;
  ui.runSelect.value = record.id;
  ui.replayEmpty.hidden = true; ui.replayContent.hidden = false; ui.sideEmpty.hidden = true;
  ui.timeline.hidden = false; ui.mapTools.hidden = false; ui.legendMini.hidden = false; drawer(false);
  ui.map.hidden = false; renderer.resize();
  renderer.setRun(record.spec, record.result || {});
  ui.runTitle.textContent = record.title || record.spec.title;
  ui.runMeta.textContent = `${record.provider} · seed ${record.seed} · ${record.status} · ${date(record.createdAt)}`;
  const result = record.result || {}, stats = result.providerStats || {}, metrics = result.metrics || {};
  const warnings = [...(record.warnings || [])];
  const fallbackRate = (stats.fallbacks || 0) / Math.max(1, stats.decisions || result.decisions?.length || stats.requests || 0);
  ui.sourceBadge.textContent = record.provider === 'jev' ? fallbackRate > .2 ? 'Heavy rules fallback' : stats.fallbacks ? 'Jev + rules fallback' : 'Jev agents' : 'Rules baseline';
  ui.sourceBadge.classList.toggle('live', record.provider === 'jev' && fallbackRate <= .2);
  ui.sourceBadge.title = record.provider === 'jev' ? String(stats.fallbacks || 0) + ' decisions fell back to rules.' : 'Offline action weights; prose guidelines are not interpreted.';
  if (record.provider === 'jev' && stats.fallbacks) ui.runMeta.textContent += fallbackRate > .2 ? ' · heavy rules fallback' : ' · mixed Jev/rules decisions';
  if (record.status !== 'done') warnings.push(`This is a ${record.status} record; results may be partial.`);
  if (record.provider === 'rules') warnings.push('Offline rules baseline: actions are sampled from declared weights. Prose guidelines do not affect this run.');
  if (stats.fallbacks) warnings.push(`${stats.fallbacks} decisions fell back to rules. This record includes mixed decision providers.`);
  if (record.error) warnings.push(record.error);
  ui.runWarning.textContent = warnings.join('\n'); ui.runWarning.hidden = !warnings.length;
  ui.metrics.replaceChildren(...[
    ['Agents', metrics.agents], ['Completed actions', metrics.completedActions], ['Terminal agents', metrics.terminalAgents],
    ['Blocked decisions', metrics.blockedDecisions], ...(metrics.custom || []).map(metric => [metric.label, metric.value])
  ].map(([label, value]) => { const node = el('div', '', 'metric'); node.append(el('b', number(value)), el('span', label)); return node; }));
  ui.roleFilter.replaceChildren(option('', 'All roles'), ...(record.spec?.roles || []).map(role => option(role.id, role.name)));
  ui.agentSelect.replaceChildren(option('', 'Choose an agent'), ...(result.agents || []).map(agent => option(agent.id, agent.name || agent.id)));
  setTimeline();
  ui.playBtn.disabled = !(result.frames?.length > 1); ui.scrubber.disabled = !(result.frames?.length > 1);
  if (state.download) URL.revokeObjectURL(state.download);
  state.download = URL.createObjectURL(new Blob([stringify(record)], { type: 'application/json' }));
  ui.downloadRun.href = state.download; ui.downloadRun.download = `${record.id}.json`;
  history.replaceState(null, '', `#run=${enc(record.id)}`);
  controls(); renderFrame(); renderAgent();
}
function currentFrame() { return state.run?.result?.frames?.[state.frame]; }
function renderFrame() {
  const frame = currentFrame();
  if (!frame) {
    if (state.preview) renderer.draw(state.preview, { role: ui.roleFilter.value, colorBy: ui.colorBy.value });
    else {
      ui.resources.replaceChildren(el('p', 'No recorded resource state.', 'hint'));
      ui.events.replaceChildren(el('li', 'No recorded frames.', 'hint'));
      ui.worldState.textContent = '';
      ui.eventCount.textContent = '';
    }
    return;
  }
  updateTimeline();
  renderer.draw(frame, { role: ui.roleFilter.value, selectedAgent: state.agentId, colorBy: ui.colorBy.value });
  const eventsSoFar = (state.run.result.events || []).filter(event => event.tick <= frame.tick);
  ui.metrics.replaceChildren(...[
    ['Agents', frame.agents.length],
    ['Completed actions', eventsSoFar.filter(event => event.type === 'completed').length],
    ['Finished agents', frame.agents.filter(agent => agent.status === 'terminal').length],
    ['Blocked decisions', eventsSoFar.filter(event => event.type === 'blocked').length],
    ...(state.run.result.metrics?.custom || []).map(metric => ['Final: ' + metric.label, metric.value])
  ].map(([label, value]) => { const node = el('div', '', 'metric'); node.append(el('b', number(value)), el('span', label)); return node; }));
  ui.worldState.textContent = stringify(frame.world);
  ui.resources.replaceChildren(...(frame.resources || []).map(resource => {
    const node = el('div', '', 'resource-chip'), label = el('div', '', 'resource-label'), bar = el('progress');
    label.append(el('span', resource.name || resource.id), el('span', `${resource.used} / ${resource.capacity}`));
    bar.max = Math.max(1, resource.capacity); bar.value = resource.used;
    bar.setAttribute('aria-label', `${resource.name || resource.id}: ${resource.used} of ${resource.capacity} reserved`);
    node.append(label, bar); return node;
  }));
  const events = eventsSoFar.slice(-80).reverse();
  ui.eventCount.textContent = 'through tick ' + frame.tick;
  ui.events.replaceChildren(...events.map(event => {
    const item = el('li', '', event.type), content = el('div');
    content.append(el('span', `${event.agentId || 'Environment'} · ${event.type} ${event.action || ''}`));
    if (event.reason) content.append(el('p', event.reason, 'help'));
    item.append(el('time', `t${event.tick}`), content); return item;
  }));
  if (!events.length) ui.events.append(el('li', 'No events yet.', 'help'));
  renderAgent();
}
function renderAgent() {
  const agent = state.run?.result?.agents?.find(entry => entry.id === state.agentId), frame = currentFrame();
  if (!agent || !frame) { ui.agentInfo.replaceChildren(el('p', 'Select an agent to inspect its goals and decisions.')); ui.decisions.replaceChildren(); return; }
  const snapshot = frame.agents.find(entry => entry.id === agent.id), role = state.run.spec.roles.find(entry => entry.id === agent.role);
  ui.agentInfo.replaceChildren();
  const facts = el('div', '', 'agent-facts');
  facts.append(el('strong', agent.name || agent.id), el('p', agent.goal || role?.goal || ''), el('p', `${role?.name || agent.role} · ${snapshot?.state || 'unknown'} · ${snapshot?.status || 'unknown'}${snapshot?.action ? ` · ${snapshot.action}` : ''}`, 'help'));
  ui.agentInfo.append(facts);
  const decisions = (state.run.result.decisions || []).filter(decision => decision.agentId === agent.id && decision.t <= frame.tick);
  ui.decisions.replaceChildren(...decisions.slice(-50).reverse().map(decision => {
    const node = el('details', '', 'decision'), accepted = decision.applied?.accepted;
    const title = el('summary', `t${decision.t} · ${decision.applied?.action || 'No action'} · ${accepted ? 'started' : 'blocked'}`);
    node.append(title, el('span', `Decision by ${decision.decision?.provider || state.run.provider}`, 'decision-label'));
    if (decision.applied?.reason) node.append(el('p', decision.applied.reason, 'help'));
    const choices = el('div', '', 'decision-options');
    for (const choice of decision.options || []) {
      const row = el('div', '', 'decision-option');
      const probabilities = decision.decision?.choiceProbs || decision.decision?.probabilities || {};
      const probability = probabilities[choice.key];
      row.append(el('span', choice.label || choice.key), el('span', Number.isFinite(probability) ? `${number(probability * 100)}%` : choice.key === decision.decision?.action ? 'rules choice' : '—', 'probability')); choices.append(row);
    }
    node.append(choices, el('p', 'Recorded observation and provider response', 'help'), el('pre', stringify({ observation: decision.observation, decision: decision.decision })));
    return node;
  }));
  if (!decisions.length) ui.decisions.append(el('p', 'No decisions for this agent through the selected tick.', 'help'));
}

async function startBuild(autoRun = false) {
  if (!state.ready || state.job || state.pending) return;
  if (!ui.description.value.trim()) { drawer(true); ui.description.focus(); throw new Error('Describe the environment you want to simulate.'); }
  state.autoRun = autoRun; state.pending = true; controls(); message();
  const backend = ui.backend.value;
  try {
    const job = await api('environment-builds', { brief: brief(), backend, ...(ui.model.value.trim() ? { model: ui.model.value.trim() } : {}) });
    state.pending = false;
    await followJob({ ...job, type: 'build', backend });
  } catch (error) { state.autoRun = false; throw error; }
  finally { state.pending = false; controls(); }
}
async function startRun() {
  if (!state.ready || state.job || state.pending || !state.artifact?.id || state.dirty) return;
  for (const input of [ui.seed, ui.maxRequests]) if (!input.reportValidity()) { drawer(true); return; }
  state.pending = true; controls(); message();
  try {
    const job = await api('environment-runs', { environmentId: state.artifact.id, provider: ui.provider.value, seed: Number(ui.seed.value), maxRequests: Number(ui.maxRequests.value) });
    state.pending = false;
    await followJob({ ...job, type: 'run' });
  } finally { state.pending = false; controls(); }
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
ui.environmentBtn.addEventListener('click', () => drawer(ui.environmentDrawer.hidden));
ui.editEnvironmentBtn.addEventListener('click', () => drawer(true));
ui.drawerClose.addEventListener('click', () => drawer(false));
ui.description.addEventListener('input', () => { ui.askIn.value = ui.description.value; });
for (const input of [ui.description, ui.objectives, ui.guidelines, ui.constraints]) input.addEventListener('input', controls);
ui.themeBtn.addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  ui.themeBtn.setAttribute('aria-label', state.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  try { localStorage.setItem('scope-theme', state.theme); } catch {}
  if (state.run) setTimeline();
  renderFrame();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') drawer(false); });
ui.cancelBtn.addEventListener('click', safely(async () => {
  if (!state.job) return;
  ui.cancelBtn.disabled = true;
  try { await api(`environment-jobs/${enc(state.job.id)}/cancel`, {}); ui.jobText.textContent = 'Cancellation requested…'; }
  catch (error) { ui.cancelBtn.disabled = false; throw error; }
}));
ui.specEditor.addEventListener('input', () => { state.dirty = true; controls(); });
ui.environmentSelect.addEventListener('change', safely(async () => {
  if (!ui.environmentSelect.value) return;
  const id = ui.environmentSelect.value;
  const artifact = await api(`environments/${enc(id)}`);
  if (ui.environmentSelect.value === id) { loadArtifact(artifact); message(); }
}));
function chooseExample(example) {
  if (!example || state.job || state.pending || !state.ready) return;
  loadArtifact({ spec: example.spec, source: 'example', warnings: [] });
  ui.exampleSelect.value = example.id;
  drawer(true); message('Example loaded. Review its rules, then press Simulate.');
}
ui.exampleSelect.addEventListener('change', () => chooseExample(state.examples.find(example => example.id === ui.exampleSelect.value)));
ui.refreshBtn.addEventListener('click', safely(refreshLibraries));
ui.runSelect.addEventListener('change', safely(async () => { if (ui.runSelect.value) { message(); await openRun(ui.runSelect.value); } }));
ui.provider.addEventListener('change', controls);
ui.backend.addEventListener('change', () => {
  const selected = builderSelection.select(ui.backend.value, ui.model.value);
  ui.model.value = selected.model;
  controls();
});
ui.roleFilter.addEventListener('change', renderFrame);
ui.colorBy.addEventListener('change', renderFrame);
ui.agentSelect.addEventListener('change', () => { state.agentId = ui.agentSelect.value; renderFrame(); });
window.addEventListener('pagehide', () => { pause(); clearTimeout(state.poll); if (state.download) URL.revokeObjectURL(state.download); renderer.destroy(); });

await safely(async () => {
  controls();
  state.health = await api('health');
  if (!state.health.capabilities?.environments) {
    message('This server is running an older version. Restart npm run serve, then reload.', true);
    ui.examples.replaceChildren(el('p', 'Restart the server to load environments.', 'hint'));
    drawer(false); return;
  }
  state.ready = true;
  ui.provider.value = state.health.jev ? 'jev' : 'rules';
  const results = await Promise.allSettled([api('environment-examples'), refreshLibraries()]);
  if (results[0].status === 'fulfilled') {
    state.examples = results[0].value.examples || [];
    ui.exampleSelect.replaceChildren(option('', 'Choose an example'), ...state.examples.map(example => option(example.id, example.title)));
    ui.examples.replaceChildren(...state.examples.map(example => {
      const button = el('button', '', 'environment-case'); button.type = 'button';
      const icon = el('span', '↗', 'case-icon'); icon.setAttribute('aria-hidden', 'true');
      button.append(icon, el('b', example.title), el('small', 'Inspect the definition · run with rules or Jev'));
      button.addEventListener('click', () => {
        if (state.job || state.pending) { message('Wait for the current operation to finish or cancel it first.'); return; }
        chooseExample(example);
      }); return button;
    }));
  } else ui.examples.replaceChildren(el('span', 'Examples could not be loaded.', 'hint'));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) message(failures.map(result => result.reason.message).join('\n'), true);
  controls();
  const match = location.hash.match(/^#run=(.+)$/);
  if (match) await openRun(decodeURIComponent(match[1]));
})();
