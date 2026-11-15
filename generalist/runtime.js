// Bounded state-machine simulation. Claude authors data; the runtime owns every mutation.
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { normalizeEnvironment, ENVIRONMENT_LIMITS, environmentHash } from './spec.js';
import { RulesProvider } from '../providers/rules.js';
import { sampleDecision } from '../engine/sample.js';
import { seedRng, sampleIndex } from '../engine/util.js';

const clone = value => structuredClone(value);
const satisfies = (condition, world, agent) => {
  const actual = (condition.scope === 'world' ? world : agent.attributes)[condition.key];
  switch (condition.op) {
    case 'eq': return actual === condition.value;
    case 'ne': return actual !== condition.value;
    case 'gte': return actual >= condition.value;
    case 'lte': return actual <= condition.value;
    default: return false;
  }
};

/**
 * Run a validated declarative environment. Decisions observe a common tick snapshot, then reserve
 * resources in seeded actor order. Stale choices wait for the next tick; they never overbook capacity.
 * Effects commit atomically at completion after checking requirements again against current state.
 */
export async function runEnvironment(raw, { provider = new RulesProvider(), seed = 7, signal = null, onProgress = null } = {}) {
  const spec = normalizeEnvironment(raw);
  if (!Number.isSafeInteger(seed)) throw new Error('Environment seed must be a safe integer.');
  if (typeof provider?.decideMany !== 'function' || typeof provider?.stats !== 'function') throw new Error('Environment provider needs decideMany() and stats().');
  signal?.throwIfAborted();
  const startStats = provider.stats();
  const world = clone(spec.world);
  const resources = new Map(spec.resources.map(resource => [resource.id, { ...resource, used: 0, peak: 0 }]));
  const roleById = new Map(spec.roles.map(role => [role.id, role]));
  const actionById = new Map(spec.actions.map(action => [action.id, action]));
  // A role with `arrive` turns up over time: its actors are spread evenly over the window, each at a seeded
  // tick inside its own share of it, and an actor is offered nothing before that tick.
  const arrivalTick = (role, index, jitter) => {
    const span = role.arrive.to - role.arrive.from + 1;
    return role.arrive.from + Math.min(span - 1, Math.floor(span * (index + jitter()) / role.count));
  };
  const agents = spec.roles.flatMap(role => {
    const jitter = seedRng(seed, 'environment-arrival', role.id);
    return Array.from({ length: role.count }, (_, index) => ({
      id: `${role.id}_${index + 1}`, role: role.id, name: `${role.name} ${index + 1}`, goal: role.goal,
      state: role.initialState, attributes: clone(role.state), status: 'idle', action: null, busyUntil: null,
      completedActions: 0, decisionIndex: 0, ...(role.arrive ? { arrivesAt: arrivalTick(role, index, jitter) } : {})
    }));
  });
  // Someone who has not turned up yet is not in the frames, is not counted in what others are told, and is not asked.
  const here = agent => (agent.arrivesAt ?? 0) <= tick;
  const events = [], decisions = [], frames = [];
  const byAction = Object.fromEntries(spec.actions.map(action => [action.id, 0]));
  let completedActions = 0, blockedDecisions = 0, rejectedCompletions = 0, idleAgentTicks = 0, tick = 0;
  let traceBytes = 0;
  const traceLimit = () => Object.assign(new Error('Environment decision trace exceeds 64 MiB; reduce ticks, actors or state detail.'), { code: 'TRACE_LIMIT' });
  const frameStride = Math.max(1, Math.ceil(spec.ticks / (ENVIRONMENT_LIMITS.frames - 1)));
  const applicable = (action, agent) => (!action.roles.length || action.roles.includes(agent.role)) && action.from.includes(agent.state);
  const conditionsMet = (action, agent) => action.requirements.every(condition => satisfies(condition, world, agent));
  const capacityAvailable = action => action.resources.every(claim => {
    const resource = resources.get(claim.id);
    return resource.used + claim.units <= resource.capacity;
  });
  const resourceView = () => [...resources.values()].map(resource => ({
    id: resource.id, name: resource.name, capacity: resource.capacity, used: resource.used, available: resource.capacity - resource.used, peak: resource.peak
  }));
  const eligible = agent => spec.actions.filter(action => applicable(action, agent) && conditionsMet(action, agent) && capacityAvailable(action));
  const settleStatus = agent => {
    if (agent.action) return;
    agent.status = spec.actions.some(action => applicable(action, agent)) ? 'idle' : 'terminal';
  };
  const release = action => {
    for (const claim of action.resources) resources.get(claim.id).used -= claim.units;
  };
  const complete = agent => {
    const action = actionById.get(agent.action);
    let reason = null;
    if (!conditionsMet(action, agent)) reason = 'requirements changed before completion';
    const nextWorld = clone(world), nextAttributes = clone(agent.attributes);
    if (!reason) {
      for (const effect of action.effects) {
        const target = effect.scope === 'world' ? nextWorld : nextAttributes;
        const next = effect.op === 'add' ? target[effect.key] + effect.value : effect.value;
        if (typeof next === 'number' && !Number.isFinite(next)) { reason = 'effect would produce a non-finite number'; break; }
        target[effect.key] = next;
      }
    }
    release(action);
    agent.action = null; agent.busyUntil = null;
    if (reason) {
      rejectedCompletions++;
      events.push({ tick, type: 'rejected', agentId: agent.id, action: action.id, reason });
    } else {
      Object.assign(world, nextWorld); agent.attributes = nextAttributes; agent.state = action.to;
      agent.completedActions++; completedActions++; byAction[action.id]++;
      events.push({ tick, type: 'completed', agentId: agent.id, action: action.id, to: action.to, effects: clone(action.effects) });
    }
    settleStatus(agent);
  };
  const capture = () => frames.push({ tick, world: clone(world), resources: resourceView(), agents: agents.filter(here).map(agent => ({
    id: agent.id, role: agent.role, state: agent.state, status: agent.status, action: agent.action
  })) });
  const stats = () => {
    const current = provider.stats(), out = { ...current };
    for (const [key, value] of Object.entries(current)) if (typeof value === 'number' && typeof startStats[key] === 'number') out[key] = value - startStats[key];
    return out;
  };
  const metrics = () => ({
    ticks: tick, agents: agents.length, completedActions, blockedDecisions, rejectedCompletions, idleAgentTicks,
    terminalAgents: agents.filter(agent => agent.status === 'terminal').length,
    activeAgents: agents.filter(agent => agent.action).length,
    byAction: { ...byAction },
    byState: agents.reduce((counts, agent) => { counts[agent.state] = (counts[agent.state] ?? 0) + 1; return counts; }, {}),
    custom: spec.metrics.map(metric => {
      const values = metric.scope === 'world' ? [world[metric.key]] : agents.map(agent => agent.attributes[metric.key]);
      let value;
      if (metric.aggregation === 'min') value = Math.min(...values);
      else if (metric.aggregation === 'max') value = Math.max(...values);
      else { value = values.reduce((sum, entry) => sum + entry, 0); if (metric.aggregation === 'mean') value /= values.length; }
      return { id: metric.id, label: metric.label, value };
    })
  });
  const result = () => ({
    environmentHash: environmentHash(spec), seed, metrics: metrics(), world: clone(world), resources: resourceView(),
    frames, agents: clone(agents), decisions, events, providerStats: stats()
  });

  try {
    for (tick = 0; tick <= spec.ticks; tick++) {
      signal?.throwIfAborted();
      // The prior tick's seeded start order is retained when simultaneous completions contend.
      const finishing = agents.filter(agent => agent.action && agent.busyUntil <= tick)
        .sort((a, b) => a.busyUntil - b.busyUntil || a.startedOrder - b.startedOrder);
      for (const agent of finishing) complete(agent);
      for (const agent of agents) settleStatus(agent);
      if (tick < spec.ticks) {
        // Random priority prevents a fixed role/ID from monopolizing a shared resource every tick.
        const priority = seedRng(seed, 'environment-priority', tick);
        const ready = agents.filter(agent => !agent.action && agent.status !== 'terminal' && here(agent))
          .map(agent => ({ agent, priority: priority() })).sort((a, b) => a.priority - b.priority);
        const batch = [];
        let batchBytes = 0;
        for (const { agent } of ready) {
          const options = eligible(agent);
          if (!options.length) { idleAgentTicks++; continue; }
          const weights = options.map(action => action.weight);
          const weightsToUse = weights.some(weight => weight > 0) ? weights : weights.map(() => 1);
          const picked = sampleIndex(weightsToUse, seedRng(seed, 'environment-rules', agent.id, tick)());
          const req = {
            id: `d${decisions.length + batch.length + 1}`, t: tick, kind: 'action', agentId: agent.id,
            decisionIndex: agent.decisionIndex++, archetypeId: agent.role, personaId: agent.id, personaName: agent.name,
            asks: { choice: 'action' }, options: options.map(action => ({ key: action.id, label: action.label })),
            auto: { action: options[picked].id },
            observation: {
              environment: { title: spec.title, description: spec.description, tick, remainingTicks: spec.ticks - tick },
              guidelines: spec.guidelines,
              actor: { name: agent.name, role: roleById.get(agent.role).name, goal: agent.goal, state: agent.state, attributes: clone(agent.attributes) },
              world: clone(world), resources: resourceView(),
              population: agents.filter(here).reduce((counts, other) => { counts[other.state] = (counts[other.state] ?? 0) + 1; return counts; }, {}),
              actions: options.map(action => ({ id: action.id, label: action.label, to: action.to, duration: action.duration, effects: clone(action.effects), resources: clone(action.resources) }))
            }
          };
          // Reserve the request plus two copies' worth of event/effect records before retaining a
          // whole batch. This also bounds intermediate allocation when an author supplies long text.
          batchBytes += Buffer.byteLength(JSON.stringify(req)) * 3;
          if (traceBytes + batchBytes > ENVIRONMENT_LIMITS.traceBytes) throw traceLimit();
          batch.push({ agent, req });
        }
        if (decisions.length + batch.length > ENVIRONMENT_LIMITS.decisions) {
          throw Object.assign(new Error(`Environment decision limit (${ENVIRONMENT_LIMITS.decisions}) exceeded; reduce ticks or actors.`), { code: 'DECISION_LIMIT' });
        }
        if (batch.length) {
          const answers = await provider.decideMany(batch.map(item => item.req), { seed, spec, signal });
          signal?.throwIfAborted();
          if (!Array.isArray(answers) || answers.length !== batch.length) throw new Error(`Provider returned ${answers?.length ?? 'no'} decisions for ${batch.length} requests.`);
          const answerBytes = Buffer.byteLength(JSON.stringify(answers));
          if (traceBytes + batchBytes + answerBytes > ENVIRONMENT_LIMITS.traceBytes) throw traceLimit();
          traceBytes += batchBytes + answerBytes;
          for (let index = 0; index < batch.length; index++) {
            const { agent, req } = batch[index], answer = answers[index] ?? {};
            const sampled = sampleDecision(req, answer, seedRng(seed, 'environment-decision', agent.id, req.decisionIndex));
            const action = actionById.get(sampled.action);
            let applied = false, reason = null;
            if (!action || !req.options.some(option => option.key === action.id) || !applicable(action, agent)) reason = 'invalid action';
            else if (!conditionsMet(action, agent)) reason = 'requirements changed';
            else if (!capacityAvailable(action)) reason = 'resource capacity was reserved by another actor';
            else {
              for (const claim of action.resources) {
                const resource = resources.get(claim.id); resource.used += claim.units; resource.peak = Math.max(resource.peak, resource.used);
              }
              agent.action = action.id; agent.busyUntil = tick + action.duration; agent.status = 'running'; agent.startedOrder = decisions.length;
              events.push({ tick, type: 'started', agentId: agent.id, action: action.id, completesAt: agent.busyUntil });
              applied = true;
            }
            if (!applied) { blockedDecisions++; idleAgentTicks++; events.push({ tick, type: 'blocked', agentId: agent.id, action: sampled.action, reason }); }
            decisions.push({ ...req, decision: clone(answer), applied: { action: sampled.action, accepted: applied, reason } });
          }
        }
      }
      if (tick % frameStride === 0 || tick === spec.ticks) capture();
      onProgress?.({ tick, ticks: spec.ticks, decisions: decisions.length, completedActions, providerStats: stats() });
      // Let HTTP cancellation and progress subscribers run even for a synchronous rules baseline.
      await yieldTurn();
    }
    tick = spec.ticks;
    return result();
  } catch (error) {
    if (frames.at(-1)?.tick !== tick) capture();
    error.partialResult = result();
    throw error;
  }
}
