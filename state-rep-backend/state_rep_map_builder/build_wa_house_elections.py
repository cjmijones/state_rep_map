"""Publish Washington's 2024 U.S. House results for the 119th-district map.

The Census describes 119th congressional boundaries as those in effect for
the 2024 election cycle. This pilot is restricted to that election and plan.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen

from .probe_federal_sources import utc_now, write_atomically
from .probe_wa_results import SOURCE_URL, normalize


EXPORT_PAGE = "https://results.vote.wa.gov/results/20241105/export.html"
PLAN_SOURCE = "https://www.census.gov/programs-surveys/decennial-census/about/rdo/congressional-districts.119th_Congress.html"


def build(probe: dict, geography: dict) -> dict:
    if geography.get("congress") != 119:
        raise ValueError("Expected the 119th Congress geography manifest")
    expected = {geoid for geoid in geography.get("house", []) if geoid.startswith("53")}
    if len(expected) != 10:
        raise ValueError(f"Expected ten Washington House district shapes, found {len(expected)}")
    if probe.get("source", {}).get("url") != SOURCE_URL:
        raise ValueError("Washington result source URL does not match the official export")
    contests = []
    for contest in probe.get("contests", []):
        if contest.get("state") != "WA" or contest.get("chamber") != "us_house":
            continue
        if contest.get("electionDate") != "2024-11-05" or contest.get("stage") != "general":
            raise ValueError("Unexpected Washington House election date or stage")
        geoid = "53" + str(contest["district"])
        if geoid not in expected or any(item["geoid"] == geoid for item in contests):
            raise ValueError(f"Washington House result has an unknown or duplicate district: {geoid}")
        candidates = contest.get("candidates", [])
        if len(candidates) < 2 or sum(item["votes"] for item in candidates) <= 0:
            raise ValueError(f"Washington House district {geoid} has incomplete results")
        contests.append({
            "geoid": geoid, "district": contest["district"], "electionDate": "2024-11-05",
            "stage": "general", "boundaryPlanId": "US-CD119",
            "candidates": candidates, "totalVotes": sum(item["votes"] for item in candidates),
        })
    if {item["geoid"] for item in contests} != expected:
        raise ValueError("Washington House results do not cover all ten 119th districts")
    contests.sort(key=lambda item: item["district"])
    return {
        "generatedAt": utc_now(), "coverage": "Washington U.S. House, 2024 general election",
        "boundaryPlanId": "US-CD119", "boundarySourceUrl": PLAN_SOURCE,
        "source": {**probe["source"], "exportPageUrl": EXPORT_PAGE},
        "status": probe["status"], "contests": contests,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geography", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--probe", type=Path, help="Use an existing normalized probe for an offline check")
    args = parser.parse_args()
    if args.probe:
        probe = json.loads(args.probe.read_text(encoding="utf-8"))
    else:
        request = Request(SOURCE_URL, headers={"User-Agent": "StatehouseAtlasElections/0.1"})
        with urlopen(request, timeout=45) as response:
            csv_bytes = response.read()
        probe = normalize(csv_bytes, fetched_at=utc_now())
    geography = json.loads(args.geography.read_text(encoding="utf-8"))
    result = build(probe, geography)
    write_atomically(args.output, result)
    print(f"Published {len(result['contests'])} Washington House contests to {args.output}")


if __name__ == "__main__":
    main()
