// The owner's view (docs/PROTOTYPE.md §21g): the period, the change to try, and today next to the change in four
// numbers. And, for a period longer than one day, the chart that takes the map's place. The numbers and words come
// from owner.js; this file only builds the DOM.
import { el } from './panels.js';

const seg = (label, items, selected, onPick) => {
  const g = el('div', 'seg owner-seg');
  g.setAttribute('role', 'group');
  g.setAttribute('aria-label', label);
  for (const it of items) {
    const b = el('button', null, it.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(it.id === selected));
    b.addEventListener('click', () => { if (it.id !== selected) onPick(it.id); });
    g.append(b);
  }
  return g;
};

// root: the panel at the top of the side panel. onPeriod(n), onChange(id), onTry(text), onDetails(), onPromo().
export function createOwner(root, { onPeriod, onChange, onTry, onDetails, onPromo }) {
  return {
    // periods: [{ n, label }]; changes: [{ id, short }]; rows from figureRows; missing: { text, command } when the
    // change has no saved result here. promo: label of the quiet step to the promotion test, or ''.
    // tryText: what the text box holds (the change in words). busy: the sentence being run, or ''. error: why the
    // last try failed. understood: how a typed sentence was read.
    show({ periods, n, changes, change, title, headline, rows, caution, missing = null, details = false, promo = '', tryText = '', busy = '', error = '', understood = '' }) {
      const had = root.contains(document.activeElement) ? document.activeElement.textContent : null;
      const head = el('div', 'owner-head');
      head.append(el('p', 'owner-label', 'Over'), seg('Period', periods.map(p => ({ id: p.n, label: p.label })), n, onPeriod));
      const pick = el('div', 'owner-head');
      pick.append(el('p', 'owner-label', 'Try'), seg('Change to try', changes.map(c => ({ id: c.id, label: c.short })), change, onChange));

      // The change in the owner's own words: it starts as the suggestion, and Enter runs whatever is typed.
      const form = el('form', 'owner-try');
      form.autocomplete = 'off';
      const input = el('input');
      input.type = 'text';
      input.maxLength = 160;
      input.value = busy || tryText;
      input.disabled = Boolean(busy);
      input.setAttribute('aria-label', 'The change to try, in your own words');
      input.placeholder = 'Type a change, for example: three more seats';
      const go = el('button', 'btn small', 'Try it');
      go.type = 'submit';
      go.disabled = Boolean(busy);
      form.append(input, go);
      form.addEventListener('submit', e => { e.preventDefault(); if (input.value.trim()) onTry(input.value.trim()); });

      const parts = [head, pick, form];
      if (busy) {
        parts.push(el('h2', 'owner-headline', 'Running two months with Jev…'), el('p', 'hint', 'The same customers, the same Fridays, with your change. This takes about three minutes and costs about ten cents.'), el('progress', 'owner-progress'), el('p', 'hint owner-progress-line', 'Starting.'));
        root.replaceChildren(...parts);
        return;
      }
      if (error) parts.push(el('p', 'hint warn', error));
      if (understood) parts.push(el('p', 'hint', `Read as: ${understood}.`));
      if (missing) {
        parts.push(el('h2', null, missing.text), el('p', 'hint', 'Run it once (a few minutes, about 10 cents with Jev) and reload:'), el('pre', 'cmd', missing.command));
      } else {
        parts.push(el('h2', 'owner-headline', headline));
        const cols = el('div', 'owner-cols');
        const col = (name, key, cls) => {
          const c = el('div', `owner-col ${cls}`);
          c.append(el('h3', null, name));
          for (const r of rows) {
            const f = el('div', 'owner-fig');
            f.append(el('p', 'owner-fig-label', r.label), el('p', 'owner-fig-num', r[key]));
            if (key === 'after') f.append(el('p', 'owner-fig-change' + (r.moved ? ' moved' : ''), r.change));
            c.append(f);
          }
          return c;
        };
        cols.append(col('Today', 'base', 'before'), col(title, 'after', 'after'));
        parts.push(cols, el('p', 'hint', caution));
      }
      const foot = el('div', 'owner-foot');
      const more = el('button', 'btn quiet small', details ? 'Hide the detail' : 'Show the evening in detail');
      more.type = 'button';
      more.setAttribute('aria-expanded', String(details));
      more.addEventListener('click', onDetails);
      foot.append(more);
      if (promo) {
        const p = el('button', 'btn quiet small', promo);
        p.type = 'button';
        p.addEventListener('click', onPromo);
        foot.append(p);
      }
      parts.push(foot);
      root.replaceChildren(...parts);
      if (had != null) [...root.querySelectorAll('button')].find(b => b.textContent === had)?.focus();
    }
  };
}

// The chart for a period of several days, in place of the map: for each day two bars, today and with the change,
// each stacked as returning customers, new customers and people turned away.
// bars: dayBars(); labels: ["Friday 1", …]; names: ["Today", "With two more seats"].
export function renderPeriodChart(root, { bars, labels, names, title }) {
  const max = Math.max(1, ...[...bars.base, ...bars.after].map(d => d.returning + d.fresh + d.away));
  const bar = (d, cls) => {
    const b = el('div', `pc-bar ${cls}`);
    for (const [k, v] of [['away', d.away], ['fresh', d.fresh], ['returning', d.returning]]) {
      const s = el('i', `pc-${k}`);
      s.style.height = `${(100 * v) / max}%`;
      b.append(s);
    }
    b.title = `${Math.round(d.returning)} returning, ${Math.round(d.fresh)} new, ${Math.round(d.away)} turned away`;
    return b;
  };
  const plot = el('div', 'pc-plot');
  bars.base.forEach((d, i) => {
    const day = el('div', 'pc-day');
    const pair = el('div', 'pc-pair');
    pair.append(bar(d, 'before'), bar(bars.after[i], 'after'));
    day.append(pair, el('p', 'pc-day-label', labels[i]));
    plot.append(day);
  });
  const legend = el('div', 'pc-legend');
  for (const [cls, text] of [['pc-returning', 'Returning customers seated'], ['pc-fresh', 'New customers seated'], ['pc-away', 'Turned away or gave up']]) {
    const s = el('span');
    s.append(el('i', cls), document.createTextNode(text));
    legend.append(s);
  }
  root.replaceChildren(
    el('h2', null, title),
    el('p', 'hint', `Each pair of bars is one evening: ${names[0].toLowerCase()} on the left, ${names[1].charAt(0).toLowerCase()}${names[1].slice(1)} on the right.`),
    plot, legend
  );
}
