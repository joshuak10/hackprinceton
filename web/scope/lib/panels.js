// Side panel: counters, bottleneck ranking, incident feed, agent inspector, and the run-details drawer.
import { clockText } from './frames.js';
import { CATEGORIES } from './incidents.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const fmt = n => Math.round(n).toLocaleString('en-US');

export function renderCounters(root, st) {
  const f = st.frame;
  if (!f) { root.replaceChildren(); return; }
  const agents = st.visibleAgents || [];
  let items;
  if (st.geometry.kind === 'lot') {
    const cars = agents.filter(a => a.s !== 0 && a.s !== 4).length;
    const total = st.geometry.lot.stalls.length;
    items = [
      [fmt(cars), 'Cars moving in the lot'],
      [`${fmt(f.c.free ?? 0)} of ${total}`, 'Spaces free', (f.c.free ?? total) < total * 0.06],
      [fmt(f.c.inside ?? 0), 'Shopping inside'],
      [fmt(f.c.abandoned), 'Shoppers lost so far', f.c.abandoned > 0]
    ];
  } else {
    const inLine = agents.filter(a => a.s === 1).length;
    items = [
      [fmt(f.c.active), 'In the building now'],
      [fmt(inLine), 'In a line now'],
      [fmt(f.c.served), 'Served so far'],
      [fmt(f.c.abandoned), 'Walked away or gave up', f.c.abandoned > 0]
    ];
  }
  root.replaceChildren(...items.map(([v, l, alert]) => {
    const d = el('div', 'counter' + (alert ? ' alert' : ''));
    d.append(el('b', null, v), el('span', null, l));
    return d;
  }));
}

// Words for a line at places that aren't counters (parking lot).
const LINE_WORDS = { entry_drive: 'cars waiting to turn in', search: 'cars circling', exit_drive: 'cars waiting to leave' };

export function renderRank(root, st, onPick) {
  if (st.rankMode === 'now') return renderRankNow(root, st, onPick);
  const rows = st.bottlenecks;
  const max = st.bottleneckMax;
  if (!rows.length || rows.every(r => r.score < 0.5)) {
    root.replaceChildren(el('li', 'empty-row', 'No waits or losses yet.'));
    return;
  }
  root.replaceChildren(...rows.filter(r => r.score >= 0.5).slice(0, 5).map(r => {
    const li = el('li');
    li.append(el('span', 'name', r.name));
    const lost = r.lost ? `, ${r.lost} lost` : '';
    li.append(el('span', 'val', `${fmt(r.waitMin)} wait min${lost}`));
    const bar = el('span', 'bar');
    const i = el('i');
    i.style.width = `${Math.max(2, (r.score / max) * 100)}%`;
    bar.append(i);
    li.append(bar);
    li.title = `Score ${fmt(r.score)}: ${fmt(r.waitMin)} minutes waited + 30 × ${r.lost} people lost`;
    li.addEventListener('click', () => onPick(r.id));
    return li;
  }));
}

function renderRankNow(root, st, onPick) {
  const rows = st.bottlenecksNow.filter(r => r.inLine > 0);
  if (!rows.length) {
    root.replaceChildren(el('li', 'empty-row', 'No lines at this moment.'));
    return;
  }
  root.replaceChildren(...rows.slice(0, 5).map(r => {
    const li = el('li');
    li.append(el('span', 'name', r.name));
    const who = LINE_WORDS[r.id] || 'in line';
    const wait = r.waitNow != null ? `, about ${Math.max(1, Math.round(r.waitNow))} min wait` : '';
    li.append(el('span', 'val', `${r.inLine} ${who}${wait}`));
    const bar = el('span', 'bar');
    const i = el('i');
    i.style.width = `${Math.max(2, (r.score / st.bottleneckNowMax) * 100)}%`;
    bar.append(i);
    li.append(bar);
    li.title = r.waitNow != null
      ? `${r.inLine} in line now. Someone joining now would wait about ${Math.round(r.waitNow)} minutes.`
      : `${r.inLine} ${who} now.`;
    li.addEventListener('click', () => onPick(r.id));
    return li;
  }));
}

export function renderFilters(root, st, onToggle) {
  root.replaceChildren(...CATEGORIES.map(c => {
    const b = el('button', st.filters[c.id] ? 'on' : '');
    b.type = 'button';
    b.title = c.long;
    b.setAttribute('aria-pressed', String(!!st.filters[c.id]));
    b.append(el('i', `glyph ${c.id}`), document.createTextNode(c.label));
    b.addEventListener('click', () => onToggle(c.id));
    return b;
  }));
}

export function renderFeed(root, st, onPick) {
  const items = [];
  for (let i = st.incidents.length - 1; i >= 0 && items.length < 80; i--) {
    const it = st.incidents[i];
    if (it.t > st.t || !st.filters[it.cat]) continue;
    items.push(it);
  }
  if (!items.length) {
    root.replaceChildren(el('li', 'empty-row', st.t < 1 ? 'Press play or drag the slider. Incidents appear here as they happen.' : 'Nothing yet with these filters.'));
    return;
  }
  const multiFloor = st.geometry.floors.length > 1;
  root.replaceChildren(...items.map(it => {
    const li = el('li', (st.t - it.t < 2 ? 'fresh' : '') + (st.selectedIncident?.id === it.id ? ' sel' : ''));
    li.append(el('i', `glyph ${it.cat}`));
    const txt = el('span', 'txt', it.text);
    if (multiFloor && (it.floor || 0) !== st.floor) txt.append(el('span', 'where', `On ${st.geometry.floors[it.floor || 0]?.label || 'another floor'}`));
    li.append(txt, el('time', null, it.clock));
    li.addEventListener('click', () => onPick(it));
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

export function renderInspector(root, st, id, onClose) {
  const agent = st.agentsById.get(id);
  if (!agent) { root.hidden = true; return; }
  const persona = st.personas.get(agent.personaId) || {};
  const decisions = st.decisions.filter(d => d.agentId === id);
  const nameOf = pid => st.nodeName(pid);
  const now = (st.visibleAgents || []).find(a => a.id === id);

  const head = el('div', 'insp-head');
  const who = el('div');
  who.append(el('h2', null, agent.personaName || `Agent ${id}`));
  const group = st.archNames.get(agent.archetypeId) || agent.archetypeId;
  who.append(el('p', 'who', [group, persona.age ? `${persona.age}` : null].filter(Boolean).join(', ')));
  who.append(el('span', 'now-pill', now ? STATE_WORDS[now.s] || 'On the map' : agent.done != null && agent.done <= st.t ? `Left at ${clockText(st.clockStart, agent.done)}` : agent.born > st.t ? `Arrives at ${clockText(st.clockStart, agent.born)}` : 'Not on this floor or inside'));
  const close = el('button', 'btn ghost small', 'Close');
  close.type = 'button';
  close.addEventListener('click', onClose);
  head.append(who, close);

  const dl = el('dl', 'persona');
  for (const [k, v] of [['About', persona.about], ['Wants', persona.wants], ['Listens to', persona.listens_to], ['Live wait app', agent.informed ? 'Yes' : 'No']]) {
    if (!v) continue;
    dl.append(el('dt', null, k), el('dd', null, v));
  }

  const list = el('div');
  list.append(el('h3', 'insp-sec', `Decisions (${decisions.length})`));
  if (!decisions.length) list.append(el('p', 'hint', st.decisions.length ? 'No decisions recorded for this person.' : 'This run used the engine\'s built-in rules, which don\'t record decisions. Run it with Jev to see each choice and its probabilities.'));
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
    const tags = el('div', 'tags');
    if (dec.provider === 'mock') tags.append(el('span', 'tag mock', 'Mock probabilities'));
    if (ap.frustration != null) tags.append(el('span', 'tag', `Feeling ${['calm', 'mildly annoyed', 'frustrated', 'very frustrated', 'furious'][Math.max(0, Math.min(4, Math.round(ap.frustration)))]}`));
    if (ap.tell) tags.append(el('span', 'tag told', `Told others: ${ap.remarkKind === 'bad_service' ? 'bad experience' : ap.remarkKind === 'good_experience' ? 'good experience' : 'long wait'}`));
    if (dec.latencyMs) tags.append(el('span', 'tag', `${dec.latencyMs} ms`));
    box.append(tags);
    list.append(box);
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

  root.replaceChildren(head, dl, list, trace);
  root.hidden = false;
}

function decidedBy(dec = {}) {
  switch (dec.provider) {
    case 'mock': return 'Mock decision';
    case 'jev': return `Jev ${dec.model || ''}`.trim();
    case 'jev-cache': return 'Jev, cached answer';
    case 'replay': return 'Jev, replayed';
    case 'rules-fallback': return 'Rules (Jev request failed)';
    default: return 'Rules';
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

// ---------- drawer ----------
const PROV_LABELS = {
  rooms: 'Room outlines', walls: 'Walls', openings: 'Doorways and openings', obstacles: 'Obstacles (mesh)',
  pois: 'Counters and doors', stalls: 'Parking stalls', lanes: 'Driving lanes', store: 'Store footprint', image: 'Aerial image'
};
export function renderDrawer(root, st, caseInfo) {
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
  const legend = el('div', 'legend');
  for (const [cls, text] of [['a-walk', 'Walking'], ['a-queue', 'In a line'], ['a-serve', 'Being served or staying put'], ['a-think', 'Deciding (waiting on Jev)'], ['a-leave', 'Leaving']]) {
    const d = el('div'); const i = el('i'); i.style.background = `var(--${cls})`; d.append(i, document.createTextNode(text)); legend.append(d);
  }
  for (const c of CATEGORIES) { const d = el('div'); d.append(el('i', `glyph ${c.id}`), document.createTextNode(c.long)); legend.append(d); }

  root.replaceChildren(
    sec('Who decided', [
      ['Decisions by', mock ? 'Mock generator (not Jev)' : prov === 'jev' || prov === 'replay' ? `Jev, ${ps.model || m.model || ''}` : 'Engine rule policy (not Jev)'],
      ['Decisions', fmt(st.decisions.length)],
      ['Requests', fmt(ps.requests ?? st.decisions.length)],
      ['Cache hits', fmt(ps.cacheHits ?? 0)],
      ['Fallback to rules', ps.requests ? `${((ps.fallbacks || 0) / ps.requests * 100).toFixed(1)}%` : '0%'],
      ['Latency p50 / p95', `${pct(0.5)} / ${pct(0.95)}`],
      ['Input tokens', ps.inputTokens ? fmt(ps.inputTokens) : 'n/a'],
      ['Estimated cost', ps.estCostUSD != null ? `$${ps.estCostUSD.toFixed(3)} (unverified)` : 'n/a']
    ], mock ? 'These probabilities come from the mock generator, shaped like Jev answers.' : prov === 'rules' ? 'A rules run: no Jev requests were made.' : ps.priceNote),
    sec('World', [
      ['Case', caseInfo?.label || m.title],
      ['Place', caseInfo?.place || geo.source?.name || ''],
      ['Time window', `${clockText(m.clockStart, 0)} to ${clockText(m.clockStart, m.duration)}`],
      ['People', fmt(st.bundle.agents.length)],
      ['Seed', String(m.seed ?? '')],
      ['Scale', `${(geo.metersPerUnit || 1).toFixed(2)} m per map unit`]
    ]),
    sec('Where the data came from', Object.entries(provenance).map(([k, v]) => [PROV_LABELS[k] || k.charAt(0).toUpperCase() + k.slice(1), typeof v === 'object' ? JSON.stringify(v) : String(v)])),
    (() => { const f = document.createDocumentFragment(); f.append(el('h3', null, 'Legend'), legend); return f; })()
  );
}
