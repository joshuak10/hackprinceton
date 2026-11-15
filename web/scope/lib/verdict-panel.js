// The verdict panel at the top of the side panel (docs/PROTOTYPE.md §9b). It answers "did the change help?".
// Before a test: the worst line (or, at the sushi restaurant, who left without a seat) in words and one button.
// After: the verdict in customers kept, a before / after / change table, one sentence of why, and the Baseline /
// change toggle. For a changed room (§18): how it did against the room as sketched. No dialog.
// The words and numbers come from lib/verdict.js and lib/layout.js; this file only builds the DOM.
import { el } from './panels.js';
import { cellWords } from './verdict.js';

// onTest(): start the test. onCancel(): stop waiting for it. onPick(runId): show that run on the map.
export function createVerdict(root, { onTest, onCancel, onPick }) {
  let runningNodes = null;

  // Swap the panel's content. If keyboard focus was inside, it moves to the new first button, not to the page.
  function set(nodes) {
    const had = root.contains(document.activeElement);
    runningNodes = null;
    root.replaceChildren(...nodes.filter(Boolean));
    if (had) root.querySelector('button[aria-pressed="true"], button')?.focus();
  }
  const action = (cls, text, fn) => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };
  // "On the map: [Baseline | +1 staff]". sides: [[runId, label], [runId, label]]; selected: the run on screen.
  function toggle(sides, selected) {
    const pick = el('div', 'onmap');
    pick.append(el('span', 'hint', 'On the map'));
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Run shown on the map');
    for (const [id, text] of sides) {
      const b = action('', text, () => { if (id !== selected) onPick(id); });
      b.setAttribute('aria-pressed', String(id === selected));
      seg.append(b);
    }
    pick.append(seg);
    return pick;
  }

  return {
    clear() { set([]); },

    message(text) { set([el('p', 'hint', text)]); },

    // words: { headline, why, offer? } from worstLineWords or promotionWords; test: testWords for the change.
    before({ words, test, canTest, cannotWhy, note }) {
      set([
        el('h2', null, words.headline),
        el('p', 'why', words.why),
        words.offer ? el('p', 'offer', words.offer) : null,
        canTest ? action('btn solid', test.action, onTest) : null,
        el('p', 'hint', canTest ? test.plan : cannotWhy),
        note ? el('p', 'hint', note) : null
      ]);
    },

    // step: the sentence for the run in progress; done of total runs finished.
    running({ title, step, done, total }) {
      if (!runningNodes) {
        const h = el('h2', null, title);
        const line = el('p', 'why');
        const bar = el('progress');
        bar.max = total;
        bar.setAttribute('aria-label', 'Test progress');
        const cancel = action('btn', 'Cancel', onCancel);
        set([h, line, bar, cancel, el('p', 'hint', 'You can keep watching the map while it runs.')]);
        runningNodes = { line, bar };
      }
      runningNodes.line.textContent = step;
      runningNodes.bar.value = done;
    },

    failed({ again, message }) {
      set([
        el('h2', null, 'The test did not finish'),
        el('p', 'why', message),
        action('btn solid', again, onTest)
      ]);
    },

    // words: { tone, headline, detail } from verdictWords; rows from testResult; why from whySentence;
    // toggle: { baseline, change (run ids), labels: [baseline, change], selected (run id on screen), note }.
    after({ words, rows, runs, why, toggle: t }) {
      const table = el('table', 'vt');
      const cap = el('caption', null, `Averages over the ${runs} test runs, whole run`);
      const thead = el('thead'), hr = el('tr');
      for (const [i, text] of ['', 'Before', 'After', 'Change'].entries()) {
        const th = el(i ? 'th' : 'td', null, text);
        if (i) th.scope = 'col';
        hr.append(th);
      }
      thead.append(hr);
      const tbody = el('tbody');
      for (const r of rows) {
        const tr = el('tr');
        const th = el('th', null, r.label);
        th.scope = 'row';
        const delta = el('td', 'delta' + (r.strong && Math.round(r.change || 0) !== 0 ? ' strong' : ''), cellWords(r.kind, r.change, true));
        tr.append(th, el('td', null, cellWords(r.kind, r.before)), el('td', null, cellWords(r.kind, r.after)), delta);
        tbody.append(tr);
      }
      table.append(cap, thead, tbody);

      const whyP = el('p', 'why');
      whyP.append(el('b', null, 'Why: '), document.createTextNode(why));

      set([
        el('h2', `tone-${words.tone}`, words.headline),
        el('p', 'detail', words.detail),
        table,
        whyP,
        toggle([[t.baseline, t.labels[0]], [t.change, t.labels[1]]], t.selected),
        t.note ? el('p', 'hint', t.note) : null
      ]);
    },

    // A changed room against the room as sketched (layout.js compareParts). change: what was moved, in words.
    // toggle: { sketched, mine (run ids, same seed and decision-maker), selected } or null when there is no pair.
    room({ headline, detail, change, toggle: t }) {
      set([
        el('h2', null, headline),
        detail ? el('p', 'detail', detail) : null,
        change ? el('p', 'why', change) : null,
        t ? toggle([[t.sketched, 'As sketched'], [t.mine, 'Your room']], t.selected) : null
      ]);
    }
  };
}
