// Demand (docs/PROTOTYPE.md §14b): who walks through the building in a scenario, how many, and what each
// tenant space can serve. Counts come from the building profile where it has data (tenant headcounts,
// square feet, hours) and from DEFAULT_ASSUMPTIONS otherwise. Every number is tagged `data` or `assumed`,
// and every assumption used is listed in assumptionsUsed so a robustness check can nudge it.
import { PUBLIC_USES, sameFloor } from './profile.js';

export const SCENARIOS = Object.freeze({
  'weekday-morning': Object.freeze({ id: 'weekday-morning', label: 'weekday morning', day: 'weekday', clockStart: 450, duration: 150 }),
  'weekday-lunch': Object.freeze({ id: 'weekday-lunch', label: 'weekday lunch', day: 'weekday', clockStart: 690, duration: 120 }),
  'saturday-afternoon': Object.freeze({ id: 'saturday-afternoon', label: 'Saturday afternoon', day: 'saturday', clockStart: 720, duration: 180 })
});

// The tag on the stairs or elevator place that stands for every other floor.
export const OTHER_FLOORS_TAG = 'other floors';
// Uses people walk in to (food, shops, services) and uses people book ahead (clinics, classes).
export const WALK_IN_USES = ['restaurant', 'retail', 'service'];
export const APPOINTMENT_USES = ['medical', 'fitness'];
export const MAX_GROUPS = 6;   // the world spec allows six archetypes

const deepFreeze = o => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };

// Every made-up number in the pipeline. These are ASSUMPTIONS, not facts: rough planning values chosen so
// the simulation is plausible, each with its basis in plain words. Override any of them through
// profileToDemand's `assumptions` option; overridden values are still tagged `assumed`.
export const DEFAULT_ASSUMPTIONS = deepFreeze({
  // About 200 rentable square feet per office worker: the middle of the 150-250 SF range common in US
  // office space planning. Used only when CoStar gives a tenant's square feet but not its employees.
  sfPerOfficeWorker: 200,
  // Share of an office tenant's workers who are in the building on a typical weekday. Hybrid work keeps
  // this near half (badge-swipe occupancy trackers have reported roughly 50-55% in recent years).
  officeAttendance: 0.55,
  // Share of the day's in-office workers who arrive between 7:30 and 10:00; the rest come earlier or later.
  morningArrivalShare: 0.8,
  // Share of in-office workers who walk to a food, shop or service tenant inside this building during the
  // two-hour lunch window. The rest eat at their desks or leave the building (not simulated).
  lunchOutShare: 0.35,
  // Walk-in customer visits per 1,000 SF per hour in a normal open hour, by use. Rough rates for small
  // in-line tenants: a counter-service cafe sees a steady stream, a dentist a few patients an hour.
  // `office` is visitors and couriers to an office suite.
  visitsPer1000SFPerHour: { restaurant: 8, retail: 3, service: 1.5, medical: 1, fitness: 2, office: 0.3 },
  // How busy each use is in this window compared with its normal open hour: lunch is the food peak,
  // Saturday afternoon the shopping peak, and offices and clinics are quiet on Saturday.
  scenarioFactor: {
    'weekday-morning': { restaurant: 0.5, retail: 0.2, service: 0.5, medical: 0.8, fitness: 0.7, office: 0.5 },
    'weekday-lunch': { restaurant: 1.6, retail: 1.0, service: 1.0, medical: 0.8, fitness: 0.8, office: 1.0 },
    'saturday-afternoon': { restaurant: 1.2, retail: 1.5, service: 0.8, medical: 0.3, fitness: 1.0, office: 0.1 }
  },
  // Minutes one person spends being served, by use: ordering and picking up at a counter, browsing and
  // paying, a haircut or bank visit, a dental appointment, a class, signing in at an office reception.
  dwellMinutes: { restaurant: 3, retail: 10, service: 15, medical: 30, fitness: 45, office: 3, other: 10 },
  // People served at the same time per 1,000 SF, by use: registers at a counter, shoppers a small shop
  // holds, chairs or stations, treatment rooms, people in a class, reception desks.
  serversPer1000SF: { restaurant: 1, retail: 3, service: 1.5, medical: 1, fitness: 8, office: 0.1, other: 1 },
  // Square feet assumed for a tenant whose size CoStar does not give: typical small in-line spaces.
  defaultTenantSF: { restaurant: 2000, retail: 1500, service: 1200, medical: 2500, fitness: 4000, office: 3000, other: 1500 },
  // What one person typically spends, in dollars. Shown to agents as cost; clinics bill later and gyms
  // are paid by membership, so nothing is paid at the door.
  priceByUse: { restaurant: 12, retail: 30, service: 25, medical: 0, fitness: 0, office: 0, other: 0 },
  // Minutes of waiting in one line each group puts up with. Lunch-break workers 10-15 minutes (as in
  // worlds/SCHEMA.md); people with an appointment wait longer; Saturday shoppers are less rushed.
  patience: { workerMorning: 8, workerLunch: 12, customer: 15, appointment: 30, weekendCustomer: 20, visitor: 10 },
  // Share of each group with live wait information (an app or a screen). Small buildings rarely have one.
  info: { worker: 0.2, customer: 0.15 },
  // Most places one person is served at before leaving: a coffee stop then the desk; lunch then one errand.
  visits: { workerMorning: 2, workerLunch: 2, customer: 2, appointment: 1, visitor: 1 },
  // Rules-policy weights (used only by the rules provider and the API-outage fallback, never by Jev):
  // workers on a break weigh waits and walking more and price less than customers do.
  ruleWeights: {
    worker: { appeal: 1, wait: 1.5, distance: 1.5, price: 0.2 },
    customer: { appeal: 1, wait: 1, distance: 0.8, price: 0.5 }
  },
  // Rules-policy appeal (0-1): a worker's own office is where they are headed; other places are neutral.
  appeal: { ownOffice: 0.9, place: 0.5 },
  // Opening hours by use when CoStar gives none ([open, close], null = closed that day). Cafes are
  // restaurants whose name or industry says coffee, bakery, bagels, breakfast, juice or tea.
  defaultHours: {
    weekday: { office: ['08:00', '18:00'], cafe: ['06:30', '16:00'], restaurant: ['11:00', '21:00'], retail: ['10:00', '19:00'],
      service: ['09:00', '18:00'], medical: ['08:00', '17:00'], fitness: ['05:30', '21:00'], other: ['09:00', '17:00'] },
    saturday: { office: null, cafe: ['07:30', '15:00'], restaurant: ['11:00', '21:00'], retail: ['10:00', '19:00'],
      service: ['09:00', '17:00'], medical: null, fitness: ['07:00', '18:00'], other: null }
  },
  // When arrivals stop (minutes into the window) and their shape: a commute peak around 8:30, a lunch peak
  // around 12:15, and a flat Saturday afternoon. People still inside finish after arrivals stop.
  arrivalWindow: {
    'weekday-morning': { end: 120, shape: 'peak' },
    'weekday-lunch': { end: 90, shape: 'peak' },
    'saturday-afternoon': { end: 150, shape: 'uniform' }
  },
  // Stairs and elevators as a place people pass through to reach the other floors. Stairs: many climb at
  // once, about half a minute per floor. Elevator: one car carrying about six people per 1.5-minute trip.
  vertical: { stairs: { servers: 20, minutes: 0.5 }, elevator: { servers: 6, minutes: 1.5 } },
  // Indoor walking speed in meters per second (people in a building walk a little slower than outside).
  walkingSpeedMps: 1.2,
  // Which exterior door people use: wider doors (double doors, the main entrance) take a larger share.
  entranceWeightBy: 'door width'
});

// One line per assumption, for assumptionsUsed (the comments above give the fuller basis).
export const ASSUMPTION_NOTES = Object.freeze({
  sfPerOfficeWorker: 'about 200 SF per office worker (US planning range 150-250 SF), used when CoStar has no headcount',
  officeAttendance: 'about half of office workers are in on a typical weekday with hybrid work',
  morningArrivalShare: 'most in-office workers arrive between 7:30 and 10:00',
  lunchOutShare: 'about a third of in-office workers walk to a tenant in the building at lunch',
  visitsPer1000SFPerHour: 'rough walk-in visits per 1,000 SF per open hour for this use',
  scenarioFactor: 'how busy this use is in this window compared with a normal open hour',
  dwellMinutes: 'minutes one person spends being served at this use',
  serversPer1000SF: 'people served at once per 1,000 SF at this use',
  defaultTenantSF: 'typical size of this kind of space, used when CoStar has no square feet',
  priceByUse: 'typical spend per person at this use, shown to agents as cost',
  patience: 'minutes of waiting in one line this group puts up with',
  info: 'share of this group with live wait information',
  visits: 'most places one person is served at before leaving',
  ruleWeights: 'rules-policy weights only (never used by Jev)',
  appeal: 'rules-policy appeal only (never used by Jev)',
  defaultHours: 'opening hours for this use when CoStar gives none',
  arrivalWindow: 'when arrivals stop and their shape in this window',
  vertical: 'how many people the stairs or elevator move at once and how long it takes',
  walkingSpeedMps: 'indoor walking speed, used for walking times',
  entranceWeightBy: 'wider exterior doors take a larger share of arrivals',
  scenarios: 'the study window chosen for this scenario (docs/PROTOTYPE.md §14b)'
});

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const r2 = v => Math.round(v * 100) / 100;
const fmtInt = n => Math.round(n).toLocaleString('en-US');
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));

// The dotted path of a value inside an object: get({ a: { b: 1 } }, 'a.b') → 1.
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

const noteFor = key => {
  for (let k = key; k; k = k.includes('.') ? k.slice(0, k.lastIndexOf('.')) : '') if (ASSUMPTION_NOTES[k]) return ASSUMPTION_NOTES[k];
  return 'assumption';
};

// { key, value, why } for one assumption (a dotted path into the assumptions).
export function assumptionEntry(key, assumptions = DEFAULT_ASSUMPTIONS) {
  return { key, value: getPath(assumptions, key), why: noteFor(key) };
}

// Deep-merges overrides into DEFAULT_ASSUMPTIONS. Unknown keys and values of the wrong type are ignored
// with a warning. Returns { assumptions, warnings }.
export function mergeAssumptions(overrides) {
  const warnings = [];
  const merge = (base, over, path) => {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    for (const [k, v] of Object.entries(over)) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in base)) { warnings.push(`assumptions.${p}: unknown assumption; ignored`); continue; }
      const b = base[k];
      if (isObj(b) && isObj(v)) out[k] = merge(b, v, p);
      else if (typeof b === 'number' && typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
      else if ((b === null || Array.isArray(b)) && (v === null || Array.isArray(v))) out[k] = v;
      else if (typeof b === 'string' && typeof v === 'string') out[k] = v;
      else warnings.push(`assumptions.${p}: ${JSON.stringify(v)} does not fit the default ${JSON.stringify(b)}; ignored`);
    }
    return out;
  };
  if (overrides === undefined || overrides === null) return { assumptions: DEFAULT_ASSUMPTIONS, warnings };
  if (!isObj(overrides)) return { assumptions: DEFAULT_ASSUMPTIONS, warnings: ['assumptions: not an object; using the defaults'] };
  return { assumptions: merge(DEFAULT_ASSUMPTIONS, overrides, ''), warnings };
}

// The tag that ties people to one tenant: its name in lower case, as agents read it under "offers".
export const tenantTag = name => String(name).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40);

const slugId = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'group';

const CAFE = /\b(coffee|cafe|caf[eé]|espresso|bakery|bagels?|donuts?|doughnuts?|breakfast|juice|smoothie|tea)\b/i;
export const isCafe = t => t.use === 'restaurant' && CAFE.test(`${t.name} ${t.industry ?? ''}`);

const minutesOf = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Opening hours of a tenant for the scenario's day: its own hours (data), the building's hours for an
// office (data), else the default for its use (assumed). Returns { open, close, source } or null (closed).
function hoursFor(t, profile, sc, use) {
  if (t.hours) return { open: t.hours.open, close: t.hours.close, source: 'data' };
  if (t.use === 'office' && profile.hours && sc.day === 'weekday') return { ...profile.hours, source: 'data' };
  const kind = isCafe(t) ? 'cafe' : t.use in DEFAULT_ASSUMPTIONS.defaultHours.weekday ? t.use : 'other';
  const key = `defaultHours.${sc.day}.${kind}`;
  const h = use(key);
  return h ? { open: h[0], close: h[1], source: 'assumed' } : null;
}

// Hours of the window [clockStart, clockStart + duration] during which the tenant is open.
function openHoursInWindow(h, sc) {
  if (!h) return 0;
  const a = Math.max(minutesOf(h.open), sc.clockStart), b = Math.min(minutesOf(h.close), sc.clockStart + sc.duration);
  return Math.max(0, b - a) / 60;
}

// Builds the groups (who comes, how many, from where, to what) and the place parameters for a scenario.
//   options.scenario     one of SCENARIOS (default 'weekday-lunch')
//   options.assumptions  overrides of DEFAULT_ASSUMPTIONS
//   options.layout       { here: [tenant names], elsewhere: [tenant names] }: tenants with a room on the
//                        simulated floor, and tenants on other floors reached by stairs or elevator.
//                        Tenants in neither list are left out. Without it, options.floor splits tenants
//                        by their floor; without either, every tenant counts as here.
export function profileToDemand(profile, { scenario = 'weekday-lunch', assumptions, floor, layout } = {}) {
  const sc = SCENARIOS[scenario];
  if (!sc) throw new Error(`profileToDemand: unknown scenario "${scenario}"; use one of ${Object.keys(SCENARIOS).join(', ')}`);
  if (!isObj(profile)) throw new Error('profileToDemand: expected a building profile (docs/PROTOTYPE.md §14a)');
  const merged = mergeAssumptions(assumptions);
  const A = merged.assumptions;
  const warnings = [...merged.warnings];
  const used = new Map();
  const use = key => { const v = getPath(A, key); used.set(key, v); return v; };
  const provenance = {};

  const tenants = (Array.isArray(profile.tenants) ? profile.tenants : []).filter(t => t && t.name && t.use !== 'vacant');
  const where = t => {
    if (layout) return layout.here?.includes(t.name) ? 'here' : layout.elsewhere?.includes(t.name) ? 'elsewhere' : 'absent';
    if (floor !== undefined && floor !== null && t.floor !== null && t.floor !== undefined) return sameFloor(t.floor, floor) ? 'here' : 'elsewhere';
    return 'here';
  };
  const absent = tenants.filter(t => where(t) === 'absent');
  if (absent.length) warnings.push(`left out of the demand (no room on this floor and no stairs or elevator to them): ${absent.map(t => t.name).join(', ')}`);
  const active = tenants.filter(t => where(t) !== 'absent');

  // Square feet (data, or the default for the use) and opening hours of every active tenant.
  const info = new Map();
  for (const t of active) {
    const sfData = Number.isFinite(t.sf) && t.sf > 0;
    const useKey = t.use in A.defaultTenantSF ? t.use : 'other';
    const sf = sfData ? t.sf : use(`defaultTenantSF.${useKey}`);
    const hours = hoursFor(t, profile, sc, use);
    const openH = openHoursInWindow(hours, sc);
    info.set(t.name, { sf, sfSource: sfData ? 'data' : 'assumed', hours, openH, where: where(t) });
    provenance[`places.${t.name}.sf`] = sfData ? 'data' : 'assumed';
    if (hours) provenance[`places.${t.name}.hours`] = hours.source;
  }

  // Office headcount: CoStar employees (data), else square feet ÷ SF per worker (assumed).
  const headcount = {};
  for (const t of active.filter(x => x.use === 'office')) {
    if (Number.isFinite(t.employees)) headcount[t.name] = { employees: t.employees, source: 'data' };
    else if (Number.isFinite(t.sf) && t.sf > 0) headcount[t.name] = { employees: Math.round(t.sf / use('sfPerOfficeWorker')), source: 'assumed' };
    else {
      headcount[t.name] = { employees: Math.round(info.get(t.name).sf / use('sfPerOfficeWorker')), source: 'assumed' };
      warnings.push(`${t.name}: no employees or square feet in the profile; headcount from the default office size`);
    }
    provenance[`headcount.${t.name}`] = headcount[t.name].source;
  }

  // Customer visits to a tenant in this window: SF/1000 × visits per 1,000 SF per hour × open hours × factor.
  const visitsTo = t => {
    const i = info.get(t.name);
    if (!i.openH) return 0;
    const rate = use(`visitsPer1000SFPerHour.${t.use}`), factor = use(`scenarioFactor.${sc.id}.${t.use}`);
    return (i.sf / 1000) * rate * i.openH * factor;
  };

  const groups = [];
  const usedIds = new Set();
  const groupId = base => { let id = slugId(base), k = 2; while (usedIds.has(id)) id = `${slugId(base)}_${k++}`; usedIds.add(id); return id; };
  const addGroup = ({ idBase, ...g }) => {
    if (g.count < 1) return;
    groups.push({ id: groupId(idBase), ...g });
  };
  const worker = { info: use('info.worker'), weights: use('ruleWeights.worker') };
  const customer = { info: use('info.customer'), weights: use('ruleWeights.customer') };
  const isOpen = t => info.get(t.name).openH > 0;
  const offices = active.filter(t => t.use === 'office');
  const publicOpen = active.filter(t => PUBLIC_USES.includes(t.use) && isOpen(t));
  const restaurantOpen = publicOpen.some(t => t.use === 'restaurant');
  const name40 = (s, suffix) => (s.length + suffix.length > 40 ? s.slice(0, 40 - suffix.length).trim() : s) + suffix;
  const sumCounts = list => list.reduce((s, x) => s + x, 0);

  // Workers of each office tenant on this floor (one group each), and of offices on other floors (one group).
  const workerGroups = (share, shareKey, origin, visitsKey, patienceKey, describe, needsHere, needsElsewhere) => {
    const att = use('officeAttendance'), frac = use(shareKey);
    const counts = new Map(offices.map(t => [t.name, Math.round(headcount[t.name].employees * att * frac)]));
    for (const t of offices.filter(x => where(x) === 'here')) {
      const n = counts.get(t.name);
      addGroup({
        idBase: `staff_${t.name}`, name: name40(t.name, ' staff'), role: 'workers',
        description: describe(t.name).slice(0, 200), count: n, tenantCounts: { [t.name]: n },
        origin, tenantNames: [t.name], use: 'office', visits: use(visitsKey), patience: use(patienceKey), ...worker,
        likes: [tenantTag(t.name)], needs: needsHere(t),
        basis: `${headcount[t.name].employees} employees (${headcount[t.name].source}) × ${att} in office × ${frac} ${share} (assumed)`
      });
    }
    const away = offices.filter(x => where(x) === 'elsewhere');
    if (away.length) {
      const tc = Object.fromEntries(away.map(t => [t.name, counts.get(t.name)]));
      addGroup({
        idBase: 'staff_other_floors', name: 'Staff of offices on other floors', role: 'workers-elsewhere',
        description: describe('offices on the other floors').slice(0, 200), count: sumCounts(Object.values(tc)), tenantCounts: tc,
        origin, tenantNames: away.map(t => t.name), use: 'office', visits: use(visitsKey), patience: use(patienceKey), ...worker,
        likes: [], needs: needsElsewhere,
        basis: away.map(t => `${t.name}: ${headcount[t.name].employees} (${headcount[t.name].source})`).join('; ') +
          ` × ${att} in office × ${frac} ${share} (assumed)`
      });
    }
  };

  const customerGroup = (idBase, name, description, list, visitsKey, patienceKey, needs, groupUse) => {
    const tc = Object.fromEntries(list.map(t => [t.name, visitsTo(t)]));
    const total = sumCounts(Object.values(tc));
    addGroup({
      idBase, name, role: 'customers', description, count: Math.round(total),
      tenantCounts: Object.fromEntries(Object.entries(tc).map(([k, v]) => [k, r2(v)])),
      origin: 'outside', tenantNames: list.map(t => t.name), use: groupUse,
      visits: use(visitsKey), patience: use(patienceKey), ...customer, likes: [], needs,
      basis: 'sum over tenants of SF/1000 × visits per 1,000 SF per hour × open hours × scenario factor (assumed rates)'
    });
  };

  // Walk-in uses (food, shops, services) and appointment uses (clinics, classes) get separate groups, so
  // nobody picks a dentist for lunch and patients get an appointment's patience.
  const walkIn = publicOpen.filter(t => WALK_IN_USES.includes(t.use));
  const booked = publicOpen.filter(t => APPOINTMENT_USES.includes(t.use));
  const appointments = (description, patienceKey) => customerGroup('appointments', 'Appointments and classes', description,
    booked, 'visits.appointment', patienceKey, APPOINTMENT_USES, 'medical');
  if (sc.id === 'weekday-morning') {
    const coffee = restaurantOpen ? ['restaurant'] : [];
    workerGroups('arrive this morning', 'morningArrivalShare', 'outside', 'visits.workerMorning', 'patience.workerMorning',
      who => `Staff of ${who} arriving for the workday${coffee.length ? '; some stop for coffee first' : ''}.`,
      t => [tenantTag(t.name), ...coffee], [OTHER_FLOORS_TAG, ...coffee]);
    customerGroup('early_customers', 'Early customers', 'People coming in from outside for coffee or an errand before work.',
      walkIn, 'visits.customer', 'patience.customer', WALK_IN_USES, 'restaurant');
    appointments('People coming in from outside for an early appointment or class.', 'patience.appointment');
  } else if (sc.id === 'weekday-lunch') {
    workerGroups('go out at lunch', 'lunchOutShare', 'tenant', 'visits.workerLunch', 'patience.workerLunch',
      who => `Staff of ${who} leaving their desks at lunch for food, a shop or an errand in the building.`,
      () => WALK_IN_USES, WALK_IN_USES);
    customerGroup('lunch_customers', 'Lunch customers from outside', 'People coming in from the street for lunch, a shop or an errand.',
      walkIn, 'visits.customer', 'patience.customer', WALK_IN_USES, 'restaurant');
    appointments('People coming in from the street for a lunchtime appointment or class.', 'patience.appointment');
    customerGroup('office_visitors', 'Office visitors and couriers', 'Clients, couriers and food deliveries heading to an office reception.',
      offices.filter(isOpen), 'visits.visitor', 'patience.visitor', ['office'], 'office');
  } else {
    customerGroup('diners', 'Saturday diners', 'People coming in for a meal or a coffee on a Saturday.',
      walkIn.filter(t => t.use === 'restaurant'), 'visits.customer', 'patience.weekendCustomer', ['restaurant'], 'restaurant');
    customerGroup('shoppers', 'Saturday shoppers and errands', 'People browsing the shops or running an errand on a Saturday.',
      walkIn.filter(t => t.use !== 'restaurant'), 'visits.customer', 'patience.weekendCustomer', ['retail', 'service'], 'retail');
    appointments('People with a Saturday appointment or class.', 'patience.appointment');
  }

  fitGroups(groups, warnings);
  if (!groups.length) warnings.push(`nobody to simulate in the ${sc.label} scenario: no open tenant with demand`);

  // Place parameters for every active tenant (compose decides which become places in the world).
  const places = {};
  for (const t of active) {
    const i = info.get(t.name);
    const u = t.use in A.dwellMinutes ? t.use : 'other';
    const isPublic = PUBLIC_USES.includes(t.use);
    const p = {
      use: t.use, floor: t.floor ?? null, where: i.where, open: i.openH > 0,
      tags: [tenantTag(t.name), t.use, ...(isPublic ? ['public'] : [])],
      about: describePlace(t, i),
      appeal: use('appeal.place'),
      price: use(`priceByUse.${u}`)
    };
    if (t.use === 'office' && sc.id === 'weekday-morning') {
      // Arriving staff stay at their desks for the rest of the window instead of walking back out:
      // one "server" per desk (the tenant's headcount), and a service time as long as the window.
      p.servers = clampInt(Math.max(1, headcount[t.name].employees), 1, 1000);
      p.serviceTime = sc.duration;
      p.serviceDist = 'fixed';
      p.appeal = use('appeal.ownOffice');
      p.about = `${p.about}; their workplace for the day`.slice(0, 160);
      provenance[`places.${t.name}.serviceTime`] = 'assumed';
      provenance[`places.${t.name}.servers`] = headcount[t.name].source;
    } else {
      p.servers = clampInt((i.sf / 1000) * use(`serversPer1000SF.${u}`), 1, 1000);
      p.serviceTime = use(`dwellMinutes.${u}`);
      provenance[`places.${t.name}.servers`] = 'assumed';
      provenance[`places.${t.name}.serviceTime`] = 'assumed';
    }
    provenance[`places.${t.name}.appeal`] = 'assumed';
    provenance[`places.${t.name}.price`] = 'assumed';
    provenance[`places.${t.name}.about`] = 'data';
    places[t.name] = p;
  }

  for (const g of groups) {
    for (const k of ['count', 'tenantCounts', 'visits', 'patience', 'info', 'weights.appeal', 'weights.wait', 'weights.distance', 'weights.price']) {
      provenance[`groups.${g.id}.${k}`] = 'assumed';
    }
  }

  const win = use(`arrivalWindow.${sc.id}`);
  const total = sumCounts(groups.map(g => g.count));
  const arrivals = { total, start: 0, end: Math.min(win.end, sc.duration), shape: win.shape };
  Object.assign(provenance, { 'arrivals.total': 'assumed', 'arrivals.start': 'assumed', 'arrivals.end': 'assumed', clockStart: 'assumed', duration: 'assumed' });

  const assumptionsUsed = [
    { key: `scenarios.${sc.id}.clockStart`, value: sc.clockStart, why: ASSUMPTION_NOTES.scenarios },
    { key: `scenarios.${sc.id}.duration`, value: sc.duration, why: ASSUMPTION_NOTES.scenarios },
    ...[...used].map(([key, value]) => ({ key, value, why: noteFor(key) }))
  ];

  return {
    scenario: sc.id, label: sc.label, day: sc.day,
    clockStart: sc.clockStart, duration: sc.duration, arrivals,
    groups, places, headcount, provenance, assumptionsUsed, warnings
  };
}

const USE_ABOUT = {
  restaurant: 'counter service', retail: 'walk-in shop', medical: 'appointments and a waiting room',
  service: 'walk-in service', fitness: 'classes and open gym', office: 'office suite with a reception desk', other: 'tenant space'
};

function describePlace(t, i) {
  const bits = [t.industry || t.use];
  bits.push(`about ${fmtInt(i.sf)} SF${i.sfSource === 'assumed' ? ' (estimated)' : ''}`);
  if (t.suite) bits.push(`suite ${t.suite}`);
  const hours = i.hours ? `; open ${i.hours.open}-${i.hours.close}` : '; closed today';
  return `${bits.join(', ')}; ${USE_ABOUT[t.use] ?? USE_ABOUT.other}${hours}`.slice(0, 160);
}

// Keeps at most MAX_GROUPS groups by merging the two smallest groups of office staff on this floor.
// Merged staff in the morning may walk to any of the merged offices, so this is reported.
function fitGroups(groups, warnings) {
  while (groups.length > MAX_GROUPS) {
    const staff = groups.filter(g => g.role === 'workers').sort((a, b) => a.count - b.count);
    if (staff.length < 2) { warnings.push(`more than ${MAX_GROUPS} groups and nothing left to merge; dropped ${groups.splice(MAX_GROUPS).map(g => g.name).join(', ')}`); return; }
    const [a, b] = staff;
    const m = {
      ...a,
      id: a.id.startsWith('staff_more') ? a.id : `staff_more_${groups.filter(g => g.id.startsWith('staff_more')).length + 1}`,
      name: 'Staff of other offices on this floor',
      description: `Staff of ${[...a.tenantNames, ...b.tenantNames].join(', ')}`.slice(0, 200),
      count: a.count + b.count,
      tenantCounts: { ...a.tenantCounts, ...b.tenantCounts },
      tenantNames: [...a.tenantNames, ...b.tenantNames],
      likes: [...new Set([...a.likes, ...b.likes])].slice(0, 12),
      needs: [...new Set([...a.needs, ...b.needs])].slice(0, 12),
      basis: `${a.basis}; ${b.basis}`
    };
    groups.splice(groups.indexOf(a), 1, m);
    groups.splice(groups.indexOf(b), 1);
    warnings.push(`merged the staff of ${a.tenantNames.join(', ')} and ${b.tenantNames.join(', ')} into one group to stay within ${MAX_GROUPS} groups; ` +
      'merged staff may walk to either office');
  }
}
