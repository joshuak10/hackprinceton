// Ask the room (docs/PROTOTYPE.md §17, §17b). Change the moment, ask every cast member, see who moves.
// Two modes: at the counter (a person has just arrived) and the next morning (do they go back today?).
import { points, refOf, grade, recomputeShare, summarize, byChange, morningChange, morningSummary, byMorningChange } from './maths.js';
import { langButton } from '../scope/lib/i18n.js';

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

// `scenario`, `asked`, `edits` and `result` belong to the at-the-counter mode; `morning` holds the same for the
// next morning. Each mode keeps its own controls and its last answers.
const st = {
  view: null, scenario: null, asked: null, edits: {}, result: null, open: null, busy: false, queued: null, sortByChange: true,
  mode: 'counter', morning: { scenario: null, result: null },
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

// A click made while an ask is running is kept, not dropped: the latest one runs next. A waiting ask for
// everyone is never replaced by an ask for one person.
async function ask(only = null) {
  if (st.busy) { st.queued = { only: st.queued && st.queued.only == null ? null : only }; return; }
  const mode = st.mode, morning = mode === 'morning';
  if (morning) only = null;                                          // the next morning is always asked of everyone
  st.busy = true;
  setStatus(only ? 'Asking one person…' : 'Asking everyone…');
  $('askBtn').setAttribute('aria-busy', 'true');
  const started = performance.now();
  try {
    // One person is asked about the moment everyone last answered, whatever the controls say now.
    const one = Boolean(only && st.result && st.asked);
    const body = morning ? { scenario: st.morning.scenario } : { scenario: one ? st.asked : st.scenario, edits: st.edits };
    if (st.world) body.world = st.world;
    if (one) body.only = [only];
    const result = await api(morning ? '/api/room/morning' : '/api/room/ask', body);
    const ms = Math.round(performance.now() - started);
    setMode(result.live);
    const shown = st.mode === mode;                                  // the mode may have been switched while this was answered
    // The next morning: someone who has never been inside may still answer from the record when the change is not
    // in her record, so "nobody" there means no returning customer.
    const nobody = morning ? result.share.now == null : result.failed === result.people.length;
    if (result.people.length && nobody && (morning ? st.morning.result : st.result)) {
      // Nobody could answer: the last answers stay on screen, with the reason.
      if (shown) {
        setAsked('');
        setStatus(result.live
          ? `Jev did not answer${result.error ? ` (${result.error})` : ''}. These are still the last answers.`
          : 'That question has no saved answer, and there is no Jev key to ask it now. These are still the last answers.', true);
      }
    } else {
      if (morning) {
        st.morning.result = result;
      } else if (one) {
        const fresh = result.people[0];
        st.result.people = st.result.people.map(p => (p.id === fresh.id ? fresh : p));
        recomputeShare(st.result);
      } else {
        st.result = result;
        st.asked = structuredClone(body.scenario);
      }
      if (shown) {
        report(result, ms);
        render();
        if (!one) document.querySelector('.room').scrollTop = 0;    // a new answer for everyone starts at its headline
      }
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
  st.open = null;
  if (st.mode === 'morning') {
    st.morning.scenario = structuredClone(st.view.morning.defaults);
    syncMorning();
  } else {
    st.scenario = structuredClone(st.view.defaults);
    st.edits = {};
    syncControls();
  }
  ask();
}

// ---------- the two modes (docs/PROTOTYPE.md §17b) ----------
const first = name => name.split(' ')[0];
const listOf = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const dollars = x => `$${Number(x).toFixed(2)}`;
const agoWords = d => (d === 1 ? 'yesterday' : d % 7 === 0 ? `${d / 7} ${d === 7 ? 'week' : 'weeks'} ago` : `${d} days ago`);
const changeWords = d => (d === 0 ? 'the same' : `${d > 0 ? '+' : '−'}${Math.abs(d) < 1 ? `${Math.round(100 * Math.abs(d))}¢` : `$${Math.abs(d)}`}`);

// What the page says it is, under the headline. The next morning's limits come from the return probe (§20d).
function honestText() {
  const v = st.view;
  if (st.mode !== 'morning') return `${v.cast.length} simulated people answering through Jev, a decision model, not checked against real customers. One person counts as moved at ${points(v.noisePerson ?? 0.15)} points; smaller shifts happen with no real change.`;
  return `${v.cast.length} simulated people answering through Jev, a decision model. This is one morning’s decision for each of them, not a simulated week. Jev’s percentages sit too close to the middle: someone who rarely comes is given about 1.5 times the chance their visit count implies. So read which way a bar moves and who reacts, not how high it stands. One person counts as moved at ${points(v.morning.noisePerson)} points.`;
}

function syncMode() {
  const morning = st.mode === 'morning';
  $('modeCounter').setAttribute('aria-pressed', String(!morning));
  $('modeMorning').setAttribute('aria-pressed', String(morning));
  $('counterControls').hidden = morning;
  $('morningControls').hidden = !morning;
  $('nowKey').textContent = morning ? 'goes today' : 'chooses the shop now';
  $('honest').textContent = honestText();
}

// Each mode keeps its controls and its last answers. Those answers are shown at once and then asked again,
// which sends Jev nothing new when they are already on record.
function switchMode(mode) {
  if (!st.view || mode === st.mode || (mode === 'morning' && !st.view.morning)) return;
  st.mode = mode;
  st.open = null;
  $('people').replaceChildren();                    // the two modes draw a person's details differently
  const url = new URL(location.href);
  if (mode === 'morning') url.searchParams.set('mode', 'morning'); else url.searchParams.delete('mode');
  history.replaceState(null, '', url);
  syncMode();
  setAsked('');
  if (mode === 'morning' ? st.morning.result : st.result) render();
  else { $('sumLine').textContent = 'Asking everyone…'; $('sumSub').textContent = ''; }
  ask();
}

// One row of choices for the next morning: [value, label, title]. A click sets the value and asks at once.
const MORNING_ROWS = [['mWait', 'wait'], ['mOutcome', 'outcome'], ['mWhen', 'daysAgo'], ['mPrice', 'priceChange'], ['mCard', 'card'], ['mRemark', 'remark'], ['mRating', 'rating'], ['mMessage', 'message']];
function choiceRow(id, key, options) {
  const box = $(id);
  box.replaceChildren();
  for (const [value, label, title] of options) {
    const b = el('button', 'chip', label);
    b.type = 'button';
    b._value = value;
    if (title) b.title = title;
    b.addEventListener('click', () => {
      if (st.morning.scenario[key] === value) return;
      st.morning.scenario[key] = value;
      syncMorning();
      ask();
    });
    box.append(b);
  }
}

function buildMorning() {
  const m = st.view.morning, o = m.options, need = m.cardNeed;
  choiceRow('mWait', 'wait', o.wait.map(v => [v, String(v), v === 0 ? 'No line: served right away' : `Waited about ${v} minutes in line`]));
  choiceRow('mOutcome', 'outcome', o.outcome.map(v => [v, v === 'left' ? 'left without ordering' : 'was served']));
  choiceRow('mWhen', 'daysAgo', o.daysAgo.map(v => [v, agoWords(v)]));
  choiceRow('mPrice', 'priceChange', o.priceChange.map(v => [v, changeWords(v), v === 0 ? `${dollars(m.price)} today, and nothing said about last week` : `${dollars(m.price + v)} today; it was ${dollars(m.price)} last week`]));
  choiceRow('mCard', 'card', [[null, 'none'], ...o.card.map(v => [v, `${v} of ${need}`, `${v} of ${need} stamps filled`])]);
  choiceRow('mRemark', 'remark', [['', 'none'], ...o.remark.map(v => [v, v, m.remarks[v]])]);
  choiceRow('mRating', 'rating', [[null, 'none'], ...o.rating.map(v => [v, v.toFixed(1), `${v.toFixed(1)} out of 5 stars from online reviews`])]);
  choiceRow('mMessage', 'message', [['', 'none'], ...o.message.map(v => [v, `${Math.round(100 * m.dealOff)}% off today`, m.deal])]);
  $('morningHint').textContent = `Anything added to a record is compared with a plain version of it, never with nothing: a deal with a message that gives only the opening hours, a friend’s remark with one about something else, a changed price with “the same as last week”, a card with ${m.compare.card} of ${need} stamps, a rating with ${m.compare.rating.toFixed(1)} stars.`;
  syncMorning();
}

function syncMorning() {
  const s = st.morning.scenario;
  if (s.wait < 1) s.outcome = 'served';             // nobody leaves a line that was not there
  for (const [id, key] of MORNING_ROWS) {
    for (const b of $(id).children) b.setAttribute('aria-pressed', String(b._value === s[key]));
  }
  for (const b of $('mOutcome').children) b.disabled = b._value === 'left' && s.wait < 1;
}

// What is typed into a person's boxes is kept as it is typed, so either Ask button carries it.
function draft(id, key, value) {
  const v = value.trim(), e = (st.edits[id] ??= {});
  if (v && v !== original(id)[key]) e[key] = v; else delete e[key];
  if (!Object.keys(e).length) delete st.edits[id];
}

// ---------- results ----------
function render() {
  if (st.mode === 'morning') renderMorning(); else renderCounter();
}

function renderCounter() {
  const r = st.result;
  if (!r) return;
  const home = place(r.shop), sum = summarize(r);
  renderSummary(sum, home);
  $('tickKey').textContent = sum.withSign ? 'with a plain sign' : 'before';
  $('smallKey').textContent = `under ${points(sum.noisePerson)} points: too small to tell`;
  drawPeople(st.sortByChange ? byChange(r.people, sum.id, sum.withSign) : r.people, (li, p) => updatePerson(li, p, sum, home));
}

// The list of people in the given order. A person's row is kept from one answer to the next.
function drawPeople(shown, update) {
  const list = $('people');
  const existing = new Map([...list.children].map(li => [li.dataset.id, li]));
  shown.forEach((p, i) => {
    const li = existing.get(p.id) || personNode(p);
    existing.delete(p.id);
    update(li, p);
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
  if (sum.unchanged) {
    big.append(`Right now ${home.name} gets `, el('b', null, pct(sum.to)), ` of these ${sum.asked} people.`);
    parts.push('Change the sign, the price or the line, and see who moves.');
  } else if (sum.flat && sum.movers.length) {
    // The room's total hides it, so the people come first.
    const named = sum.movers.slice(0, 4);
    named.forEach((m, i) => {
      if (i) big.append(', ');
      big.append(el('b', m.d > 0 ? 'up' : 'down', `${first(m.p.name)} ${signed(m.d)}`));
      if (m.p.edited) big.append(' (rewritten)');
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
  row.addEventListener('click', () => { st.open = st.open === p.id ? null : p.id; render(); });
  li.append(row);
  return li;
}

// One person's bar: the chance now, a tick at the chance it is compared with, and the change between them in
// color, or in grey when it is under the bar for one person. Returns the change in words.
function drawMeter(li, now, was, sum) {
  const fill = li.querySelector('.fill'), delta = li.querySelector('.delta'), tick = li.querySelector('.tick');
  const pctEl = li.querySelector('.pct'), chg = li.querySelector('.chg');
  const d = now - was, g = grade(d, sum.noise, sum.noisePerson);
  fill.style.width = `${100 * Math.min(now, was)}%`;
  delta.style.left = `${100 * Math.min(now, was)}%`;
  delta.style.width = `${g === 'none' ? 0 : 100 * Math.abs(d)}%`;
  delta.className = `delta ${g === 'small' ? 'small' : d > 0 ? 'up' : 'down'}`;
  tick.style.left = `${100 * was}%`;
  pctEl.textContent = pct(now);
  chg.textContent = g === 'none' ? 'no change' : `${signed(d)} pts`;
  chg.className = `chg ${g === 'none' ? '' : g}`;
  if (g === 'small') chg.title = `Under ${points(sum.noisePerson)} points: one person’s answer can shift this much when nothing real changes.`; else chg.removeAttribute('title');
  return g === 'none' ? 'no change' : `${d > 0 ? 'up' : 'down'} ${Math.abs(points(d))} points${g === 'small' ? ', too small to tell' : ''}`;
}

function noAnswer(li, p) {
  const pctEl = li.querySelector('.pct'), chg = li.querySelector('.chg');
  pctEl.textContent = 'n/a'; chg.textContent = 'no answer'; chg.className = 'chg failed'; chg.removeAttribute('title');
  li.querySelector('.row').setAttribute('aria-label', `${p.name}: no answer. Show details.`);
}

function updatePerson(li, p, sum, home) {
  const id = sum.id, row = li.querySelector('.row');
  const name = li.querySelector('.name');
  name.replaceChildren(p.name, el('span', 'age', String(p.age)), el('span', 'group', p.group));
  if (p.edited) name.append(el('span', 'edited', 'rewritten'));
  const feel = li.querySelector('.feel');
  feel.textContent = p.personality || '';
  feel.title = p.bio || '';
  const meter = li.querySelector('.meter');
  const ref = refOf(p, sum.withSign), ok = Boolean(p.now && ref);
  meter.classList.toggle('empty', !ok);
  if (!ok) {
    noAnswer(li, p);
  } else {
    const now = clamp01(p.now[id]), said = drawMeter(li, now, clamp01(ref.probs[id]), sum);
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
  const inputs = {};
  for (const [key, label] of FIELDS) {
    const lab = el('label', null, label);
    const ta = el('textarea'); ta.rows = key === 'bio' ? 3 : 2; ta.maxLength = st.view.limits.text;
    ta.addEventListener('input', () => draft(personId, key, ta.value));
    lab.append(ta); right.append(lab); inputs[key] = ta;
  }
  const actions = el('div', 'actions');
  const go = el('button', 'btn primary', 'Ask this person'); go.type = 'button';
  go.addEventListener('click', () => ask(personId));
  const undo = el('button', 'btn', 'Restore'); undo.type = 'button';
  undo.addEventListener('click', () => { delete st.edits[personId]; for (const [key] of FIELDS) inputs[key].value = original(personId)[key] || ''; ask(personId); });
  actions.append(go, undo);
  right.append(actions, el('p', 'note', 'The three boxes are read together. Change the words and ask again: Jev reads them each time, and no answer on this page was written by us.'));
  wrap.append(left, right);
  return { wrap, left, inputs };
}

function updateDetail(detail, p, sum, home, ref) {
  for (const [key] of FIELDS) {
    const ta = detail.inputs[key], want = st.edits[p.id]?.[key] ?? original(p.id)[key] ?? '';
    if (document.activeElement !== ta && ta.value.trim() !== want) ta.value = want;
  }
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

// ---------- results: the next morning (docs/PROTOTYPE.md §17b) ----------
function renderMorning() {
  const r = st.morning.result;
  if (!r) return;
  const home = place(r.shop), sum = morningSummary(r);
  renderMorningSummary(sum, home, r);
  $('tickKey').textContent = 'the ordinary morning';
  $('smallKey').textContent = `under ${points(sum.noisePerson)} points: too small to tell`;
  drawPeople(st.sortByChange ? byMorningChange(r.people) : r.people, (li, p) => updateMorningPerson(li, p, sum, home));
}

// The plain sentences the comparison carries, in the headline's words.
function plainWords(compare) {
  const m = st.view.morning, out = [];
  if (compare.price) out.push(`the price given as “${compare.price}”`);
  if (compare.card) out.push(`a stamp card at ${m.compare.card} of ${m.cardNeed}`);
  if (compare.remark) out.push('a friend’s remark about something else');
  if (compare.rating) out.push(`a rating of ${m.compare.rating.toFixed(1)} stars`);
  if (compare.message) out.push('a message from the shop with no offer');
  return out;
}

function renderMorningSummary(sum, home, r) {
  const big = $('sumLine'), sub = $('sumSub');
  big.replaceChildren();
  if (!sum.answered) { big.textContent = 'Nobody could answer.'; sub.textContent = ''; return; }
  const who = sum.regulars === 1 ? 'this 1 returning customer' : `these ${sum.regulars} returning customers`;
  const parts = [];
  if (sum.unchanged) {
    big.append(`The next morning ${home.name} gets `, el('b', null, pct(sum.to)), ` of ${who}.`);
    const memory = r.people.find(p => p.returning)?.told.before.memory[0];
    parts.push(`This is the ordinary morning${memory ? `: each of them remembers “${memory}”` : '.'}`);
    parts.push('Change what they remember or what they are told today, and see who comes back.');
  } else if (sum.flat && sum.movers.length) {
    // The room's total hides it, so the people come first.
    const named = sum.movers.slice(0, 4);
    named.forEach((m, i) => {
      if (i) big.append(', ');
      big.append(el('b', m.d > 0 ? 'up' : 'down', `${first(m.p.name)} ${signed(m.d)}`));
    });
    const rest = sum.asked - named.length;
    big.append(named.length < sum.movers.length ? ` and ${sum.movers.length - named.length} more moved.` : ' moved.');
    if (named.length === sum.movers.length && rest > 0) big.append(` The other ${rest} did not.`);
    parts.push(`${home.name} still gets about ${pct(sum.to)} of ${who} (${pct(sum.from)} on the ordinary morning).`);
  } else {
    const d = sum.to - sum.from;
    big.append(`${home.name} gets `, el('b', sum.flat ? null : d > 0 ? 'up' : 'down', pct(sum.to)), ` of ${who}`);
    big.append(sum.flat ? ', about the same as on the ordinary morning.' : `, ${d > 0 ? 'up' : 'down'} from ${pct(sum.from)}.`);
    // The four largest by name, and how many more there are.
    const list = dir => {
      const all = sum.movers.filter(m => (m.d > 0) === dir), named = all.slice(0, 4).map(m => `${first(m.p.name)} (${signed(m.d)})`);
      return all.length > named.length ? `${named.join(', ')} and ${all.length - named.length} more` : named.join(', ');
    };
    const lost = list(false), won = list(true);
    if (lost) parts.push(`Less likely: ${lost}.`);
    if (won) parts.push(`More likely: ${won}.`);
    parts.push(!sum.movers.length ? `No one moved by ${points(sum.noisePerson)} points or more.` : sum.still ? `${sum.still} of ${sum.asked} did not move.` : `All ${sum.asked} moved.`);
  }
  const plain = plainWords(sum.compare);
  if (plain.length) parts.push(`Each bar is compared with the ordinary morning plus ${listOf(plain)}, because any added sentence nudges the answers.`);
  sub.textContent = parts.join(' ');
}

const NEVER_NOTE = 'Has never been inside, so the last visit, last week’s price and a stamp card do not apply.';

function updateMorningPerson(li, p, sum, home) {
  const row = li.querySelector('.row'), name = li.querySelector('.name');
  const visits = p.returning ? `, ${p.visits} ${p.visits === 1 ? 'visit' : 'visits'} in ${st.view.morning.weeks} weeks` : '';
  name.replaceChildren(p.name, el('span', 'age', String(p.age)), el('span', 'group', `${p.group}${visits}`));
  if (!p.returning) name.append(el('span', 'never', 'never been'));
  const feel = li.querySelector('.feel');
  feel.textContent = p.personality || '';
  feel.title = p.bio || '';
  const meter = li.querySelector('.meter'), pctEl = li.querySelector('.pct'), chg = li.querySelector('.chg');
  const skip = p.applies === false, ok = p.now != null && p.before != null;
  // The page changed only things that are not in this person's record: say so, and draw no bar.
  meter.classList.toggle('skip', skip);
  meter.classList.toggle('empty', skip || !ok);
  let why = meter.querySelector('.why');
  if (skip && !why) { why = el('span', 'why', NEVER_NOTE); meter.append(why); }
  if (!skip && why) why.remove();
  if (skip) {
    pctEl.textContent = ''; chg.textContent = 'does not apply'; chg.className = 'chg'; chg.removeAttribute('title');
    row.setAttribute('aria-label', `${p.name}: ${NEVER_NOTE} Show details.`);
  } else if (!ok) {
    noAnswer(li, p);
  } else {
    const now = clamp01(p.now), said = drawMeter(li, now, clamp01(p.before), sum);
    row.setAttribute('aria-label', `${p.name}: ${pct(now)} likely to go to ${home.name} today, ${said}. Show details.`);
  }
  const open = st.open === p.id;
  row.setAttribute('aria-expanded', String(open));
  li._detail?.wrap.remove();
  li._detail = open ? morningDetail(p, sum, home) : null;
  if (open) li.append(li._detail.wrap);
}

// One record as the person was told it, and the chance Jev gave for it.
function toldColumn(title, told, chance, home) {
  const col = el('div');
  col.append(el('h3', null, title));
  const box = el('div', 'told');
  box.append(el('p', null, `${told.time[0].toUpperCase()}${told.time.slice(1)}. ${told.now}`));
  for (const line of [told.history, ...told.memory, told.card]) if (line) box.append(el('p', null, line));
  for (const line of [...told.heard, ...told.offers]) box.append(el('p', 'sign', line));
  const cost = el('p', 'place');
  cost.append(el('b', null, home.name), `: ${told.cost}${told.rating ? `; ${told.rating}` : ''}.`);
  box.append(cost);
  for (const other of told.others) {
    const line = el('p', 'place');
    line.append(el('b', null, other.name), `: ${other.cost}.`);
    box.append(line);
  }
  col.append(box);
  if (chance != null) {
    const split = el('div', 'split'), bar = el('span', 'bar'), i = el('i');
    i.style.width = `${100 * clamp01(chance)}%`;
    bar.append(i);
    split.append(el('span', 'lab', 'Goes today'), bar, el('span', 'val', pct(chance)));
    col.append(split);
  }
  return col;
}

function morningDetail(p, sum, home) {
  const wrap = el('div', 'detail pair');
  const left = toldColumn('What they were told this morning', p.told.now, p.now, home);
  if (p.partly) left.append(el('p', 'note', `${first(p.name)} has never been inside, so the last visit, last week’s price and a stamp card are not in this record. The bar shows what the rest did.`));
  let right;
  if (p.applies === false) {
    right = el('div');
    right.append(el('h3', null, 'What it is compared with'), el('p', 'note', `Nothing the page changed is in this record: ${first(p.name)} has never been inside, so there is no last visit, no last week’s price and no stamp card.`));
  } else if (sum.unchanged) {
    right = el('div');
    right.append(el('h3', null, 'What it is compared with'), el('p', 'note', 'Nothing has been changed yet, so there is nothing to compare this with.'));
  } else {
    right = toldColumn('What it is compared with', p.told.before, p.before, home);
  }
  wrap.append(left, right);
  return { wrap };
}

// ---------- start ----------
async function start() {
  langButton($('langBtn'));
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
  $('modeCounter').addEventListener('click', () => switchMode('counter'));
  $('modeMorning').addEventListener('click', () => switchMode('morning'));
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
  // The next morning needs a pool file for the world (who comes how often). Without one the mode is not offered.
  if (st.view.morning) {
    st.morning.scenario = structuredClone(st.view.morning.defaults);
    buildMorning();
    if (new URLSearchParams(location.search).get('mode') === 'morning') st.mode = 'morning';
  } else {
    $('modeMorning').disabled = true;
    $('modeMorning').title = 'This world has no pool file, so there is nobody to ask the next morning.';
  }
  syncMode();
  ask();
}

start();
