// Ask the room (docs/PROTOTYPE.md §17). Change the moment, ask every cast member, see who moves.
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const pct = v => `${Math.round(100 * v)}%`;
const clamp01 = v => Math.min(1, Math.max(0, v));
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

const PRESETS = [
  'Sign on the door: A second register is open this morning. The line moves fast.',
  'Sign on the door: Cash only today. Our card reader is down.',
  'Sign on the door: Regulars, your tenth coffee is on us.',
  'Sign on the door: We are short-staffed today. Thank you for your patience.'
];

const st = {
  view: null, scenario: null, edits: {}, result: null, open: null, busy: false, sortByChange: false,
  theme: new URLSearchParams(location.search).get('theme') || store.get('room-theme') || 'dark',
  world: new URLSearchParams(location.search).get('world') || ''
};

// ---------- data ----------
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

const shop = () => st.view.places.find(p => p.id === st.scenario.shop);
const rivals = () => st.view.places.filter(p => p.id !== st.scenario.shop);
const waitOf = (place, ahead) => (ahead > 0 ? (ahead + 1) * place.serviceTime / place.servers : 0);
const waitWords = min => (min < 1 ? 'no line' : `about ${min >= 10 ? Math.round(min / 5) * 5 : Math.max(1, Math.round(min))} min`);

async function ask(only = null) {
  if (st.busy) return;
  st.busy = true;
  setStatus(only ? 'Asking one person…' : 'Asking everyone…');
  $('askBtn').disabled = true;
  const started = performance.now();
  try {
    const body = { scenario: st.scenario, edits: st.edits };
    if (st.world) body.world = st.world;
    if (only) body.only = [only];
    const result = await api('/api/room/ask', body);
    if (only && st.result) {
      const fresh = result.people[0];
      st.result.people = st.result.people.map(p => (p.id === fresh.id ? fresh : p));
      recomputeShare();
    } else st.result = result;
    const ms = Math.round(performance.now() - started);
    const n = result.asked;
    setMode(result.live);
    setStatus(result.failed
      ? `${result.failed} ${result.failed === 1 ? 'person' : 'people'} could not answer${result.live ? '' : ': that question was never asked live, so there is no recorded answer'}.`
      : `${n} questions answered in ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}${result.people.every(p => p.source === 'recorded') ? ' (all asked before, so answered from the record)' : ''}.`, result.failed > 0);
    render();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    st.busy = false;
    $('askBtn').disabled = false;
  }
}

function recomputeShare() {
  const r = st.result, id = r.shop, ok = r.people.filter(p => p.before && p.now);
  const mean = f => (ok.length ? ok.reduce((s, p) => s + f(p), 0) / ok.length : null);
  r.share = { before: mean(p => p.before[id]), now: mean(p => p.now[id]), neutral: r.scenario.sign ? mean(p => (p.neutral ? p.neutral[id] : p.now[id])) : null };
}

// ---------- controls ----------
function setStatus(text, error = false) { const s = $('status'); s.textContent = text; s.classList.toggle('error', Boolean(error)); }
function setMode(live) { const m = $('mode'); m.textContent = live ? 'Live: Jev answers each question' : 'Recorded answers (no Jev key)'; m.classList.toggle('live', Boolean(live)); }

function applyTheme() {
  document.documentElement.dataset.theme = st.theme;
  $('themeBtn').textContent = st.theme === 'dark' ? 'Light' : 'Dark';
  $('themeBtn').setAttribute('aria-label', st.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}

function buildControls() {
  const v = st.view, home = shop();
  $('shopName').textContent = home.name;
  $('shopAbout').textContent = home.about || '';
  const others = rivals();
  $('rivalLine').textContent = others.length ? `Also on offer: ${others.map(p => `${p.name}, about $${Math.round(p.price)}`).join('; ')}. Or: ${v.leaveLabel.toLowerCase()}.` : '';
  const lines = $('lines');
  lines.replaceChildren();
  for (const p of v.places) {
    const row = el('div', 'line-row');
    const id = `ahead-${p.id}`;
    const label = el('label', null, p.name); label.htmlFor = id;
    const out = el('output'); out.htmlFor = id; out.id = `${id}-out`;
    const range = el('input'); range.type = 'range'; range.id = id; range.min = '0'; range.max = String(Math.min(v.limits.ahead, 20)); range.step = '1';
    range.value = String(st.scenario.ahead[p.id]);
    range.addEventListener('input', () => { st.scenario.ahead[p.id] = Number(range.value); syncControls(); });
    row.append(label, out, range);
    lines.append(row);
  }
  const chips = $('chips');
  chips.replaceChildren();
  for (const text of PRESETS) {
    const b = el('button', 'chip', text.replace(/^Sign on the door: /, '').split('.')[0]);
    b.type = 'button'; b.title = text;
    b.addEventListener('click', () => { $('sign').value = text; st.scenario.sign = text; ask(); });
    chips.append(b);
  }
  syncControls();
}

function syncControls() {
  const s = st.scenario, v = st.view, base = v.defaults;
  for (const p of v.places) {
    const n = s.ahead[p.id];
    $(`ahead-${p.id}`).value = String(n);
    $(`ahead-${p.id}-out`).textContent = n === 0 ? 'nobody in line' : `${n} in line, ${waitWords(waitOf(p, n))}`;
  }
  $('priceOut').textContent = `$${Math.round(s.price)}`;
  const changed = Math.round(s.price) !== Math.round(base.price);
  $('remember').disabled = !changed;
  if (!changed) { $('remember').checked = false; s.priorPrice = null; }
  $('rememberText').textContent = changed ? `They know it was $${Math.round(base.price)} last week` : 'They know it used to be different';
  $('sign').value = s.sign || '';
}

function reset() {
  st.scenario = structuredClone(st.view.defaults);
  st.edits = {};
  st.open = null;
  syncControls();
  ask();
}

// ---------- results ----------
const ref = p => (p.neutral || p.before);          // a sign is judged against the neutral sign, anything else against before
const change = (p, id) => (p.now && ref(p) ? p.now[id] - ref(p)[id] : 0);

function render() {
  const r = st.result;
  if (!r) return;
  const id = r.shop, home = st.view.places.find(p => p.id === id), noise = r.noise;
  const withSign = Boolean(r.scenario.sign);
  const from = withSign ? r.share.neutral : r.share.before, to = r.share.now;
  const sumLine = $('sumLine'), sumSub = $('sumSub');
  sumLine.replaceChildren();
  if (from == null || to == null) sumLine.textContent = 'Nobody could answer.';
  else {
    const d = to - from, flat = Math.abs(d) < noise;
    sumLine.append(`${home.name} gets `, el('b', flat ? null : d > 0 ? 'up' : 'down', pct(to)), ` of these ${r.people.length} people`);
    sumLine.append(flat ? ', about the same as before.' : `, ${d > 0 ? 'up' : 'down'} from ${pct(from)}.`);
  }
  const movers = r.people.filter(p => p.now && ref(p)).map(p => ({ p, d: change(p, id) })).filter(x => Math.abs(x.d) >= noise).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const first = n => n.split(' ')[0];
  const lost = movers.filter(x => x.d < 0).slice(0, 3).map(x => `${first(x.p.name)} (${Math.round(100 * x.d)})`);
  const won = movers.filter(x => x.d > 0).slice(0, 3).map(x => `${first(x.p.name)} (+${Math.round(100 * x.d)})`);
  const still = r.people.length - movers.length;
  const parts = [];
  if (lost.length) parts.push(`Less likely: ${lost.join(', ')}.`);
  if (won.length) parts.push(`More likely: ${won.join(', ')}.`);
  parts.push(still === r.people.length ? 'Nobody moved by more than asking twice would give.' : `${still} of ${r.people.length} did not move.`);
  if (withSign) parts.push('Compared with the same moment and a neutral sign.');
  sumSub.textContent = parts.join(' ');

  const list = $('people');
  const order = r.people.slice();
  if (st.sortByChange) order.sort((a, b) => Math.abs(change(b, id)) - Math.abs(change(a, id)));
  const existing = new Map([...list.children].map(li => [li.dataset.id, li]));
  for (const p of order) {
    let li = existing.get(p.id);
    if (!li) { li = personNode(p); existing.set(p.id, li); }
    updatePerson(li, p, id, noise, home);
    list.append(li);                               // re-appending moves it into the new order
  }
}

function personNode(p) {
  const li = el('li', 'person'); li.dataset.id = p.id;
  const row = el('button', 'row'); row.type = 'button'; row.setAttribute('aria-expanded', 'false');
  const who = el('span', 'who');
  const name = el('span', 'name'); who.append(name, el('span', 'bio'), el('span', 'group'));
  const meter = el('span', 'meter');
  const track = el('span', 'track'); track.append(el('span', 'fill'), el('span', 'delta'));
  meter.append(track, el('span', 'tick'));
  const num = el('span', 'num'); num.append(el('span', 'pct'), el('span', 'chg'));
  row.append(who, meter, num);
  row.addEventListener('click', () => { st.open = st.open === p.id ? null : p.id; render(); });
  li.append(row);
  return li;
}

function updatePerson(li, p, id, noise, home) {
  const row = li.querySelector('.row');
  const name = li.querySelector('.name');
  name.replaceChildren(p.name, el('span', 'age', String(p.age)));
  if (p.edited) name.append(el('span', 'edited', 'rewritten'));
  li.querySelector('.bio').textContent = p.bio;
  li.querySelector('.group').textContent = p.group;
  const meter = li.querySelector('.meter'), fill = li.querySelector('.fill'), delta = li.querySelector('.delta'), tick = li.querySelector('.tick');
  const pctEl = li.querySelector('.pct'), chg = li.querySelector('.chg');
  const ok = p.now && ref(p);
  meter.classList.toggle('empty', !ok);
  if (!ok) { pctEl.textContent = 'n/a'; chg.textContent = 'no answer'; chg.className = 'chg failed'; }
  else {
    const now = clamp01(p.now[id]), was = clamp01(ref(p)[id]), d = now - was, flat = Math.abs(d) < noise;
    fill.style.width = `${100 * Math.min(now, was)}%`;
    delta.style.left = `${100 * Math.min(now, was)}%`;
    delta.style.width = `${flat ? 0 : 100 * Math.abs(d)}%`;
    delta.className = `delta ${d > 0 ? 'up' : 'down'}`;
    tick.style.left = `${100 * was}%`;
    pctEl.textContent = pct(now);
    chg.textContent = flat ? 'no change' : `${d > 0 ? '+' : ''}${Math.round(100 * d)} pts`;
    chg.className = `chg ${flat ? '' : d > 0 ? 'up' : 'down'}`;
    row.setAttribute('aria-label', `${p.name}: ${pct(now)} likely to choose ${home.name}, ${flat ? 'no change' : `${d > 0 ? 'up' : 'down'} ${Math.abs(Math.round(100 * d))} points`}. Show details.`);
  }
  const open = st.open === p.id;
  row.setAttribute('aria-expanded', String(open));
  const old = li.querySelector('.detail');
  if (!open) { old?.remove(); return; }
  const detail = detailNode(p, id, home);
  if (old) old.replaceWith(detail); else li.append(detail);
}

function detailNode(p, id, home) {
  const wrap = el('div', 'detail');
  const left = el('div');
  left.append(el('h3', null, 'What they were told'));
  const told = el('div', 'told');
  told.append(el('p', null, `${p.told.time[0].toUpperCase()}${p.told.time.slice(1)}. ${p.told.now}`));
  for (const pl of p.told.places) {
    const line = el('p', 'place');
    line.append(el('b', null, pl.name), `: ${pl.cost}; line ${pl.line}${pl.people ? ` (${pl.people})` : ''}.`);
    told.append(line);
  }
  if (p.told.sign) told.append(el('p', 'sign', p.told.sign));
  left.append(told);
  if (p.now) {
    const split = el('div', 'split');
    const rows = [[home.name, id, ''], ...st.view.places.filter(x => x.id !== id).map(x => [x.name, x.id, 'rival']), [st.view.leaveLabel, 'leave', 'skip']];
    for (const [label, key, cls] of rows) {
      const bar = el('span', 'bar'); const i = el('i', cls); i.style.width = `${100 * clamp01(p.now[key] || 0)}%`; bar.append(i);
      const was = ref(p) ? ` (was ${pct(ref(p)[key] || 0)})` : '';
      split.append(el('span', 'lab', label), bar, el('span', 'val', `${pct(p.now[key] || 0)}${was}`));
    }
    left.append(split);
  }
  const right = el('div', 'edit');
  right.append(el('h3', null, 'Rewrite this person'));
  const fields = [['bio', 'Their situation'], ['personality', 'What they are like'], ['goal', 'What they want']];
  const inputs = {};
  for (const [key, label] of fields) {
    const lab = el('label', null, label);
    const ta = el('textarea'); ta.rows = key === 'bio' ? 3 : 2; ta.maxLength = st.view.limits.text; ta.value = p[key] || '';
    lab.append(ta); right.append(lab); inputs[key] = ta;
  }
  const actions = el('div', 'actions');
  const go = el('button', 'btn primary', 'Ask this person'); go.type = 'button';
  go.addEventListener('click', () => {
    const original = st.view.cast.find(c => c.id === p.id), edit = {};
    for (const [key] of fields) if (inputs[key].value.trim() && inputs[key].value.trim() !== original[key]) edit[key] = inputs[key].value.trim();
    if (Object.keys(edit).length) st.edits[p.id] = edit; else delete st.edits[p.id];
    ask(p.id);
  });
  const undo = el('button', 'btn', 'Restore'); undo.type = 'button';
  undo.addEventListener('click', () => { delete st.edits[p.id]; ask(p.id); });
  actions.append(go, undo);
  right.append(actions, el('p', 'note', 'Change one sentence and ask again. The answer comes from the words, so nothing here was written in advance.'));
  wrap.append(left, right);
  return wrap;
}

// ---------- start ----------
async function start() {
  applyTheme();
  $('themeBtn').addEventListener('click', () => { st.theme = st.theme === 'dark' ? 'light' : 'dark'; store.set('room-theme', st.theme); applyTheme(); });
  $('sortBtn').addEventListener('click', () => { st.sortByChange = !st.sortByChange; $('sortBtn').textContent = st.sortByChange ? 'Sort by group' : 'Sort by change'; render(); });
  $('priceDown').addEventListener('click', () => { st.scenario.price = Math.max(1, Math.round(st.scenario.price) - 1); syncControls(); });
  $('priceUp').addEventListener('click', () => { st.scenario.price = Math.min(st.view.limits.price, Math.round(st.scenario.price) + 1); syncControls(); });
  $('remember').addEventListener('change', e => { st.scenario.priorPrice = e.target.checked ? st.view.defaults.price : null; });
  $('sign').addEventListener('input', e => { st.scenario.sign = e.target.value; });
  $('resetBtn').addEventListener('click', reset);
  $('form').addEventListener('submit', e => { e.preventDefault(); ask(); });
  try {
    st.view = await api(`/api/room${st.world ? `?world=${encodeURIComponent(st.world)}` : ''}`);
  } catch (err) {
    $('mode').textContent = 'Not connected';
    setStatus(`${err.message} Start the server with: node bin/swarm.js serve`, true);
    return;
  }
  st.scenario = structuredClone(st.view.defaults);
  setMode(st.view.live);
  buildControls();
  ask();
}

start();
