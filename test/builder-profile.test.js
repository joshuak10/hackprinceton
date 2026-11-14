// Building profile tests (docs/PROTOTYPE.md §14a): validateProfile, the tolerant CoStar adapter, classifyUse.
// Fixtures in test/fixtures/costar/ are hand-made and fictional.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  USE_TYPES, classifyUse, validateProfile, costarToProfile, normalizeFloor, sameFloor, parseNumber, parseHours
} from '../builder/profile.js';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/costar/${name}`, import.meta.url), 'utf8'));
const SAMPLE = fixture('sample-profile.json');
const RAW = fixture('sample-raw.json');

describe('classifyUse', () => {
  const cases = {
    office: ['Kessler & Moss Law', 'Legal Services', 'Accounting', 'Insurance Agency', 'Software', 'Marketing agency',
      'Professional, Scientific, and Technical Services', 'Finance and Insurance'],
    restaurant: ['Bluebird Café', 'Coffee shop', 'Main Street Grill', 'Pizza', 'Sushi bar', 'Accommodation and Food Services'],
    medical: ['Dental office', 'Northgate Dental', 'Walk-in clinic', 'Physical therapy', 'Health Care and Social Assistance'],
    service: ['Hair salon', 'Barbershop', 'First National Bank', 'Dry cleaner', 'Other Services (except Public Administration)'],
    fitness: ['Gym', 'Juniper Yoga', 'Pilates studio'],
    retail: ['Gift boutique', 'Shoe store', 'Farmers Market', 'Retail Trade'],
    vacant: ['Vacant', 'Available'],
    other: ['Zorblax', '', null, undefined]
  };
  for (const [use, names] of Object.entries(cases)) {
    test(`→ ${use}`, () => {
      for (const n of names) assert.equal(classifyUse(n), use, String(n));
    });
  }

  test('specific words win over generic ones', () => {
    assert.equal(classifyUse('Coffee shop'), 'restaurant');   // not retail ("shop")
    assert.equal(classifyUse('Dental office'), 'medical');    // not office
    assert.equal(classifyUse('Marketing'), 'office');         // not retail ("market")
  });

  test('always returns a USE_TYPES value', () => {
    for (const s of ['x', 'Bank of Somewhere', 'Yoga & Pilates', '12345']) assert.ok(USE_TYPES.includes(classifyUse(s)));
  });
});

describe('small parsers', () => {
  test('parseNumber reads numbers out of CoStar-style text', () => {
    assert.equal(parseNumber('45,726SF'), 45726);
    assert.equal(parseNumber('45,200 SF'), 45200);
    assert.equal(parseNumber('3.32/1,000 SF'), 3.32);
    assert.equal(parseNumber('85%'), 85);
    assert.equal(parseNumber(12), 12);
    assert.ok(Number.isNaN(parseNumber('n/a')));
  });

  test('normalizeFloor and sameFloor', () => {
    assert.equal(normalizeFloor('2nd'), 2);
    assert.equal(normalizeFloor('Ground floor'), 1);
    assert.equal(normalizeFloor('Second floor'), 2);
    assert.equal(normalizeFloor('Floor 3'), 3);
    assert.equal(normalizeFloor('LL'), 0);
    assert.equal(normalizeFloor('Mezzanine'), 'Mezzanine');
    assert.equal(normalizeFloor(null), null);
    assert.ok(sameFloor('1st', 'Ground'));
    assert.ok(!sameFloor(1, 2));
    assert.ok(!sameFloor(null, 1));
  });

  test('parseHours reads text and objects', () => {
    assert.deepEqual(parseHours('7:00 AM - 7:00 PM'), { open: '07:00', close: '19:00' });
    assert.deepEqual(parseHours({ open: '6:30', close: '16:00' }), { open: '06:30', close: '16:00' });
    assert.equal(parseHours('whenever'), null);
  });
});

describe('validateProfile', () => {
  test('the sample profile is valid and every value present is tagged "data"', () => {
    const v = validateProfile(SAMPLE);
    assert.equal(v.ok, true, v.errors.join('; '));
    assert.deepEqual(v.warnings, []);
    assert.equal(v.profile.tenants.length, 8);
    assert.equal(v.profile.rbaSF, 45200);
    for (const path of ['rbaSF', 'floors', 'name', 'parking.spaces', 'trafficCounts[0].vehiclesPerDay', 'tenants[0].employees', 'tenants[0].sf', 'tenants[2].hours']) {
      assert.equal(v.profile.provenance[path], 'data', path);
    }
    assert.equal(v.profile.provenance['tenants[1].employees'], undefined, 'no tag for a value that is missing');
    for (const tag of Object.values(v.profile.provenance)) assert.equal(tag, 'data');
  });

  test('normalizes loose values and reports problems with field paths', () => {
    const v = validateProfile({
      source: 'Manual', name: 'Fictional Block', rbaSF: '12,000 SF', floors: '2', percentLeased: 0.9, hours: '8am - 6pm',
      parking: { spaces: 'lots' }, extra: 1,
      tenants: [
        { name: 'Corner Cafe (fictional)', industry: 'Coffee', floor: '1st', sf: '1,200' },
        { name: 'Odd Use Co (fictional)', use: 'cafe', floor: 'Second floor' },
        { industry: 'Law' },
        { name: 'Corner Cafe (fictional)', use: 'retail' }
      ]
    });
    assert.equal(v.ok, true, v.errors.join('; '));
    const p = v.profile;
    assert.equal(p.source, 'manual');
    assert.equal(p.rbaSF, 12000);
    assert.equal(p.floors, 2);
    assert.equal(p.percentLeased, 90);
    assert.deepEqual(p.hours, { open: '08:00', close: '18:00' });
    assert.equal(p.parking, null);
    assert.equal(p.tenants.length, 3);
    assert.deepEqual([p.tenants[0].use, p.tenants[0].floor, p.tenants[0].sf], ['restaurant', 1, 1200]);
    assert.equal(p.tenants[1].use, 'other');
    assert.equal(p.tenants[1].floor, 2);
    assert.equal(p.tenants[2].name, 'Corner Cafe (fictional) (2)');
    const w = v.warnings.join('\n');
    for (const piece of ['extra: unknown field', 'percentLeased:', 'parking.spaces:', 'tenants[1].use: "cafe" is not one of', 'restaurant',
      'tenants[2]: no name', 'tenants[3].name:']) {
      assert.ok(w.includes(piece), `warning mentions ${piece}`);
    }
    // A manual profile's values are owner-reported; a use found by keyword is an assumption.
    assert.equal(p.provenance.rbaSF, 'owner-reported');
    assert.equal(p.provenance['tenants[0].use'], 'assumed');
    assert.equal(p.provenance['tenants[1].use'], 'owner-reported');
  });

  test('given provenance is kept and re-indexed when a tenant is dropped', () => {
    const v = validateProfile({
      source: 'costar', name: 'X',
      tenants: [{ industry: 'nameless' }, { name: 'Kept (fictional)', employees: 5 }],
      provenance: { 'tenants[1].employees': 'owner-reported', rbaSF: 'vision' }
    });
    assert.equal(v.profile.provenance['tenants[0].employees'], 'owner-reported');
    assert.ok(v.warnings.some(m => m.startsWith('provenance.rbaSF:')));
  });

  test('a raw CoStar record or a non-object is not a profile', () => {
    const raw = validateProfile(RAW);
    assert.equal(raw.ok, false);
    assert.match(raw.errors[0], /^source: missing/);
    assert.equal(validateProfile({ source: 'CoStar API' }).ok, false);
    const none = validateProfile('nope');
    assert.equal(none.ok, false);
    assert.equal(none.profile, null);
  });

  test('a profile with no tenants is usable, with a warning', () => {
    const v = validateProfile({ source: 'manual', name: 'Empty (fictional)' });
    assert.equal(v.ok, true);
    assert.ok(v.warnings.some(m => m.startsWith('tenants:')));
  });
});

describe('costarToProfile', () => {
  test('maps the sample raw record to the same building as the sample profile', () => {
    const { profile, mapped, unmapped, warnings } = costarToProfile(RAW);
    const want = validateProfile(SAMPLE).profile;
    for (const k of ['source', 'propertyId', 'name', 'address', 'city', 'state', 'buildingType', 'rbaSF', 'floors', 'yearBuilt', 'percentLeased', 'parking', 'trafficCounts', 'hours']) {
      assert.deepEqual(profile[k], want[k], k);
    }
    assert.equal(profile.tenants.length, 8);
    profile.tenants.forEach((t, i) => {
      const w = want.tenants[i];
      for (const k of ['name', 'industry', 'use', 'sf', 'floor', 'suite', 'employees']) assert.deepEqual(t[k], w[k], `tenants[${i}].${k}`);
    });
    assert.deepEqual(warnings, []);

    for (const m of ['Property Name → name', 'Building.RBA → rbaSF', 'Building.Number Of Stories → floors', 'Leasing.Percent Leased → percentLeased',
      'Parking_Spaces → parking.spaces', 'parking ratio → parking.ratioPer1000SF', 'Building Hours → hours',
      'Traffic Counts → trafficCounts (1)', 'Tenancy.Tenants[] → tenants (8)']) {
      assert.ok(mapped.includes(m), `mapped: ${m}`);
    }
    for (const u of ['Last Sale Price', 'Secondary Type', 'True Owner.Name', 'True Owner.City', 'Location.Latitude', 'Tenancy.Tenants[].Move In Date']) {
      assert.ok(unmapped.includes(u), `unmapped: ${u}`);
    }
    assert.ok(!mapped.some(m => m.startsWith('True Owner')), "the owner's name is never read as the building's");
  });

  test('every mapped value is tagged "data"; uses found by keyword are "assumed"', () => {
    const { profile } = costarToProfile(RAW);
    for (const path of ['name', 'rbaSF', 'floors', 'percentLeased', 'parking.spaces', 'parking.ratioPer1000SF', 'hours', 'trafficCounts[0].vehiclesPerDay']) {
      assert.equal(profile.provenance[path], 'data', path);
    }
    profile.tenants.forEach((t, i) => {
      assert.equal(profile.provenance[`tenants[${i}].name`], 'data');
      assert.equal(profile.provenance[`tenants[${i}].use`], 'assumed');
      if (t.employees !== null) assert.equal(profile.provenance[`tenants[${i}].employees`], 'data');
    });
  });

  test('a valid profile comes back unchanged', () => {
    const { profile, unmapped } = costarToProfile(SAMPLE);
    assert.deepEqual(profile, validateProfile(SAMPLE).profile);
    assert.deepEqual(unmapped, []);
  });

  test('tolerates other spellings, deeper nesting, vacancy and an unnamed tenant list', () => {
    const { profile, mapped, unmapped, warnings } = costarToProfile({
      data: {
        property: { property_name: 'Fictional Court', rentable_building_area: 20000, STORIES: 3, vacancy_rate: '12%' }
      },
      people: [
        { company: 'Acme Dental (fictional)', square_feet: '2,000', flr: 'Ground', headcount: 7 },
        { company: 'Beta Yoga (fictional)', square_feet: 3000, flr: '2nd' }
      ],
      Weird: 1
    });
    assert.equal(profile.name, 'Fictional Court');
    assert.equal(profile.rbaSF, 20000);
    assert.equal(profile.floors, 3);
    assert.equal(profile.percentLeased, 88);
    assert.deepEqual(profile.tenants.map(t => [t.name, t.use, t.sf, t.floor, t.employees]), [
      ['Acme Dental (fictional)', 'medical', 2000, 1, 7],
      ['Beta Yoga (fictional)', 'fitness', 3000, 2, null]
    ]);
    assert.ok(mapped.includes('people[] → tenants (2)'));
    assert.ok(unmapped.includes('Weird'));
    assert.ok(warnings.some(w => w.includes('100 minus')));
  });

  test('gross area is used with a warning; a record with no tenants says so', () => {
    const r = costarToProfile({ 'Building Name': 'Gross Hall (fictional)', GBA: '9,000' });
    assert.equal(r.profile.rbaSF, 9000);
    assert.ok(r.warnings.some(w => w.includes('gross')));
    assert.ok(r.warnings.some(w => w.includes('no list of tenants')));
    assert.equal(costarToProfile(null).profile, null);
  });
});
