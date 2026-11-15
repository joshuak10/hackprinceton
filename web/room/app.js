// Ask the room (docs/PROTOTYPE.md §17). Change the moment, ask every cast member, see who moves.
import { points, refOf, grade, recomputeShare, summarize, byChange } from './maths.js';
import { FEELINGS, withFeeling, firstName } from './feelings.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const pct = v => `${Math.round(100 * v)}%`;
const clamp01 = v => Math.min(1, Math.max(0, v));
const signed = d => `${d > 0 ? '+' : '−'}${Math.abs(points(d))}`;
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

// The words on the sign only: the server tells each person whose door it is on.
const PRESETS = [
  'A second register is open this morning. The line moves fast.',
  'Cash only today. Our card reader is down.',
  'Quiet hour until 9. No music, no blenders, soft voices please.',
  'We are short-staffed today. Thank you for your patience.'
];
const FIELDS = [['bio', 'Their situation'], ['personality', 'What they are like'], ['goal', 'What they want']];
const FONTS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,650;12..96,750&family=IBM+Plex+Sans:wght@400;500;600&display=swap';

const st = {
  view: null, scenario: null, asked: null, edits: {}, result: null, open: null, busy: false, queued: null, sortByChange: true,
  mood: null, feel: {},          // a feeling for the whole room, and one per person (ids from feelings.js)
  theme: new URLSearchParams(location.search).get('theme') || store.get('room-theme') || 'dark',
  world: new URLSearchParams(location.search).get('world') || ''
};

// ---------- data ----------
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `The server answered ${res.status}.`), { status: res.status });
  return data;
}

const place = id => st.view.places.find(p => p.id === id);
const shop = () => place(st.scenario.shop);
const rivals = () => st.view.places.filter(p => p.id !== st.scenario.shop);
const original = id => st.view.cast.find(c => c.id === id);
const waitOf = (p, ahead) => (ahead > 0 ? (ahead + 1) * p.serviceTime / p.servers : 0);
const waitWords = min => (min < 1 ? 'no line' : `about ${min >= 10 ? Math.round(min / 5) * 5 : Math.max(1, Math.round(min))} min`);
const duration = ms => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// The feeling a person has today: their own, or the room's. A typed rewrite takes its place.
const feelingOf = id => (st.edits[id] ? null : FEELINGS.find(f => f.id === (st.feel[id] || st.mood)) || null);
const feltBio = (id, feeling) => { const o = original(id); return withFeeling(o.bio, o.name, feeling, shop().name); };
// What is asked: each typed rewrite, and for everyone else with a feeling, their situation plus that one sentence.
function editsToSend() {
  const out = { ...st.edits };
  for (const c of st.view.cast) { const f = feelingOf(c.id); if (f) out[c.id] = { bio: feltBio(c.id, f) }; }
  return out;
}

// A click made while an ask is running is kept, not dropped: the latest one runs next. A waiting ask for
// everyone is never replaced by an ask for one person.
async function ask(only = null) {
  if (st.busy) { st.queued = { only: st.queued && st.queued.only == null ? null : only }; return; }
  st.busy = true;
  setStatus(only ? 'Asking one person…' : 'Asking everyone…');
  $('askBtn').setAttribute('aria-busy', 'true');
  const started = performance.now();
  try {
    // One person is asked about the moment everyone last answered, whatever the controls say now.
    const one = Boolean(only && st.result && st.asked);
    const body = { scenario: one ? st.asked : st.scenario, edits: editsToSend() };
    if (st.world) body.world = st.world;
    if (one) body.only = [only];
    const result = await api('/api/room/ask', body);
    const ms = Math.round(performance.now() - started);
    setMode(result.live);
    if (result.people.length && result.failed === result.people.length && st.result) {
      // Nobody could answer: the last answers stay on screen, with the reason.
      setAsked('');
      setStatus(result.live
        ? `Jev did not answer${result.error ? ` (${result.error})` : ''}. These are still the last answers.`
        : 'That question has no saved answer, and there is no Jev key to ask it now. These are still the last answers.', true);
    } else {
      if (one) {
        const fresh = result.people[0];
        st.result.people = st.result.people.map(p => (p.id === fresh.id ? fresh : p));
        recomputeShare(st.result);
      } else {
        st.result = result;
        st.asked = structuredClone(body.scenario);
      }
      report(result, ms);
      render();
      document.querySelector('.room').scrollTop = 0;                // every new answer starts at its headline, which names who moved
    }
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    st.busy = false;
    $('askBtn').removeAttribute('aria-busy');
    const next = st.queued;
    st.queued = null;
    if (next) ask(next.only);
  }
}

// Says plainly which answers were asked just now and which were asked before and saved.
function report(result, ms) {
  const n = result.asked, live = result.askedLive || 0, took = duration(ms);
  if (result.failed) {
    setAsked('');
    const why = result.live ? (result.error ? `: Jev ${result.error}` : '') : ': that question has no saved answer, and there is no Jev key to ask it now';
    setStatus(`${result.failed} ${result.failed === 1 ? 'person' : 'people'} could not answer${why}.`, true);
    return;
  }
  setAsked(live ? `Asked Jev just now: ${live} new ${live === 1 ? 'question' : 'questions'}, ${took}` : 'Asked before: these are Jev’s saved answers', live > 0);
  setStatus(live
    ? `${n} questions: ${live} asked just now, ${n - live} answered from the record. ${took}.`
    : `${n} questions, all asked before and answered from the record. ${took}.`);
}

// ---------- controls ----------
function setStatus(text, error = false) { const s = $('status'); s.textContent = text; s.classList.toggle('error', Boolean(error)); }
function setAsked(text, live = false) { const a = $('asked'); a.textContent = text; a.classList.toggle('live', Boolean(live)); }
function setMode(live) { const m = $('mode'); m.textContent = live ? 'Live: new questions go to Jev' : 'Recorded answers (no Jev key)'; m.classList.toggle('live', Boolean(live)); }

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
  $('signLegend').textContent = `A sign on the door of ${home.name}`;
  $('honest').textContent = `${v.cast.length} simulated people answering through Jev, a decision model, not checked against real customers. One person counts as moved at ${points(v.noisePerson ?? 0.15)} points; smaller shifts happen with no real change.`;
  const lines = $('lines');
  lines.replaceChildren();
  for (const p of v.places) {
    const row = el('div', 'line-row');
    const id = `ahead-${p.id}`;
    const label = el('label', null, p.name); label.htmlFor = id;
    const out = el('output'); out.htmlFor = id; out.id = `${id}-out`;
    const range = el('input'); range.type = 'range'; range.id = id; range.min = '0'; range.step = '1';
    range.max = String(Math.max(20, st.scenario.ahead[p.id]));
    range.value = String(st.scenario.ahead[p.id]);
    range.addEventListener('input', () => { st.scenario.ahead[p.id] = Number(range.value); syncControls(); });
    range.addEventListener('change', () => ask());
    row.append(label, out, range);
    lines.append(row);
  }
  const moods = $('moods');
  moods.replaceChildren();
  for (const f of FEELINGS) {
    const b = el('button', 'chip', f.label);
    b.type = 'button'; b.dataset.feeling = f.id;
    b.addEventListener('click', () => { st.mood = st.mood === f.id ? null : f.id; st.feel = {}; syncControls(); ask(); });
    moods.append(b);
  }
  const chips = $('chips');
  chips.replaceChildren();
  for (const text of PRESETS) {
    const b = el('button', 'chip', text.split('.')[0]);
    b.type = 'button'; b.title = text;
    b.addEventListener('click', () => { st.scenario.sign = text; syncControls(); ask(); });
    chips.append(b);
  }
  syncControls();
}

function syncControls() {
  const s = st.scenario, v = st.view, base = v.defaults;
  for (const p of v.places) {
    const n = s.ahead[p.id], words = n === 0 ? 'nobody in line' : `${n} in line, ${waitWords(waitOf(p, n))}`;
    const range = $(`ahead-${p.id}`);
    range.value = String(n);
    range.setAttribute('aria-valuetext', words);
    $(`ahead-${p.id}-out`).textContent = words;
  }
  for (const b of $('moods').children) b.setAttribute('aria-pressed', String(st.mood === b.dataset.feeling));
  $('priceOut').textContent = `$${Math.round(s.price)}`;
  const changed = Math.round(s.price) !== Math.round(base.price);
  if (!changed) s.priorPrice = null;
  $('remember').disabled = !changed;
  $('remember').checked = s.priorPrice != null;
  $('rememberText').textContent = changed ? `They know it was $${Math.round(base.price)} last week` : 'They know it used to be different';
  if ($('sign').value !== (s.sign || '')) $('sign').value = s.sign || '';
}

// A new price is asked at once. People are taken to remember last week's price until the box is cleared.
function setPrice(next) {
  const s = st.scenario, base = Math.round(st.view.defaults.price), was = Math.round(s.price);
  if (next === was) return;
  s.price = next;
  if (next === base) s.priorPrice = null;
  else if (was === base) s.priorPrice = st.view.defaults.price;
  syncControls();
  ask();
}

function reset() {
  st.scenario = structuredClone(st.view.defaults);
  st.edits = {};
  st.mood = null;
  st.feel = {};
  st.open = null;
  syncControls();
  ask();
}

// What is typed into a person's boxes is kept as it is typed, so either Ask button carries it.
function draft(id, key, value) {
  delete st.feel[id];                                   // typing takes over from a one-click feeling
  const v = value.trim(), e = (st.edits[id] ??= {});
  if (v && v !== original(id)[key]) e[key] = v; else delete e[key];
  if (!Object.keys(e).length) delete st.edits[id];
}

// ---------- results ----------
function render() {
  const r = st.result;
  if (!r) return;
  const home = place(r.shop), sum = summarize(r);
  renderSummary(sum, home);
  $('tickKey').textContent = sum.withSign ? 'with a plain sign' : 'before';
  $('smallKey').textContent = `under ${points(sum.noisePerson)} points: too small to tell`;

  const list = $('people');
  const undecided = p => (p.now ? Math.abs(p.now[sum.id] - 0.5) : 1);
  const shown = !st.sortByChange ? r.people
    : sum.unchanged ? r.people.map((p, i) => ({ p, i })).sort((a, b) => undecided(a.p) - undecided(b.p) || a.i - b.i).map(x => x.p)
      : byChange(r.people, sum.id, sum.withSign);
  const existing = new Map([...list.children].map(li => [li.dataset.id, li]));
  shown.forEach((p, i) => {
    const li = existing.get(p.id) || personNode(p);
    existing.delete(p.id);
    updatePerson(li, p, sum, home);
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);   // moved only when the order changed, so focus stays put
  });
  for (const li of existing.values()) li.remove();
}

function renderSummary(sum, home) {
  const big = $('sumLine'), sub = $('sumSub');
  big.replaceChildren();
  if (!sum.answered) { big.textContent = 'Nobody could answer.'; sub.textContent = ''; return; }
  const first = name => name.split(' ')[0];
  const versus = sum.withSign ? 'with a plain sign' : 'before';
  const parts = [];
  const r = st.result, mood = FEELINGS.find(f => f.id === st.mood) || null;
  const felt = r.people.filter(p => p.edited && p.now && p.written);
  const names = (list, dir) => list.filter(m => (m.d > 0) === dir).slice(0, 3).map(m => `${first(m.p.name)} (${signed(m.d)})`);
  if (mood && felt.length === r.people.length && felt.length) {
    // The whole room has the same feeling: each person against themselves without it, at this same moment.
    const without = felt.reduce((s, p) => s + p.written[sum.id], 0) / felt.length, d = sum.to - without;
    const flat = Math.abs(points(d)) < points(sum.noise);
    big.append(`Everyone ${mood.today}: ${home.name} gets `, el('b', flat ? null : d > 0 ? 'up' : 'down', pct(sum.to)), ` of these ${sum.asked} people`);
    big.append(flat ? ', about the same as without it.' : `, ${d > 0 ? 'up' : 'down'} from ${pct(without)}.`);
    const lost = names(sum.movers, false), won = names(sum.movers, true);
    if (lost.length) parts.push(`Less likely: ${lost.join(', ')}.`);
    if (won.length) parts.push(`More likely: ${won.join(', ')}.`);
    parts.push(sum.movers.length ? `${sum.still} of ${sum.asked} did not move.` : `No one moved by ${points(sum.noisePerson)} points or more.`);
    parts.push('Each person is compared with themselves without the feeling, at this same price and line.');
    sub.textContent = parts.join(' ');
    return;
  }
  if (!mood && felt.length === 1 && !sum.withSign) {
    // One person with a feeling or a rewrite: say who, what, and both numbers.
    const p = felt[0], f = feelingOf(p.id), now = p.now[sum.id], was = p.written[sum.id], d = now - was;
    const g = grade(d, sum.noise, sum.noisePerson);
    big.append(`${first(p.name)}, ${f ? f.today : 'rewritten'}: `, el('b', g === 'up' || g === 'down' ? g : null, pct(now)), `, was ${pct(was)}.`);
    if (g === 'none' || g === 'small') parts.push(`A change this small could be chance: one person’s answer can shift by nearly ${points(sum.noisePerson)} points when nothing real changes.`);
    parts.push(`${home.name} gets ${pct(sum.to)} of these ${sum.asked} people.`);
    parts.push(`${first(p.name)} is compared with ${first(p.name)} as first written, at this same price and line.`);
    sub.textContent = parts.join(' ');
    return;
  }
  if (sum.unchanged) {
    big.append(`Right now ${home.name} gets `, el('b', null, pct(sum.to)), ` of these ${sum.asked} people.`);
    parts.push('Start here: give the room a feeling on the left, or open a person and give only them one. You can also change the sign, the price or the line.');
  } else if (sum.flat && sum.movers.length) {
    // The room's total hides it, so the people come first.
    const named = sum.movers.slice(0, 4);
    named.forEach((m, i) => {
      if (i) big.append(', ');
      big.append(el('b', m.d > 0 ? 'up' : 'down', `${first(m.p.name)} ${signed(m.d)}`));
      if (m.p.edited) big.append(` (${feelingOf(m.p.id)?.today || 'rewritten'})`);
    });
    const rest = sum.asked - named.length;
    big.append(named.length < sum.movers.length ? ` and ${sum.movers.length - named.length} more moved.` : ' moved.');
    if (named.length === sum.movers.length && rest > 0) big.append(` The other ${rest} did not.`);
    parts.push(`${home.name} still gets about ${pct(sum.to)} of these ${sum.asked} people (${pct(sum.from)} ${versus}).`);
  } else {
    const d = sum.to - sum.from;
    big.append(`${home.name} gets `, el('b', sum.flat ? null : d > 0 ? 'up' : 'down', pct(sum.to)), ` of these ${sum.asked} people`);
    big.append(sum.flat ? `, about the same as ${versus}.` : `, ${d > 0 ? 'up' : 'down'} from ${pct(sum.from)}${sum.withSign ? ' with a plain sign' : ''}.`);
    const list = dir => sum.movers.filter(m => (m.d > 0) === dir).slice(0, 3).map(m => `${first(m.p.name)} (${signed(m.d)}${m.p.edited ? ', rewritten' : ''})`);
    const lost = list(false), won = list(true);
    if (lost.length) parts.push(`Less likely: ${lost.join(', ')}.`);
    if (won.length) parts.push(`More likely: ${won.join(', ')}.`);
    parts.push(sum.movers.length ? `${sum.still} of ${sum.asked} did not move.` : `No one moved by ${points(sum.noisePerson)} points or more.`);
  }
  if (sum.withSign) {
    parts.push('Each bar is compared with the same moment and a plain sign about restrooms, so this is the sign’s own effect.');
    if (sum.alsoChanged && sum.before != null) parts.push(`Before any change it was ${pct(sum.before)}.`);
  }
  if (sum.rewritten) parts.push('A rewritten person is compared with the same moment as they were first written.');
  sub.textContent = parts.join(' ');
}

function personNode(p) {
  const li = el('li', 'person'); li.dataset.id = p.id;
  const row = el('button', 'row'); row.type = 'button'; row.setAttribute('aria-expanded', 'false');
  const who = el('span', 'who');
  who.append(el('span', 'name'), el('span', 'feel'));
  const meter = el('span', 'meter');
  const track = el('span', 'track'); track.append(el('span', 'fill'), el('span', 'delta'));
  meter.append(track, el('span', 'tick'));
  const num = el('span', 'num'); num.append(el('span', 'pct'), el('span', 'chg'));
  row.append(who, meter, num);
  row.addEventListener('click', () => {
    st.open = st.open === p.id ? null : p.id;
    render();
    if (st.open === p.id) li.scrollIntoView({ block: 'nearest' });       // the panel and its feelings, not only the row
  });
  li.append(row);
  return li;
}

function updatePerson(li, p, sum, home) {
  const id = sum.id, row = li.querySelector('.row');
  const name = li.querySelector('.name');
  name.replaceChildren(p.name, el('span', 'age', String(p.age)), el('span', 'group', p.group));
  if (p.edited && !feelingOf(p.id)) name.append(el('span', 'edited', 'rewritten'));
  const feel = li.querySelector('.feel'), today = p.edited ? feelingOf(p.id) : null;
  feel.textContent = today ? `Today: ${today.today}` : p.personality || '';
  feel.classList.toggle('today', Boolean(today));
  feel.title = p.bio || '';
  const meter = li.querySelector('.meter'), fill = li.querySelector('.fill'), delta = li.querySelector('.delta'), tick = li.querySelector('.tick');
  const pctEl = li.querySelector('.pct'), chg = li.querySelector('.chg');
  const ref = refOf(p, sum.withSign), ok = Boolean(p.now && ref);
  meter.classList.toggle('empty', !ok);
  if (!ok) {
    pctEl.textContent = 'n/a'; chg.textContent = 'no answer'; chg.className = 'chg failed'; chg.removeAttribute('title');
    row.setAttribute('aria-label', `${p.name}: no answer. Show details.`);
  } else {
    const now = clamp01(p.now[id]), was = clamp01(ref.probs[id]), d = now - was, g = grade(d, sum.noise, sum.noisePerson);
    fill.style.width = `${100 * Math.min(now, was)}%`;
    delta.style.left = `${100 * Math.min(now, was)}%`;
    delta.style.width = `${g === 'none' ? 0 : 100 * Math.abs(d)}%`;
    delta.className = `delta ${g === 'small' ? 'small' : d > 0 ? 'up' : 'down'}`;
    tick.style.left = `${100 * was}%`;
    pctEl.textContent = pct(now);
    chg.textContent = g === 'none' ? 'no change' : `${signed(d)} pts`;
    chg.className = `chg ${g === 'none' ? '' : g}`;
    if (g === 'small') chg.title = `Under ${points(sum.noisePerson)} points: one person’s answer can shift this much when nothing real changes.`; else chg.removeAttribute('title');
    const said = g === 'none' ? 'no change' : `${d > 0 ? 'up' : 'down'} ${Math.abs(points(d))} points${g === 'small' ? ', too small to tell' : ''}`;
    row.setAttribute('aria-label', `${p.name}: ${pct(now)} likely to choose ${home.name}, ${said}. Show details.`);
  }
  const open = st.open === p.id;
  row.setAttribute('aria-expanded', String(open));
  if (!open) { li._detail?.wrap.remove(); li._detail = null; return; }
  if (!li._detail) { li._detail = detailNode(p.id); li.append(li._detail.wrap); }
  updateDetail(li._detail, p, sum, home, ref);
}

// Built once per opening and then updated in place, so typing in a box is never interrupted by an answer arriving.
function detailNode(personId) {
  const wrap = el('div', 'detail'), left = el('div'), right = el('div', 'edit');
  right.append(el('h3', null, 'Rewrite this person'));
  // One click adds one sentence about how the person feels today, and asks them again. Nothing else changes.
  const feel = el('div', 'feelings');
  feel.append(el('span', 'feel-lead', 'Give them a feeling today'));
  const chips = {};
  for (const f of FEELINGS) {
    const b = el('button', 'chip', f.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      const on = !st.edits[personId] && st.feel[personId] === f.id;
      delete st.edits[personId];
      if (on) delete st.feel[personId]; else st.feel[personId] = f.id;
      ask(personId);
    });
    chips[f.id] = b;
    feel.append(b);
  }
  right.append(feel);
  const inputs = {};
  for (const [key, label] of FIELDS) {
    const lab = el('label', null, label);
    const ta = el('textarea'); ta.rows = key === 'bio' ? 5 : 2; ta.maxLength = st.view.limits.text;
    ta.addEventListener('input', () => draft(personId, key, ta.value));
    lab.append(ta); right.append(lab); inputs[key] = ta;
  }
  const actions = el('div', 'actions');
  const go = el('button', 'btn primary', 'Ask this person'); go.type = 'button';
  go.addEventListener('click', () => ask(personId));
  const undo = el('button', 'btn', 'Restore'); undo.type = 'button';
  undo.addEventListener('click', () => { delete st.edits[personId]; delete st.feel[personId]; ask(personId); });
  actions.append(go, undo);
  right.append(actions, el('p', 'note', 'The three boxes are read together. Change the words and ask again: Jev reads them each time, and no answer on this page was written by us.'));
  const certain = el('p', 'certain');
  right.append(certain);
  wrap.append(left, right);
  return { wrap, left, inputs, chips, certain };
}

function updateDetail(detail, p, sum, home, ref) {
  const mine = feelingOf(p.id);
  for (const [key] of FIELDS) {
    const ta = detail.inputs[key];
    const want = st.edits[p.id]?.[key] ?? (key === 'bio' && mine ? feltBio(p.id, mine) : original(p.id)[key]) ?? '';
    if (document.activeElement !== ta && ta.value.trim() !== want) ta.value = want;
  }
  for (const f of FEELINGS) detail.chips[f.id].setAttribute('aria-pressed', String(mine?.id === f.id));
  // A person who is already sure has no room to show a feeling: say so, and say what to try.
  const sure = mine && ref?.kind === 'written' && p.now ? ref.probs[sum.id] : null;
  const still = sure != null && Math.abs(points(p.now[sum.id] - sure)) < points(sum.noisePerson);
  detail.certain.textContent = still && (sure >= 0.95 || sure <= 0.05)
    ? `${firstName(p.name)} is already almost certain ${sure >= 0.95 ? 'to come in' : 'not to come in'} at this line and price, so a feeling has little room to show. ${sure >= 0.95 ? 'Make the line longer or raise the price' : 'Shorten the line'} and try the feeling again.`
    : '';
  const left = detail.left;
  left.replaceChildren(el('h3', null, 'What they were told'));
  const told = el('div', 'told');
  told.append(el('p', null, `${p.told.time[0].toUpperCase()}${p.told.time.slice(1)}. ${p.told.now}`));
  for (const pl of p.told.places) {
    const line = el('p', 'place');
    line.append(el('b', null, pl.name), `: ${pl.cost}; line ${pl.line}${pl.people ? ` (${pl.people})` : ''}.`);
    told.append(line);
  }
  if (p.told.sign) told.append(el('p', 'sign', p.told.sign));
  left.append(told);
  if (!p.now) return;
  const versus = { before: 'was', neutral: 'plain sign', written: 'as written' }[ref?.kind] || '';
  const split = el('div', 'split');
  const rows = [[home.name, sum.id, ''], ...st.view.places.filter(x => x.id !== sum.id).map(x => [x.name, x.id, 'rival']), [st.view.leaveLabel, 'leave', 'skip']];
  for (const [label, key, cls] of rows) {
    const bar = el('span', 'bar'); const i = el('i', cls); i.style.width = `${100 * clamp01(p.now[key] || 0)}%`; bar.append(i);
    split.append(el('span', 'lab', label), bar, el('span', 'val', `${pct(p.now[key] || 0)}${ref ? ` (${versus} ${pct(ref.probs[key] || 0)})` : ''}`));
  }
  left.append(split);
}

// ---------- start ----------
async function start() {
  applyTheme();
  // The fonts are added here and not in the page's head, so a slow font server cannot hold the page back.
  const fonts = el('link'); fonts.rel = 'stylesheet'; fonts.href = FONTS; document.head.append(fonts);
  $('themeBtn').addEventListener('click', () => { st.theme = st.theme === 'dark' ? 'light' : 'dark'; store.set('room-theme', st.theme); applyTheme(); });
  $('sortBtn').addEventListener('click', () => { st.sortByChange = !st.sortByChange; $('sortBtn').textContent = st.sortByChange ? 'Sort by group' : 'Sort by change'; render(); });
  $('priceDown').addEventListener('click', () => setPrice(Math.max(Math.min(1, Math.round(st.view.defaults.price)), Math.round(st.scenario.price) - 1)));
  $('priceUp').addEventListener('click', () => setPrice(Math.min(st.view.limits.price, Math.round(st.scenario.price) + 1)));
  $('remember').addEventListener('change', e => { st.scenario.priorPrice = e.target.checked ? st.view.defaults.price : null; ask(); });
  $('sign').addEventListener('input', e => { st.scenario.sign = e.target.value; });
  $('sign').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
  $('resetBtn').addEventListener('click', reset);
  $('form').addEventListener('submit', e => { e.preventDefault(); ask(); });
  try {
    st.view = await api(`/api/room${st.world ? `?world=${encodeURIComponent(st.world)}` : ''}`);
  } catch (err) {
    $('mode').textContent = err.status ? 'Not available' : 'Not connected';
    setStatus(err.status ? err.message : `${err.message} Start the server with: node bin/swarm.js serve`, true);
    return;
  }
  st.scenario = structuredClone(st.view.defaults);
  setMode(st.view.live);
  buildControls();
  ask();
}

start();
