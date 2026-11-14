// Suggestions for the run on screen (docs/PROTOTYPE.md §9b, §15c; docs/INSIGHTS.md).
// Nothing is requested until someone clicks Suggestions. Then, in order:
//   1. the advisor's tested advice for this run (GET /api/runs/:id/advice, written by `swarm advise`);
//   2. otherwise the quick read (POST /api/insights): one pass over the run's recorded numbers whose
//      suggestions are untested experiments.
// Based on Justin's feedback panel (frontend-updates); restyled to the display and gated on click.

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

export function createFeedback() {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const dialog = $('feedbackDialog');
  let target = null, question = '', state = 'idle', result = null, controller = null, generation = 0;

  const setExpanded = v => $('feedbackBtn').setAttribute('aria-expanded', String(v));
  $('feedbackBtn').addEventListener('click', open);
  $('feedbackOpen').addEventListener('click', open);
  $('feedbackClose').addEventListener('click', () => dialog.close());
  $('feedbackRetry').addEventListener('click', () => request());
  dialog.addEventListener('close', () => setExpanded(false));

  // A new run on screen: forget the old result and cancel any request in flight.
  function reset(next, q = '') {
    controller?.abort();
    generation++;
    target = next; question = q || ''; state = 'idle'; result = null;
    $('feedbackBtn').disabled = !next;
    $('feedbackPreview').hidden = true;
    if (dialog.open) dialog.close();
  }

  function open() {
    if (!target) return;
    dialog.showModal();
    setExpanded(true);
    if (state === 'idle' || state === 'error') request();
    else render();
  }

  async function request() {
    controller?.abort();
    controller = new AbortController();
    const ctl = controller, { signal } = ctl;
    const mine = ++generation;
    const timer = setTimeout(() => ctl.abort(), 60000);
    state = 'loading';
    render();
    try {
      let advice = null;
      if (target.runId) {
        const res = await fetch(`/api/runs/${encodeURIComponent(target.runId)}/advice`, { signal, cache: 'no-cache' });
        if (res.ok) advice = (await res.json()).advice;
        else if (res.status !== 404) throw new Error(`Loading this run's advice failed (${res.status}).`);
      }
      if (advice) {
        result = { kind: 'advice', advice };
      } else {
        const res = await fetch('/api/insights', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ ...target, question })
        });
        const report = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(res.status === 404
            ? 'This server has no suggestions endpoint. Serve the display with node bin/swarm.js serve (or npm run web for mock runs).'
            : report.error || `The quick read failed (${res.status}).`);
        }
        result = { kind: 'insights', report };
      }
      if (mine !== generation) return;
      state = 'ready';
    } catch (err) {
      if (mine !== generation) return;
      state = 'error';
      result = { error: err.name === 'AbortError' ? 'The request took longer than a minute. Try again.' : err.message };
    } finally {
      clearTimeout(timer);
    }
    render();
  }

  // ---------- rendering ----------
  function render() {
    const body = $('feedbackBody');
    $('feedbackRetry').hidden = state !== 'error';
    body.setAttribute('aria-busy', String(state === 'loading'));
    const preview = $('feedbackPreview');
    preview.hidden = state === 'idle';
    if (state === 'loading') {
      body.replaceChildren(el('p', 'fb-status', target.runId ? 'Looking for tested advice on this run…' : 'Reading the run’s recorded numbers…'));
      $('feedbackStatus').textContent = 'Preparing suggestions…';
      $('feedbackSummary').textContent = '';
      return;
    }
    if (state === 'error') {
      body.replaceChildren(el('p', 'fb-error', result.error));
      $('feedbackStatus').textContent = 'Suggestions unavailable';
      $('feedbackSummary').textContent = result.error;
      return;
    }
    if (state !== 'ready') return;
    if (result.kind === 'advice') renderAdvice(body, result.advice);
    else renderInsights(body, result.report);
  }

  function renderAdvice(body, a) {
    const start = (a.transcript || []).find(s => s.kind === 'start') || {};
    const tests = (a.experiments || []).filter(e => !e.confirms).length;
    $('feedbackStatus').textContent = 'Tested advice';
    $('feedbackSummary').textContent = a.answer || '';
    const out = [];
    out.push(el('p', 'fb-source', `Tested advice from the advisor: ${tests} experiment${tests === 1 ? '' : 's'} on seeds ${(start.seeds || []).join(', ') || 'n/a'}, decisions by ${start.provider || 'n/a'}${start.model ? `, written by ${start.model}` : ''}.`));
    if (start.question) out.push(el('p', 'fb-question', start.question));
    out.push(el('p', 'fb-lead', a.answer || 'The advisor gave no answer.'));

    const recs = a.recommendations || [];
    out.push(el('h3', null, recs.length ? 'Recommended changes, measured on the same crowd' : 'No tested change is recommended'));
    for (const r of recs) {
      const card = el('article', 'fb-card');
      card.append(el('h4', null, r.label));
      if (r.why) card.append(el('p', null, r.why));
      const effects = Object.entries(r.effect || {}).filter(([, m]) => m);
      if (effects.length) {
        const ul = el('ul', 'fb-effects');
        for (const [k, m] of effects) ul.append(el('li', null, effectWords(k, m)));
        card.append(ul);
      }
      const tags = el('p', 'fb-tags');
      tags.append(
        el('span', 'tag', `${r.confidence || 'unknown'} confidence`),
        el('span', 'tag', r.holdsAcrossSeeds ? 'holds across seeds' : 'does not hold across seeds'),
        el('span', 'tag', `tested with ${r.testedWith || 'n/a'}`)
      );
      if (r.confirmation) tags.append(el('span', 'tag', r.confirmation.agrees ? `confirmed with ${r.confirmation.testedWith}` : `${r.confirmation.testedWith} disagrees`));
      card.append(tags);
      if (r.costNote) card.append(el('p', 'fb-note', `Cost: ${r.costNote}`));
      out.push(card);
    }
    const cautions = a.cautions || [];
    const notTested = cautions.filter(c => c.startsWith('Could not test: ')).map(c => c.slice('Could not test: '.length));
    const plain = cautions.filter(c => !c.startsWith('Could not test: '));
    out.push(list('Cautions', plain), list('What could not be tested', notTested), list('Next steps', a.nextSteps || []), list('Findings', a.findings || []));
    const exps = a.experiments || [];
    if (exps.length) {
      const details = el('details', 'fb-more');
      details.append(el('summary', null, `Every experiment (${exps.length})`));
      for (const e of exps) {
        const kpis = Object.entries(e.kpis || {}).filter(([, v]) => v && typeof v.change === 'number')
          .map(([k, v]) => `${keyLabel(k)} ${v.change > 0 ? '+' : ''}${valueWords(k, v.change)}`).join(', ');
        details.append(el('p', null, `${e.n}. ${e.label}: ${e.verdict || 'no verdict'}${kpis ? ` (${kpis})` : ''}`));
      }
      out.push(details);
    }
    body.replaceChildren(...out.filter(Boolean));
  }

  function renderInsights(body, report) {
    const claude = report.source === 'claude';
    $('feedbackStatus').textContent = 'Quick read';
    $('feedbackSummary').textContent = report.summary || '';
    const out = [];
    out.push(el('p', 'fb-source', claude
      ? `Quick read by Claude (${report.model}) from this run's recorded numbers. Its suggestions are untested.`
      : 'Quick read from this run’s recorded numbers (no AI). Its suggestions are untested.'));
    if (target.runId) {
      const hint = el('p', 'fb-note');
      hint.append('No tested advice for this run yet. For tested recommendations, run the advisor on its world, for example ');
      hint.append(el('code', null, 'node bin/swarm.js advise data/worlds/floor1-lunch.json'));
      hint.append(' (needs an Anthropic key), or /advise in Claude Code. Its advice shows here for the runs it creates.');
      out.push(hint);
    }
    const q = report.evidence?.question || report.evidence?.title;
    if (q) out.push(el('p', 'fb-question', q));
    out.push(el('p', 'fb-lead', report.summary || ''));
    const facts = new Map((report.evidence?.facts || []).map(f => [f.id, f]));
    for (const f of report.findings || []) {
      const card = el('article', 'fb-card');
      card.append(el('h4', null, f.title), el('p', null, f.observation));
      const refs = (f.evidenceIds || []).map(id => facts.get(id)).filter(Boolean);
      if (refs.length) {
        const ul = el('ul', 'fb-effects');
        for (const r of refs) ul.append(el('li', null, `${r.label}: ${r.value} ${r.unit}${r.sampleSize ? ` (${r.sampleSize} people)` : ''}`));
        card.append(ul);
      }
      card.append(el('p', 'fb-kicker', 'Experiment to try'), el('p', null, f.suggestion), el('p', 'fb-kicker', 'How to check it'), el('p', null, f.validation));
      out.push(card);
    }
    out.push(list('What this run can tell you', report.limitations || []));
    const all = report.evidence?.facts || [];
    if (all.length) {
      const details = el('details', 'fb-more');
      details.append(el('summary', null, `All ${all.length} numbers used`));
      for (const f of all) details.append(el('p', null, `${f.label}: ${f.value} ${f.unit}`));
      out.push(details);
    }
    body.replaceChildren(...out.filter(Boolean));
  }

  function list(title, items) {
    if (!items.length) return null;
    const sec = el('section', 'fb-list');
    sec.append(el('h3', null, title));
    const ul = el('ul');
    for (const t of items) ul.append(el('li', null, t));
    sec.append(ul);
    return sec;
  }

  return { reset, open };
}
