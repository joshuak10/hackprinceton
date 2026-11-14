"""Small independent customer-facing businesses in the CoStar kit: a list of who to contact.

Kept: a current tenancy (no end date) whose company is active, marked as a single location (not a franchise or a
chain branch), with at most 50 employees, not a known chain, and whose name appears at no more than 2 locations.
Categories: counter-service food and drink, restaurants and bars, personal services, retail. Hotels, caterers and
hospitality groups are left out.

  python3 scripts/costar/independent_businesses.py
    -> data/costar/independent-businesses.csv   (all four categories)
    -> data/costar/food-call-list.csv           (food and drink only)

Phone numbers in the kit are fake (area code 555); find real ones from each business's website. Confirm a business
is independent before contacting it: the chain filter is a name list.
"""
import argparse
import os
import re
from collections import Counter, defaultdict

from common import CHAINS, DEFAULT_KIT, DEFAULT_OUT_DIR, Kit, company_name, output_path, write_csv

HOTEL = re.compile(r"hotel|\binn\b|suites|motel|resort|lodg|hostel|marriott|hilton|hyatt|sheraton|westin|holiday inn|courtyard|"
                   r"hampton|residence inn|airbnb|catering company|food service management|aramark|sodexo|compass group", re.I)
HOTEL_SITE = re.compile(r"marriott\.com|hilton\.com|hyatt\.com|ihg\.com", re.I)
NOT_FOOD = re.compile(r"hospitality|group\b|holdings|cleaning|apartment|housing|\bcamp\b|collective|culinary|catering|express llc|"
                      r"insightexpress|agility|royal prestige|utility operators|lunch on me|brunch llc|fate foods|btla|roaming hunger|"
                      r"chef hall|hpt trs|foods, llc", re.I)
COUNTER_STRONG = re.compile(r"coffee|espresso|juice|smoothie|acai|kolache|boba|\btea\b|bakery|donut|bagel|deli\b|sandwich|ice cream|"
                            r"gelato|yogurt|dessert|cupcake|crepe|waffle|cookie|lemonade", re.I)
COUNTER = re.compile(r"caf[eé]|coffee|espresso|bakery|bake|donut|doughnut|\btea\b|boba|juice|smoothie|deli\b|sandwich|bagel|pizza|"
                     r"taco|taqueria|burger|ice cream|gelato|yogurt|creamery|crepe|dessert|cupcake|patisserie|p[aâ]tisserie|kolache|"
                     r"poke|ramen|noodle|pho\b|dumpling|empanada|bbq|barbecue|wings|chicken|grill|kitchen|eatery|bistro|market|"
                     r"bread|cookie|waffle|acai|kombucha|salad|burrito|tamale|pupuser|mediterranean|falafel|shawarma|gyro", re.I)
SITDOWN = re.compile(r"restaurant|\bbar\b|lounge|pub\b|saloon|tavern|wine|sushi|izakaya|seafood|steak|karaoke|daiquiri|rooftop|"
                     r"bistro|fooding|draught|brasserie|trattoria|osteria", re.I)
ORDER = {'Counter-service food & drink': 0, 'Restaurants & bars': 1, 'Personal services': 2, 'Retail': 3}
FOOD = ('Counter-service food & drink', 'Restaurants & bars')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--kit', default=DEFAULT_KIT, help='path to the CoStar kit (default: costar-hackathon-kit/)')
    ap.add_argument('--out', default=os.path.join(DEFAULT_OUT_DIR, 'independent-businesses.csv'), help='output CSV (under data/)')
    ap.add_argument('--food-out', default=os.path.join(DEFAULT_OUT_DIR, 'food-call-list.csv'), help='food and drink CSV (under data/)')
    args = ap.parse_args()
    kit = Kit(args.kit)
    out, food_out = output_path(args.out), output_path(args.food_out)

    companies = {c['id']: c for c in kit.records('company-detail.jsonl')}
    scanned = kit.scanned_property_ids()
    name_count = Counter(company_name(c).lower() for c in companies.values() if company_name(c))
    current = defaultdict(list)
    for o in kit.records('location-occupancy.jsonl'):
        if o.get('toDate') is None and o.get('tenantLocationId') in companies:
            current[o['tenantLocationId']].append(o)

    rows, dropped = [], Counter()
    for cid, occs in current.items():
        c, occ = companies[cid], occs[0]
        name, company = (c.get('name') or '').strip(), company_name(c)
        profile = c.get('profile') or {}
        site = profile.get('websiteUrl') or ''
        reason = ('not active' if c.get('businessStatus') != 1 else
                  'not a single location' if c.get('officeType') != 5 else
                  'no name' if not name else
                  'known chain' if CHAINS.search(name) or CHAINS.search(company) else
                  'name repeats across locations' if name_count[company.lower()] > 2 else
                  'over 50 employees' if (c.get('numEmployees') or 0) > 50 else None)
        if reason:
            dropped[reason] += 1
            continue
        industry = profile.get('industryType') or occ.get('industryType') or 0
        if industry == 17:
            if HOTEL.search(name) or HOTEL_SITE.search(site):
                dropped['hotel restaurant'] += 1
                continue
            if NOT_FOOD.search(name):
                dropped['not a food business'] += 1
                continue
            category = 'Counter-service food & drink' if COUNTER_STRONG.search(name) or (COUNTER.search(name) and not SITDOWN.search(name)) else 'Restaurants & bars'
        elif industry == 13:
            category = 'Personal services'
        elif industry in (6, 27):
            category = 'Retail'
        else:
            dropped['other industry'] += 1
            continue
        a = c.get('address') or {}
        sqft = sum((s.get('squareFeetOccupied') or 0) for o in occs for s in (o.get('spaces') or []))
        rows.append({
            'category': category, 'name': name, 'city': kit.address(occ['propertyId'], c).split(', ')[-1],
            'state': a.get('state') or (kit.props.get(occ['propertyId'], {}).get('primaryAddress') or {}).get('state') or '',
            'address': kit.address(occ['propertyId'], c).rsplit(', ', 1)[0], 'suite': (c.get('suite') or '').strip(),
            'zip': a.get('postcode') or a.get('zip') or '', 'website': site,
            'employees': c.get('numEmployees') if c.get('numEmployees') is not None else '',
            'sqft_occupied': int(sqft) if sqft else '',
            'in_place_since': min((o.get('moveInDate') or o.get('fromDate') or '')[:4] for o in occs),
            'building_matterport_scan': 'yes' if occ['propertyId'] in scanned else 'no',
            'costar_property_id': occ['propertyId'], 'costar_location_id': cid,
            'about': (profile.get('locationBio') or '')[:160].replace('\n', ' '),
        })
    rows.sort(key=lambda r: (ORDER[r['category']], r['city'], r['name'].lower()))
    write_csv(out, rows)
    write_csv(food_out, [r for r in rows if r['category'] in FOOD])
    print('By category:', dict(Counter(r['category'] for r in rows)))
    print('Left out:', dict(dropped))


if __name__ == '__main__':
    main()
