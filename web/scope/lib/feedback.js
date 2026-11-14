// Suggestions for the run on screen (docs/PROTOTYPE.md §9b; docs/INSIGHTS.md).
// For now there is ONE hard-coded suggestion: one more server at the run's worst bottleneck. It is a fixed rule,
// not written by AI. Running it starts a new run of the same world and seed with that one change; the display then
// offers a dropdown to switch between the baseline and the suggestion run, with the headline numbers side by side.
// The advisor (GET /api/runs/:id/advice) and the quick read (POST /api/insights) are not called from here for now.
// Based on Justin's feedback panel (frontend-updates); restyled to the display.

const LABELS = {
  abandonRate: 'Walk-away rate', avgWait: 'Average wait', served: 'Served', abandoned: 'Walked away', spawned: 'People',
  avgTrip: 'Average trip', avgDelay: 'Average delay', arrived: 'Arrived', avgSpent: 'Average spent',
  walkAwaysPerPerson: 'Walk-aways per person', shareNeverServed: 'Never served', avgVisits: 'Visits per person',
  avgFrustration: 'Frustration'
};
const PERCENT = new Set(['abandonRate', 'shareNeverServed']);
const MINUTES = new Set(['avgWait', 'avgTrip', 'avgDelay']);

export function keyLabel(key) { return LABELS[key] || key; }

export function valueWords(key, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'n/a';
  if (PERCENT.has(key)) return `${(v * 100).toFixed(1)}%`;
  if (MINUTES.has(key)) return `${v.toFixed(1)} min`;
  if (key === 'avgSpent') return `$${v.toFixed(2)}`;
  return Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100);
}

// One measured effect from the advisor: { before, after, change, spread, bySeed }.
export function effectWords(key, m) {
  if (!m) return `${keyLabel(key)}: n/a`;
  if (m.before == null) return `${keyLabel(key)}: ${valueWords(key, m.after)} after the change`;
  const seeds = Array.isArray(m.bySeed) && m.bySeed.length > 1
    ? `, same direction on ${m.bySeed.filter(d => Math.sign(d) === Math.sign(m.change) && d !== 0).length} of ${m.bySeed.length} seeds` : '';
  return `${keyLabel(key)}: ${valueWords(key, m.before)} to ${valueWords(key, m.after)}${seeds}`;
}

// Which run the request is about. Runs recorded by the engine are named by their run id; mock runs by case.
export function feedbackTarget(bundle, caseInfo) {
  const runId = bundle?.meta?.runId;
  return caseInfo?.runs?.length && runId ? { runId } : { caseId: caseInfo?.id };
}

// The one hard-coded suggestion: add a server at the place with the highest bottleneck score in the run's metrics
// (wait minutes + 30 for each person who walked away), or the first place with a line when there are no metrics.
export function hardCodedSuggestion(spec, metrics) {
  const places = (spec?.nodes || []).filter(n => n.kind === 'service');
  if (!places.length) return null;
  const scored = (metrics?.nodes || []).filter(m => places.some(p => p.id === m.id)).sort((a, b) => (b.score || 0) - (a.score || 0));
  const node = places.find(p => p.id === scored[0]?.id) || places[0];
  const from = Number(node.servers) || 1;
  const m = scored[0]?.id === node.id ? scored[0] : null;
  return {
    id: 'add-server', nodeId: node.id, nodeName: node.name || node.id, from, to: from + 1,
    label: `Add one more server at ${node.name || node.id}`,
    change: `${node.name || node.id}: ${from} server${from === 1 ? '' : 's'} to ${from + 1}`,
    why: m
      ? `${node.name || node.id} is this run's worst bottleneck: ${Math.round(m.abandoned || 0)} people walked away and the average wait was ${valueWords('avgWait', m.avgWait)}.`
      : `${node.name || node.id} is the first place with a line in this world.`
  };
}

// The world with the suggestion applied. The input is not changed.
export function applySuggestion(spec, s) {
  const out = JSON.parse(JSON.stringify(spec));
  const node = (out.nodes || []).find(n => n.id === s.nodeId);
  if (!node) throw new Error(`This world has no place "${s.nodeId}" to change.`);
  node.servers = s.to;
  return out;
}

// Headline numbers of two runs side by side: [{ label, key, before, after }].
export function compareRows(before, after, s) {
  const rows = ['abandoned', 'abandonRate', 'avgWait', 'served'].map(key => ({ label: keyLabel(key), key, before: before?.[key], after: after?.[key] }));
  const at = (m, k) => (m?.nodes || []).find(n => n.id === s?.nodeId)?.[k];
  if (s?.nodeId) {
    rows.push({ label: `Average wait at ${s.nodeName}`, key: 'avgWait', before: at(before, 'avgWait'), after: at(after, 'avgWait') });
    rows.push({ label: `Walked away at ${s.nodeName}`, key: 'abandoned', before: at(before, 'abandoned'), after: at(after, 'abandoned') });
  }
  return rows;
}

// onRun(): start the suggestion run. onPick(runId): show that run.
export function createFeedback({ onRun, onPick } = {}) {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const dialog = $('feedbackDialog');
  // ctx: { suggestion, canRun, cannotRunWhy, runNote, compare: { options: [{ runId, label }], selected, rows, note } | null }
  let ctx = null;

  const setExpanded = v => $('feedbackBtn').setAttribute('aria-expanded', String(v));
  $('feedbackBtn').addEventListener('click', open);
  $('feedbackOpen').addEventListener('click', open);
  $('feedbackClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => setExpanded(false));
  $('feedbackCompareSel').addEventListener('change', e => onPick?.(e.target.value));
  $('feedbackRetry').hidden = true;

  // A new run on screen (or its comparison arrived): show what belongs to it.
  function reset(next) {
    ctx = next || null;
    $('feedbackBtn').disabled = !ctx?.suggestion;
    if (dialog.open && !ctx?.suggestion) dialog.close();
    render();
  }

  function open() {
    if (!ctx?.suggestion) return;
    dialog.showModal();
    setExpanded(true);
    render();
  }

  function picker(id) {
    const sel = el('select');
    if (id) sel.id = id;
    sel.setAttribute('aria-label', 'Run to show');
    fillPicker(sel);
    sel.addEventListener('change', e => { if (dialog.open) dialog.close(); onPick?.(e.target.value); });
    return sel;
  }
  function fillPicker(sel) {
    sel.replaceChildren(...(ctx?.compare?.options || []).map(o => {
      const opt = el('option', null, o.label);
      opt.value = o.runId;
      opt.selected = o.runId === ctx.compare.selected;
      return opt;
    }));
  }

  function render() {
    const cmp = ctx?.compare;
    const preview = $('feedbackPreview');
    preview.hidden = !cmp;
    if (cmp) {
      $('feedbackStatus').textContent = 'Suggestion tested';
      $('feedbackSummary').textContent = ctx.suggestion.label;
      fillPicker($('feedbackCompareSel'));
    }
    if (!dialog.open || !ctx?.suggestion) return;
    const s = ctx.suggestion, out = [];
    out.push(el('p', 'fb-source', 'One hard-coded suggestion for now. It is a fixed rule, not written by AI: one more server at the run\'s worst bottleneck.'));
    const card = el('article', 'fb-card');
    card.append(el('h4', null, s.label), el('p', null, s.why), el('p', 'fb-kicker', 'What changes'), el('p', null, `${s.change}. Everything else stays the same: same world, same people, same seed.`));
    if (!cmp) {
      if (ctx.canRun) {
        const row = el('p', 'fb-run');
        const btn = el('button', 'btn primary', 'Run this suggestion');
        btn.type = 'button';
        btn.addEventListener('click', () => { dialog.close(); onRun?.(); });
        row.append(btn);
        card.append(row);
        if (ctx.runNote) card.append(el('p', 'fb-note', ctx.runNote));
      } else {
        card.append(el('p', 'fb-note', ctx.cannotRunWhy || 'This run cannot be re-run from here.'));
      }
    }
    out.push(card);
    if (cmp) {
      out.push(el('h3', null, 'Compare the two runs'));
      const pick = el('label', 'runpick fb-compare');
      pick.append(el('span', null, 'Showing'), picker());
      out.push(pick);
      const table = el('table', 'fb-table');
      const head = el('tr');
      head.append(el('th', null, ''), el('th', null, 'Baseline'), el('th', null, 'With the suggestion'));
      table.append(head);
      for (const r of cmp.rows || []) {
        const tr = el('tr');
        tr.append(el('th', null, r.label), el('td', null, valueWords(r.key, r.before)), el('td', null, valueWords(r.key, r.after)));
        table.append(tr);
      }
      out.push(table);
      out.push(el('p', 'fb-note', cmp.note || 'One seed each, so small differences may be noise. Pick a run above to watch it; the time on the slider is kept.'));
    }
    $('feedbackBody').replaceChildren(...out);
  }

  return { reset, open };
}
