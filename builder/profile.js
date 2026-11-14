// Building profile (docs/PROTOTYPE.md §14a): a neutral shape for one building and its tenants, so the
// rest of the pipeline never depends on CoStar's field names. validateProfile normalizes a profile;
// costarToProfile is a best-effort, tolerant adapter for a raw CoStar record (to be finalized against a
// real CoStar response); classifyUse maps an industry or tenant name to a use type by keyword.

export const USE_TYPES = ['office', 'retail', 'restaurant', 'medical', 'service', 'fitness', 'other', 'vacant'];
// Uses that serve walk-in members of the public (they get the `public` tag in a composed world).
export const PUBLIC_USES = ['retail', 'restaurant', 'medical', 'service', 'fitness'];
export const PROVENANCE_TAGS = ['data', 'assumed', 'owner-reported'];
export const PROFILE_KEYS = ['source', 'propertyId', 'name', 'address', 'city', 'state', 'buildingType', 'rbaSF', 'floors',
  'yearBuilt', 'percentLeased', 'parking', 'trafficCounts', 'hours', 'tenants', 'provenance'];
const TENANT_KEYS = ['name', 'industry', 'use', 'sf', 'floor', 'suite', 'employees', 'hours'];
const SOURCES = ['costar', 'manual'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const missing = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const show = v => { const s = JSON.stringify(v) ?? String(v); return s.length > 48 ? s.slice(0, 45) + '...' : s; };
const cleanText = (v, max = 120) => String(v).replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- use classification ----------

// Checked in this order, so "coffee shop" is a restaurant (before "shop" means retail), "barbershop" is a
// service, and "dental office" is medical (before "office"). Word boundaries keep "marketing" out of "market".
const USE_RULES = [
  ['vacant', /\b(vacant|vacancy|available|unleased|for lease)\b/],
  ['medical', /\b(dental|dentist|orthodont\w*|endodont\w*|clinic|medical|physicians?|doctors?|pediatric\w*|urgent care|chiropract\w*|physical therapy|physiotherapy|optometr\w*|eye care|dermatolog\w*|cardiolog\w*|health care|healthcare|hospital|veterinar\w*|animal hospital|imaging|radiology|lab(oratory)? services|audiolog\w*|podiatr\w*|mental health|counseling)\b/],
  ['restaurant', /\b(cafes?|coffee|espresso|bakery|bagels?|deli|grill|pizza|pizzeria|sushi|restaurants?|bistro|kitchen|taqueria|tacos?|burgers?|diner|pub|tavern|brewery|bar|juice|smoothie|tea|donuts?|doughnuts?|sandwich(es)?|noodles?|ramen|pho|bbq|barbecue|steakhouse|eatery|food services?|accommodation and food|creamery|ice cream|wings|chicken|salad)\b/],
  ['fitness', /\b(gym|fitness|yoga|pilates|crossfit|martial arts|karate|boxing|cycling studio|spin|barre|dance studio|climbing|athletic club|health club|personal training)\b/],
  ['service', /\b(salon|barber\w*|spa|nails?|dry clean\w*|cleaners|laundromat|laundry|tailor\w*|alterations|banks?|banking|credit union|post office|postal|shipping|ups store|fedex|notary|tutoring|learning center|child ?care|daycare|pet grooming|grooming|cobbler|shoe repair|travel agency|other services)\b/],
  ['retail', /\b(boutique|stores?|shop|shops|market|supermarket|mart|outlet|apparel|clothing|shoes|jewel(l)?ery|jewelers?|florist|flowers|books?|bookstore|gifts?|pharmacy|drugstore|convenience|hardware|electronics|wireless|cell(ular)? phones?|mattress|furniture|liquor|wine shop|grocery|groceries|retail|retail trade|optical|eyewear|toys?|cosmetics|beauty supply|thrift|pet supplies|sporting goods|vape|smoke shop)\b/],
  ['office', /\b(law|legal|attorneys?|lawyers?|accounting|accountants?|cpa|tax|insurance|software|technology|tech|consulting|consultants?|engineering|engineers|architects?|architecture|design|marketing|advertising|agency|financial|finance|investments?|capital|wealth|advisors?|realty|real estate|property management|staffing|recruiting|nonprofit|non-profit|foundation|government|public administration|office|offices|headquarters|corporate|associates|partners|llp|pllc|title company|mortgage|professional|scientific|technical services|information|media|publishing|management|administrative|holdings|ventures|labs|analytics|data)\b/]
];

// Maps an industry or tenant name to a USE_TYPES value by keyword; 'other' when nothing matches.
export function classifyUse(industryOrName) {
  if (missing(industryOrName)) return 'other';
  const s = String(industryOrName).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9' -]+/g, ' ');
  for (const [use, re] of USE_RULES) if (re.test(s)) return use;
  return 'other';
}

// ---------- small parsers ----------

// The first number in a value: 45726, "45,726 SF", "3.5/1,000 SF", "92%". NaN when there is none.
export function parseNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const m = v.replace(/(\d),(?=\d{3}(?!\d))/g, '$1').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

const ORDINAL_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

// A floor as a number where possible: 2, "2", "2nd", "Floor 2", "Second floor" → 2; "Ground", "G", "Lobby",
// "Main", "Street" → 1; "LL", "Lower level", "Basement" → 0. Anything else stays as trimmed text.
export function normalizeFloor(v) {
  if (missing(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().toLowerCase();
  if (/^(g|gf|ground|ground floor|ground level|l|lobby|main|main floor|main level|street|street level|first)$/.test(s) ||
    /\bground\b/.test(s)) return 1;
  if (/^(ll|lower level|lower|basement|b|bsmt|cellar)$/.test(s) || /\b(basement|lower level)\b/.test(s)) return 0;
  for (const [w, n] of Object.entries(ORDINAL_WORDS)) if (new RegExp(`\\b${w}\\b`).test(s)) return n;
  const m = s.match(/-?\d+/);
  return m ? Number(m[0]) : String(v).trim();
}

// True when two floor values name the same floor (after normalizeFloor).
export function sameFloor(a, b) {
  const x = normalizeFloor(a), y = normalizeFloor(b);
  if (x === null || y === null) return false;
  return typeof x === typeof y && (typeof x === 'number' ? x === y : x.toLowerCase() === y.toLowerCase());
}

// "7:00 AM", "07:00", "19:30", "7pm" → "HH:MM"; null when unreadable.
export function parseClock(v) {
  if (missing(v)) return null;
  const m = String(v).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    const pm = m[3].startsWith('p');
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// { open, close } from an object or text like "7:00 AM - 7:00 PM"; null when unreadable.
export function parseHours(v) {
  if (missing(v)) return null;
  if (isObj(v)) {
    const open = parseClock(v.open ?? v.opens ?? v.start), close = parseClock(v.close ?? v.closes ?? v.end);
    return open && close ? { open, close } : null;
  }
  const parts = String(v).split(/\s*(?:-|–|—|to)\s*/i);
  if (parts.length !== 2) return null;
  const open = parseClock(parts[0]), close = parseClock(parts[1]);
  return open && close ? { open, close } : null;
}

// ---------- validateProfile ----------

function num(rep, path, v, { min = -Infinity, max = Infinity, int = false } = {}) {
  if (missing(v)) return null;
  const n = parseNumber(v);
  if (!Number.isFinite(n)) { rep.warn(path, `${show(v)} is not a number; ignored`); return null; }
  if (n < min || n > max) { rep.warn(path, `${n} is outside ${min}–${max}; ignored`); return null; }
  if (int && !Number.isInteger(n)) { rep.warn(path, `${n} is not a whole number; using ${Math.round(n)}`); return Math.round(n); }
  return n;
}

function txt(rep, path, v, max = 120) {
  if (missing(v)) return null;
  if (typeof v !== 'string' && typeof v !== 'number') { rep.warn(path, `${show(v)} is not text; ignored`); return null; }
  return cleanText(v, max);
}

function hoursField(rep, path, v) {
  if (missing(v)) return null;
  const h = parseHours(v);
  if (!h) rep.warn(path, `${show(v)} is not opening hours like { open: "07:00", close: "19:00" }; ignored`);
  return h;
}

// Percent leased as 0–100. A value in (0, 1] is read as a fraction.
function percent(rep, path, v) {
  const n = num(rep, path, v, { min: 0, max: 100 });
  if (n !== null && n > 0 && n <= 1 && !(typeof v === 'string' && v.includes('%'))) {
    rep.warn(path, `${n} looks like a fraction; using ${+(n * 100).toFixed(2)}%`);
    return +(n * 100).toFixed(2);
  }
  return n;
}

// Normalizes the neutral profile shape. ok is false only for problems that make it unusable as a profile:
// not an object, or no valid `source` (a raw CoStar record has none; send it through costarToProfile).
export function validateProfile(raw) {
  const errors = [], warnings = [];
  const rep = { warn: (p, m) => warnings.push(`${p}: ${m}`), error: (p, m) => errors.push(`${p}: ${m}`) };
  if (!isObj(raw)) {
    rep.error('profile', 'must be a JSON object');
    return { ok: false, errors, warnings, profile: null };
  }
  for (const k of Object.keys(raw)) if (!PROFILE_KEYS.includes(k)) rep.warn(k, 'unknown field; ignored');

  let source = typeof raw.source === 'string' ? raw.source.trim().toLowerCase() : raw.source;
  if (missing(source)) {
    rep.error('source', 'missing; a building profile says where it came from ("costar" or "manual"). ' +
      'For a raw CoStar record use costarToProfile');
    source = null;
  } else if (!SOURCES.includes(source)) {
    rep.error('source', `${show(raw.source)} is not "costar" or "manual"`);
    source = null;
  }

  const profile = {
    source,
    propertyId: txt(rep, 'propertyId', raw.propertyId, 80),
    name: txt(rep, 'name', raw.name, 120),
    address: txt(rep, 'address', raw.address, 160),
    city: txt(rep, 'city', raw.city, 80),
    state: txt(rep, 'state', raw.state, 40),
    buildingType: txt(rep, 'buildingType', raw.buildingType, 80),
    rbaSF: num(rep, 'rbaSF', raw.rbaSF, { min: 1, max: 1e8 }),
    floors: num(rep, 'floors', raw.floors, { min: 1, max: 200, int: true }),
    yearBuilt: num(rep, 'yearBuilt', raw.yearBuilt, { min: 1600, max: 2100, int: true }),
    percentLeased: percent(rep, 'percentLeased', raw.percentLeased),
    parking: null,
    trafficCounts: [],
    hours: hoursField(rep, 'hours', raw.hours),
    tenants: [],
    provenance: {}
  };
  if (!profile.name) rep.warn('name', 'missing; the world will be titled "Unnamed building"');

  if (!missing(raw.parking)) {
    if (!isObj(raw.parking)) rep.warn('parking', `${show(raw.parking)} is not { spaces, ratioPer1000SF }; ignored`);
    else {
      for (const k of Object.keys(raw.parking)) if (!['spaces', 'ratioPer1000SF'].includes(k)) rep.warn(`parking.${k}`, 'unknown field; ignored');
      const spaces = num(rep, 'parking.spaces', raw.parking.spaces, { min: 0, max: 1e6, int: true });
      const ratio = num(rep, 'parking.ratioPer1000SF', raw.parking.ratioPer1000SF, { min: 0, max: 1000 });
      if (spaces !== null || ratio !== null) profile.parking = { spaces, ratioPer1000SF: ratio };
    }
  }

  if (!missing(raw.trafficCounts)) {
    if (!Array.isArray(raw.trafficCounts)) rep.warn('trafficCounts', 'not a list; ignored');
    else raw.trafficCounts.forEach((t, i) => {
      const p = `trafficCounts[${i}]`;
      if (!isObj(t)) { rep.warn(p, 'not an object; ignored'); return; }
      const vpd = num(rep, `${p}.vehiclesPerDay`, t.vehiclesPerDay, { min: 0, max: 1e7 });
      if (vpd === null) { rep.warn(p, 'no vehiclesPerDay; ignored'); return; }
      profile.trafficCounts.push({ street: txt(rep, `${p}.street`, t.street, 80), vehiclesPerDay: vpd });
    });
  }

  // Tenants. Names must be unique: they key the demand's places and the world's tags.
  const tenantPaths = new Map();   // normalized index → raw index, for provenance paths
  if (!missing(raw.tenants)) {
    if (!Array.isArray(raw.tenants)) rep.warn('tenants', 'not a list; ignored');
    else {
      const names = new Set();
      raw.tenants.forEach((t, i) => {
        const p = `tenants[${i}]`;
        if (!isObj(t)) { rep.warn(p, 'not an object; ignored'); return; }
        for (const k of Object.keys(t)) if (!TENANT_KEYS.includes(k)) rep.warn(`${p}.${k}`, 'unknown field; ignored');
        let name = txt(rep, `${p}.name`, t.name, 60);
        if (!name) { rep.warn(p, 'no name; ignored'); return; }
        if (names.has(name.toLowerCase())) {
          let k = 2;
          while (names.has(`${name} (${k})`.toLowerCase())) k++;
          rep.warn(`${p}.name`, `"${name}" is already used; using "${name} (${k})"`);
          name = `${name} (${k})`;
        }
        names.add(name.toLowerCase());
        const industry = txt(rep, `${p}.industry`, t.industry, 80);
        let use, useClassified = false;
        if (missing(t.use)) {
          use = classifyUse(industry);
          if (use === 'other') use = classifyUse(name);
          useClassified = true;
        } else {
          use = String(t.use).trim().toLowerCase();
          if (!USE_TYPES.includes(use)) {
            const guess = classifyUse(t.use);
            rep.warn(`${p}.use`, `${show(t.use)} is not one of ${USE_TYPES.join(', ')}; using "other"` +
              (guess !== 'other' ? ` (it reads like "${guess}")` : ''));
            use = 'other';
          }
        }
        const idx = profile.tenants.length;
        tenantPaths.set(idx, i);
        profile.tenants.push({
          name, industry, use,
          sf: num(rep, `${p}.sf`, t.sf, { min: 1, max: 1e7 }),
          floor: normalizeFloor(t.floor),
          suite: txt(rep, `${p}.suite`, t.suite, 20),
          employees: num(rep, `${p}.employees`, t.employees, { min: 0, max: 1e6, int: true }),
          hours: hoursField(rep, `${p}.hours`, t.hours)
        });
        if (useClassified) profile.provenance[`tenants[${idx}].use`] = 'assumed';
      });
    }
  }
  if (!profile.tenants.length) rep.warn('tenants', 'no tenants; every room will be common space and only visitors are simulated');

  // Provenance: keep valid given tags (re-indexed for tenants that were dropped), then tag every present
  // value that has none: "data" for a CoStar profile, "owner-reported" for a manual one.
  const given = isObj(raw.provenance) ? raw.provenance : {};
  if (!missing(raw.provenance) && !isObj(raw.provenance)) rep.warn('provenance', 'not an object; ignored');
  const rawToNew = new Map([...tenantPaths].map(([n, r]) => [r, n]));
  for (const [k, v] of Object.entries(given)) {
    if (!PROVENANCE_TAGS.includes(v)) { rep.warn(`provenance.${k}`, `${show(v)} is not one of ${PROVENANCE_TAGS.join(', ')}; ignored`); continue; }
    const m = k.match(/^tenants\[(\d+)\](.*)$/);
    if (m) {
      if (!rawToNew.has(Number(m[1]))) continue;
      profile.provenance[`tenants[${rawToNew.get(Number(m[1]))}]${m[2]}`] = v;
    } else profile.provenance[k] = v;
  }
  const fallback = source === 'manual' ? 'owner-reported' : 'data';
  for (const path of presentPaths(profile)) if (!(path in profile.provenance)) profile.provenance[path] = fallback;

  return { ok: errors.length === 0, errors, warnings, profile };
}

// Field paths of every value present in a normalized profile (the things provenance should cover).
function presentPaths(p) {
  const out = [];
  for (const k of ['propertyId', 'name', 'address', 'city', 'state', 'buildingType', 'rbaSF', 'floors', 'yearBuilt', 'percentLeased', 'hours']) {
    if (p[k] !== null && p[k] !== undefined) out.push(k);
  }
  if (p.parking) for (const k of ['spaces', 'ratioPer1000SF']) if (p.parking[k] !== null) out.push(`parking.${k}`);
  p.trafficCounts.forEach((t, i) => { out.push(`trafficCounts[${i}].vehiclesPerDay`); if (t.street) out.push(`trafficCounts[${i}].street`); });
  p.tenants.forEach((t, i) => {
    for (const k of TENANT_KEYS) if (t[k] !== null && t[k] !== undefined) out.push(`tenants[${i}].${k}`);
  });
  return out;
}

// ---------- costarToProfile ----------

// Lowercase, without spaces, underscores, dashes, dots, slashes, parentheses or "#": "Rentable Building Area"
// and "rentable_building_area" both become "rentablebuildingarea".
const norm = k => String(k).toLowerCase().replace(/[\s_\-./()#:]+/g, '');

// Field → normalized raw key names, best first. Matching is exact on the normalized key.
const BUILDING_FIELDS = {
  propertyId: ['propertyid', 'costarpropertyid', 'costarid', 'propid', 'pid', 'propertynumber', 'id'],
  name: ['propertyname', 'buildingname', 'propname', 'name', 'property', 'building'],
  address: ['propertyaddress', 'streetaddress', 'buildingaddress', 'address', 'address1', 'addressline1', 'street'],
  city: ['city', 'propertycity', 'town', 'municipality'],
  state: ['state', 'propertystate', 'stateprovince', 'st', 'province'],
  buildingType: ['propertytype', 'buildingtype', 'primarytype', 'type', 'propertyclass', 'usetype'],
  rbaSF: ['rba', 'rbasf', 'rentablebuildingarea', 'rentablebuildingareasf', 'rentablearea', 'buildingsize', 'buildingsizesf',
    'buildingsf', 'totalbuildingsf', 'totalrba', 'buildingarea', 'totalsf', 'sizesf', 'squarefeet', 'sqft', 'gba', 'grossbuildingarea'],
  floors: ['numberofstories', 'stories', 'numberoffloors', 'floors', 'numfloors', 'nooffloors', 'nostories', 'floorcount',
    'storycount', 'totalfloors', 'buildingfloors', 'levels'],
  yearBuilt: ['yearbuilt', 'yrbuilt', 'built', 'yearconstructed', 'constructionyear', 'yearbuiltrenovated'],
  percentLeased: ['percentleased', 'leased', 'pctleased', 'leasedpercent', 'percentleasedtotal', 'leasedpct', 'occupancy',
    'percentoccupied', 'occupancyrate', 'occupied'],
  percentVacant: ['percentvacant', 'vacancy', 'vacancyrate', 'vacantpercent', 'pctvacant'],
  parkingSpaces: ['numberofparkingspaces', 'parkingspaces', 'totalparkingspaces', 'parkingspacecount', 'parking', 'parkingcount'],
  parkingRatio: ['parkingratio', 'parkingratioper1000sf', 'parkingper1000sf', 'parkingratioper1000', 'parkingratio1000sf'],
  hours: ['buildinghours', 'hours', 'operatinghours', 'hoursofoperation', 'openhours'],
  trafficCounts: ['trafficcounts', 'trafficcount', 'traffic', 'trafficvolumes', 'trafficdata', 'aadt']
};
const TENANT_FIELDS = {
  name: ['tenantname', 'tenant', 'occupantname', 'occupant', 'companyname', 'company', 'businessname', 'business', 'name', 'dba'],
  industry: ['industry', 'industrytype', 'tenantindustry', 'industrydescription', 'naicsdescription', 'sicdescription',
    'category', 'businesstype', 'tenanttype', 'type', 'usetype'],
  use: ['use', 'spaceuse'],
  sf: ['sfoccupied', 'sqftoccupied', 'occupiedsf', 'squarefeetoccupied', 'squarefeet', 'squarefootage', 'sqft', 'sf', 'rsf',
    'leasedsf', 'suitesf', 'size', 'sizesf', 'area', 'spacesf'],
  floor: ['floor', 'floornumber', 'flr', 'level', 'floorlevel'],
  suite: ['suite', 'suitenumber', 'unit', 'unitnumber', 'space', 'spacenumber'],
  employees: ['employees', 'numberofemployees', 'employeecount', 'employeesatlocation', 'headcount', 'staff', 'emps',
    'numemployees', 'employeesonsite'],
  hours: ['hours', 'operatinghours', 'hoursofoperation']
};
const TENANT_LIST_KEYS = ['tenants', 'tenantlist', 'tenantroster', 'occupants', 'occupantlist', 'stackingplan', 'tenancy',
  'leases', 'tenantsinfo', 'rentroll'];
const TRAFFIC_STREET = ['collectionstreet', 'street', 'streetname', 'road', 'location', 'crossstreet', 'name'];
const TRAFFIC_COUNT = ['vehiclesperday', 'trafficvolume', 'volume', 'count', 'aadt', 'vpd', 'averagedailytraffic',
  'avgdailyvolume', 'dailyvolume', 'trafficcount'];

const isScalar = v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

// Nested objects about another party (the owner's name, the broker's address) never fill building fields.
const PARTY = /owner|seller|buyer|broker|lender|contact|manager|agent|landlord|developer|architect|sale|loan/;

// Every scalar and array in raw down to two levels of nesting: [{ path, key, value, depth, party }].
function collect(raw) {
  const out = [];
  const walk = (obj, prefix, depth, party) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (isObj(v) && depth < 2) walk(v, path, depth + 1, party || PARTY.test(norm(k)));
      else out.push({ path, key: norm(k), value: v, depth, party });
    }
  };
  walk(raw, '', 0, false);
  return out;
}

// Finds the best match for each field among entries: synonym order first, then shallower depth.
function pick(entries, synonyms, accept = e => isScalar(e.value) && !missing(e.value)) {
  let best = null, bestRank = Infinity;
  for (const e of entries) {
    const i = synonyms.indexOf(e.key);
    if (i < 0 || !accept(e)) continue;
    const rank = i * 10 + e.depth;
    if (rank < bestRank) { best = e; bestRank = rank; }
  }
  return best;
}

const tenantLike = item => {
  if (!isObj(item)) return false;
  const keys = Object.keys(item).map(norm);
  const hasName = keys.some(k => TENANT_FIELDS.name.includes(k));
  const others = ['industry', 'sf', 'floor', 'suite', 'employees'].filter(f => keys.some(k => TENANT_FIELDS[f].includes(k)));
  return hasName && others.length >= 1;
};

// The array of tenant-like records: a list under a tenant-ish key wins, otherwise any list whose items
// mostly look like tenants (a name plus a size, floor, suite, industry or headcount).
function findTenantArray(entries) {
  const lists = entries.filter(e => Array.isArray(e.value) && e.value.length);
  const score = e => e.value.filter(tenantLike).length / e.value.length;
  const named = lists.filter(e => TENANT_LIST_KEYS.includes(e.key) && score(e) >= 0.5)
    .sort((a, b) => TENANT_LIST_KEYS.indexOf(a.key) - TENANT_LIST_KEYS.indexOf(b.key) || a.depth - b.depth);
  if (named.length) return named[0];
  return lists.filter(e => score(e) >= 0.5).sort((a, b) => b.value.length - a.value.length || a.depth - b.depth)[0] ?? null;
}

// Best-effort mapping of a raw CoStar record to the neutral profile. Field names are matched
// case-insensitively, ignoring spaces, underscores and punctuation, down to two levels of nesting.
// Returns { profile, mapped: ['<raw path> → <field>'], unmapped: ['<raw path>'], warnings }.
// A raw object that already is a valid profile comes back as validateProfile normalized it.
export function costarToProfile(raw) {
  const warnings = [], mapped = [], unmapped = [];
  if (!isObj(raw)) {
    return { profile: null, mapped, unmapped, warnings: ['the CoStar record must be a JSON object'] };
  }
  if (Object.keys(raw).every(k => PROFILE_KEYS.includes(k))) {
    const v = validateProfile(raw);
    if (v.ok) return { profile: v.profile, mapped: Object.keys(raw).map(k => `${k} → ${k}`), unmapped, warnings: v.warnings };
  }

  const entries = collect(raw);
  const used = new Set();   // raw paths consumed
  const out = { source: 'costar' };
  const take = (field, e, value) => {
    used.add(e.path);
    mapped.push(`${e.path} → ${field}`);
    out[field] = value;
  };

  // The tenant list first, so its items are not read as building fields.
  const tenantList = findTenantArray(entries);
  const free = () => entries.filter(x => !used.has(x.path) && !x.party);
  for (const [field, syns] of Object.entries(BUILDING_FIELDS)) {
    if (field === 'trafficCounts') continue;
    const e = pick(free(), syns);
    if (!e) continue;
    const v = e.value;
    switch (field) {
      case 'percentVacant': {
        if (out.percentLeased !== undefined) continue;
        const n = parseNumber(v);
        if (!Number.isFinite(n)) continue;
        const pct = n > 0 && n <= 1 && !String(v).includes('%') ? n * 100 : n;
        take('percentLeased', e, +(100 - pct).toFixed(2));
        warnings.push(`percentLeased: computed as 100 minus ${e.path} (${show(v)})`);
        break;
      }
      case 'parkingSpaces': case 'parkingRatio': {
        const n = parseNumber(v);
        if (!Number.isFinite(n)) continue;
        used.add(e.path);
        const key = field === 'parkingSpaces' ? 'spaces' : 'ratioPer1000SF';
        mapped.push(`${e.path} → parking.${key}`);
        out.parking = { spaces: null, ratioPer1000SF: null, ...(out.parking || {}), [key]: n };
        break;
      }
      case 'hours': {
        const h = parseHours(v);
        if (!h) { warnings.push(`hours: could not read ${show(v)} from ${e.path}`); continue; }
        take('hours', e, h);
        break;
      }
      case 'rbaSF':
        if (['gba', 'grossbuildingarea'].includes(e.key)) warnings.push(`rbaSF: read from ${e.path} (gross, not rentable, area)`);
        take(field, e, v);
        break;
      default:
        take(field, e, v);
    }
  }

  // Traffic counts: a list of records, one record, or a single number.
  const traffic = pick(free(), BUILDING_FIELDS.trafficCounts, e => !missing(e.value));
  if (traffic) {
    const items = Array.isArray(traffic.value) ? traffic.value : [traffic.value];
    const counts = [];
    for (const it of items) {
      if (isObj(it)) {
        const keys = Object.entries(it).map(([k, val]) => ({ key: norm(k), value: val, depth: 0, path: k }));
        const c = pick(keys, TRAFFIC_COUNT), s = pick(keys, TRAFFIC_STREET);
        const n = c ? parseNumber(c.value) : NaN;
        if (Number.isFinite(n)) counts.push({ street: s ? cleanText(s.value, 80) : null, vehiclesPerDay: n });
      } else if (Number.isFinite(parseNumber(it))) counts.push({ street: null, vehiclesPerDay: parseNumber(it) });
    }
    if (counts.length) {
      used.add(traffic.path);
      mapped.push(`${traffic.path} → trafficCounts (${counts.length})`);
      out.trafficCounts = counts;
    }
  }

  // Tenants.
  if (tenantList) {
    used.add(tenantList.path);
    const unknownTenantKeys = new Set();
    const tenants = [];
    tenantList.value.forEach(item => {
      if (!isObj(item)) return;
      const keys = Object.entries(item).map(([k, val]) => ({ key: norm(k), value: val, depth: 0, path: k }));
      const t = {}, taken = new Set();
      for (const [field, syns] of Object.entries(TENANT_FIELDS)) {
        const e = pick(keys.filter(x => !taken.has(x.path)), syns);
        if (!e) continue;
        taken.add(e.path);
        t[field] = field === 'hours' ? (parseHours(e.value) ?? undefined) : e.value;
      }
      for (const k of keys) if (!taken.has(k.path)) unknownTenantKeys.add(k.path);
      // A raw "use" that is not one of USE_TYPES ("Retail Trade") is treated as the industry, so it gets classified.
      if (!missing(t.use) && !USE_TYPES.includes(String(t.use).trim().toLowerCase())) {
        if (missing(t.industry)) t.industry = t.use;
        delete t.use;
      }
      if (!missing(t.name)) tenants.push(t);
    });
    mapped.push(`${tenantList.path}[] → tenants (${tenants.length})`);
    for (const k of unknownTenantKeys) unmapped.push(`${tenantList.path}[].${k}`);
    out.tenants = tenants;
  } else {
    warnings.push('no list of tenants found; the profile has no tenants');
  }

  for (const e of entries) {
    if (used.has(e.path)) continue;
    if (tenantList && e.path.startsWith(tenantList.path + '.')) continue;
    unmapped.push(e.path);
  }

  // Every mapped value is CoStar data; tenant uses classified by keyword are assumptions.
  out.provenance = {};
  const v = validateProfile(out);
  for (const w of v.warnings) warnings.push(w);
  if (!v.profile) return { profile: null, mapped, unmapped, warnings };
  return { profile: v.profile, mapped, unmapped, warnings };
}
