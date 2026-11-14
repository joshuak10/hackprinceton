# CoStar kit scripts

Scripts that find independent businesses in the CoStar hackathon kit and track their changes, for the independent-business use case ([INDEPENDENT_BUSINESS_SPEC.md](../../INDEPENDENT_BUSINESS_SPEC.md)).

**The kit is licensed hackathon data.** Put it at `costar-hackathon-kit/` in the repo root, which is gitignored, or pass `--kit <path>`. The scripts only read it. They write results under `data/costar/`, also gitignored, and refuse to write anywhere else in the repo. Never commit the kit or anything made from it.

| Script | What it writes |
|---|---|
| `independent_businesses.py` | `independent-businesses.csv`: small independent businesses that are still open: counter-service food and drink, restaurants and bars, personal services, retail. Also writes `food-call-list.csv`, the food and drink ones. |
| `business_changes.py` | `business-changes.csv`: small independent businesses that opened a second location, moved, expanded, shrank or downsized, found from their tenancy records. With `--all`, it writes `all-business-changes.csv` instead, which covers every tenant, with chain and size as labels. |
| `merge_web_changes.py` | `customer-facing-changes.csv`: the customer-facing rows of `business-changes.csv`, plus changes from a web research JSON (`--web`). |

```sh
python3 scripts/costar/independent_businesses.py
python3 scripts/costar/business_changes.py            # small independents
python3 scripts/costar/business_changes.py --all      # every tenant, labelled
python3 scripts/costar/merge_web_changes.py --web data/costar/case-all.json
```

These scripts use only Python 3's standard library. `common.py` holds the shared helpers and the chain name list.

**Limits:**
- **The chain filter is a list of names, not proof.** Confirm that a business is independent before contacting it.
- **Phone numbers in the kit are fake** (area code 555).
- **Coverage is partial.** The kit covers only the buildings on CoStar's Matterport capture list in Houston and Los Angeles, so a second location elsewhere is invisible.
- **The records can lag reality.** For example, the kit still lists Father's Office as open after it closed in September 2025.
