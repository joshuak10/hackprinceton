"""Shared helpers for the CoStar kit scripts (scripts/costar/).

The kit is licensed hackathon data. These scripts only read it, and they write their results under data/
(gitignored). Never commit the kit or anything derived from it.
"""
import csv
import json
import os
import re
import sys
from datetime import date

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DEFAULT_KIT = os.path.join(REPO, 'costar-hackathon-kit')
DEFAULT_OUT_DIR = os.path.join(REPO, 'data', 'costar')

# Known chains, franchises and non-targets. A name list, not proof: confirm independence before contacting anyone.
CHAINS = re.compile(
    r"starbucks|subway|mcdonald|chipotle|jamba|panera|dunkin|domino|pizza hut|taco bell|wendy|burger king|chick-fil-a|"
    r"panda express|jack in the box|popeyes|\bkfc\b|sonic drive|whataburger|smoothie king|pinkberry|yogurtland|coffee bean|"
    r"peet'?s|philz|blue bottle|sweetgreen|cava\b|shake shack|in-n-out|wingstop|raising cane|kolache factory|shipley|einstein|"
    r"corner bakery|pain quotidien|paris baguette|85c|kung fu tea|gong cha|dutch bros|tim hortons|krispy|baskin|cold stone|"
    r"dairy queen|papa john|little caesar|jersey mike|jimmy john|firehouse sub|potbelly|qdoba|el pollo loco|del taco|carl'?s jr|"
    r"ihop|denny|cheesecake factory|p\.f\. chang|olive garden|applebee|chili'?s|buffalo wild wings|hooters|nothing bundt|crumbl|"
    r"tiff'?s treats|halal guys|cinnabon|auntie anne|wetzel|pressed juicery|erewhon|whole foods|trader joe|7-eleven|cvs|"
    r"walgreens|h-e-b|kroger|ralphs|vons|target|walmart|costco|bank of america|wells fargo|chase|jpmorgan|regus|wework|"
    r"state farm|allstate|farmers insurance|edward jones|h&r block|ups store|fedex|verizon|at&t|t-mobile|sprint|bibibop|"
    r"toastique|wow wow|kura sushi|mastro|au bon pain|marco'?s pizza|sentral|blaze pizza|mendocino farms|lemonade|"
    r"tender greens|veggie grill|urth caff|joe & the juice|bluestone lane|alfred coffee|la colombe|intelligentsia|verve coffee|"
    r"sprinkles|nekter|kreation|sharky|tocaya|dog haus|fatburger|johnny rockets|rubio|chronic tacos|sugarfish|katsuya|nobu|"
    r"ruth'?s chris|morton'?s|fogo de|del frisco|eddie v|capital grille|perry'?s|pappas|pappadeaux|landry|saltgrass|torchy|"
    r"velvet taco|snooze|first watch|another broken egg|black bear diner|waffle house|anytime fitness|orangetheory|f45|"
    r"planet fitness|24 hour fitness|equinox|massage envy|hand & stone|european wax|great clips|supercuts|sport clips|drybar|"
    r"the joint|aspen dental|western dental|lenscrafters|pearle vision|industrious|davita|fresenius|labcorp|quest diagnostics|"
    r"concentra|nextcare|minuteclinic|kelsey-seybold|memorial hermann|houston methodist|cedars|kaiser|ucla health|baylor|"
    r"texas children|optum|carbon health|one medical|goodwill|gamestop|mattress firm|sherwin|dollar tree|family dollar|"
    r"dollar general|ross dress|tj maxx|marshalls|five below|ulta|sephora|bath & body|victoria'?s secret|gnc\b|vitamin shoppe|"
    r"blu jam|barnes & noble|west elm|sola salon|corepower|eos fitness|club pilates|lovesac|servpro|puroclean|natera|privia|"
    r"select physical|visiting angels|synergy homecare|which wich|charming charlie|wheel works|at your side|"
    r"chamber of commerce|new hope housing|ti communities|fitness tenant|vision to learn|aspire fertility|st\.? hope|"
    r"pregnancy specialty|gi specialists|complete women|women'?s healthcare associates|facial plastic surgery associates|"
    r"vital heart|tgf hair",
    re.I)


class Kit:
    """Reads the kit's JSON Lines datasets and enums."""

    def __init__(self, kit_dir):
        self.dir = os.path.abspath(kit_dir)
        if not os.path.isdir(os.path.join(self.dir, 'data')):
            sys.exit(f"No CoStar kit at {self.dir} (expected a data/ folder). Pass --kit <path>.")
        with open(os.path.join(self.dir, 'schemas', 'enums.json')) as f:
            self.enums = json.load(f)
        self._props = None

    def records(self, name):
        with open(os.path.join(self.dir, 'data', name)) as f:
            for line in f:
                if line.strip():
                    yield json.loads(line)

    def enum(self, kind, value, default='Unknown'):
        return self.enums.get(kind, {}).get(str(value if value is not None else 0), default)

    @property
    def props(self):
        if self._props is None:
            self._props = {p['id']: p for p in self.records('commercial-property.jsonl')}
        return self._props

    def scanned_property_ids(self):
        ids = set()
        with open(os.path.join(self.dir, 'commercial-properties.csv')) as f:
            for row in csv.DictReader(f):
                if row.get('MatterportModelId'):
                    ids.add(int(row['PropertyId']))
        return ids

    def address(self, property_id, company=None):
        """Street and city of a company location, falling back to the property's primary address."""
        a = (company or {}).get('address') or (self.props.get(property_id, {}).get('primaryAddress') or {})
        street = ' '.join(x for x in [a.get('streetNumber'), a.get('streetDirection'), (a.get('streetName') or '').title(), a.get('streetType')] if x)
        return f"{street}, {(a.get('city') or '').title()}".strip(', ')


def parse_date(s):
    try:
        return date.fromisoformat((s or '')[:10])
    except ValueError:
        return None


def company_name(c):
    return ((c.get('profile') or {}).get('companyName') or c.get('name') or '').strip()


def company_key(c):
    """A loose key that groups the locations of one company: lower case, punctuation and legal suffixes removed."""
    words = re.sub(r"[^a-z0-9& ]", " ", company_name(c).lower())
    words = re.sub(r"\b(llc|inc|ltd|lp|llp|co|corp|corporation|company|pllc|pc|pa)\b\.?", "", words)
    return ' '.join(words.split())


def output_path(path):
    """Results contain licensed data: inside the repo they may only go under data/ (gitignored)."""
    full = os.path.abspath(path)
    rel = os.path.relpath(full, REPO)
    if not rel.startswith('..') and not rel.startswith('data' + os.sep):
        sys.exit(f"Refusing to write {rel}: results from the CoStar kit go under data/ (gitignored) so they are never committed.")
    os.makedirs(os.path.dirname(full), exist_ok=True)
    return full


def write_csv(path, rows):
    if not rows:
        print(f"No rows to write to {path}.")
        return
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"Wrote {len(rows)} rows to {os.path.relpath(path, REPO)}")
