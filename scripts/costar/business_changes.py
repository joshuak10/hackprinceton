"""Businesses in the CoStar kit that made a significant change, found from their tenancy records.

A change is one of:
  second location        a new property starts while an earlier one is still occupied (different street address)
  second location closed within 2 years
  moved                  a tenancy ended "MoveIntoAnotherProperty" (destination when the data has it)
  moved within building / expanded space / shrank space   "MovingIntoSameBuilding", with a 25% size change
  downsized              moved into an executive suite or a home office, or shed space
  split space            "OccupancySplit"
Closures alone are not counted as changes.

Default: small independent businesses only (no known chain or franchise, at most 6 locations in the data, 50 or fewer
employees at every location with a count). --all keeps every tenant and labels chains and size instead.

  python3 scripts/costar/business_changes.py                       # -> data/costar/business-changes.csv
  python3 scripts/costar/business_changes.py --all                 # -> data/costar/all-business-changes.csv

Limits: the kit only covers buildings on CoStar's Matterport capture list, so a second site elsewhere is invisible,
and CoStar's records can lag reality.
"""
import argparse
import os
from collections import Counter, defaultdict

from common import CHAINS, DEFAULT_KIT, DEFAULT_OUT_DIR, Kit, company_key, output_path, parse_date, write_csv


def tenancies_by_company(kit):
    companies = {c['id']: c for c in kit.records('company-detail.jsonl')}
    out = defaultdict(list)
    for o in kit.records('location-occupancy.jsonl'):
        c = companies.get(o.get('tenantLocationId'))
        if not c:
            continue
        k = company_key(c)
        if not k:
            continue
        out[k].append({
            'loc': c['id'], 'pid': o['propertyId'], 'c': c,
            'start': parse_date(o.get('moveInDate') or o.get('fromDate')), 'end': parse_date(o.get('toDate')),
            'why': kit.enum('LocationOccupancyExpirationReason', o.get('expirationReason')),
            'sqft': sum((s.get('squareFeetOccupied') or 0) for s in (o.get('spaces') or [])),
            'ind': (c.get('profile') or {}).get('industryType') or o.get('industryType') or 0,
        })
    return out


def changes_of(kit, ts):
    addr = kit.address
    ts = sorted((t for t in ts if t['start']), key=lambda t: t['start'])
    ev = []
    seen = []
    for t in ts:
        for s in seen:
            if (s['pid'] != t['pid'] and addr(s['pid'], s['c']) != addr(t['pid'], t['c'])
                    and (s['end'] is None or (s['end'] - t['start']).days > 90) and (t['start'] - s['start']).days > 30):
                closed_fast = bool(t['end'] and t['why'] == 'ClosedLocationOrBankrupt' and (t['end'] - t['start']).days < 730)
                ev.append(('second location', t['start'], f"opened {addr(t['pid'], t['c'])} while still at {addr(s['pid'], s['c'])}"
                           + (f"; it closed {t['end']:%b %Y}" if closed_fast else '')))
                if closed_fast:
                    ev.append(('second location closed within 2 years', t['end'], addr(t['pid'], t['c'])))
                break
        seen.append(t)
    for t in ts:
        if not t['end']:
            continue
        near = [u for u in ts if u is not t and abs((u['start'] - t['end']).days) <= 365]
        here = addr(t['pid'], t['c'])
        if t['why'] == 'MoveIntoAnotherProperty':
            dest = next((u for u in near if u['pid'] != t['pid']), None)
            there = addr(dest['pid'], dest['c']) if dest else 'a property outside the data'
            if there != here:
                ev.append(('moved', t['end'], f"{here} -> {there}"))
        elif t['why'] == 'MovingIntoSameBuilding':
            dest = next((u for u in near if u['pid'] == t['pid']), None)
            change = dest['sqft'] / t['sqft'] - 1 if dest and t['sqft'] and dest['sqft'] else 0
            if change >= 0.25:
                ev.append(('expanded space', dest['start'], f"{int(t['sqft'])} -> {int(dest['sqft'])} sq ft at {here}"))
            elif change <= -0.25:
                ev.append(('shrank space', dest['start'], f"{int(t['sqft'])} -> {int(dest['sqft'])} sq ft at {here}"))
            else:
                ev.append(('moved within building', t['end'], here))
        elif t['why'] in ('MovingIntoExecutiveSuite', 'MovingIntoHomeOffice', 'ShedSpace'):
            ev.append(('downsized', t['end'], f"{t['why']} from {here}"))
        elif t['why'] == 'OccupancySplit':
            ev.append(('split space', t['end'], here))
    return ts, sorted(ev, key=lambda e: e[1])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--kit', default=DEFAULT_KIT, help='path to the CoStar kit (default: costar-hackathon-kit/)')
    ap.add_argument('--all', action='store_true', help='keep every tenant; label chains and size instead of filtering')
    ap.add_argument('--out', help='output CSV (must be under data/)')
    args = ap.parse_args()
    kit = Kit(args.kit)
    out = output_path(args.out or os.path.join(DEFAULT_OUT_DIR, 'all-business-changes.csv' if args.all else 'business-changes.csv'))

    rows, kinds = [], Counter()
    for k, ts in tenancies_by_company(kit).items():
        locs = {t['loc']: t['c'] for t in ts}
        name = next((c.get('name') for c in locs.values() if c.get('name')), k)
        emps = [c.get('numEmployees') for c in locs.values() if c.get('numEmployees') is not None]
        pids = {t['pid'] for t in ts}
        franchise = any(c.get('officeType') == 4 for c in locs.values())
        chain = 'yes' if (CHAINS.search(name) or CHAINS.search(k) or franchise) else ('likely' if max(len(pids), len(locs)) > 6 else 'no')
        size = 'unknown' if not emps else ('small (50 or fewer per site)' if max(emps) <= 50 else 'larger')
        if not args.all and (chain != 'no' or size == 'larger'):
            continue
        ts, ev = changes_of(kit, ts)
        if not ev:
            continue
        kinds.update(e[0] for e in ev)
        active = [t for t in ts if t['end'] is None and t['c'].get('businessStatus') == 1]
        industry = Counter(kit.enum('IndustryType', t['ind']) for t in ts).most_common(1)[0][0]
        website = next(((c.get('profile') or {}).get('websiteUrl') for c in locs.values() if (c.get('profile') or {}).get('websiteUrl')), '')
        rows.append({
            'business': name, 'industry': industry, 'chain_or_franchise': chain, 'size': size,
            'still_active_in_data': 'yes' if active else 'no',
            'current_address': '; '.join(sorted({kit.address(t['pid'], t['c']) for t in active})),
            'locations_in_data': len(pids), 'max_employees': max(emps) if emps else '',
            'change_types': ', '.join(sorted({e[0] for e in ev})), 'latest_change': ev[-1][1].isoformat(),
            'changes': ' | '.join(f"{e[1]:%Y-%m} {e[0]}: {e[2]}" for e in ev), 'website': website or '',
        })
    rows.sort(key=lambda r: r['latest_change'], reverse=True)          # newest first ...
    rows.sort(key=lambda r: r['still_active_in_data'] != 'yes')        # ... with still-active businesses on top
    write_csv(out, rows)
    print(f"{'All' if args.all else 'Small independent'} businesses with a significant change: {len(rows)}, "
          f"still active: {sum(r['still_active_in_data'] == 'yes' for r in rows)}")
    print('Businesses by change type:', Counter(t for r in rows for t in r['change_types'].split(', ')).most_common())
    print('Top industries:', Counter(r['industry'] for r in rows).most_common(8))


if __name__ == '__main__':
    main()
