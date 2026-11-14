// Demand tests (docs/PROTOTYPE.md §14b): scenario groups and counts, data-vs-assumed tags, assumptionsUsed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateProfile } from '../builder/profile.js';
import {
  SCENARIOS, DEFAULT_ASSUMPTIONS, ASSUMPTION_NOTES, OTHER_FLOORS_TAG, WALK_IN_USES, APPOINTMENT_USES, MAX_GROUPS,
  profileToDemand, mergeAssumptions, tenantTag
} from '../builder/demand.js';

const SAMPLE = validateProfile(JSON.parse(readFileSync(new URL('./fixtures/costar/sample-profile.json', import.meta.url), 'utf8'))).profile;
const KESSLER = 'Kessler & Moss Law (fictional)', BRIGHT = 'Brightline Software (fictional)';
const byId = (d, id) => d.groups.find(g => g.id === id);
const staffOf = (d, name) => d.groups.find(g => g.role === 'workers' && g.tenantNames.includes(name));
const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

// Every leaf number of an object, as dotted paths.
function numberPaths(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number') out.push(p);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...numberPaths(v, p));
  }
  return out;
}

describe('scenarios and assumptions', () => {
  test('the three scenarios match the contract', () => {
    assert.deepEqual(Object.keys(SCENARIOS), ['weekday-morning', 'weekday-lunch', 'saturday-afternoon']);
    assert.deepEqual([SCENARIOS['weekday-morning'].clockStart, SCENARIOS['weekday-morning'].duration], [450, 150]);
    assert.deepEqual([SCENARIOS['weekday-lunch'].clockStart, SCENARIOS['weekday-lunch'].duration], [690, 120]);
    assert.deepEqual([SCENARIOS['saturday-afternoon'].clockStart, SCENARIOS['saturday-afternoon'].duration], [720, 180]);
  });

  test('every assumption has a note and the defaults are frozen', () => {
    for (const key of Object.keys(DEFAULT_ASSUMPTIONS)) assert.ok(ASSUMPTION_NOTES[key], `note for ${key}`);
    assert.equal(DEFAULT_ASSUMPTIONS.sfPerOfficeWorker, 200);
    assert.throws(() => { DEFAULT_ASSUMPTIONS.visitsPer1000SFPerHour.retail = 99; }, TypeError);
  });

  test('mergeAssumptions overrides known values and ignores the rest with warnings', () => {
    const { assumptions, warnings } = mergeAssumptions({ officeAttendance: 0.7, patience: { customer: 20 }, nope: 1, sfPerOfficeWorker: 'big' });
    assert.equal(assumptions.officeAttendance, 0.7);
    assert.equal(assumptions.patience.customer, 20);
    assert.equal(assumptions.patience.workerLunch, DEFAULT_ASSUMPTIONS.patience.workerLunch);
    assert.equal(assumptions.sfPerOfficeWorker, 200);
    assert.ok(warnings.some(w => w.startsWith('assumptions.nope:')));
    assert.ok(warnings.some(w => w.startsWith('assumptions.sfPerOfficeWorker:')));
  });
});

describe('profileToDemand: weekday-morning', () => {
  const d = profileToDemand(SAMPLE, { scenario: 'weekday-morning', floor: 1 });

  test('staff of each office tenant on this floor arrive from outside and head to their own office, maybe via a cafe', () => {
    const k = staffOf(d, KESSLER), b = staffOf(d, BRIGHT);
    assert.equal(k.origin, 'outside');
    assert.equal(k.count, Math.round(38 * 0.55 * 0.8));                 // employees from CoStar
    assert.equal(b.count, Math.round(Math.round(6200 / 200) * 0.55 * 0.8)); // headcount from square feet
    assert.deepEqual(k.needs, [tenantTag(KESSLER), 'restaurant']);
    assert.deepEqual(k.tenantNames, [KESSLER]);
    assert.equal(k.visits, DEFAULT_ASSUMPTIONS.visits.workerMorning);
    assert.equal(k.patience, DEFAULT_ASSUMPTIONS.patience.workerMorning);
  });

  test('staff of offices on other floors are one group headed for the stairs or elevator', () => {
    const g = byId(d, 'staff_other_floors');
    assert.deepEqual(g.tenantNames.sort(), ['Halvorsen Insurance (fictional)', 'Ledgerline Accounting (fictional)']);
    assert.equal(g.count, Math.round(30 * 0.44) + Math.round(22 * 0.44));
    assert.deepEqual(g.needs, [OTHER_FLOORS_TAG, 'restaurant']);
  });

  test('early customers come for walk-in places; appointments are their own group', () => {
    const c = byId(d, 'early_customers'), a = byId(d, 'appointments');
    assert.deepEqual(c.needs, WALK_IN_USES);
    assert.deepEqual(a.needs, APPOINTMENT_USES);
    // Fernway Gifts opens at 10:00 (default retail hours), after the morning window.
    assert.ok(!c.tenantNames.includes('Fernway Gifts (fictional)'));
    assert.equal(d.places['Fernway Gifts (fictional)'].open, false);
    assert.ok(c.tenantNames.includes('Bluebird Coffee (fictional)'));
    assert.deepEqual(a.tenantNames.sort(), ['Juniper Yoga (fictional)', 'Northgate Dental (fictional)']);
  });

  test('arriving staff stay at their desks: one server per employee, a service time as long as the window', () => {
    const p = d.places[KESSLER];
    assert.equal(p.servers, 38);
    assert.equal(p.serviceTime, 150);
    assert.equal(p.serviceDist, 'fixed');
    assert.equal(d.provenance[`places.${KESSLER}.servers`], 'data');
    assert.equal(d.provenance[`places.${BRIGHT}.servers`], 'assumed');
  });
});

describe('profileToDemand: weekday-lunch', () => {
  const d = profileToDemand(SAMPLE, { scenario: 'weekday-lunch', floor: 1 });

  test('staff start inside at their own tenant and go to walk-in places in the building', () => {
    const k = staffOf(d, KESSLER);
    assert.equal(k.origin, 'tenant');
    assert.equal(k.count, Math.round(38 * 0.55 * 0.35));
    assert.deepEqual(k.needs, WALK_IN_USES);
    assert.equal(byId(d, 'staff_other_floors').origin, 'tenant');
  });

  test('outside customers, appointments and office visitors arrive', () => {
    assert.deepEqual(d.groups.map(g => g.id), [
      'staff_kessler_moss_law_fiction', 'staff_brightline_software_fict', 'staff_other_floors', 'lunch_customers', 'appointments', 'office_visitors'
    ]);
    for (const id of ['lunch_customers', 'appointments', 'office_visitors']) assert.equal(byId(d, id).origin, 'outside');
    assert.deepEqual(byId(d, 'office_visitors').needs, ['office']);
    const coffee = byId(d, 'lunch_customers').tenantCounts['Bluebird Coffee (fictional)'];
    // 1,800 SF × 8 per 1,000 SF per hour × 2 open hours × lunch factor 1.6 (all assumed rates)
    assert.equal(coffee, Math.round(1.8 * 8 * 2 * 1.6 * 100) / 100);
  });

  test('place parameters come from square feet and the assumptions', () => {
    const cafe = d.places['Bluebird Coffee (fictional)'];
    assert.equal(cafe.servers, Math.round(1.8 * 1));
    assert.equal(cafe.serviceTime, DEFAULT_ASSUMPTIONS.dwellMinutes.restaurant);
    assert.deepEqual(cafe.tags, [tenantTag('Bluebird Coffee (fictional)'), 'restaurant', 'public']);
    assert.deepEqual(d.places[KESSLER].tags, [tenantTag(KESSLER), 'office']);
    assert.match(cafe.about, /Coffee Shop, about 1,800 SF, suite 101; counter service; open 06:30-16:00/);
  });
});

describe('profileToDemand: saturday-afternoon', () => {
  const d = profileToDemand(SAMPLE, { scenario: 'saturday-afternoon', floor: 1 });

  test('outside customers only; offices are closed', () => {
    assert.ok(d.groups.length > 0);
    for (const g of d.groups) assert.equal(g.origin, 'outside');
    assert.ok(!d.groups.some(g => g.role.startsWith('workers')));
    assert.deepEqual(d.groups.map(g => g.id), ['diners', 'shoppers', 'appointments']);
    for (const name of [KESSLER, BRIGHT, 'Northgate Dental (fictional)']) assert.equal(d.places[name].open, false, name);
    assert.equal(d.arrivals.shape, 'uniform');
  });
});

describe('provenance and assumptionsUsed', () => {
  for (const scenario of Object.keys(SCENARIOS)) {
    test(`${scenario}: no number without a tag, and every assumption used is listed`, () => {
      const d = profileToDemand(SAMPLE, { scenario, floor: 1 });
      const tags = new Set(Object.values(d.provenance));
      for (const t of tags) assert.ok(['data', 'assumed'].includes(t), t);
      for (const g of d.groups) {
        for (const p of numberPaths(g).filter(p => !p.startsWith('tenantCounts'))) assert.ok(d.provenance[`groups.${g.id}.${p}`], `groups.${g.id}.${p}`);
        assert.ok(d.provenance[`groups.${g.id}.tenantCounts`]);
        assert.ok(g.basis.includes('assumed'));
      }
      for (const [name, p] of Object.entries(d.places)) {
        for (const f of ['servers', 'serviceTime', 'appeal', 'price', 'sf']) assert.ok(d.provenance[`places.${name}.${f}`], `places.${name}.${f}`);
        assert.equal(typeof p.servers, 'number');
      }
      for (const name of Object.keys(d.headcount)) assert.ok(d.provenance[`headcount.${name}`]);
      for (const k of ['arrivals.total', 'arrivals.start', 'arrivals.end', 'clockStart', 'duration']) assert.equal(d.provenance[k], 'assumed', k);

      const keys = d.assumptionsUsed.map(a => a.key);
      assert.equal(new Set(keys).size, keys.length, 'no duplicates');
      for (const a of d.assumptionsUsed) {
        assert.ok(a.why && a.why.length > 10, `why for ${a.key}`);
        const want = a.key.startsWith('scenarios.') ? getPath(SCENARIOS, a.key.slice('scenarios.'.length)) : getPath(DEFAULT_ASSUMPTIONS, a.key);
        assert.deepEqual(a.value, want, a.key);
      }
      for (const k of ['officeAttendance', 'ruleWeights.customer', `arrivalWindow.${scenario}`]) {
        if (scenario !== 'saturday-afternoon' || k !== 'officeAttendance') assert.ok(keys.includes(k), k);
      }
    });
  }

  test('headcount is data where CoStar gives employees and assumed otherwise', () => {
    const d = profileToDemand(SAMPLE, { scenario: 'weekday-lunch', floor: 1 });
    assert.deepEqual(d.headcount[KESSLER], { employees: 38, source: 'data' });
    assert.deepEqual(d.headcount[BRIGHT], { employees: 31, source: 'assumed' });
    assert.equal(d.provenance[`places.${KESSLER}.sf`], 'data');
    assert.ok(d.assumptionsUsed.some(a => a.key === 'sfPerOfficeWorker'));
  });

  test('sfPerOfficeWorker is not listed when every office has a headcount', () => {
    const p = { ...SAMPLE, tenants: SAMPLE.tenants.map(t => (t.use === 'office' ? { ...t, employees: t.employees ?? 10 } : t)) };
    const d = profileToDemand(p, { scenario: 'weekday-lunch', floor: 1 });
    assert.ok(!d.assumptionsUsed.some(a => a.key === 'sfPerOfficeWorker'));
  });

  test('overridden assumptions change the counts and are still tagged assumed', () => {
    const d = profileToDemand(SAMPLE, { scenario: 'weekday-lunch', floor: 1, assumptions: { officeAttendance: 1 } });
    assert.equal(staffOf(d, KESSLER).count, Math.round(38 * 1 * 0.35));
    assert.deepEqual(d.assumptionsUsed.find(a => a.key === 'officeAttendance').value, 1);
    assert.equal(d.provenance[`groups.${staffOf(d, KESSLER).id}.count`], 'assumed');
  });
});

describe('layout, limits and errors', () => {
  test('layout decides which tenants are here, elsewhere, or left out', () => {
    const d = profileToDemand(SAMPLE, {
      scenario: 'weekday-lunch',
      layout: { here: [KESSLER, 'Bluebird Coffee (fictional)'], elsewhere: ['Halvorsen Insurance (fictional)'] }
    });
    assert.deepEqual(Object.keys(d.places).sort(), [KESSLER, 'Bluebird Coffee (fictional)', 'Halvorsen Insurance (fictional)'].sort());
    assert.equal(d.places['Halvorsen Insurance (fictional)'].where, 'elsewhere');
    assert.deepEqual(byId(d, 'staff_other_floors').tenantNames, ['Halvorsen Insurance (fictional)']);
    assert.ok(d.warnings.some(w => w.startsWith('left out of the demand') && w.includes(BRIGHT)));
  });

  test(`at most ${MAX_GROUPS} groups: the smallest staff groups merge, keeping every person`, () => {
    const tenants = Array.from({ length: 7 }, (_, i) => ({ name: `Office ${i + 1} (fictional)`, industry: 'Accounting', use: 'office', sf: 2000 + i * 1000, floor: 1, suite: null, employees: 10 + i * 5, hours: null }));
    const p = validateProfile({ source: 'manual', name: 'Many Offices (fictional)', tenants }).profile;
    const d = profileToDemand(p, { scenario: 'weekday-morning', floor: 1 });
    assert.ok(d.groups.length <= MAX_GROUPS);
    const expected = tenants.reduce((s, t) => s + Math.round(t.employees * 0.55 * 0.8), 0);
    assert.equal(d.groups.reduce((s, g) => s + g.count, 0), expected);
    assert.ok(d.warnings.some(w => w.startsWith('merged the staff of')));
    assert.equal(d.arrivals.total, expected);
  });

  test('unknown scenario and missing profile throw clear errors', () => {
    assert.throws(() => profileToDemand(SAMPLE, { scenario: 'sunday-brunch' }), /unknown scenario "sunday-brunch"/);
    assert.throws(() => profileToDemand(null), /expected a building profile/);
  });

  test('a building with no open tenant says there is nobody to simulate', () => {
    const p = validateProfile({ source: 'manual', name: 'Closed (fictional)', tenants: [{ name: 'Night Law (fictional)', use: 'office', sf: 1000 }] }).profile;
    const d = profileToDemand(p, { scenario: 'saturday-afternoon' });
    assert.deepEqual(d.groups, []);
    assert.ok(d.warnings.some(w => w.startsWith('nobody to simulate')));
  });
});
