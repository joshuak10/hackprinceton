// Prompt box: match free text to one of the supported cases, confirm, then show run progress.
// Later this becomes Claude's compile step (POST /api/compile); the confirm card stays.

const KEYWORDS = {
  building: ['building', 'inside', 'indoor', 'interior', 'floor', 'floors', 'lobby', 'door', 'doors', 'doorway', 'hallway', 'corridor', 'stairs',
    'stair', 'elevator', 'office', 'offices', 'cafe', 'café', 'counter', 'restroom', 'checkout', 'line', 'queue', 'crowd', 'crowding',
    'congestion', 'congested', 'stuck', 'lunch', 'walk', 'walking', 'people', 'matterport', 'market', 'evacuat'],
  parking: ['parking', 'park', 'lot', 'car', 'cars', 'drive', 'driving', 'driver', 'drivers', 'space', 'spaces', 'stall', 'stalls', 'traffic',
    'entrance', 'exit', 'saturday', 'shopping center', 'retail center', 'strip', 'vexcel', 'aerial', 'circling', 'garage'],
  sushi: ['sushi', 'restaurant', 'seat', 'seats', 'seated', 'table', 'tables', 'diner', 'diners', 'dinner', 'omakase', 'chef', 'kitchen',
    'reservation', 'eight-seat']
};

export function matchCase(text) {
  const s = ` ${String(text).toLowerCase()} `;
  const score = {};
  for (const [id, words] of Object.entries(KEYWORDS)) {
    score[id] = words.reduce((n, w) => n + (s.includes(w.length > 4 ? w : ` ${w}`) ? (w.length > 6 ? 2 : 1) : 0), 0);
  }
  // "store" alone is ambiguous; it tips toward parking only with lot words.
  const [best, second] = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!best[1]) return null;
  if (best[1] === second[1]) return { id: null, tie: true, score };
  return { id: best[0], score };
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// actions: [{ label, primary, onClick }]; the first primary action gets focus.
export function showConfirm(card, { caseInfo, question, facts, actions = [], onCancel }) {
  const h = el('h3', null, caseInfo.label);
  const where = el('p', 'sub', caseInfo.place);
  where.style.color = 'var(--muted)';
  const q = el('p', 'q', question);
  const dl = el('dl');
  for (const [k, v] of facts) dl.append(el('dt', null, k), el('dd', null, v));
  const buttons = actions.map(a => {
    const b = el('button', a.primary ? 'btn primary' : 'btn', a.label);
    b.type = 'button';
    b.addEventListener('click', a.onClick);
    return b;
  });
  const cancel = el('button', 'btn ghost', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  const row = el('div', 'row');
  row.append(...buttons, cancel);
  card.replaceChildren(h, where, q, dl, row);
  card.hidden = false;
  (buttons.find((_, i) => actions[i].primary) || buttons[0] || cancel).focus();
}

export function showChoices(card, { message, cases, onPick, onCancel }) {
  const p = el('p', null, message);
  const list = el('div', 'case-chips');
  for (const c of cases) {
    const b = el('button', 'case-chip');
    b.type = 'button';
    b.append(el('b', null, c.label), el('span', null, c.question));
    b.addEventListener('click', () => onPick(c.id));
    list.append(b);
  }
  const cancel = el('button', 'btn ghost small', 'Close');
  cancel.type = 'button';
  cancel.style.marginTop = '10px';
  cancel.addEventListener('click', onCancel);
  card.replaceChildren(p, list, cancel);
  card.hidden = false;
}

export function hideCard(card) { card.hidden = true; card.replaceChildren(); }

// Staged progress. `steps` = [{ label, ms? }]; call set(i, labelOverride) to move on.
export function showProgress(root, steps, note) {
  const ol = el('ol');
  const items = steps.map(s => {
    const li = el('li');
    li.append(el('i'), el('span', null, s.label));
    ol.append(li);
    return li;
  });
  const n = el('p', 'note', note || '');
  root.replaceChildren(ol, n);
  root.hidden = false;
  return {
    set(i, label) {
      items.forEach((li, k) => { li.className = k < i ? 'done' : k === i ? 'now' : ''; });
      if (label && items[i]) items[i].lastChild.textContent = label;
    },
    done() { root.hidden = true; root.replaceChildren(); }
  };
}
