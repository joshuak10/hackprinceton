// The "Tell Jev what just happened, and ask again" box in the person view (docs/PROTOTYPE.md §9c). It is one node that
// the inspector keeps across its redraws, so what is typed, and the last answer, stay while the replay runs.
// The words come from ask-again.js; asking is done by the caller (onAsk).
import { el } from './panels.js';
import { ASK_PRESETS, askRows, askWords, rowWords } from './ask-again.js';

// onAsk(decisionId, sentence) -> Promise<result from POST /api/runs/:id/agents/:agentId/ask>
export function createAskPanel({ onAsk }) {
  const node = el('div', 'ask-again');
  const S = { key: null, decision: null, question: '', busy: false, result: null, error: '', asked: '' };

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
    if (S.busy) { out.replaceChildren(el('p', 'hint', 'Asking Jev twice: once as it was, once with your sentence…')); return; }
    if (S.error) { out.replaceChildren(el('p', 'hint warn', S.error)); return; }
    if (!S.result) { out.replaceChildren(); return; }
    const words = askWords(S.decision, S.result, { question: S.question });
    if (!words) { out.replaceChildren(el('p', 'hint warn', 'Jev did not answer.')); return; }
    const table = el('table', 'vt saved');
    const thead = el('thead'), hr = el('tr');
    for (const [i, text] of ['', 'That evening', 'Asked again', 'With your sentence'].entries()) {
      const th = el(i ? 'th' : 'td', null, text);
      if (i) th.scope = 'col';
      hr.append(th);
    }
    thead.append(hr);
    const tbody = el('tbody');
    for (const r of askRows(S.decision, S.result).map(rowWords)) {
      const tr = el('tr');
      const th = el('th', null, r.label);
      th.scope = 'row';
      tr.append(th, el('td', null, r.recorded), el('td', null, r.again), el('td', 'delta strong', r.changed));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    out.replaceChildren(
      el('p', 'ask-said', `“${S.asked}”`),
      el('p', `why ask-${words.size}`, words.headline),
      words.feeling ? el('p', 'hint', words.feeling) : document.createTextNode(''),
      table,
      el('p', 'hint', words.note)
    );
  }

  async function ask() {
    const text = input.value.trim();
    if (S.busy || !S.decision) return;
    if (text.length < 3) { S.error = 'Write a few words about what happened first.'; S.result = null; drawOut(); return; }
    const key = S.key;
    Object.assign(S, { busy: true, error: '', result: null, asked: text });
    drawOut();
    try {
      const result = await onAsk(S.decision.id, text);
      if (S.key !== key) return;                       // another person or another choice is on screen now
      S.result = result;
    } catch (err) {
      if (S.key !== key) return;
      S.error = err?.message || 'Jev could not be asked.';
    } finally {
      if (S.key === key) { S.busy = false; drawOut(); }
    }
  }
  form.addEventListener('submit', e => { e.preventDefault(); ask(); });

  return {
    node,
    input,
    // decision: the choice to ask again (targetChoice), or null to hide the box. key: person and choice.
    // when: "7:03 pm". question: "Keep waiting at Table?". why: shown in place of the form when asking is not possible.
    update({ key, decision, when = '', question = '', why = '' }) {
      node.hidden = !decision;
      if (!decision) { S.key = null; S.decision = null; return; }
      if (S.key !== key) {
        Object.assign(S, { key, decision, question, busy: false, result: null, error: '', asked: '' });
        input.value = '';
        drawOut();
      }
      which.textContent = why || `Their choice at ${when}: ${question} Add one sentence and see whether the answer, and how they feel, moves.`;
      form.hidden = Boolean(why);
      presets.hidden = Boolean(why);
    }
  };
}
