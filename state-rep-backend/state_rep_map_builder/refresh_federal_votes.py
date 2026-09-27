"""Build complete official House and Senate floor roll-call snapshots.

Reuses validated rolls from the previous snapshot. Each run checks the newest
few rolls again because official vote details can be corrected after posting.
"""

from __future__ import annotations

import argparse
import json
import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from .probe_federal_sources import (
    HOUSE_ROOT, fetch, parse_house_vote, parse_senate_vote,
    senate_sources, text, utc_now, write_atomically,
)


def available_rolls(chamber: str, congress: int, session: int, year: int) -> tuple[list[int], list[dict[str, Any]]]:
    if chamber == "house":
        raw, source = fetch(f"{HOUSE_ROOT}/{year}/index.asp")
        sources = [source]
        rolls = {int(number) for number in re.findall(rb"rollnumber=(\d+)", raw, re.IGNORECASE)}
        pages = {page.decode("ascii").upper() for page in re.findall(rb"ROLL_(\d{3})\.asp", raw, re.IGNORECASE)}
        for page in sorted(pages):
            page_raw, page_source = fetch(f"{HOUSE_ROOT}/{year}/ROLL_{page}.asp")
            sources.append(page_source)
            rolls.update(int(number) for number in re.findall(rb"rollnumber=(\d+)", page_raw, re.IGNORECASE))
    else:
        url, _ = senate_sources(congress, session)
        raw, source = fetch(url)
        sources = [source]
        root = ET.fromstring(raw)
        rolls = {int(text(node, "vote_number")) for node in root.findall("./votes/vote")}
    if not rolls or min(rolls) != 1 or len(rolls) != max(rolls):
        raise ValueError(f"{chamber} index has missing roll numbers")
    return sorted(rolls, reverse=True), sources


def vote_url(chamber: str, congress: int, session: int, year: int, roll: int) -> str:
    if chamber == "house":
        return f"{HOUSE_ROOT}/{year}/roll{roll:03d}.xml"
    _, base = senate_sources(congress, session)
    return f"{base}/vote_{congress}_{session}_{roll:05d}.xml"


def fetch_roll(chamber: str, congress: int, session: int, year: int, roll: int) -> dict[str, Any]:
    url = vote_url(chamber, congress, session, year, roll)
    for attempt in range(3):
        try:
            raw, source = fetch(url, timeout=45)
            break
        except (TimeoutError, OSError):
            if attempt == 2:
                raise
            time.sleep(1 + attempt * 2)
    parsed = parse_house_vote(raw, year, roll) if chamber == "house" else parse_senate_vote(raw, congress, session, roll)
    return {
        "roll": roll, "date": parsed["date"], "question": parsed["question"],
        "result": parsed["voteResult"], "document": parsed["document"],
        "description": parsed.get("description", ""), "voteType": parsed.get("voteType", ""),
        "sourceUrl": url, "source": source,
        "positions": {member["id"]: member["vote"] for member in parsed["members"]},
    }


def refresh_chamber(chamber: str, args: argparse.Namespace, previous: dict[str, Any], checkpoint: Path) -> dict[str, Any]:
    listed, index_sources = available_rolls(chamber, args.congress, args.session, args.year)
    if previous.get("rollCount", 0) > len(listed):
        raise ValueError(f"{chamber} index has fewer rolls than the last good snapshot")
    old = {vote["roll"]: vote for vote in previous.get("rolls", [])}
    if checkpoint.exists():
        old.update({vote["roll"]: vote for vote in json.loads(checkpoint.read_text()).get("rolls", [])})
    refresh = set(listed[:args.recheck])
    missing = [roll for roll in listed if roll not in old or roll in refresh]
    errors = []
    completed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch_roll, chamber, args.congress, args.session, args.year, roll): roll for roll in missing}
        for future in as_completed(futures):
            try:
                old[futures[future]] = future.result()
                completed += 1
                if completed % 20 == 0:
                    write_atomically(checkpoint, {"rolls": list(old.values())}, compact=True)
            except Exception as error:
                errors.append(f"{chamber} roll {futures[future]}: {error}")
    write_atomically(checkpoint, {"rolls": list(old.values())}, compact=True)
    if errors:
        raise RuntimeError(f"{len(errors)} roll requests failed; checkpoint saved. First: {errors[0]}")
    votes = [old[roll] for roll in listed]
    if len(votes) != len(listed) or len({vote["roll"] for vote in votes}) != len(listed):
        raise ValueError(f"{chamber} snapshot does not match its official index")
    return {"generatedAt": utc_now(), "congress": args.congress, "session": args.session,
            "year": args.year, "chamber": chamber, "indexSources": index_sources,
            "rollCount": len(votes), "rolls": votes}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--congress", type=int, default=119)
    parser.add_argument("--session", type=int, default=2)
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--recheck", type=int, default=5)
    parser.add_argument("--workers", type=int, default=3)
    args = parser.parse_args()
    expected_year = 1789 + (args.congress - 1) * 2 + args.session - 1
    if args.year != expected_year or args.session not in (1, 2) or not 0 <= args.recheck <= 20 or not 1 <= args.workers <= 8:
        parser.error("Invalid Congress/session/year, recheck window, or worker count")
    result = {}
    for chamber in ("house", "senate"):
        path = args.output_dir / f"federal-votes-{chamber}.json"
        previous = json.loads(path.read_text()) if path.exists() else {}
        if previous and any(previous.get(key) != value for key, value in (("congress", args.congress), ("session", args.session), ("year", args.year), ("chamber", chamber))):
            previous = {}
        checkpoint = args.output_dir / f".federal-votes-{chamber}.checkpoint.json"
        snapshot = refresh_chamber(chamber, args, previous, checkpoint)
        write_atomically(path, snapshot, compact=True)
        checkpoint.unlink(missing_ok=True)
        result[chamber] = {"rolls": snapshot["rollCount"], "output": str(path)}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
