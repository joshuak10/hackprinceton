// The "Tell Jev what just happened, and ask again" box in the person view (docs/PROTOTYPE.md §9c). It is one node
// that the inspector keeps across its redraws, so what is typed, and the last answer, stay while the replay runs.
// The words come from ask-again.js; asking is done by the caller (onAsk, onAskAll).
import { el } from './panels.js';
import { ASK_PRESETS, askRows, askWords, rowWords, everyoneRows } from './ask-again.js';

const table = (head, rows) => {
  const t = el('table', 'vt saved');
  const thead = el('thead'), hr = el('tr');
  for (const [i, text] of head.entries()) {
    const th = el(i ? 'th' : 'td', null, text);
    if (i) th.scope = 'col';
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el('tbody');
  for (const cells of rows) {
    const tr = el('tr');
    cells.forEach((cell, i) => {
      // A cell is a string, or { text, sub, cls }.
      const c = typeof cell === 'object' && cell ? cell : { text: cell };
      if (i === 0) {
        const th = el('th', null, c.text);
        th.scope = 'row';
        if (c.sub) th.append(el('span', 'ask-sub', c.sub));
        tr.append(th);
      } else tr.append(el('td', c.cls || null, c.text));
    });
    tbody.append(tr);
  }
  t.append(thead, tbody);
  return t;
};

// onAsk(decisionId, sentence) -> Promise<result of POST /api/runs/:id/agents/:agentId/ask>
// onAskAll(sentence) -> Promise<[{ name, about, result }]>: the same sentence asked of one of each kind of diner
export function createAskPanel({ onAsk, onAskAll }) {
  const node = el('div', 'ask-again');
  const S = { key: null, decision: null, busy: false, result: null, error: '', asked: '', all: null, allBusy: false, allError: '', backLabel: undefined };

  const title = el('h3', 'insp-sec', 'Tell Jev what just happened, and ask again');
  const which = el('p', 'hint');
  const form = el('form');
  form.autocomplete = 'off';
  const input = el('input');
  input.type = 'text';
  input.maxLength = 240;
  input.placeholder = 'What has just happened to them?';
  input.setAttribute('aria-label', 'What has just happened to this person');
  const go = el('button', 'btn small', 'Ask again');
  go.type = 'submit';
  form.append(input, go);
  const presets = el('div', 'presets');
  for (const text of ASK_PRESETS) {
    const b = el('button', 'btn quiet small', text);
    b.type = 'button';
    b.addEventListener('click', () => { input.value = text; ask(); });
    presets.append(b);
  }
  const out = el('div', 'ask-out');
  out.setAttribute('role', 'status');
  node.append(title, which, form, presets, out);

  function drawOut() {
    go.disabled = S.busy;
    if (S.busy) { out.replaceChildren(el('p', 'hint', 'Asking Jev: once as it is, once with your sentence…')); return; }
    if (S.error) { out.replaceChildren(el('p', 'hint warn', S.error)); return; }
    if (!S.result) { out.replaceChildren(); return; }
    const opts = { backLabel: S.backLabel };
    const words = askWords(S.result, opts);
    if (!words) { out.replaceChildren(el('p', 'hint warn', 'Jev did not answer.')); return; }
    const rows = askRows(S.result, opts).map(rowWords);
    const everyone = el('button', 'btn small', S.allBusy ? 'Asking every diner…' : 'Ask every diner the same');
    everyone.type = 'button';
    everyone.disabled = S.allBusy;
    everyone.addEventListener('click', askAll);
    const parts = [
      el('p', 'ask-said', `“${S.asked}”`),
      el('p', `why ask-${words.size}`, words.headline),
      words.feeling ? el('p', 'ask-feel', words.feeling) : null,
      table(['', 'Without it', 'With your sentence', 'Change'], rows.map(r => [r.label, r.again, r.changed, { text: r.change, cls: 'delta' + (r.size === 'clear' ? ' strong' : '') }])),
      el('p', 'hint', words.note),
      onAskAll ? everyone : null
    ];
    if (S.allError) parts.push(el('p', 'hint warn', S.allError));
    if (S.all) {
      const list = everyoneRows(S.all);
      parts.push(
        el('p', 'ask-all-head', 'The same sentence, one of each diner: stays to eat here tonight'),
        table(['', 'Without', 'With', 'Feels'], list.map(r => [{ text: r.name, sub: r.about }, r.again, { text: `${r.changed} (${r.change})`, cls: 'delta' + (r.size === 'clear' ? ' strong' : '') }, r.feeling])),
        el('p', 'hint', 'Each is asked at their own moment in the evening. Who moves, and who does not, depends on who they are.')
      );
    }
    out.replaceChildren(...parts.filter(Boolean));
  }

  async function ask() {
    const text = input.value.trim();
    if (S.busy || !S.decision) return;
    if (text.length < 3) { Object.assign(S, { error: 'Write a few words about what happened first.', result: null, all: null }); drawOut(); return; }
    const key = S.key;
    Object.assign(S, { busy: true, error: '', result: null, asked: text, all: null, allError: '' });
    drawOut();
    try {
      const result = await onAsk(S.decision.id, text);
      if (S.key !== key) return;                       // another person or another moment is on screen now
      S.result = result;
    } catch (err) {
      if (S.key !== key) return;
      S.error = err?.message || 'Jev could not be asked.';
    } finally {
      if (S.key === key) { S.busy = false; drawOut(); }
    }
  }
  async function askAll() {
    if (S.allBusy || !S.asked) return;
    const key = S.key, text = S.asked;
    Object.assign(S, { allBusy: true, allError: '' });
    drawOut();
    try {
      const list = await onAskAll(text);
      if (S.key !== key || S.asked !== text) return;
      S.all = list;
    } catch (err) {
      if (S.key === key) S.allError = err?.message || 'The other diners could not be asked.';
    } finally {
      if (S.key === key) { S.allBusy = false; drawOut(); }
    }
  }
  form.addEventListener('submit', e => { e.preventDefault(); ask(); });

  return {
    node,
    input,
    // decision: the moment to ask about (targetChoice), or null to hide the box. key: person and moment.
    // when: "7:03 pm". situation: what they were told was happening. why: shown in place of the form when asking
    // is not possible. backLabel: "Comes back next Friday".
    update({ key, decision, when = '', situation = '', why = '', backLabel }) {
      node.hidden = !decision;
      if (!decision) { S.key = null; S.decision = null; return; }
      S.backLabel = backLabel;
      if (S.key !== key) {
        Object.assign(S, { key, decision, busy: false, result: null, error: '', asked: '', all: null, allBusy: false, allError: '' });
        input.value = '';
        drawOut();
      }
      which.textContent = why || `At ${when}: ${situation} Add one sentence and see whether what they do, and how they feel, changes.`;
      form.hidden = Boolean(why);
      presets.hidden = Boolean(why);
    }
  };
}
