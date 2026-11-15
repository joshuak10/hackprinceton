import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workflowLayout, createWorkflowRenderer } from '../web/studio/render.js';

test('workflow layout preserves the authored state graph, including self-loops and parallel actions', () => {
  const spec = JSON.parse(readFileSync(new URL('../environments/warehouse-fulfillment.json', import.meta.url), 'utf8'));
  const before = structuredClone(spec), layout = workflowLayout(spec);
  assert.deepEqual(spec, before);
  assert.deepEqual(layout, workflowLayout(structuredClone(spec)));
  const authoredStates = new Set([...spec.roles.map(role => role.initialState), ...spec.actions.flatMap(action => [...action.from, action.to])]);
  assert.deepEqual(new Set(layout.zones.map(zone => zone.id)), authoredStates);
  for (const action of spec.actions) for (const from of action.from) {
    const edges = layout.edges.filter(edge => edge.from === from && edge.to === action.to && edge.actions.some(entry => entry.id === action.id));
    assert.equal(edges.length, 1, `authored transition ${action.id} is represented once`);
  }
  assert.ok(layout.edges.some(edge => edge.from === edge.to), 'waiting remains a state self-loop');
  assert.ok(layout.edges.some(edge => edge.actions.length > 1), 'standard and express shipping share their actual destination');
});

test('long workflows fit their diagram bounds without overlapping state zones', () => {
  const spec = {
    roles: [{ initialState: 'start' }],
    actions: Array.from({ length: 100 }, (_, index) => ({ id: `a${index}`, from: [index ? `state${index}` : 'start'], to: `state${index + 1}` }))
  };
  const layout = workflowLayout(spec);
  assert.equal(layout.zones.length, 101);
  for (const zone of layout.zones) {
    assert.ok(zone.x >= 0 && zone.y >= 0 && zone.x + zone.w <= layout.width && zone.y + zone.h <= layout.height);
    for (const other of layout.zones) {
      if (other === zone) continue;
      assert.ok(zone.x + zone.w <= other.x || other.x + other.w <= zone.x || zone.y + zone.h <= other.y || other.y + other.h <= zone.y);
    }
  }
});

// Exercise canvas hit testing against the points actually painted. The fake context collects
// filled circles; it does not reproduce the renderer's layout or coordinate transformation.
function fakeCanvas(t) {
  const previous = new Map(['window', 'document', 'getComputedStyle'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.window = { devicePixelRatio: 2 };
  globalThis.document = { documentElement: { dataset: { theme: 'dark' } } };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#8ec5ff' });
  t.after(() => { for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  const dots = [], events = new Map(), attributes = new Map();
  let arc = null;
  const context = new Proxy({
    clearRect() { dots.length = 0; },
    beginPath() { arc = null; },
    arc(x, y, radius) { arc = { x, y, radius }; },
    fill() { if (arc) dots.push(arc); },
    measureText(text) { return { width: String(text).length * 7 }; }
  }, { get: (target, name) => name in target ? target[name] : () => {} });
  const bounds = { left: 35, top: 60, width: 1000, height: 700 };
  const canvas = {
    style: {}, getContext: () => context, getBoundingClientRect: () => bounds,
    setAttribute: (name, value) => attributes.set(name, value),
    addEventListener: (name, listener) => events.set(name, listener),
    removeEventListener: name => events.delete(name)
  };
  const click = dot => events.get('click')?.({ clientX: bounds.left + dot.x, clientY: bounds.top + dot.y });
  return { canvas, dots, events, attributes, bounds, click };
}

test('recorded actors stay selectable through role filtering, zoom and a state transition', t => {
  const surface = fakeCanvas(t), selections = [];
  const renderer = createWorkflowRenderer(surface.canvas, { onSelect: id => selections.push(id) });
  const spec = {
    roles: [{ id: 'first', initialState: 'ready', count: 1 }, { id: 'second', initialState: 'ready', count: 1 }],
    actions: [{ id: 'finish', from: ['ready'], to: 'done' }]
  };
  const agents = [
    { id: 'first_1', role: 'first', state: 'ready', status: 'idle', action: null },
    { id: 'second_1', role: 'second', state: 'ready', status: 'idle', action: null }
  ];
  renderer.setRun(spec, { agents });
  renderer.draw({ tick: 0, agents }, { role: 'second', colorBy: 'role' });
  assert.equal(surface.dots.length, 1);
  surface.click(surface.dots[0]); assert.equal(selections.at(-1), 'second_1');
  surface.events.get('wheel')({ deltaY: -200, clientX: 500, clientY: 350, preventDefault() {} });
  surface.click(surface.dots[0]); assert.equal(selections.at(-1), 'second_1');
  const oldPosition = { ...surface.dots[0] };
  renderer.draw({ tick: 1, agents: [agents[0], { ...agents[1], state: 'done', status: 'terminal' }] }, { role: 'second' });
  const count = selections.length;
  surface.click(oldPosition); assert.equal(selections.length, count, 'old hit target was cleared');
  surface.click(surface.dots[0]); assert.equal(selections.at(-1), 'second_1');
  assert.match(surface.attributes.get('aria-label'), /workflow states, not physical locations/);
  renderer.destroy(); assert.equal(surface.events.size, 0);
});
