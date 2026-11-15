// Prompt box: the card under it, and the progress steps for a new run.
// The display shows one place at a time, and the card lists the places it can open. A typed question is shown
// above the map; it does not change the simulation yet.
// Later this becomes Claude's compile step (POST /api/compile); the card stays.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// The places the card can open: a heading and one row per place, in the look of Run details' lists.
// Every row is a link, except the place on screen, which is marked and cannot be picked.
function placeList({ heading, items }) {
  const h = el('h3', null, heading);
  h.id = 'askPlacesHead';
  const ul = el('ul', 'runs places');
  ul.setAttribute('aria-labelledby', h.id);
  for (const p of items) {
    let row;
    if (p.current) {
      row = el('button', 'row');
      row.type = 'button';
      row.disabled = true;
      row.setAttribute('aria-current', 'true');
    } else {
      row = el('a', 'row');
      row.href = p.href;
    }
    row.append(el('span', 'name', p.label));
    if (p.note) row.append(el('span', 'val', p.note));
    const li = el('li');
    li.append(row);
    ul.append(li);
  }
  return [h, ul];
}

// Tab stays in the open card: after its last control comes its first, and the other way round with Shift.
// The first action has the focus when the card opens, so this is how Tab reaches the places listed above it.
function keepTab(card, e) {
  if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
  const stops = [...card.querySelectorAll('a[href], button:not(:disabled)')];
  if (stops.length < 2) return;
  const first = stops[0], last = stops[stops.length - 1];
  if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
}

// A card with a title, a few sentences, the places to open, and actions.
// places: { heading, items: [{ label, href, current, note }] }. actions: [{ label, solid, onClick }]; the first gets focus.
export function showCard(card, { title, lines = [], places = null, actions = [], onCancel }) {
  const h = el('h2', null, title);
  const body = lines.filter(Boolean).map(t => el('p', null, t));
  const list = places?.items?.length ? placeList(places) : [];
  const buttons = actions.map(a => {
    const b = el('button', a.solid ? 'btn solid' : 'btn', a.label);
    b.type = 'button';
    b.addEventListener('click', a.onClick);
    return b;
  });
  const cancel = el('button', 'btn quiet', actions.length ? 'Cancel' : 'Close');
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  const row = el('div', 'row');
  row.append(...buttons, cancel);
  card.replaceChildren(h, ...body, ...list, row);
  card.onkeydown = e => keepTab(card, e);
  card.hidden = false;
  (buttons[0] || cancel).focus();
}

export function hideCard(card) { card.hidden = true; card.onkeydown = null; card.replaceChildren(); }

// Staged progress. `steps` = [{ label }]; call set(i, labelOverride) to move on.
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
    note(text) { n.textContent = text || ''; },
    done() { root.hidden = true; root.replaceChildren(); }
  };
}
