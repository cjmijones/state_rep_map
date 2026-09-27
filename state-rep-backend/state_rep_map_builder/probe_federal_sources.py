"""Probe public federal roll-call and Census district sources.

This is a feasibility probe, not a production refresh job: each run fetches the
newest House and Senate rolls listed for the requested year/session. A House
roll can be pinned for a reproducible sample. It does not poll election results,
state sources, or polling data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


USER_AGENT = "StatehouseAtlasFederalSourceProbe/0.1 (public data feasibility check)"
SENATE_ROOT = "https://www.senate.gov/legislative/LIS/roll_call_votes"
HOUSE_ROOT = "https://clerk.house.gov/evs"
CENSUS_ROOT = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fetch(url: str, timeout: int = 30) -> tuple[bytes, dict[str, Any]]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    return raw, {"sourceURL": url, "fetchedAt": utc_now(), "sha256": hashlib.sha256(raw).hexdigest()}


def text(parent: ET.Element, name: str, default: str = "") -> str:
    node = parent.find(name)
    return (node.text or "").strip() if node is not None else default


def integer(value: str, label: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} is missing or not an integer: {value!r}") from error


def validate_members(members: list[dict[str, str]], source: str) -> None:
    ids = [member["id"] for member in members]
    if not members:
        raise ValueError(f"{source} returned no voting members")
    if any(not member_id for member_id in ids):
        raise ValueError(f"{source} has a member with an empty ID")
    if len(ids) != len(set(ids)):
        raise ValueError(f"{source} has duplicate member IDs")
    if any(not member["name"] for member in members):
        raise ValueError(f"{source} has a member with an empty name")


def parse_senate_vote(raw: bytes, congress: int, session: int, roll: int) -> dict[str, Any]:
    root = ET.fromstring(raw)
    if integer(text(root, "congress"), "Senate congress") != congress:
        raise ValueError("Senate detail congress does not match the requested Congress")
    if integer(text(root, "session"), "Senate session") != session:
        raise ValueError("Senate detail session does not match the requested session")
    if integer(text(root, "vote_number"), "Senate vote number") != roll:
        raise ValueError("Senate detail roll number does not match the requested roll")

    members = []
    for node in root.findall("./members/member"):
        full = text(node, "member_full")
        members.append({
            "id": text(node, "lis_member_id"),
            "name": text(node, "first_name") + (" " if text(node, "first_name") else "") + text(node, "last_name"),
            "displayName": full,
            "state": text(node, "state"),
            "vote": text(node, "vote_cast"),
        })
    validate_members(members, "Senate roll call")

    counts = root.find("count")
    declared_total = None
    if counts is not None:
        labels = ("yeas", "nays", "present", "absent")
        values = [integer(text(counts, label, "0") or "0", f"Senate {label} tally") for label in labels]
        declared_total = sum(values)
        if declared_total and declared_total != len(members):
            raise ValueError(f"Senate tally declares {declared_total} members but lists {len(members)}")

    return {
        "congress": congress,
        "session": session,
        "roll": roll,
        "date": text(root, "vote_date"),
        "question": text(root, "vote_question_text"),
        "voteResult": text(root, "vote_result_text") or text(root, "vote_result"),
        "document": text(root, "vote_title"),
        "memberCount": len(members),
        "declaredTallyTotal": declared_total,
        "members": members,
    }


def parse_house_vote(raw: bytes, year: int, roll: int) -> dict[str, Any]:
    root = ET.fromstring(raw)
    metadata = root.find("vote-metadata")
    if metadata is None:
        raise ValueError("House roll call has no vote-metadata")
    found_roll = integer(text(metadata, "rollcall-num"), "House roll number")
    if found_roll != roll:
        raise ValueError(f"House detail roll {found_roll} does not match requested roll {roll}")
    congress = integer(text(metadata, "congress"), "House congress")
    session_text = text(metadata, "session")
    session = integer("".join(character for character in session_text if character.isdigit()), "House session")
    expected_year = 1789 + (congress - 1) * 2 + session - 1
    if expected_year != year:
        raise ValueError(f"House roll belongs to {expected_year}, not requested {year}")

    members = []
    for record in root.findall("./vote-data/recorded-vote"):
        legislator = record.find("legislator")
        vote = text(record, "vote")
        if legislator is None:
            members.append({"id": "", "name": "", "state": "", "vote": vote})
            continue
        members.append({
            "id": legislator.attrib.get("name-id", "").strip(),
            "name": "".join(legislator.itertext()).strip(),
            "state": legislator.attrib.get("state", "").strip(),
            "party": legislator.attrib.get("party", "").strip(),
            "vote": vote,
        })
    validate_members(members, "House roll call")

    totals = root.find("./vote-metadata/vote-totals/totals-by-vote")
    declared_total = None
    if totals is not None:
        labels = ("yea-total", "nay-total", "present-total", "not-voting-total")
        values = [integer(text(totals, label, "0") or "0", f"House {label}") for label in labels]
        declared_total = sum(values)
        if declared_total and declared_total != len(members):
            raise ValueError(f"House tally declares {declared_total} members but lists {len(members)}")

    return {
        "congress": congress,
        "session": session,
        "year": year,
        "roll": roll,
        "date": text(metadata, "action-date"),
        "question": text(metadata, "vote-question"),
        "voteResult": text(metadata, "vote-result"),
        "voteType": text(metadata, "vote-type"),
        "document": text(metadata, "legis-num"),
        "description": text(metadata, "vote-desc"),
        "memberCount": len(members),
        "declaredTallyTotal": declared_total,
        "members": members,
    }


def senate_sources(congress: int, session: int) -> tuple[str, str]:
    base = f"{SENATE_ROOT}/vote{congress}{session}"
    menu = f"https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_{congress}_{session}.xml"
    return menu, base


def census_status(
    congress: int,
    states: list[dict[str, Any]],
    status: dict[str, Any],
) -> dict[str, Any]:
    base_url = f"{CENSUS_ROOT}?{urllib.parse.urlencode({'f': 'pjson'})}"
    raw, metadata = fetch(base_url)
    status["resources"].append(metadata)
    service = json.loads(raw)
    expected_name = f"{congress}th Congressional Districts"
    layers = service.get("layers", [])
    groups = {layer.get("id"): layer.get("name", "") for layer in layers}
    matches = [layer for layer in layers if layer.get("name") == expected_name]
    bas_matches = [layer for layer in matches if str(groups.get(layer.get("parentLayerId"), "")).startswith("BAS ")]
    if len(bas_matches) != 1:
        raise ValueError(f"Census service has {len(bas_matches)} BAS layers named {expected_name!r} among {len(matches)} matches")
    layer = bas_matches[0]
    parent_name = groups[layer["parentLayerId"]]
    layer_url = f"{CENSUS_ROOT}/{int(layer['id'])}?{urllib.parse.urlencode({'f': 'pjson'})}"
    layer_raw, layer_metadata = fetch(layer_url)
    status["resources"].append(layer_metadata)
    layer_info = json.loads(layer_raw)
    fields = layer_info.get("fields", [])
    field_by_name = {str(field.get("name", "")).upper(): field for field in fields}
    state_field = next((field_by_name[name] for name in ("STATEFP", "STATE", "STATE_FIPS", "STATEFP20") if name in field_by_name), None)
    if state_field is None:
        raise ValueError("Census congressional layer exposes no recognizable state FIPS field")
    state_field_name = state_field["name"]
    district_field_name = f"CD{congress}"
    if district_field_name not in field_by_name:
        raise ValueError(f"Census layer is missing the expected district code {district_field_name}")
    state_codes = [str(state["fips"]) for state in states]
    quoted = str(state_field.get("type", "")).lower().endswith("string")
    values = ",".join(f"'{code}'" if quoted else code for code in state_codes)
    where = f"{state_field_name} IN ({values})"
    query_url = f"{CENSUS_ROOT}/{int(layer['id'])}/query?{urllib.parse.urlencode({'where': where, 'returnCountOnly': 'true', 'returnGeometry': 'false', 'f': 'json'})}"
    count_raw, count_metadata = fetch(query_url)
    status["resources"].append(count_metadata)
    count_result = json.loads(count_raw)
    if "count" not in count_result:
        raise ValueError(f"Census count response has no count: {count_result.get('error', count_result)!r}")
    count = integer(str(count_result["count"]), "Census congressional feature count")
    if count <= 0:
        raise ValueError("Census congressional district query returned no features for the 50 states")
    represented_where = f"{where} AND {district_field_name} <> 'ZZ'"
    represented_url = f"{CENSUS_ROOT}/{int(layer['id'])}/query?{urllib.parse.urlencode({'where': represented_where, 'returnCountOnly': 'true', 'returnGeometry': 'false', 'f': 'json'})}"
    represented_raw, represented_metadata = fetch(represented_url)
    status["resources"].append(represented_metadata)
    represented_result = json.loads(represented_raw)
    if "count" not in represented_result:
        raise ValueError(f"Census represented district response has no count: {represented_result.get('error', represented_result)!r}")
    represented = integer(str(represented_result["count"]), "Census represented district count")
    if not 0 < represented <= count:
        raise ValueError(f"Census represented district count {represented} is outside 1..{count}")
    status.update({
        "status": "ok",
        "layer": {"id": layer["id"], "name": layer["name"], "group": parent_name},
        "stateFilterField": state_field_name,
        "stateCount": len(state_codes),
        "districtFeatureCount": count,
        "representedDistrictCount": represented,
        "unassignedAreaCount": count - represented,
    })
    return status


def load_states() -> list[dict[str, Any]]:
    frontend = Path(__file__).resolve().parents[2] / "state-rep-map-visualizationo"
    path = frontend / "public" / "data" / "states.json"
    states = json.loads(path.read_text(encoding="utf-8"))
    if len(states) != 50:
        raise ValueError(f"Expected 50 state entries in {path}, found {len(states)}")
    return states


def run(args: argparse.Namespace) -> tuple[dict[str, Any], bool]:
    report: dict[str, Any] = {
        "probe": "federal-source-feasibility",
        "createdAt": utc_now(),
        "senate": {"status": "failed", "resources": []},
        "house": {"status": "failed", "resources": []},
        "census": {"status": "failed", "resources": []},
        "failures": [],
    }

    try:
        menu_url, senate_base = senate_sources(args.congress, args.session)
        menu_raw, menu_metadata = fetch(menu_url)
        report["senate"]["resources"].append(menu_metadata)
        menu = ET.fromstring(menu_raw)
        available = [integer(text(node, "vote_number"), "Senate menu vote number") for node in menu.findall("./votes/vote")]
        if not available:
            raise ValueError("Senate vote menu contains no vote numbers")
        roll = max(available)
        detail_url = f"{senate_base}/vote_{args.congress}_{args.session}_{roll:05d}.xml"
        vote_raw, vote_metadata = fetch(detail_url)
        report["senate"]["resources"].append(vote_metadata)
        report["senate"].update({"status": "ok", "vote": parse_senate_vote(vote_raw, args.congress, args.session, roll)})
    except Exception as error:  # Keep probing other public sources after one source fails.
        report["failures"].append({"source": "senate", "error": str(error)})

    try:
        house_roll = args.house_roll
        if house_roll is None:
            index_url = f"{HOUSE_ROOT}/{args.year}/index.asp"
            index_raw, index_metadata = fetch(index_url)
            report["house"]["resources"].append(index_metadata)
            available = [int(value) for value in re.findall(rb"rollnumber=(\d+)", index_raw, re.IGNORECASE)]
            if not available:
                raise ValueError("House index contains no roll-call numbers")
            house_roll = max(available)
        house_url = f"{HOUSE_ROOT}/{args.year}/roll{house_roll:03d}.xml"
        house_raw, house_metadata = fetch(house_url)
        report["house"]["resources"].append(house_metadata)
        report["house"].update({
            "status": "ok",
            "sampleLabel": "pinned roll; not necessarily latest" if args.house_roll is not None else "latest listed roll at refresh time",
            "vote": parse_house_vote(house_raw, args.year, house_roll),
        })
    except Exception as error:
        report["failures"].append({"source": "house", "error": str(error)})

    try:
        census_status(args.congress, load_states(), report["census"])
    except Exception as error:
        report["failures"].append({"source": "census", "error": str(error)})

    return report, not report["failures"]


def write_atomically(path: Path, data: dict[str, Any], *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False)
    temporary = Path(handle.name)
    try:
        with handle:
            if compact:
                json.dump(data, handle, separators=(",", ":"), ensure_ascii=False)
            else:
                json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--congress", type=int, default=119)
    parser.add_argument("--session", type=int, default=2)
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--house-roll", type=int, help="Pin a House roll for a reproducible sample; default is latest listed")
    args = parser.parse_args()
    if min(args.congress, args.session, args.year) <= 0 or (args.house_roll is not None and args.house_roll <= 0):
        parser.error("congress, session, year, and house-roll must be positive integers")
    return args


def main() -> int:
    args = parse_args()
    report, success = run(args)
    if success:
        write_atomically(args.output, report)
        print(json.dumps({"status": "ok", "output": str(args.output), "sources": {name: report[name]["status"] for name in ("senate", "house", "census")}}, indent=2))
        return 0
    if not args.output.exists():
        write_atomically(args.output, report)
        output_note = f"Failure report written to {args.output}; sources with errors are reported separately."
    else:
        output_note = f"Existing output left untouched after failure: {args.output}"
    print(json.dumps(report, indent=2, ensure_ascii=False))
    print(output_note, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
