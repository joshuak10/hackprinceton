#!/usr/bin/env python3
"""List every Matterport model the API token can access and write them to a CSV.

Usage:
    set -a && source .env.local && set +a
    python3 scripts/list_models.py [output.csv] [--search TEXT]

Reads MATTERPORT_API_KEY (token ID) and MATTERPORT_API_TOKEN (token secret)
from the environment.
"""
import base64
import csv
import json
import os
import sys
import urllib.request

URL = "https://api.matterport.com/api/models/graph"
PAGE_SIZE = 1000
QUERY = """
query($offset: String, $pageSize: Int, $query: String) {
  models(offset: $offset, pageSize: $pageSize, query: $query) {
    totalResults
    nextOffset
    results { id name created }
  }
}
"""


def gql(auth, variables):
    body = json.dumps({"query": QUERY, "variables": variables}).encode()
    req = urllib.request.Request(
        URL,
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Basic {auth}"},
    )
    with urllib.request.urlopen(req) as resp:
        data = json.load(resp)
    if "errors" in data:
        raise SystemExit(f"API error: {data['errors']}")
    return data["data"]["models"]


def main():
    args = sys.argv[1:]
    search = None
    if "--search" in args:
        i = args.index("--search")
        search = args[i + 1]
        del args[i : i + 2]
    out_path = args[0] if args else "models.csv"

    key, secret = os.environ.get("MATTERPORT_API_KEY"), os.environ.get("MATTERPORT_API_TOKEN")
    if not key or not secret:
        raise SystemExit("Set MATTERPORT_API_KEY and MATTERPORT_API_TOKEN (source .env.local).")
    auth = base64.b64encode(f"{key}:{secret}".encode()).decode()

    rows, offset = [], None
    while True:
        page = gql(auth, {"offset": offset, "pageSize": PAGE_SIZE, "query": search})
        rows.extend(page["results"])
        print(f"{len(rows)}/{page['totalResults']}", file=sys.stderr)
        offset = page.get("nextOffset")
        if not offset or not page["results"]:
            break

    with open(out_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "name", "created", "url"])
        for r in rows:
            w.writerow([r["id"], r["name"], r["created"], f"https://my.matterport.com/show/?m={r['id']}"])
    print(f"Wrote {len(rows)} models to {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
