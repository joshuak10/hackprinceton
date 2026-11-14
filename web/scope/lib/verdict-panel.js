// The verdict panel at the top of the side panel (docs/PROTOTYPE.md §9b). It answers "did the change help?".
// Before a test: the worst line in words and one button. After: the verdict in customers kept, a
// before / after / change table, one sentence of why, and the Baseline / +1 staff toggle. No dialog.
// The words and numbers come from lib/verdict.js; this file only builds the DOM.
import { el } from './panels.js';
import { cellWords, changeWords } from './verdict.js';

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

  return {
    clear() { set([]); },

    message(text) { set([el('p', 'hint', text)]); },

    // words: { headline, why } from worstLineWords; change from staffChange.
    before({ words, change, canTest, cannotWhy, note }) {
      set([
        el('h2', null, words.headline),
        el('p', 'why', words.why),
        canTest ? action('btn solid', `Test ${changeWords(change)} here`, onTest) : null,
        el('p', 'hint', canTest
          ? `Plays the same lunch 3 times with ${change.from} staff and 3 times with ${change.to}, using the rule model. It takes a few seconds.`
          : cannotWhy),
        note ? el('p', 'hint', note) : null
      ]);
    },

    running({ change, done, total }) {
      if (!runningNodes) {
        const h = el('h2', null, `Testing ${changeWords(change)} at ${change.nodeName}`);
        const step = el('p', 'why');
        const bar = el('progress');
        bar.max = total;
        bar.setAttribute('aria-label', 'Test progress');
        const cancel = action('btn', 'Cancel', onCancel);
        set([h, step, bar, cancel, el('p', 'hint', 'You can keep watching the map while it runs.')]);
        runningNodes = { step, bar };
      }
      const side = done % 2 === 0 ? `${change.from} staff` : `${change.to} staff`;
      runningNodes.step.textContent = `Run ${Math.min(total, done + 1)} of ${total}: the lunch with ${side}.`;
      runningNodes.bar.value = done;
    },

    failed({ change, message }) {
      set([
        el('h2', null, 'The test did not finish'),
        el('p', 'why', message),
        action('btn solid', `Test ${changeWords(change)} again`, onTest)
      ]);
    },

    // words: { tone, headline, detail } from verdictWords; rows from testResult; why from whySentence;
    // toggle: { baseline, change (run ids), selected (run id on screen), note }.
    after({ words, rows, runs, why, change, toggle }) {
      const table = el('table', 'vt');
      const cap = el('caption', null, `Averages over the ${runs} test runs, whole run`);
      const thead = el('thead'), hr = el('tr');
      for (const [i, t] of ['', 'Before', 'After', 'Change'].entries()) {
        const th = el(i ? 'th' : 'td', null, t);
        if (i) th.scope = 'col';
        hr.append(th);
      }
      thead.append(hr);
      const tbody = el('tbody');
      for (const r of rows) {
        const tr = el('tr');
        const th = el('th', null, r.label);
        th.scope = 'row';
        const delta = el('td', 'delta' + (r.label.startsWith('Walked away') && Math.round(r.change || 0) !== 0 ? ' strong' : ''), cellWords(r.kind, r.change, true));
        tr.append(th, el('td', null, cellWords(r.kind, r.before)), el('td', null, cellWords(r.kind, r.after)), delta);
        tbody.append(tr);
      }
      table.append(cap, thead, tbody);

      const whyP = el('p', 'why');
      whyP.append(el('b', null, 'Why: '), document.createTextNode(why));

      const pick = el('div', 'onmap');
      pick.append(el('span', 'hint', 'On the map'));
      const seg = el('div', 'seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Run shown on the map');
      for (const [id, text] of [[toggle.baseline, `Baseline (${change.from} staff)`], [toggle.change, `${changeWords(change)}`]]) {
        const b = action('', text, () => { if (id !== toggle.selected) onPick(id); });
        b.setAttribute('aria-pressed', String(id === toggle.selected));
        seg.append(b);
      }
      pick.append(seg);

      set([
        el('h2', `tone-${words.tone}`, words.headline),
        el('p', 'detail', words.detail),
        table,
        whyP,
        pick,
        toggle.note ? el('p', 'hint', toggle.note) : null
      ]);
    }
  };
}
