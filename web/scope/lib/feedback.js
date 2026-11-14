// Analysis belongs to the completed recording, not to the current playback frame.
export function createFeedback() {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, value) => Object.assign(document.createElement(tag), { className: cls, textContent: value });
  let request = null, controller = null, generation = 0;
  const dialog = $('feedbackDialog');
  function open() { dialog.showModal(); $('feedbackBtn').setAttribute('aria-expanded', 'true'); $('feedbackOpen').setAttribute('aria-expanded', 'true'); }
  $('feedbackBtn').onclick = open;
  $('feedbackOpen').onclick = open;
  $('feedbackClose').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { $('feedbackBtn').setAttribute('aria-expanded', 'false'); $('feedbackOpen').setAttribute('aria-expanded', 'false'); });
  $('feedbackRetry').onclick = () => load(request);

  async function load(input) {
    request = input;
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    const current = ++generation;
    const activeController = controller;
    const timer = setTimeout(() => activeController.abort(), 60000);
    $('feedbackBtn').disabled = false;
    $('feedbackPreview').hidden = false;
    $('feedbackStatus').textContent = 'Reviewing completed run…';
    $('feedbackSummary').textContent = 'The analysis agent is collecting outcomes and comparing participant experiences.';
    $('feedbackBody').replaceChildren(el('p', 'feedback-loading', 'Reviewing outcomes, checking evidence, and preparing suggestions…'));
    $('feedbackRetry').hidden = true;
    $('feedbackBody').setAttribute('aria-busy', 'true');
    try {
      const res = await fetch('/api/insights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
      const report = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 404 ? 'The analysis API is unavailable. Restart the frontend with npm run web to enable feedback.' : report.error || 'Could not complete the analysis. Please try again.');
      if (current !== generation) return;
      $('feedbackStatus').textContent = report.source === 'claude' ? 'Claude analysis ready' : 'Data review ready';
      $('feedbackSummary').textContent = report.summary;
      const root = $('feedbackBody'); root.replaceChildren();
      root.append(el('span', 'badge', report.source === 'claude' ? 'AI analysis · Claude' : 'Recorded-data analysis · No AI interpretation'));
      root.append(el('p', 'feedback-question', report.evidence.question || report.evidence.title));
      root.append(el('p', 'feedback-lead', report.summary));
      root.append(el('p', 'hint', 'Full-run feedback · Suggestions are experiments to test, not measured improvements.'));
      const evidence = new Map(report.evidence.facts.map(f => [f.id, f]));
      for (const [index, finding] of report.findings.entries()) {
        const card = el('article', 'feedback-finding', '');
        card.append(el('span', 'eyebrow', `FINDING ${String(index + 1).padStart(2, '0')}`), el('h3', '', finding.title), el('p', '', finding.observation));
        const refs = el('div', 'feedback-evidence', '');
        for (const id of finding.evidenceIds) {
          const fact = evidence.get(id);
          if (fact) refs.append(el('p', '', `${id.toUpperCase()} · ${fact.label}: ${fact.value} ${fact.unit}${fact.sampleSize ? ` (n=${fact.sampleSize})` : ''}`));
        }
        card.append(refs, el('h4', '', 'Suggested experiment'), el('p', '', finding.suggestion), el('h4', '', 'How to evaluate it'), el('p', '', finding.validation));
        root.append(card);
      }
      const limitations = el('section', 'feedback-limitations', '');
      limitations.append(el('h3', '', 'What this run can tell you'));
      const list = el('ul', '', '');
      report.limitations.forEach(note => list.append(el('li', '', note)));
      limitations.append(list); root.append(limitations);
      const details = el('details', 'feedback-all-evidence', '');
      details.append(el('summary', '', `View all ${report.evidence.facts.length} evidence points`));
      report.evidence.facts.forEach(f => details.append(el('p', '', `${f.id.toUpperCase()} · ${f.label}: ${f.value} ${f.unit}`)));
      root.append(details);
    } catch (err) {
      if (current !== generation) return;
      const message = err.name === 'AbortError' ? 'The analysis took too long. Please try again.' : err.message;
      $('feedbackStatus').textContent = 'Feedback unavailable';
      $('feedbackSummary').textContent = message;
      $('feedbackBody').replaceChildren(el('p', 'feedback-error', message));
      $('feedbackRetry').hidden = false;
    } finally {
      clearTimeout(timer);
      if (current === generation) $('feedbackBody').setAttribute('aria-busy', 'false');
    }
  }
  return { load };
}
