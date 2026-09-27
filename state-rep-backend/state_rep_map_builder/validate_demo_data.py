"""Validate the generated browser dataset before it is served."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from .build_demo_data import STATE_INFO


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()

    manifest = json.loads((args.data_dir / "manifest.json").read_text())
    states = json.loads((args.data_dir / "states.json").read_text())
    expected = {abbr for abbr, _ in STATE_INFO.values()}
    actual = {item["code"] for item in states}
    errors: list[str] = []
    if actual != expected:
        errors.append(f"states.json has {sorted(actual ^ expected)} outside the 50-state scope")
    if set(manifest["states"]) != expected:
        errors.append("manifest state list does not contain exactly the 50 states")

    all_records = []
    for state in sorted(expected):
        path = args.data_dir / f"{state}.json"
        if not path.exists():
            errors.append(f"missing {path.name}")
            continue
        records = json.loads(path.read_text())
        all_records.extend(records)
        district_keys = [(record["chamber"], record["geoid"]) for record in records]
        if len(district_keys) != len(set(district_keys)):
            errors.append(f"{state} contains duplicate chamber/GEOID pairs")
        for record in records:
            if record["state"] != state:
                errors.append(f"{state} contains a record for {record['state']}")
            if record["chamber"] not in ("upper", "lower"):
                errors.append(f"{state} has an invalid chamber")
            if not record["members"] and record["matchType"] == "exact":
                errors.append(f"{state} has an exact match with no members")
            for member in record["members"]:
                if member["verification"] not in ("official-link-listed", "needs-official-link"):
                    errors.append(f"{state} has an invalid verification value")

    counts = Counter(record["chamber"] for record in all_records)
    if len(all_records) != manifest["districts"]:
        errors.append("manifest district count does not match state files")
    if counts["upper"] != 1947:
        errors.append(f"expected 1,947 upper districts, found {counts['upper']}")
    if counts["lower"] != 4838:
        errors.append(f"expected 4,838 lower districts, found {counts['lower']}")

    print(json.dumps({
        "states": len(actual),
        "districts": len(all_records),
        "upper": counts["upper"],
        "lower": counts["lower"],
        "unmatched": sum(record["matchType"] == "unmatched" for record in all_records),
        "errors": errors,
    }, indent=2))
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
