// Prompt box: the card under it, and the progress steps for a new run.
// The display runs one place. A typed question is shown above the map; it does not change the simulation yet.
// Later this becomes Claude's compile step (POST /api/compile); the card stays.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// A card with a title, a few sentences, and actions. actions: [{ label, solid, onClick }]; the first gets focus.
export function showCard(card, { title, lines = [], actions = [], onCancel }) {
  const h = el('h2', null, title);
  const body = lines.filter(Boolean).map(t => el('p', null, t));
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
  card.replaceChildren(h, ...body, row);
  card.hidden = false;
  (buttons[0] || cancel).focus();
}

export function hideCard(card) { card.hidden = true; card.replaceChildren(); }

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
    done() { root.hidden = true; root.replaceChildren(); }
  };
}
