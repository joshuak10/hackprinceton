// RulesProvider: answers every decision with the engine's own rule policy (req.auto.action).
// Inline by default (external: false), in which case the Sim decides internally and runSwarm never
// calls decideMany. With { external: true } it goes through the decision protocol, which is how
// the protocol is tested and how `swarm estimate` counts requests (docs/PROTOTYPE.md §6).
// Targeted offers (§15b) need nothing here: the Sim's rule policy already prices each place at what the
// agent would pay after its offers, both inline and in req.auto.action.

// The rule answer for one request. `arrive` requests have auto: null, so action stays undefined.
export function ruleAction(req) {
  return req?.auto?.action ?? undefined;
}

// The Decision other providers return when they cannot answer (API error, budget, replay miss).
export function fallbackDecision(req, error, extra = {}) {
  return { provider: 'rules-fallback', action: ruleAction(req), error: String(error), ...extra };
}

export class RulesProvider {
  constructor({ external = false } = {}) {
    this.name = 'rules';
    this.external = Boolean(external);
    this.decisions = 0;
    this.byKind = {};
  }

  async decideMany(requests) {
    return requests.map(req => {
      this.decisions++;
      this.byKind[req.kind] = (this.byKind[req.kind] || 0) + 1;
      return { provider: 'rules', action: ruleAction(req) };
    });
  }

  // `requests` counts decision requests answered (no API calls are made); the remaining fields
  // mirror JevProvider.stats() so callers can print any provider's stats the same way.
  stats() {
    return {
      provider: 'rules',
      external: this.external,
      model: null,
      requests: this.decisions,
      decisions: this.decisions,
      byKind: { ...this.byKind },
      cacheHits: 0,
      fallbacks: 0,
      errors: 0,
      firstError: null,
      inputTokens: 0,
      outputTokens: 0,
      latency: { p50: 0, p95: 0, max: 0 },
      estCostUSD: 0
    };
  }
}
