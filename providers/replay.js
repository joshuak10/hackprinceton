// ReplayProvider: answers from a recorded run's decisions.jsonl with no API calls
// (docs/PROTOTYPE.md §6). A request is matched by requestHash when this provider can rebuild the
// same Jev body, otherwise by request id (same agent and kind), otherwise it falls back to rules
// and counts a miss.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildJevRequest } from './jev.js';
import { fallbackDecision } from './rules.js';

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export class ReplayProvider {
  constructor({ runDir, model = null } = {}) {
    if (!runDir) throw new Error('ReplayProvider needs runDir: the directory of a recorded run.');
    const file = join(runDir, 'decisions.jsonl');
    if (!existsSync(file)) throw new Error(`No decisions.jsonl in ${runDir}; is it a recorded run directory?`);
    this.name = 'replay';
    this.external = true;
    this.runDir = runDir;

    this.byHash = new Map();   // requestHash → records (several when identical states recur)
    this.byId = new Map();
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      let rec;
      try { rec = JSON.parse(line); } catch { throw new Error(`${file} line ${i + 1} is not valid JSON`); }
      if (!rec || typeof rec.decision !== 'object' || rec.decision === null) return;
      if (rec.id != null) this.byId.set(String(rec.id), rec);
      const h = rec.decision.requestHash;
      if (h) {
        if (!this.byHash.has(h)) this.byHash.set(h, []);
        this.byHash.get(h).push(rec);
      }
    });

    // The recorded body carried the model name that was sent (usually an alias such as
    // jev-latest), which the hash depends on. Try the likely names, most specific first.
    const meta = readJson(join(runDir, 'meta.json'));
    this.recordedSpec = readJson(join(runDir, 'spec.json'));
    this.recordedModel = meta?.model ?? null;
    this.models = [...new Set([model, meta?.providerStats?.requestedModel, meta?.model, 'jev-latest'].filter(Boolean))];

    this.decisions = 0;
    this.hashHits = 0;
    this.idHits = 0;
    this.misses = 0;
    this.firstError = null;
  }

  async decideMany(requests, ctx = {}) {
    return requests.map(req => this.#answer(req, ctx));
  }

  #answer(req, ctx) {
    this.decisions++;
    let rec = this.#matchHash(req, ctx);
    if (rec) {
      this.hashHits++;
    } else {
      const byId = this.byId.get(String(req.id));
      if (byId && byId.agentId === req.agentId && byId.kind === req.kind) {
        rec = byId;
        this.idHits++;
      }
    }
    if (!rec) {
      this.misses++;
      const msg = `replay miss: no recorded decision for ${req.id}`;
      if (this.firstError == null) this.firstError = msg;
      return fallbackDecision(req, msg);
    }
    return { ...rec.decision, provider: 'replay', replayOf: rec.decision.provider };
  }

  // Among records sharing a hash, prefer the same request id (faithful replay of the same run),
  // then any real Jev answer, then whatever was recorded.
  #matchHash(req, ctx) {
    if (!this.byHash.size) return null;
    const spec = ctx?.spec ?? this.recordedSpec;
    for (const model of this.models) {
      let hash;
      try { hash = buildJevRequest(req, { model, spec }).requestHash; } catch { return null; }
      const list = this.byHash.get(hash);
      if (!list) continue;
      if (model !== this.models[0]) this.models = [model, ...this.models.filter(m => m !== model)];
      return list.find(r => String(r.id) === String(req.id)) ?? list.find(r => r.decision.answers) ?? list[0];
    }
    return null;
  }

  stats() {
    return {
      provider: 'replay',
      model: this.recordedModel,
      runDir: this.runDir,
      requests: 0,
      decisions: this.decisions,
      hashHits: this.hashHits,
      idHits: this.idHits,
      misses: this.misses,
      cacheHits: 0,
      fallbacks: this.misses,
      errors: 0,
      firstError: this.firstError,
      inputTokens: 0,
      outputTokens: 0,
      latency: { p50: 0, p95: 0, max: 0 },
      estCostUSD: 0
    };
  }
}
