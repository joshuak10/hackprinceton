// Shared Scope palette. Reading styles is deferred until a renderer paints.
import { makeRamp } from './heat.js';

const STATE_VAR = ['--a-walk', '--a-queue', '--a-serve', '--a-think', '--a-leave', '--a-car'];

export function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = name => cs.getPropertyValue(name).trim();
  const names = ['--ground', '--room', '--room-edge', '--mesh', '--hatch', '--wall', '--label', '--muted', '--faint', '--text', '--accent',
    '--asphalt', '--stall', '--parked', '--store', '--panel', '--line-2', '--i-decision', '--i-congestion', '--i-complaint',
    '--heat-1', '--heat-2', '--heat-3', '--heat-blend', '--g-1', '--g-2', '--g-3', '--g-4', '--g-5', '--c-returning', '--c-new', ...STATE_VAR];
  const p = {};
  for (const n of names) p[n.slice(2)] = v(n);
  p.ramp = makeRamp(p['heat-1'], p['heat-2'], p['heat-3']);
  p.light = document.documentElement.dataset.theme === 'light';
  return p;
}
