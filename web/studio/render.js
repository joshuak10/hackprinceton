// The dashboard's drawing (its palette and type) applied to the steps of a workflow. These are diagram positions,
// never physical coordinates: a person stays in their current step until the recorded transition.
import { readPalette } from '../scope/lib/palette.js';

const hash = value => {
  let result = 2166136261;
  for (const character of String(value)) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
};
const title = value => String(value).replace(/_/g, ' ').replace(/^./, character => character.toUpperCase());
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function workflowLayout(spec) {
  const names = [...new Set([
    ...(spec?.roles || []).map(role => role.initialState),
    ...(spec?.actions || []).flatMap(action => [...action.from, action.to])
  ])];
  const rank = new Map(), queue = [];
  for (const role of spec?.roles || []) if (!rank.has(role.initialState)) { rank.set(role.initialState, 0); queue.push(role.initialState); }
  for (let index = 0; index < queue.length; index++) {
    const source = queue[index];
    for (const action of spec?.actions || []) if (action.from.includes(source) && !rank.has(action.to)) {
      rank.set(action.to, rank.get(source) + 1); queue.push(action.to);
    }
  }
  const lastRank = Math.max(0, ...rank.values());
  for (const name of names) if (!rank.has(name)) rank.set(name, lastRank + 1);
  // Long chains wrap into a compact grid. Arrows retain the authored relationships.
  const columns = Math.min(5, Math.max(0, ...rank.values()) + 1);
  const groups = Array.from({ length: columns }, () => []);
  for (const name of names) groups[rank.get(name) % columns].push(name);
  const rows = Math.max(1, ...groups.map(group => group.length));
  const width = columns * 250 - 60, height = rows * 200 - 50;
  const zones = groups.flatMap((group, column) => group.map((name, row) => ({
    id: name, x: column * 250, y: (height - (group.length * 200 - 50)) / 2 + row * 200, w: 190, h: 150
  })));
  const edgeMap = new Map();
  for (const action of spec?.actions || []) for (const from of action.from) {
    const key = `${from}>${action.to}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { from, to: action.to, actions: [] });
    edgeMap.get(key).actions.push(action);
  }
  return { zones, edges: [...edgeMap.values()], width, height };
}

// onSelect(id): a person's dot was picked. onView(moved): the view was panned or zoomed (true) or put back (false).
// tr(text): translates the few fixed strings drawn on the canvas; the page passes the language module's.
export function createWorkflowRenderer(canvas, { onSelect = () => {}, onView = () => {}, tr = text => text } = {}) {
  const context = canvas.getContext('2d');
  let spec = null, diagram = null, actors = [], slots = new Map(), frame = null;
  let opts = {}, hits = [], size = { width: 1, height: 1, dpr: 1 }, view = { x: 0, y: 0, zoom: 1 };
  let pointer = null, suppressClick = false, destroyed = false;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Map of the work. Each dot is a person. Click a dot to see what that person chose. Boxes are workflow states, not physical locations.');
  canvas.tabIndex = 0;
  canvas.style.touchAction = 'none';

  const geometry = () => {
    if (!diagram) return { scale: 1, x: 0, y: 0 };
    // Room is left for the tools in the top corner and the legend at the bottom.
    const fit = Math.max(0.04, Math.min((size.width - 100) / diagram.width, (size.height - 96) / diagram.height));
    const scale = fit * view.zoom;
    return { scale, x: size.width / 2 - diagram.width * scale / 2 + view.x, y: size.height / 2 - diagram.height * scale / 2 + view.y };
  };
  const position = event => {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const hitAt = point => hits.reduce((best, hit) => {
    const distance = Math.hypot(hit.x - point.x, hit.y - point.y);
    return distance <= Math.max(7, hit.radius + 3) && (!best || distance < best.distance) ? { ...hit, distance } : best;
  }, null);
  const shortened = (text, maxWidth) => {
    let out = String(text);
    if (context.measureText(out).width <= maxWidth) return out;
    while (out.length > 1 && context.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
    return out + '…';
  };

  function paint() {
    if (destroyed || !context) return;
    const palette = readPalette();
    const g = context;
    g.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    g.clearRect(0, 0, size.width, size.height);
    g.fillStyle = palette.ground; g.fillRect(0, 0, size.width, size.height);
    hits = [];
    if (!diagram?.zones.length || !frame) {
      g.textAlign = 'center'; g.fillStyle = palette.muted; g.font = '400 15px "IBM Plex Sans", system-ui, sans-serif';
      g.fillText(tr('This environment has no steps to draw.'), size.width / 2, size.height / 2);
      return;
    }
    const transform = geometry(), { scale } = transform;
    const screen = point => ({ x: transform.x + point.x * scale, y: transform.y + point.y * scale });
    const visible = frame.agents.filter(agent => !opts.role || agent.role === opts.role);
    const selected = frame.agents.find(agent => agent.id === opts.selectedAgent);
    const zones = new Map(diagram.zones.map(zone => [zone.id, zone]));
    const byState = new Map(diagram.zones.map(zone => [zone.id, []]));
    for (const agent of visible) byState.get(agent.state)?.push(agent);
    const roleColors = new Map((spec.roles || []).map((role, index) => [role.id, palette[`g-${index % 5 + 1}`]]));
    const actorColor = agent => opts.colorBy === 'role' ? roleColors.get(agent.role) || palette['a-walk'] :
      agent.status === 'terminal' ? palette['a-serve'] : agent.status === 'running' ? palette['a-walk'] : palette['a-queue'];
    const arrow = (from, to, active) => {
      const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
      if (!length) return;
      g.strokeStyle = active ? palette.accent : palette['room-edge']; g.fillStyle = g.strokeStyle;
      g.lineWidth = active ? 2 : 1.15; g.beginPath(); g.moveTo(from.x, from.y); g.lineTo(to.x, to.y); g.stroke();
      const tip = Math.atan2(dy, dx), radius = clamp(5 * scale, 4, 8);
      g.beginPath(); g.moveTo(to.x, to.y); g.lineTo(to.x - Math.cos(tip - .48) * radius, to.y - Math.sin(tip - .48) * radius);
      g.lineTo(to.x - Math.cos(tip + .48) * radius, to.y - Math.sin(tip + .48) * radius); g.closePath(); g.fill();
    };
    for (const edge of diagram.edges) {
      const from = zones.get(edge.from), to = zones.get(edge.to);
      if (!from || !to) continue;
      const permitted = edge.actions.filter(action => !opts.role || !action.roles?.length || action.roles.includes(opts.role));
      if (!permitted.length) continue;
      const active = selected?.action && permitted.some(action => action.id === selected.action);
      if (from === to) {
        const start = screen({ x: from.x + from.w - 32, y: from.y }), end = screen({ x: from.x + from.w - 5, y: from.y });
        g.strokeStyle = active ? palette.accent : palette['room-edge']; g.lineWidth = active ? 2 : 1;
        g.beginPath(); g.moveTo(start.x, start.y); g.bezierCurveTo(start.x, start.y - 22 * scale, end.x + 10 * scale, end.y - 22 * scale, end.x, end.y); g.stroke();
        continue;
      }
      const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
      const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
      const dx = toCenter.x - fromCenter.x, dy = toCenter.y - fromCenter.y;
      const exit = 1 / Math.max(Math.abs(dx) / (from.w / 2 + 3), Math.abs(dy) / (from.h / 2 + 3));
      const entry = 1 / Math.max(Math.abs(dx) / (to.w / 2 + 3), Math.abs(dy) / (to.h / 2 + 3));
      arrow(screen({ x: fromCenter.x + dx * exit, y: fromCenter.y + dy * exit }), screen({ x: toCenter.x - dx * entry, y: toCenter.y - dy * entry }), active);
    }

    for (const zone of diagram.zones) {
      const point = screen(zone), width = zone.w * scale, height = zone.h * scale;
      const occupants = byState.get(zone.id), focused = selected?.state === zone.id;
      const fontSize = clamp(13 * scale, 10, 15), headingHeight = Math.max(29, 34 * scale);
      g.fillStyle = palette.room; g.fillRect(point.x, point.y, width, height);
      g.strokeStyle = focused ? palette.accent : palette['room-edge']; g.lineWidth = focused ? 1.8 : 1;
      g.strokeRect(point.x, point.y, width, height);
      g.strokeStyle = palette.mesh; g.beginPath(); g.moveTo(point.x, point.y + headingHeight); g.lineTo(point.x + width, point.y + headingHeight); g.stroke();
      g.textAlign = 'left'; g.fillStyle = palette.label; g.font = `500 ${fontSize}px "IBM Plex Sans", system-ui, sans-serif`;
      if (width > 56) g.fillText(shortened(title(zone.id), width - 48), point.x + 11, point.y + headingHeight * .65);
      g.textAlign = 'right'; g.fillStyle = occupants.length ? palette.text : palette.muted;
      g.font = `600 ${fontSize}px "IBM Plex Sans", system-ui, sans-serif`; g.fillText(String(occupants.length), point.x + width - 11, point.y + headingHeight * .65);
      const inset = Math.max(8, 14 * scale), innerWidth = Math.max(1, width - inset * 2), innerHeight = Math.max(1, height - headingHeight - inset * 2);
      const total = Math.max(1, actors.length), columns = Math.max(1, Math.ceil(Math.sqrt(total * innerWidth / innerHeight)));
      const rows = Math.ceil(total / columns), cellWidth = innerWidth / columns, cellHeight = innerHeight / rows;
      const radius = clamp(Math.min(cellWidth, cellHeight) * .25, 1.8, 4.2);
      g.save(); g.beginPath(); g.rect(point.x + 1, point.y + headingHeight + 1, width - 2, Math.max(0, height - headingHeight - 2)); g.clip();
      for (const agent of occupants) {
        const slot = ((slots.get(agent.id) ?? hash(agent.id)) + hash(zone.id)) % total;
        const jitterX = (hash(`${agent.id}:x`) / 4294967296 - .5) * .24;
        const jitterY = (hash(`${agent.id}:y`) / 4294967296 - .5) * .24;
        const x = point.x + inset + (slot % columns + .5 + jitterX) * cellWidth;
        const y = point.y + headingHeight + inset + (Math.floor(slot / columns) + .5 + jitterY) * cellHeight;
        g.fillStyle = actorColor(agent); g.beginPath(); g.arc(x, y, radius, 0, Math.PI * 2); g.fill();
        if (agent.status === 'running') { g.globalAlpha = .35; g.strokeStyle = actorColor(agent); g.lineWidth = 1; g.beginPath(); g.arc(x, y, radius + 2, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1; }
        if (agent.id === opts.selectedAgent) { g.strokeStyle = palette.text; g.lineWidth = 1.8; g.beginPath(); g.arc(x, y, radius + 5, 0, Math.PI * 2); g.stroke(); }
        if (x >= 0 && x <= size.width && y >= 0 && y <= size.height) hits.push({ id: agent.id, x, y, radius });
      }
      g.restore();
    }
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    size = { width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)), dpr: Math.min(2, window.devicePixelRatio || 1) };
    canvas.width = Math.round(size.width * size.dpr); canvas.height = Math.round(size.height * size.dpr);
    paint();
  }
  function zoom(factor, around = { x: size.width / 2, y: size.height / 2 }) {
    const before = geometry(), next = clamp(view.zoom * factor, .35, 5);
    const ratio = next / view.zoom;
    view.zoom = next;
    view.x = around.x - size.width / 2 - (around.x - size.width / 2 - view.x) * ratio;
    view.y = around.y - size.height / 2 - (around.y - size.height / 2 - view.y) * ratio;
    if (before.scale) paint();
    moved();
  }
  const moved = () => onView(view.x !== 0 || view.y !== 0 || view.zoom !== 1);
  function resetView() { view = { x: 0, y: 0, zoom: 1 }; paint(); moved(); }
  const click = event => { if (suppressClick) { suppressClick = false; return; } const hit = hitAt(position(event)); if (hit) onSelect(hit.id); };
  const down = event => { if (event.button !== 0) return; pointer = { ...position(event), viewX: view.x, viewY: view.y, moved: false }; canvas.setPointerCapture?.(event.pointerId); };
  const move = event => {
    const point = position(event);
    if (!pointer) { canvas.style.cursor = hitAt(point) ? 'pointer' : 'grab'; return; }
    const dx = point.x - pointer.x, dy = point.y - pointer.y;
    if (Math.hypot(dx, dy) > 4) pointer.moved = true;
    if (pointer.moved) { view.x = pointer.viewX + dx; view.y = pointer.viewY + dy; canvas.style.cursor = 'grabbing'; paint(); moved(); }
  };
  const up = () => { suppressClick = !!pointer?.moved; pointer = null; canvas.style.cursor = 'grab'; };
  const wheel = event => { event.preventDefault(); zoom(Math.exp(-event.deltaY * .001), position(event)); };
  const key = event => {
    if (event.key === '0') { resetView(); event.preventDefault(); }
    else if (['+', '=', '-'].includes(event.key)) { zoom(event.key === '-' ? .85 : 1.15); event.preventDefault(); }
    else if (['ArrowLeft', 'ArrowRight'].includes(event.key) && hits.length) {
      const index = hits.findIndex(hit => hit.id === opts.selectedAgent), step = event.key === 'ArrowLeft' ? -1 : 1;
      onSelect(hits[(index + step + hits.length) % hits.length].id); event.preventDefault();
    }
  };
  const listeners = [['click', click], ['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', up], ['wheel', wheel], ['keydown', key]];
  for (const [name, listener] of listeners) canvas.addEventListener(name, listener, name === 'wheel' ? { passive: false } : undefined);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas); resize();
  return {
    setRun(nextSpec, result) {
      spec = nextSpec; diagram = spec ? workflowLayout(spec) : null;
      actors = result?.agents || (spec?.roles || []).flatMap(role => Array.from({ length: role.count }, (_, index) => ({ id: `${role.id}_${index + 1}`, role: role.id })));
      slots = new Map(actors.slice().sort((a, b) => hash(a.id) - hash(b.id) || a.id.localeCompare(b.id)).map((agent, index) => [agent.id, index]));
      frame = null; hits = []; view = { x: 0, y: 0, zoom: 1 }; paint(); moved();
    },
    draw(nextFrame, options = {}) { frame = nextFrame; opts = options; paint(); },
    resize,
    resetView,
    destroy() { destroyed = true; observer?.disconnect(); for (const [name, listener] of listeners) canvas.removeEventListener(name, listener); hits = []; }
  };
}
