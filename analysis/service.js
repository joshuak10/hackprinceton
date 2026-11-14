import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { analyzeSimulation, collectEvidence, countDecision } from './insights.js';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const error = (status, message) => Object.assign(new Error(message), { status });

export function createAnalysisService({ runsDir, webDir, analyze = analyzeSimulation }) {
  const cache = new Map();
  let active = 0;
  return async function feedback({ runId, caseId, question = '' }) {
    if (typeof question !== 'string' || question.length > 2000) throw error(400, 'Keep the scenario question under 2000 characters.');
    if (Boolean(runId) === Boolean(caseId)) throw error(400, 'Provide either runId or caseId.');
    let bundle, dir;
    if (runId) {
      if (typeof runId !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/.test(runId)) throw error(400, 'Invalid run id.');
      dir = join(runsDir, runId);
      const meta = await json(join(dir, 'meta.json')).catch(() => { throw error(404, 'Completed run not found.'); });
      if (meta.status !== 'done') throw error(409, 'Feedback is available after a successful simulation.');
      const [spec, metrics, agents, remarks] = await Promise.all(['spec', 'metrics', 'agents', 'remarks'].map(name => json(join(dir, `${name}.json`))));
      bundle = { meta, spec, metrics, agents, remarks };
      // Stream decisions; large simulations must not put their entire event log in the model prompt.
      const choiceCounts = new Map();
      try {
        const lines = createInterface({ input: createReadStream(join(dir, 'decisions.jsonl')), crlfDelay: Infinity });
        for await (const line of lines) if (line.trim()) countDecision(choiceCounts, JSON.parse(line));
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
      bundle.choiceCounts = [...choiceCounts];
    } else {
      if (!['building', 'parking'].includes(caseId)) throw error(400, 'Unknown recorded scenario.');
      const scope = resolve(webDir, 'scope');
      const mock = await json(join(scope, 'mock/index.json'));
      const data = await json(join(scope, 'data/index.json')).catch(() => ({ cases: {} }));
      const info = data.cases?.[caseId] || mock.cases?.[caseId];
      if (!info || typeof info.file !== 'string') throw error(404, 'Recording not found.');
      const file = resolve(scope, info.file);
      if (!file.startsWith(scope + sep)) throw error(400, 'Recording must be inside the scope directory.');
      bundle = await json(file);
    }
    const evidence = collectEvidence(bundle, question);
    const configuration = { version: 1, ai: Boolean(process.env.ANTHROPIC_API_KEY?.trim()), model: process.env.ANALYSIS_MODEL || 'claude-opus-5-5' };
    const key = createHash('sha256').update(JSON.stringify({ evidence, configuration })).digest('hex');
    if (cache.has(key)) return cache.get(key);
    if (dir) {
      const saved = await json(join(dir, 'insights.json')).catch(() => null);
      if (saved?.inputHash === key && saved?.report?.version === 1) return saved.report;
    }
    if (cache.has(key)) return cache.get(key);
    if (active >= 2) throw error(429, 'The analysis agent is busy. Please try again shortly.');
    active++;
    const task = (async () => {
      const report = await analyze(bundle, { question });
      if (dir) await writeFile(join(dir, 'insights.json'), JSON.stringify({ inputHash: key, report }, null, 2));
      return report;
    })();
    cache.set(key, task);
    try { return await task; }
    catch (err) { cache.delete(key); throw err; }
    finally { active--; if (cache.size > 32) cache.delete(cache.keys().next().value); }
  };
}
