// Side panel: live counters, bottleneck ranking, incident feed, the person inspector, and the run-details drawer.
import { clockText } from './frames.js';
import { CATEGORIES, groupFeed } from './incidents.js';
import { providerWords, runLabel, isJev } from './verdict.js';

export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const fmt = n => Math.round(n).toLocaleString('en-US');
const button = (cls, onClick) => {
  const b = el('button', cls);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

// Replace a list's rows and keep keyboard focus on the row at the same position (rows are rebuilt as time moves).
function swap(root, nodes) {
  const a = document.activeElement;
  const idx = a && root.contains(a) ? [...root.children].findIndex(c => c === a || c.contains(a)) : -1;
  root.replaceChildren(...nodes);
  if (idx < 0) return;
  const c = root.children[Math.min(idx, root.children.length - 1)];
  (c?.matches('button') ? c : c?.querySelector('button'))?.focus();
}

// Four figures in one row. "Visits served" counts counter visits, so it can be higher than the number of people.
// In a place with seats (st.seated, the sushi restaurant) each person sits once, so the figure is people seated.
export function renderCounters(root, st) {
  const f = st.frame;
  if (!f) { root.replaceChildren(); return; }
  const agents = st.visibleAgents || [];
  let items;
  if (st.geometry.kind === 'lot') {
    const cars = agents.filter(a => a.s !== 0 && a.s !== 4).length;
    const total = st.geometry.lot.stalls.length;
    items = [
      [fmt(cars), 'Cars moving'], [`${fmt(f.c.free ?? 0)} of ${total}`, 'Spaces free'],
      [fmt(f.c.inside ?? 0), 'Shopping inside'], [fmt(f.c.abandoned), 'Shoppers lost']
    ];
  } else {
    const inLine = agents.filter(a => a.s === 1).length;
    items = [
      [fmt(f.c.active), 'People inside'],
      [fmt(inLine), 'In a line'],
      // The engine counts a person as served when they finish, so at a place with seats everyone sitting now has
      // a seat too (§18).
      st.seated
        ? [fmt(f.c.served + agents.filter(a => a.s === 2).length), 'Got a seat', 'People who have sat down so far, including those still eating. Each person sits once.']
        : [fmt(f.c.served), 'Visits served', 'Counter visits served so far. One person can be served at several counters, so this can be higher than the number of people.'],
      [fmt(f.c.abandoned), 'Walked away', 'Times someone left a line, or saw it and did not join, so far.']
    ];
  }
  root.replaceChildren(...items.map(([v, l, title]) => {
    const d = el('div', 'fig');
    if (title) d.title = title;
    d.append(el('b', null, v), el('span', null, l));
    return d;
  }));
}

// Words for a line at places that aren't counters (parking lot).
const LINE_WORDS = { entry_drive: 'cars waiting to turn in', search: 'cars circling', exit_drive: 'cars waiting to leave' };

// So far: minutes waited, plus 30 for each person lost. The bar has two parts, waiting and (in red) people lost,
// and the longest bar is the current worst place, so the bars are readable early in the run.
export function renderRank(root, st, onPick) {
  if (st.rankMode === 'now') return renderRankNow(root, st, onPick);
  const rows = st.bottlenecks.filter(r => r.score >= 0.5).slice(0, 3);
  if (!rows.length) {
    root.replaceChildren(el('li', 'empty-row', 'No waits or walk-aways yet.'));
    return;
  }
  const max = Math.max(1, ...rows.map(r => r.score));
  swap(root, rows.map(r => {
    const li = el('li');
    const b = button('row', () => onPick(r.id));
    b.append(el('span', 'name', r.name));
    b.append(el('span', 'val', `${fmt(r.waitMin)} min waited${r.lost ? `, ${r.lost} left` : ''}`));
    const bar = el('span', 'bar');
    const wait = el('i', 'wait'), lost = el('i', 'lost');
    wait.style.width = `${(r.waitMin / max) * 100}%`;
    lost.style.width = `${((30 * r.lost) / max) * 100}%`;
    bar.append(wait, lost);
    b.append(bar);
    b.title = `${fmt(r.waitMin)} minutes waited in line so far. ${r.lost} walked away; each counts as 30 minutes.`;
    li.append(b);
    return li;
  }));
}

function renderRankNow(root, st, onPick) {
  const rows = st.bottlenecksNow.filter(r => r.inLine > 0).slice(0, 3);
  if (!rows.length) {
    root.replaceChildren(el('li', 'empty-row', 'No lines at this moment.'));
    return;
  }
  const max = Math.max(1, ...rows.map(r => r.score));
  swap(root, rows.map(r => {
    const li = el('li');
    const b = button('row', () => onPick(r.id));
    b.append(el('span', 'name', r.name));
    const who = LINE_WORDS[r.id] || 'in line';
    const wait = r.waitNow != null ? `, about ${Math.max(1, Math.round(r.waitNow))} min wait` : '';
    b.append(el('span', 'val', `${r.inLine} ${who}${wait}`));
    const bar = el('span', 'bar');
    const i = el('i', 'wait');
    i.style.width = `${Math.max(2, (r.score / max) * 100)}%`;
    bar.append(i);
    b.append(bar);
    b.title = r.waitNow != null
      ? `${r.inLine} in line now. Someone joining now would wait about ${Math.round(r.waitNow)} minutes.`
      : `${r.inLine} ${who} now.`;
    li.append(b);
    return li;
  }));
}

export function renderFilters(root, st, onToggle) {
  swap(root, CATEGORIES.map(c => {
    const b = button('', () => onToggle(c.id));
    b.title = c.long;
    b.setAttribute('aria-pressed', String(!!st.filters[c.id]));
    b.append(el('i', `glyph ${c.id}`), document.createTextNode(c.label));
    return b;
  }));
}

// Newest first, repeats merged into one row with a count ("Walked away at Lucky Noodle Bar ×14").
export function renderFeed(root, st, onPick) {
  const groups = groupFeed(st.incidents, st.t, st.filters);
  if (!groups.length) {
    root.replaceChildren(el('li', 'empty-row', st.t < 1 ? 'Press play or drag the slider. Incidents appear here as they happen.' : 'Nothing yet with these filters.'));
    return;
  }
  const multiFloor = st.geometry.floors.length > 1;
  swap(root, groups.map(g => {
    const it = g.latest;
    const li = el('li');
    const b = button('row' + (st.t - it.t < 2 ? ' fresh' : '') + (st.selectedIncident?.id === it.id ? ' sel' : ''), () => onPick(it));
    b.append(el('i', `glyph ${g.cat}`));
    const txt = el('span', 'txt', g.text);
    if (g.count > 1) {
      const n = el('span', 'times', ` ×${g.count}`);
      n.setAttribute('aria-label', `, ${g.count} times`);
      txt.append(n);
    }
    if (multiFloor && (it.floor || 0) !== st.floor) txt.append(el('span', 'where', `On ${st.geometry.floors[it.floor || 0]?.label || 'another floor'}`));
    b.append(txt, el('time', null, it.clock));
    if (g.count > 1) b.title = `${g.count} times so far, most recently at ${it.clock}. Opens the most recent one.`;
    li.append(b);
    return li;
  }));
}

// ---------- inspector ----------
const STATE_WORDS = ['Walking', 'In a line', 'Being served', 'Deciding', 'Leaving', 'Driving'];

function questionFor(d, nameOf) {
  const place = nameOf(d.placeId);
  if (d.kind === 'line') return d.placeId === 'entry_drive' ? 'Turn into the lot?' : `Join the line at ${place}?`;
  if (d.kind === 'long') return d.placeId === 'search' ? 'Keep circling for a space?' : `Keep waiting at ${place}?`;
  if (d.kind === 'choose') return d.why === 'start' ? 'Where to go?' : 'What next?';
  if (d.kind === 'route') return 'Which route?';
  return 'Decision';
}

const BACK_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// One person, in place of the ranking and the feed. The verdict and the counters stay visible above it.
export function renderInspector(root, st, id, onBack) {
  const agent = st.agentsById.get(id);
  if (!agent) { root.hidden = true; return; }
  const keepFocus = root.contains(document.activeElement) && document.activeElement.classList.contains('back');
  const persona = st.personas.get(agent.personaId) || {};
  const decisions = st.decisions.filter(d => d.agentId === id);
  const nameOf = pid => st.nodeName(pid);
  const now = (st.visibleAgents || []).find(a => a.id === id);

  const back = button('btn quiet small back', onBack);
  back.innerHTML = BACK_ICON;
  back.append(document.createTextNode('Back to bottlenecks'));

  const head = el('div', 'insp-head');
  head.append(el('h2', null, agent.personaName || `Person ${id}`));
  const group = st.archNames.get(agent.archetypeId) || agent.archetypeId;
  head.append(el('p', 'who', [group, persona.age ? `${persona.age}` : null].filter(Boolean).join(', ')));
  head.append(el('p', 'state', now ? STATE_WORDS[now.s] || 'On the map' : agent.done != null && agent.done <= st.t ? `Left at ${clockText(st.clockStart, agent.done)}` : agent.born > st.t ? `Arrives at ${clockText(st.clockStart, agent.born)}` : 'Not on this floor or inside'));

  const dl = el('dl', 'persona');
  for (const [k, v] of [['About', persona.about], ['Wants', persona.wants], ['Listens to', persona.listens_to], ['Live wait app', agent.informed ? 'Yes' : 'No']]) {
    if (!v) continue;
    dl.append(el('dt', null, k), el('dd', null, v));
  }

  const trace = el('div');
  trace.append(el('h3', 'insp-sec', 'What they did'));
  const ol = el('ol', 'trace');
  for (const tr of agent.trace || []) {
    const li = el('li', tr.t > st.t ? 'future' : '');
    li.append(el('time', null, clockText(st.clockStart, tr.t)), el('span', null, tr.m.charAt(0).toUpperCase() + tr.m.slice(1)));
    ol.append(li);
  }
  trace.append(ol);

  const list = el('div');
  if (decisions.length) {
    list.append(el('h3', 'insp-sec', `Their choices (${decisions.length})`));
  } else {
    list.append(el('p', 'hint insp-note', st.decisions.length ? 'No choices were recorded for this person.'
      : 'This run used the rule model, which follows fixed rules and keeps no record of each choice. A run decided by Jev shows every choice and its odds here.'));
  }
  for (const d of decisions) {
    const box = el('div', 'dec-item' + (d.t > st.t ? ' future' : ''));
    const dh = el('div', 'dh');
    dh.append(el('span', null, clockText(st.clockStart, d.t)), el('span', null, decidedBy(d.decision)));
    box.append(dh, el('p', 'qq', questionFor(d, nameOf)));
    if (d.observation?.now) box.append(el('p', 'ctx', d.observation.now));
    const dec = d.decision || {}, ap = d.applied || {};
    if (d.asks?.yesNo && dec.yesProb != null) {
      box.append(prob('Yes', dec.yesProb, ap.yes === true), prob('No', 1 - dec.yesProb, ap.yes === false));
    } else if (dec.choiceProbs) {
      const labels = new Map((d.options || []).map(o => [o.key, o.label]));
      Object.entries(dec.choiceProbs).sort((a, b) => b[1] - a[1]).forEach(([k, p]) => box.append(prob(labels.get(k) || nameOf(k), p, ap.action === k)));
    }
    const notes = [];
    if (dec.provider === 'mock') notes.push('Sample odds');
    if (ap.frustration != null) notes.push(`Feeling ${['calm', 'mildly annoyed', 'frustrated', 'very frustrated', 'furious'][Math.max(0, Math.min(4, Math.round(ap.frustration)))]}`);
    if (ap.tell) notes.push(`Told others: ${ap.remarkKind === 'bad_service' ? 'bad experience' : ap.remarkKind === 'good_experience' ? 'good experience' : 'long wait'}`);
    if (notes.length) box.append(el('p', 'dec-notes', notes.join(' · ')));
    list.append(box);
  }

  // Rule-model runs have no choices to show, so what the person did comes first.
  root.replaceChildren(back, head, dl, ...(decisions.length ? [list, trace] : [trace, list]));
  root.hidden = false;
  if (keepFocus) back.focus();
}

function decidedBy(dec = {}) {
  switch (dec.provider) {
    case 'mock': return 'Sample decision';
    case 'jev': return 'Jev';
    case 'jev-cache': return 'Jev, repeated answer';
    case 'replay': return 'Jev, replayed';
    case 'rules-fallback': return 'Rule model (Jev did not answer)';
    default: return 'Rule model';
  }
}

function prob(label, p, picked) {
  const d = el('div', 'prob' + (picked ? ' picked' : ''));
  d.append(el('span', 'lab', picked ? `${label} (chosen)` : label), el('span', 'pct', `${Math.round(p * 100)}%`));
  const bar = el('span', 'pbar');
  const i = el('i');
  i.style.width = `${Math.max(1, p * 100)}%`;
  bar.append(i);
  d.append(bar);
  return d;
}

// ---------- drawer: everything technical lives here ----------
const PROV_LABELS = {
  rooms: 'Room outlines', walls: 'Walls', doors: 'Doors', openings: 'Doorways and openings', obstacles: 'Obstacles (mesh)', objects: 'Objects (mesh)',
  pois: 'Counters and doors', places: 'Counters', arrivals: 'How many people arrive', archetypes: 'Groups of people', minds: 'The cast',
  stalls: 'Parking stalls', lanes: 'Driving lanes', store: 'Store footprint', image: 'Aerial image', travelSpeed: 'Walking speed'
};
const PROV_WORDS = { data: 'From the scan', assumed: 'Assumed', vision: 'Read from an image', 'owner-reported': 'Reported by the owner' };

const when = iso => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? 'Today' : d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
};

// st: { bundle, decisions, geometry, runs: [{ meta, label? }], place, places: [{ label, question, href }] }.
// onPickRun(runId) opens another recorded run. `places` are the other places the display can open (?case=…).
export function renderDrawer(root, st, onPickRun) {
  const m = st.bundle.meta, ps = m.providerStats || {};
  const lat = st.decisions.map(d => d.decision?.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  const pct = q => lat.length ? `${lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]} ms` : 'n/a';
  const prov = ps.provider || m.provider;
  const mock = prov === 'mock';
  const sec = (title, rows, note) => {
    const frag = document.createDocumentFragment();
    frag.append(el('h3', null, title));
    const dl = el('dl');
    for (const [k, v] of rows) dl.append(el('dt', null, k), el('dd', null, v));
    frag.append(dl);
    if (note) frag.append(el('p', 'note', note));
    return frag;
  };
  const geo = st.geometry;
  const provenance = geo.provenance || {};

  const runsSec = document.createDocumentFragment();
  const runs = st.runs || [];
  if (runs.length) {
    runsSec.append(el('h3', null, 'Recorded runs'));
    const ol = el('ol', 'runs');
    for (const r of runs) {
      const li = el('li');
      const current = r.meta.runId === m.runId;
      const b = button('row', () => onPickRun(r.meta.runId));
      if (current) { b.setAttribute('aria-current', 'true'); b.disabled = true; }
      b.append(el('span', 'name', `${r.label || runLabel(r.meta) || 'Single run'}${current ? ' (on screen)' : ''}`));
      b.append(el('span', 'val', [providerWords(r.meta), when(r.meta.createdAt), `seed ${r.meta.seed ?? '?'}`].filter(Boolean).join(' · ')));
      li.append(b);
      ol.append(li);
    }
    runsSec.append(ol);
  }

  const placesSec = document.createDocumentFragment();
  if (st.places?.length) {
    placesSec.append(el('h3', null, 'Other places'));
    const ul = el('ul', 'runs');
    for (const p of st.places) {
      const a = el('a', 'row');
      a.href = p.href;
      a.append(el('span', 'name', p.label), el('span', 'val', p.question));
      const li = el('li');
      li.append(a);
      ul.append(li);
    }
    placesSec.append(ul);
  }

  const legend = el('div', 'legend');
  for (const [cls, text] of [['a-walk', 'Walking'], ['a-queue', 'In a line'], ['a-serve', 'Being served or staying put'], ['a-think', 'Deciding'], ['a-leave', 'Leaving']]) {
    const d = el('div'); const i = el('i'); i.style.background = `var(--${cls})`; d.append(i, document.createTextNode(text)); legend.append(d);
  }
  for (const c of CATEGORIES) { const d = el('div'); d.append(el('i', `glyph ${c.id}`), document.createTextNode(c.long)); legend.append(d); }

  const keys = el('dl', 'keys');
  for (const [k, v] of [['Space', 'Play or pause'], ['Left, Right', 'Step through time (with Shift: 10 minutes)'], ['Enter on the map', 'Pick a person; arrow keys move between people'], ['Escape', 'Close what is open']]) {
    keys.append(el('dt', null, k), el('dd', null, v));
  }
  const frag = (title, node) => { const f = document.createDocumentFragment(); f.append(el('h3', null, title), node); return f; };

  root.replaceChildren(
    sec('On screen', [
      ['Run', runLabel(m) || 'Single run, not part of a test'],
      ['Decisions by', mock ? 'Sample data generator (not Jev)' : isJev(m) ? `Jev, ${ps.model || m.model || 'model not recorded'}` : 'The engine\'s rule model (not Jev)'],
      ['Place', st.place || ''],
      ['Scenario', st.bundle.spec?.title || m.title || ''],
      ['Time window', `${clockText(m.clockStart, 0)} to ${clockText(m.clockStart, m.duration)}`],
      ['People', fmt(st.bundle.agents.length)]
    ]),
    placesSec,
    runsSec,
    sec('Technical', [
      ['Run id', m.runId || 'n/a'],
      ['Seed', String(m.seed ?? 'n/a')],
      ['Decisions recorded', fmt(st.decisions.length)],
      ['Jev requests', fmt(ps.requests ?? 0)],
      ['Repeated answers reused', fmt(ps.cacheHits ?? 0)],
      ['Fell back to rules', ps.requests ? `${((ps.fallbacks || 0) / ps.requests * 100).toFixed(1)}%` : '0%'],
      ['Response time, median / 95th', `${pct(0.5)} / ${pct(0.95)}`],
      ['Input tokens', ps.inputTokens ? fmt(ps.inputTokens) : 'n/a'],
      ['Estimated cost', ps.estCostUSD ? `$${ps.estCostUSD.toFixed(3)} (unverified)` : 'n/a'],
      ['Scale', `${(geo.metersPerUnit || 1).toFixed(2)} m per map unit`]
    ], mock ? 'These odds come from the sample data generator, shaped like Jev answers.' : isJev(m) ? ps.priceNote : 'A rule-model run makes no Jev requests.'),
    sec('Where the data came from', Object.entries(provenance).map(([k, v]) => [PROV_LABELS[k] || k.charAt(0).toUpperCase() + k.slice(1), typeof v === 'object' ? JSON.stringify(v) : PROV_WORDS[v] || String(v)])),
    frag('Legend', legend),
    frag('Keyboard', keys)
  );
}
