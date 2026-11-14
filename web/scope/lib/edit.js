// Edit the room (docs/PROTOTYPE.md §18): the panel, and what a pointer or a key does to a seat. The rules for where
// a seat may go, and the before/after arithmetic, are in layout.js. This module only holds the edit in progress.
import { seatedPlaces, cloneLayout, seatProblem, moveSeat, addSeat, removeSeat, seatAt, sameLayout, describeChanges } from './layout.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const button = (label, onClick, cls = 'btn small') => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

// The edited world with the seats of another: used to go back to the room as sketched.
function withSeatsOf(spec, from) {
  const source = new Map(seatedPlaces(from).map(p => [p.id, p]));
  const next = cloneLayout(spec);
  for (const n of next.nodes) {
    const p = source.get(n.id);
    if (p) { n.seats = p.seats.map(s => ({ x: s.x, y: s.y })); n.servers = p.seats.length; }
  }
  return next;
}

// panel: the element the controls go in. onChange: something on the map changed, redraw.
// onRun(provider, spec): run the edited world; resolves when the new run is on screen. onClose: leave edit mode.
export function createEditor({ panel, onChange, onRun, onClose }) {
  const E = { active: false, sketch: null, spec: null, selected: null, drag: null, status: '', busy: false, hasJev: false };

  // A world can be edited when it has at least one place with seats.
  E.available = bundle => Boolean(bundle?.rawSpec && seatedPlaces(bundle.rawSpec).length);

  E.open = ({ spec, sketch, hasJev }) => {
    Object.assign(E, { active: true, sketch, spec: cloneLayout(spec), selected: null, drag: null, status: '', busy: false, hasJev: Boolean(hasJev) });
    panel.hidden = false;
    render();
    onChange();
  };
  E.close = () => {
    if (!E.active) return;
    Object.assign(E, { active: false, drag: null, selected: null, busy: false });
    panel.hidden = true;
    panel.replaceChildren();
    onChange();
  };

  // What the map draws while editing: every seat, with the one being dragged at the pointer.
  E.drawState = () => {
    const seats = [];
    for (const p of seatedPlaces(E.spec)) {
      p.seats.forEach((s, index) => {
        const dragging = E.drag && E.drag.placeId === p.id && E.drag.index === index;
        seats.push({
          x: dragging ? E.drag.x : s.x, y: dragging ? E.drag.y : s.y, tag: p.name[0].toUpperCase(),
          bad: Boolean(dragging && E.drag.bad), selected: Boolean(E.selected && E.selected.placeId === p.id && E.selected.index === index)
        });
      });
    }
    return { seats };
  };

  function say(text) {
    E.status = text || '';
    const s = panel.querySelector('.edit-status');
    if (s) { s.textContent = E.status; s.classList.toggle('warn', Boolean(E.status)); }
  }
  // Take an edit from layout.js: a refused one changes nothing and its reason is shown.
  function apply(result) {
    if (result.problem) { say(result.problem); return false; }
    E.spec = result.spec;
    E.status = '';
    render();
    onChange();
    return true;
  }

  // ---------- pointer (map units) ----------
  E.pointerDown = (x, y, reach) => {
    if (E.busy) return false;
    const hit = seatAt(E.spec, x, y, reach);
    if (!hit) return false;
    E.selected = { placeId: hit.placeId, index: hit.index };
    E.drag = { placeId: hit.placeId, index: hit.index, x: hit.x, y: hit.y, dx: hit.x - x, dy: hit.y - y, bad: false, moved: false };
    render();
    onChange();
    return true;
  };
  E.pointerMove = (x, y) => {
    const d = E.drag;
    if (!d) return;
    d.x = Math.round((x + d.dx) * 10) / 10;
    d.y = Math.round((y + d.dy) * 10) / 10;
    d.moved = true;
    const problem = seatProblem(E.spec, d.placeId, d.x, d.y, { ignore: d.index });
    d.bad = Boolean(problem);
    say(problem || '');
    onChange();
  };
  E.pointerUp = () => {
    const d = E.drag;
    if (!d) return;
    E.drag = null;
    if (d.moved) apply(moveSeat(E.spec, d.placeId, d.index, d.x, d.y));   // refused: the seat goes back and the reason stays
    onChange();
  };
  E.select = sel => { E.selected = sel; render(); onChange(); };

  function removeSelected() {
    if (!E.selected) return;
    const result = removeSeat(E.spec, E.selected.placeId, E.selected.index);
    if (!result.problem) E.selected = null;
    apply(result);
  }

  // ---------- keys: true when the key was used ----------
  E.key = e => {
    if (!E.active || E.busy) return false;
    if (e.key === 'Escape') { if (E.selected) E.select(null); else onClose(); return true; }
    if (!E.selected) return false;
    if (e.key === 'Delete' || e.key === 'Backspace') { removeSelected(); return true; }
    const step = e.shiftKey ? 0.5 : 0.1;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!move) return false;
    const { placeId, index } = E.selected;
    const seat = seatedPlaces(E.spec).find(p => p.id === placeId)?.seats[index];
    if (seat) apply(moveSeat(E.spec, placeId, index, seat.x + move[0], seat.y + move[1]));
    return true;
  };

  async function start(provider) {
    E.busy = true;
    E.selected = null;
    E.status = provider === 'jev' ? 'Running your room with Jev…' : 'Running your room…';
    render();
    onChange();
    try {
      await onRun(provider, E.spec);
    } catch (err) {
      E.busy = false;
      E.status = err?.message || 'The run failed.';
      render();
    }
  }

  // ---------- panel ----------
  function render() {
    if (!E.active) return;
    const changes = describeChanges(E.sketch, E.spec), changed = !sameLayout(E.sketch, E.spec);
    const head = el('div', 'block-head');
    head.append(el('h2', null, 'Edit the room'));
    const hint = el('p', 'hint', 'Drag a seat to move it. Click a seat to select it, then remove it, or nudge it with the arrow keys.');

    const list = el('ul', 'edit-places');
    for (const p of seatedPlaces(E.spec)) {
      const li = el('li');
      const text = el('span');
      text.append(el('b', null, p.name), `${p.seats.length} ${p.seats.length === 1 ? 'seat' : 'seats'}`);
      const add = button('Add a seat', () => {
        const result = addSeat(E.spec, p.id);
        if (!result.problem) E.selected = { placeId: p.id, index: result.index };
        apply(result);
      });
      add.disabled = E.busy;
      add.setAttribute('aria-label', `Add a seat to ${p.name}`);
      li.append(text, add);
      list.append(li);
    }

    const row = el('div', 'edit-row');
    const remove = button('Remove selected seat', removeSelected);
    remove.disabled = !E.selected || E.busy;
    const reset = button('Back to the sketch', () => { E.spec = withSeatsOf(E.spec, E.sketch); E.selected = null; E.status = ''; render(); onChange(); });
    reset.disabled = !changed || E.busy;
    row.append(remove, reset);

    const what = el('p', 'edit-changes', changes.length ? `${changes.join('. ')}.` : 'No changes yet. The room is as sketched.');
    const status = el('p', 'edit-status', E.status);
    status.setAttribute('role', 'status');
    status.classList.toggle('warn', Boolean(E.status) && !E.busy);

    const run = el('div', 'edit-run');
    const rules = button('Run again with rules', () => start('rules'), E.hasJev ? 'btn' : 'btn primary');
    rules.disabled = !changed || E.busy;
    if (E.hasJev) {
      const jev = button('Run again with Jev', () => start('jev'), 'btn primary');
      jev.disabled = !changed || E.busy;
      run.append(jev);
    }
    run.append(rules);
    const cost = el('p', 'hint', E.hasJev
      ? 'Each button runs your room three times and compares it with the room as sketched. Jev: about 300 requests, a little over a cent, about 20 seconds. Rules: free, a few seconds.'
      : 'Runs your room three times with the rules policy and compares it with the room as sketched: free, a few seconds. Set a Jev key to run it with Jev.');
    const cancel = button('Cancel', onClose, 'btn ghost small');
    cancel.disabled = E.busy;

    panel.replaceChildren(head, hint, list, row, what, status, run, cost, cancel);
  }

  return E;
}
