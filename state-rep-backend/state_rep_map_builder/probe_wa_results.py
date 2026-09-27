"""Normalize Washington's 2024 general election export into district contests."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

SOURCE_URL = "https://results.vote.wa.gov/results/20241105/export/20241105_AllState.csv"
ELECTION_DATE = "2024-11-05"
EXPECTED_FIELDS = {
    "Race", "Candidate", "Party", "Votes", "PercentageOfTotalVotes",
    "JurisdictionName",
}


def parse_race(label: str, jurisdiction: str) -> tuple[str, str, str, str | None] | None:
    """Return (chamber, district, position, federal seat class) for supported races."""
    label = label.strip()
    if jurisdiction.casefold() == "congressional":
        match = re.fullmatch(
            r"Congressional\s+District\s+(\d+)\s*-\s*U\.S\.\s*Representative",
            label, re.IGNORECASE,
        )
        if match:
            return "us_house", f"{int(match[1]):02d}", "", None
    if jurisdiction.casefold() == "legislative":
        match = re.fullmatch(
            r"Legislative\s+District\s+(\d+)\s*-\s*State\s+Representative\s+Pos\.\s*([12])",
            label, re.IGNORECASE,
        )
        if match:
            return "state_house", f"{int(match[1]):03d}", match[2], None
        match = re.fullmatch(
            r"Legislative\s+District\s+(\d+)\s*-\s*State\s+Senator",
            label, re.IGNORECASE,
        )
        if match:
            return "state_senate", f"{int(match[1]):03d}", "", None
    if jurisdiction.casefold() == "united states" and re.fullmatch(
        r"U\.S\.\s*Senator", label, re.IGNORECASE
    ):
        return "us_senate", "", "", None
    return None


def normalize(csv_bytes: bytes, fetched_at: str | None, fixture_path: str | None = None) -> dict:
    text = csv_bytes.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text, newline=""))
    if not reader.fieldnames or not EXPECTED_FIELDS.issubset(reader.fieldnames):
        raise ValueError(f"CSV is missing required columns: {sorted(EXPECTED_FIELDS)}")

    grouped: dict[tuple[str, str, str], dict] = {}
    for line, row in enumerate(reader, start=2):
        parsed = parse_race(row["Race"], row["JurisdictionName"])
        if parsed is None:
            continue
        chamber, district, position, seat_class = parsed
        try:
            votes = int(row["Votes"].replace(",", "").strip())
            percentage = float(row["PercentageOfTotalVotes"].strip().rstrip("%"))
        except (AttributeError, ValueError) as exc:
            raise ValueError(f"Invalid vote count or percentage on CSV line {line}") from exc
        name = row["Candidate"].strip()
        if votes < 0 or not name or not 0 <= percentage <= 100:
            raise ValueError(f"Invalid candidate result on CSV line {line}")

        key = chamber, district, position
        contest = grouped.setdefault(key, {
            "id": f"WA-{ELECTION_DATE}-{chamber}-{district or 'at-large'}"
                  f"{'-pos' + position if position else ''}",
            "state": "WA",
            "chamber": chamber,
            "district": district or None,
            "seatPosition": position or None,
            "seatClass": seat_class,
            "sourceRace": row["Race"].strip(),
            "jurisdictionName": row["JurisdictionName"].strip(),
            "electionDate": ELECTION_DATE,
            "stage": "general",
            "boundaryPlanId": None,
            "requiresBoundaryCrosswalk": True,
            "candidates": [],
        })
        if any(candidate["name"] == name for candidate in contest["candidates"]):
            raise ValueError(f"Duplicate candidate {name!r} in {contest['sourceRace']}")
        percentage_raw = row["PercentageOfTotalVotes"].strip().rstrip("%")
        precision = len(percentage_raw.partition(".")[2]) if "." in percentage_raw else 0
        contest["candidates"].append({
            "name": name,
            "party": row["Party"].strip(),
            "votes": votes,
            "percentage": percentage,
            "_precision": precision,
        })

    contests = list(grouped.values())
    if not contests:
        raise ValueError("No supported WA legislative or federal contests found")
    for contest in contests:
        candidates = contest["candidates"]
        total = sum(c["votes"] for c in candidates)
        if total <= 0:
            raise ValueError(f"Non-positive total vote count in {contest['sourceRace']}")
        for candidate in candidates:
            observed = candidate["votes"] * 100 / total
            tolerance = 0.5 * (10 ** -candidate["_precision"]) + 0.000001
            if abs(observed - candidate["percentage"]) > tolerance:
                raise ValueError(
                    f"Percentage mismatch in {contest['sourceRace']} for {candidate['name']}: "
                    f"reported {candidate['percentage']}, computed {observed:.4f}"
                )
            del candidate["_precision"]
        candidates.sort(key=lambda candidate: (-candidate["votes"], candidate["name"].casefold()))

    contests.sort(key=lambda item: (item["chamber"], item["district"] or "", item["seatPosition"] or ""))
    return {
        "source": {
            "url": SOURCE_URL,
            "fetchedAt": fetched_at,
            "fixturePath": fixture_path,
            "importedAt": datetime.now(timezone.utc).isoformat(),
            "sha256": hashlib.sha256(csv_bytes).hexdigest(),
        },
        "status": "historical export; certification not inferred from file",
        "contests": contests,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--input", type=Path, help="Use a local CSV fixture instead of fetching.")
    args = parser.parse_args()
    try:
        if args.input:
            csv_bytes = args.input.read_bytes()
            fetched_at = None
        else:
            request = Request(SOURCE_URL, headers={"User-Agent": "state-rep-map-results-probe/1.0"})
            with urlopen(request, timeout=30) as response:
                if response.status != 200:
                    raise OSError(f"Source returned HTTP {response.status}")
                csv_bytes = response.read()
            fetched_at = datetime.now(timezone.utc).isoformat()
        result = normalize(csv_bytes, fetched_at, str(args.input) if args.input else None)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{args.output.name}.", dir=args.output.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(result, stream, indent=2, ensure_ascii=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, args.output)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    except (OSError, UnicodeError, csv.Error, ValueError) as exc:
        print(f"WA results import failed: {exc}", file=sys.stderr)
        return 1
    print(f"Wrote {len(result['contests'])} contests to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
