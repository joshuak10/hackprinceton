// Generalist Studio: data-only environment editing and recorded workflow playback.
// All generated/user content enters the DOM as text; no generated markup or code is executed.
const $ = id => document.getElementById(id);
const ui = Object.fromEntries([
  'examples', 'status', 'jobPanel', 'jobType', 'jobText', 'jobProgress', 'cancelBtn', 'briefForm',
  'description', 'objectives', 'guidelines', 'constraints', 'backend', 'model', 'builderHelp', 'buildBtn',
  'environmentSelect', 'refreshBtn', 'modelEmpty', 'modelOverview', 'environmentTitle', 'environmentDescription',
  'modelNumbers', 'definitionDetails', 'assumptions', 'warnings', 'specEditor', 'editorDetails', 'saveBtn', 'saveNote',
  'savedTag', 'provider', 'seed', 'maxRequests', 'providerHelp', 'runBtn', 'runSelect', 'replayEmpty',
  'replayContent', 'runTitle', 'runMeta', 'downloadRun', 'runWarning', 'metrics', 'playBtn', 'scrubber',
  'tickLabel', 'roleFilter', 'resources', 'workflow', 'agentSelect', 'agentInfo', 'decisions', 'events', 'worldState'
].map(id => [id, $(id)]));
const state = { artifact: null, dirty: false, run: null, job: null, poll: null, playing: null, health: null, agentId: '', frame: 0, download: null, opening: 0 };
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
}
function controls() {
  const busy = Boolean(state.job);
  ui.buildBtn.disabled = busy;
  ui.saveBtn.disabled = busy || !ui.specEditor.value.trim();
  ui.runBtn.disabled = busy || !state.artifact?.id || state.dirty;
  ui.environmentSelect.disabled = busy;
  ui.backend.disabled = busy;
  ui.savedTag.textContent = state.dirty ? 'Unsaved changes' : state.artifact?.id ? 'Saved' : state.artifact ? 'Example' : 'No model';
  ui.savedTag.classList.toggle('saved', Boolean(state.artifact?.id) && !state.dirty);
  ui.saveNote.textContent = state.dirty ? 'Save this version before running.' : state.artifact?.id ? 'This version is ready to run.' : state.artifact ? 'Save the example to run it.' : 'Paste JSON or choose an example.';
  ui.maxRequests.disabled = ui.provider.value !== 'jev' || busy;
  ui.providerHelp.textContent = ui.provider.value === 'jev'
    ? `${state.health?.jev ? 'Jev is configured.' : 'Requires TYPESAFE_API_KEY in .env.local.'} Starts live API requests up to your budget. Any fallback decisions are labeled in the record.`
    : 'Rules sample the action weights in your definition. They do not interpret prose guidelines.';
  ui.builderHelp.textContent = ui.backend.value === 'claude-code'
    ? 'Uses your local Claude Code sign-in. Generated definitions are validated before they can run.'
    : `${state.health?.claude ? 'Anthropic API is configured.' : 'Requires ANTHROPIC_API_KEY in .env.local.'} Claude returns a validated environment definition.`;
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
  state.artifact = artifact; state.dirty = !artifact.id;
  ui.environmentSelect.value = artifact.id || '';
  ui.specEditor.value = stringify(artifact.spec);
  if (useBrief) fillBrief(artifact.brief || { description: artifact.spec.description, guidelines: artifact.spec.guidelines });
  const spec = artifact.spec;
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
  const saved = await api('environments', { spec, ...(enteredBrief.description ? { brief: enteredBrief } : {}) });
  loadArtifact(saved, { useBrief: false });
  await refreshLibraries(); message(`Saved “${saved.spec.title}”. Ready to simulate.`);
  return saved;
}
function describeProgress(job) {
  if (job.status === 'queued') return 'Queued. Waiting to start.';
  const progress = job.progress;
  if (typeof progress === 'string') return progress;
  if (progress?.tick !== undefined) return `Tick ${progress.tick} / ${progress.ticks} · ${number(progress.decisions)} decisions · ${number(progress.completedActions)} actions completed`;
  if (progress?.message) return progress.message;
  if (progress?.stage) return `${progress.stage}${progress.attempt ? ` · attempt ${progress.attempt}` : ''}`;
  return job.type === 'run' ? 'Running agents…' : 'Claude is building and validating your environment…';
}
async function followJob(job) {
  clearTimeout(state.poll); state.job = job;
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
          if (current.environmentId) {
            loadArtifact(await api(`environments/${enc(current.environmentId)}`));
            message('Environment built and saved. Review its assumptions and rules, then run the agents.');
          }
          if (current.runId) { await openRun(current.runId); message('Simulation recorded. Scrub through the workflow and inspect any agent.'); }
        } else {
          if (current.runId) await openRun(current.runId);
          message(current.status === 'cancelled' ? 'Operation cancelled. Any partial run remains in the record.' : current.error || 'The operation failed.', current.status === 'error');
        }
        state.job = null; controls(); ui.jobPanel.hidden = true;
      } else state.poll = setTimeout(poll, 700);
    } catch (error) {
      // Keep the active job and the cancel control accessible when polling temporarily fails.
      ui.jobText.textContent = `Status unavailable: ${error.message}. Retrying…`;
      state.poll = setTimeout(poll, 2500);
    }
  };
  await poll();
}
function pause() { clearInterval(state.playing); state.playing = null; ui.playBtn.textContent = 'Play'; }
async function openRun(id) {
  const opening = ++state.opening;
  const record = await api(`environment-runs/${enc(id)}`);
  if (opening !== state.opening) return;
  pause(); state.run = record; state.frame = 0; state.agentId = '';
  ui.runSelect.value = record.id;
  ui.replayEmpty.hidden = true; ui.replayContent.hidden = false;
  ui.runTitle.textContent = record.title || record.spec.title;
  ui.runMeta.textContent = `${record.provider} · seed ${record.seed} · ${record.status} · ${date(record.createdAt)}`;
  const result = record.result || {}, stats = result.providerStats || {}, metrics = result.metrics || {};
  const warnings = [...(record.warnings || [])];
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
  ui.scrubber.max = Math.max(0, (result.frames?.length || 1) - 1); ui.scrubber.value = 0;
  ui.playBtn.disabled = !(result.frames?.length > 1); ui.scrubber.disabled = !(result.frames?.length > 1);
  if (state.download) URL.revokeObjectURL(state.download);
  state.download = URL.createObjectURL(new Blob([stringify(record)], { type: 'application/json' }));
  ui.downloadRun.href = state.download; ui.downloadRun.download = `${record.id}.json`;
  history.replaceState(null, '', `#run=${enc(record.id)}`);
  renderFrame(); renderAgent();
}
function currentFrame() { return state.run?.result?.frames?.[state.frame]; }
function renderFrame() {
  const frame = currentFrame();
  if (!frame) { ui.workflow.replaceChildren(el('p', 'No frames were recorded.', 'help')); return; }
  ui.scrubber.value = state.frame;
  ui.tickLabel.textContent = `Tick ${frame.tick} / ${state.run.spec.ticks}`;
  ui.worldState.textContent = stringify(frame.world);
  ui.resources.replaceChildren(...(frame.resources || []).map(resource => {
    const node = el('div', '', 'resource-chip'), label = el('div', '', 'resource-label'), bar = el('progress');
    label.append(el('span', resource.name || resource.id), el('span', `${resource.used} / ${resource.capacity}`));
    bar.max = Math.max(1, resource.capacity); bar.value = resource.used;
    bar.setAttribute('aria-label', `${resource.name || resource.id}: ${resource.used} of ${resource.capacity} reserved`);
    node.append(label, bar); return node;
  }));
  const chosen = frame.agents.filter(agent => !ui.roleFilter.value || agent.role === ui.roleFilter.value);
  const states = [...new Set([
    ...(state.run.spec.roles || []).filter(role => !ui.roleFilter.value || role.id === ui.roleFilter.value).map(role => role.initialState),
    ...(state.run.spec.actions || []).filter(action => !ui.roleFilter.value || !action.roles?.length || action.roles.includes(ui.roleFilter.value)).flatMap(action => [...action.from, action.to])
  ])];
  ui.workflow.replaceChildren(...states.map(name => {
    const agents = chosen.filter(agent => agent.state === name), lane = el('div', '', 'state-lane'), heading = el('div', '', 'state-heading');
    heading.append(el('span', name), el('b', agents.length)); lane.append(heading);
    const grid = el('div', '', 'agent-grid');
    for (const agent of agents.slice(0, 100)) {
      const dot = el('button', agent.id.split('_').at(-1), `agent-dot ${agent.status}${agent.id === state.agentId ? ' selected' : ''}`);
      dot.type = 'button'; dot.title = `${agent.id} · ${agent.status}${agent.action ? ` · ${agent.action}` : ''}`;
      dot.setAttribute('aria-label', dot.title); dot.setAttribute('aria-pressed', agent.id === state.agentId ? 'true' : 'false');
      dot.addEventListener('click', () => { state.agentId = agent.id; ui.agentSelect.value = agent.id; renderFrame(); renderAgent(); }); grid.append(dot);
    }
    if (agents.length > 100) grid.append(el('span', `+${agents.length - 100} more · choose an agent below`, 'agent-overflow'));
    lane.append(grid); return lane;
  }));
  const events = (state.run.result.events || []).filter(event => event.tick <= frame.tick).slice(-80).reverse();
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

ui.briefForm.addEventListener('submit', event => {
  event.preventDefault();
  safely(async () => {
    if (!ui.briefForm.reportValidity()) return;
    message();
    const job = await api('environment-builds', { brief: brief(), backend: ui.backend.value, ...(ui.model.value.trim() ? { model: ui.model.value.trim() } : {}) });
    await followJob({ ...job, type: 'build' });
  })();
});
ui.saveBtn.addEventListener('click', safely(save));
ui.runBtn.addEventListener('click', safely(async () => {
  if (!state.artifact?.id || state.dirty) return;
  for (const input of [ui.seed, ui.maxRequests]) if (!input.reportValidity()) return;
  message();
  const job = await api('environment-runs', { environmentId: state.artifact.id, provider: ui.provider.value, seed: Number(ui.seed.value), maxRequests: Number(ui.maxRequests.value) });
  await followJob({ ...job, type: 'run' });
}));
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
ui.refreshBtn.addEventListener('click', safely(refreshLibraries));
ui.runSelect.addEventListener('change', safely(async () => { if (ui.runSelect.value) { message(); await openRun(ui.runSelect.value); } }));
ui.provider.addEventListener('change', controls); ui.backend.addEventListener('change', controls);
ui.scrubber.addEventListener('input', () => { pause(); state.frame = Number(ui.scrubber.value); renderFrame(); });
ui.roleFilter.addEventListener('change', renderFrame);
ui.agentSelect.addEventListener('change', () => { state.agentId = ui.agentSelect.value; renderFrame(); });
ui.playBtn.addEventListener('click', () => {
  if (state.playing) { pause(); return; }
  const last = (state.run?.result?.frames?.length || 1) - 1;
  if (state.frame >= last) state.frame = 0;
  ui.playBtn.textContent = 'Pause'; renderFrame();
  state.playing = setInterval(() => { state.frame++; renderFrame(); if (state.frame >= last) pause(); }, 350);
});
window.addEventListener('pagehide', () => { pause(); clearTimeout(state.poll); if (state.download) URL.revokeObjectURL(state.download); });

await safely(async () => {
  const results = await Promise.allSettled([api('health'), api('environment-examples'), refreshLibraries()]);
  if (results[0].status === 'fulfilled') state.health = results[0].value;
  if (results[1].status === 'fulfilled') {
    ui.examples.replaceChildren(...(results[1].value.examples || []).map(example => {
      const button = el('button', `${example.title} ↗`, 'example-button'); button.type = 'button';
      button.addEventListener('click', () => {
        if (state.job) { message('Wait for the current operation to finish or cancel it first.'); return; }
        loadArtifact({ spec: example.spec, source: 'example', warnings: [] });
        message('Example loaded. Inspect or edit it, then validate & save to run without a key.');
      }); return button;
    }));
  } else ui.examples.replaceChildren(el('span', 'Examples could not be loaded.', 'help'));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) message(failures.map(result => result.reason.message).join('\n'), true);
  controls();
  const match = location.hash.match(/^#run=(.+)$/);
  if (match) await openRun(decodeURIComponent(match[1]));
})();
