"""Customer-facing businesses that changed, from the CoStar records plus web research.

Takes the output of business_changes.py, keeps customer-facing industries (food and drink, retail, personal services,
arts and recreation, health care), and merges in changes found by web research. The web research file is a JSON array
of {name, address, open_status, changes: [{date, type, description, url}]}, as written by the case-study research
(kept under data/, never committed).

  python3 scripts/costar/merge_web_changes.py --web data/costar/case-all.json
    -> data/costar/customer-facing-changes.csv
"""
import argparse
import csv
import json
import os
import re
from collections import Counter

from common import DEFAULT_OUT_DIR, output_path, write_csv

CUSTOMER_FACING = {'AccommodationAndFoodServices': 'Food & drink', 'RetailersOrWholesalers': 'Retail',
                   'PersonalServices': 'Personal services', 'ArtsEntertainmentAndRecreation': 'Arts & recreation',
                   'HealthCareAndSocialAssistance': 'Health care'}
WEB_TYPES = {'new_location': 'second location', 'expansion': 'second location', 'move': 'moved', 'renovation': 'renovation',
             'closure': 'closure', 'ownership': 'ownership change', 'service_model': 'changed service model',
             'price': 'price change', 'menu': 'menu change', 'hours': 'hours change'}


def key(name):
    return re.sub(r'[^a-z0-9]', '', name.lower().split('(')[0])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--changes', default=os.path.join(DEFAULT_OUT_DIR, 'business-changes.csv'), help='output of business_changes.py')
    ap.add_argument('--web', help='web research JSON (optional)')
    ap.add_argument('--out', default=os.path.join(DEFAULT_OUT_DIR, 'customer-facing-changes.csv'), help='output CSV (under data/)')
    args = ap.parse_args()
    out = output_path(args.out)

    rows = []
    with open(args.changes) as f:
        for r in csv.DictReader(f):
            if r['industry'] in CUSTOMER_FACING:
                rows.append({'business': r['business'], 'category': CUSTOMER_FACING[r['industry']], 'source': 'CoStar records',
                             'still_active': r['still_active_in_data'], 'current_address': r['current_address'],
                             'change_types': r['change_types'], 'latest_change': r['latest_change'][:7], 'changes': r['changes'],
                             'website': r['website'], 'max_employees': r['max_employees']})
    added = 0
    if args.web:
        by_key = {key(r['business']): r for r in rows}
        with open(args.web) as f:
            research = json.load(f)
        for b in research:
            found = [c for c in (b.get('changes') or []) if c.get('type') in WEB_TYPES]
            if not found:
                continue
            text = ' | '.join(f"{c.get('date')} {WEB_TYPES[c['type']]}: {c.get('description')} <{c.get('url')}>" for c in found)
            types = {WEB_TYPES[c['type']] for c in found}
            match = by_key.get(key(b['name']))
            if match:
                match['source'] = 'both'
                match['changes'] += ' | WEB: ' + text
                match['change_types'] = ', '.join(sorted(set(match['change_types'].split(', ')) | types))
            else:
                rows.append({'business': b['name'], 'category': 'Food & drink', 'source': 'web research',
                             'still_active': {'open': 'yes', 'closed': 'no'}.get(b.get('open_status'), 'unclear'),
                             'current_address': b.get('address') or '', 'change_types': ', '.join(sorted(types)),
                             'latest_change': '', 'changes': text, 'website': '', 'max_employees': ''})
                added += 1
    rank = {'yes': 0, 'unclear': 1, 'no': 2}
    rows.sort(key=lambda r: (r['category'] != 'Food & drink', rank.get(r['still_active'], 3)))
    write_csv(out, rows)
    print(f'Added from web research: {added}')
    print('By category:', dict(Counter(r['category'] for r in rows)))
    second = [r for r in rows if 'second location' in r['change_types']]
    print(f"Tried a second location: {len(second)}, still active: {sum(r['still_active'] == 'yes' for r in second)}")


if __name__ == '__main__':
    main()
