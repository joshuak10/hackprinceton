import { clockText } from './frames.js';

export function createNotebook({ getMoment, onRevisit }) {
  const $ = id => document.getElementById(id);
  const key = 'scope-observations-v1';
  let notes = [], pending = null;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '[]');
    if (Array.isArray(saved)) notes = saved.filter(n => n && typeof n.id === 'string' && typeof n.text === 'string' && typeof n.caseId === 'string' && Number.isFinite(n.t) && Number.isInteger(n.floor));
  } catch { /* Keep an in-memory notebook when storage is unavailable. */ }
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text });
  function persist() {
    try { localStorage.setItem(key, JSON.stringify(notes)); $('noteStatus').textContent = 'Saved in this browser.'; }
    catch { $('noteStatus').textContent = 'Browser storage unavailable. Export to keep these notes.'; }
    render();
  }
  function render() {
    $('noteCount').textContent = notes.length;
    $('exportNotesBtn').disabled = !notes.length;
    $('noteList').replaceChildren();
    if (!notes.length) $('noteList').append(el('p', 'note-empty', 'Your next insight starts with a moment. Open a replay, pause, and save what you notice.'));
    for (const note of notes) {
      const row = el('article', 'saved-note', '');
      const context = el('p', 'eyebrow', `${note.title} · ${clockText(note.clockStart, note.t)} · ${note.lens}`);
      const actions = el('div', 'row', '');
      const revisit = el('button', 'btn small', 'Revisit moment ↗'); revisit.type = 'button';
      revisit.onclick = async () => {
        revisit.disabled = true;
        try { await onRevisit(note); $('notebook').close(); }
        catch { $('noteStatus').textContent = 'Could not reopen this recording. Please try again.'; }
        finally { revisit.disabled = false; }
      };
      const remove = el('button', 'btn ghost small', 'Delete'); remove.type = 'button';
      remove.setAttribute('aria-label', `Delete observation: ${note.text.slice(0, 50)}`);
      remove.onclick = () => { notes = notes.filter(n => n.id !== note.id); persist(); };
      actions.append(revisit, remove); row.append(context, el('p', '', note.text), actions); $('noteList').append(row);
    }
  }
  function open() {
    pending = getMoment();
    $('saveNoteBtn').disabled = !pending;
    $('noteText').disabled = !pending;
    $('noteContext').textContent = pending ? `${pending.title} · ${clockText(pending.clockStart, pending.t)}` : 'Open a replay to attach a moment.';
    $('notebookBtn').setAttribute('aria-expanded', 'true');
    $('notebook').showModal();
  }
  $('notebookBtn').onclick = open;
  $('captureBtn').onclick = open;
  $('notebookClose').onclick = () => $('notebook').close();
  $('notebook').addEventListener('close', () => $('notebookBtn').setAttribute('aria-expanded', 'false'));
  $('noteForm').onsubmit = e => {
    e.preventDefault();
    if (!pending) return;
    notes.unshift({ ...pending, id: crypto.randomUUID(), text: $('noteText').value.trim() || 'A moment worth revisiting.', createdAt: new Date().toISOString() });
    $('noteText').value = ''; persist();
  };
  $('exportNotesBtn').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ application: 'Swarmscope', observations: notes }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'swarmscope-observations.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('noteStatus').textContent = 'Notebook exported.';
  };
  render();
}
