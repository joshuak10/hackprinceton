// A deliberately declarative contract: generated environments never execute JavaScript.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const ENVIRONMENT_SCHEMA = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));
export const ENVIRONMENT_LIMITS = Object.freeze({ ticks: 1000, actors: 500, decisions: 20000, frames: 121, definitionBytes: 512 * 1024, traceBytes: 64 * 1024 * 1024 });
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalarType = value => value === null ? 'null' : typeof value;

// Validate the small, explicit JSON Schema vocabulary used by schema.json. Keeping the schema
// authoritative means the Claude output contract and the runtime cannot silently diverge.
function check(value, schema, path, errors) {
  if (errors.length >= 100) return;
  if (schema.$ref) return check(value, schema.$ref.split('/').slice(1).reduce((node, key) => node[key], ENVIRONMENT_SCHEMA), path, errors);
  const fail = message => errors.push(`${path}: ${message}`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) fail(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    const fits = types.some(type => type === 'object' ? object(value) : type === 'array' ? Array.isArray(value) :
      type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) :
        type === 'null' ? value === null : typeof value === type);
    if (!fits) { fail(`must be ${types.join(' or ')}`); return; }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('must be finite');
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength && value.trim().length < schema.minLength) fail('must not be blank');
    if (schema.maxLength && value.length > schema.maxLength) fail(`must have at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`must match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) fail(`needs at least ${schema.minItems} entries`);
    if (schema.maxItems && value.length > schema.maxItems) fail(`allows at most ${schema.maxItems} entries`);
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) fail('must not contain duplicates');
    if (schema.items) value.slice(0, schema.maxItems ?? 1000).forEach((item, index) => check(item, schema.items, `${path}[${index}]`, errors));
  }
  if (object(value)) {
    const keys = Object.keys(value);
    if (schema.maxProperties && keys.length > schema.maxProperties) fail(`allows at most ${schema.maxProperties} keys`);
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const key of keys) {
      if (FORBIDDEN.has(key)) { fail(`forbidden key ${key}`); continue; }
      if (schema.propertyNames) check(key, schema.propertyNames, `${path}.${key}`, errors);
      if (Object.hasOwn(schema.properties ?? {}, key)) check(value[key], schema.properties[key], `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) fail(`unknown field ${key}`);
      else if (object(schema.additionalProperties)) check(value[key], schema.additionalProperties, `${path}.${key}`, errors);
    }
  }
}

export function validateEnvironment(raw) {
  const errors = [], warnings = [];
  try {
    const encoded = JSON.stringify(raw);
    if (encoded && Buffer.byteLength(encoded) > ENVIRONMENT_LIMITS.definitionBytes) errors.push('environment: serialized definition exceeds 512 KiB');
  } catch { errors.push('environment: must be JSON serializable'); }
  if (errors.length) return { ok: false, spec: null, errors, warnings };
  check(raw, ENVIRONMENT_SCHEMA, 'environment', errors);
  if (errors.length) return { ok: false, spec: null, errors, warnings };
  const spec = structuredClone(raw);
  spec.guidelines ??= []; spec.assumptions ??= []; spec.world ??= {};
  spec.resources ??= []; spec.metrics ??= [];
  for (const role of spec.roles) role.state ??= {};
  for (const action of spec.actions) {
    action.roles ??= []; action.duration ??= 1; action.weight ??= 1;
    action.requirements ??= []; action.effects ??= []; action.resources ??= [];
  }
  const index = (items, path) => {
    const map = new Map();
    for (const item of items) {
      if (FORBIDDEN.has(item.id)) errors.push(`${path}: forbidden id ${item.id}`);
      if (map.has(item.id)) errors.push(`${path}: duplicate id ${item.id}`);
      map.set(item.id, item);
    }
    return map;
  };
  const roles = index(spec.roles, 'roles'), resources = index(spec.resources, 'resources');
  index(spec.actions, 'actions'); index(spec.metrics, 'metrics');
  const total = spec.roles.reduce((sum, role) => sum + role.count, 0);
  if (total > ENVIRONMENT_LIMITS.actors) errors.push(`roles: total actor count ${total} exceeds ${ENVIRONMENT_LIMITS.actors}`);
  const states = new Set([...spec.roles.map(role => role.initialState), ...spec.actions.map(action => action.to)]);
  for (const state of states) if (FORBIDDEN.has(state)) errors.push(`states: forbidden state ${state}`);
  const declaredValues = (field, eligible, path) => {
    const entries = field.scope === 'world' ? [['world', spec.world]] : eligible.map(role => [`roles.${role.id}.state`, role.state]);
    return entries.map(([where, values]) => {
      if (!Object.hasOwn(values, field.key)) errors.push(`${path}: ${where}.${field.key} must be declared initially`);
      return values[field.key];
    });
  };
  for (const action of spec.actions) {
    const path = `actions.${action.id}`;
    for (const role of action.roles) if (!roles.has(role)) errors.push(`${path}.roles: unknown role ${role}`);
    for (const state of action.from) if (!states.has(state)) errors.push(`${path}.from: unreachable state ${state} (no initial state or transition enters it)`);
    const eligible = spec.roles.filter(role => !action.roles.length || action.roles.includes(role.id));
    const claims = new Set();
    for (const claim of action.resources) {
      if (claims.has(claim.id)) errors.push(`${path}.resources: duplicate resource ${claim.id}`);
      claims.add(claim.id);
      const resource = resources.get(claim.id);
      if (!resource) errors.push(`${path}.resources: unknown resource ${claim.id}`);
      else if (claim.units > resource.capacity) errors.push(`${path}.resources: ${claim.id} claim exceeds capacity`);
    }
    for (const [kind, fields] of [['requirements', action.requirements], ['effects', action.effects]]) {
      for (const [i, field] of fields.entries()) {
        const at = `${path}.${kind}[${i}]`;
        const values = declaredValues(field, eligible, at);
        if (['add', 'gte', 'lte'].includes(field.op)) {
          if (typeof field.value !== 'number' || values.some(value => typeof value !== 'number')) errors.push(`${at}: ${field.op} needs a numeric value and numeric state keys`);
        } else if (values.some(value => value !== undefined && scalarType(value) !== scalarType(field.value))) {
          errors.push(`${at}: value must have the same scalar type as the declared state key`);
        }
      }
    }
    if (action.duration > spec.ticks) warnings.push(`${path}: duration exceeds the run horizon; it can start but cannot finish`);
  }
  for (const metric of spec.metrics) {
    const values = declaredValues(metric, spec.roles, `metrics.${metric.id}`);
    if (values.some(value => typeof value !== 'number')) errors.push(`metrics.${metric.id}: aggregate metrics require numeric state keys`);
  }
  for (const role of spec.roles) {
    if (!spec.actions.some(action => (!action.roles.length || action.roles.includes(role.id)) && action.from.includes(role.initialState))) {
      warnings.push(`roles.${role.id}: no action leaves its initial state; its actors start terminal`);
    }
  }
  if (spec.guidelines.length) warnings.push('Guidelines inform Jev decisions. Only declared requirements, transitions, effects and resource capacities are enforced by the runtime.');
  return { ok: !errors.length, spec: errors.length ? null : spec, errors, warnings };
}

export function normalizeEnvironment(raw) {
  const result = validateEnvironment(raw);
  if (!result.ok) throw Object.assign(new Error(`Invalid environment:\n${result.errors.join('\n')}`), { code: 'INVALID_ENVIRONMENT', errors: result.errors });
  return result.spec;
}

export function environmentHash(raw) {
  return createHash('sha256').update(JSON.stringify(normalizeEnvironment(raw))).digest('hex').slice(0, 16);
}
