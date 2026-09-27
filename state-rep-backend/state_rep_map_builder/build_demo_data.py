"""Build the browser's district index and an auditable legislator match report.

The 2026 Census files describe the latest published districts. Michigan's
Senate and both chambers in Minnesota use their 2024 plans until legislators
elected on their newer plans take office. Mississippi held redistricting
special elections in 2025, so its newer plan is already represented. Revisit
this list when terms change; it is deliberately visible in the source code.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from collections import defaultdict
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

import yaml

from .config import GEOJSON_DIR, PROJECT_ROOT


STATE_INFO = {
    "01": ("AL", "Alabama"), "02": ("AK", "Alaska"),
    "04": ("AZ", "Arizona"), "05": ("AR", "Arkansas"),
    "06": ("CA", "California"), "08": ("CO", "Colorado"),
    "09": ("CT", "Connecticut"), "10": ("DE", "Delaware"),
    "12": ("FL", "Florida"), "13": ("GA", "Georgia"),
    "15": ("HI", "Hawaii"), "16": ("ID", "Idaho"),
    "17": ("IL", "Illinois"), "18": ("IN", "Indiana"),
    "19": ("IA", "Iowa"), "20": ("KS", "Kansas"),
    "21": ("KY", "Kentucky"), "22": ("LA", "Louisiana"),
    "23": ("ME", "Maine"), "24": ("MD", "Maryland"),
    "25": ("MA", "Massachusetts"), "26": ("MI", "Michigan"),
    "27": ("MN", "Minnesota"), "28": ("MS", "Mississippi"),
    "29": ("MO", "Missouri"), "30": ("MT", "Montana"),
    "31": ("NE", "Nebraska"), "32": ("NV", "Nevada"),
    "33": ("NH", "New Hampshire"), "34": ("NJ", "New Jersey"),
    "35": ("NM", "New Mexico"), "36": ("NY", "New York"),
    "37": ("NC", "North Carolina"), "38": ("ND", "North Dakota"),
    "39": ("OH", "Ohio"), "40": ("OK", "Oklahoma"),
    "41": ("OR", "Oregon"), "42": ("PA", "Pennsylvania"),
    "44": ("RI", "Rhode Island"), "45": ("SC", "South Carolina"),
    "46": ("SD", "South Dakota"), "47": ("TN", "Tennessee"),
    "48": ("TX", "Texas"), "49": ("UT", "Utah"),
    "50": ("VT", "Vermont"), "51": ("VA", "Virginia"),
    "53": ("WA", "Washington"), "54": ("WV", "West Virginia"),
    "55": ("WI", "Wisconsin"), "56": ("WY", "Wyoming"),
}

PRE_ELECTION_2024 = {
    ("MI", "upper"),
    ("MN", "upper"), ("MN", "lower"),
}

ORDINALS = {
    "first": "1", "second": "2", "third": "3", "fourth": "4", "fifth": "5",
    "sixth": "6", "seventh": "7", "eighth": "8", "ninth": "9", "tenth": "10",
}


def normalized_label(value: str) -> str:
    """Normalize Census names and legislative roster labels for exact comparison."""
    value = value.lower().replace("south east", "southeast")
    value = re.sub(r"\b(\d+)(?:st|nd|rd|th)\b", r"\1", value)
    for word, number in ORDINALS.items():
        value = re.sub(rf"\b{word}\b", number, value)
    value = re.sub(
        r"\b(state|house|senate|senatorial|legislative|district|subdistrict|and)\b", " ", value
    )
    value = re.sub(r"[^a-z0-9]+", " ", value)
    normalized = []
    for part in value.split():
        if part.isdigit():
            normalized.append(str(int(part)))
        elif re.fullmatch(r"\d+[a-z]", part):
            normalized.append(f"{int(part[:-1])}{part[-1]}")
        else:
            normalized.append(part)
    return " ".join(normalized)


def active_on(role: dict, as_of: date) -> bool:
    start, end = role.get("start_date"), role.get("end_date")
    return (not start or str(start) <= as_of.isoformat()) and (
        not end or str(end) >= as_of.isoformat()
    )


def official_profile(person: dict) -> str | None:
    urls = [entry.get("url", "") for entry in person.get("links", [])]
    urls += [entry.get("url", "") for entry in person.get("sources", [])]
    for url in urls:
        host = (urlparse(url).hostname or "").lower()
        if host.endswith(".gov") or host.endswith(".us"):
            return url
    return None


def current_party(person: dict, as_of: date, state: str) -> str | None:
    if state == "NE":  # Nebraska's legislature is officially nonpartisan.
        return None
    for party in reversed(person.get("party") or []):
        if active_on(party, as_of):
            return party.get("name")
    return None


def load_roster(people_root: Path, as_of: date) -> dict:
    roster = defaultdict(list)
    for file in sorted((people_root / "data").glob("*/legislature/*.yml")):
        state = file.parts[-3].upper()
        if state not in {info[0] for info in STATE_INFO.values()}:
            continue
        person = yaml.safe_load(file.read_text())
        profile = official_profile(person)
        for role in person.get("roles") or []:
            chamber = role.get("type")
            if state == "NE" and chamber == "legislature":
                chamber = "upper"
            if chamber not in ("upper", "lower") or not active_on(role, as_of):
                continue
            district = str(role.get("district", "")).strip()
            if not district:
                continue
            offices = person.get("offices") or person.get("contact_details") or []
            phone = next((o.get("voice") for o in offices if o.get("voice")), None)
            member = {
                "id": person["id"],
                "name": person["name"],
                "party": current_party(person, as_of, state),
                "email": person.get("email"),
                "phone": phone,
                "officialUrl": profile,
                "districtLabel": district,
                "verification": "official-link-listed" if profile else "needs-official-link",
            }
            key = (state, chamber, normalized_label(district))
            if not any(item["id"] == member["id"] for item in roster[key]):
                roster[key].append(member)
    return roster


def load_districts(gpkg: Path, geojson_root: Path) -> list[dict]:
    districts = []
    with sqlite3.connect(gpkg) as conn:
        for chamber, table, code_field in (
            ("upper", "State Legislative Districts - Upper", "SLDUST"),
            ("lower", "State Legislative Districts - Lower", "SLDLST"),
        ):
            query = f'SELECT STATEFP, {code_field}, GEOID, NAMELSAD FROM "{table}"'
            for fips, code, geoid, name in conn.execute(query):
                if fips not in STATE_INFO:
                    continue
                state, state_name = STATE_INFO[fips]
                if (state, chamber) in PRE_ELECTION_2024:
                    continue
                districts.append({
                    "state": state, "stateName": state_name, "chamber": chamber,
                    "code": code, "geoid": geoid, "name": name, "boundaryYear": 2026,
                })
    for state, chamber in sorted(PRE_ELECTION_2024):
        path = geojson_root / chamber / state / f"{state}_{chamber}.geojson"
        data = json.loads(path.read_text())
        for feature in data["features"]:
            props = feature["properties"]
            code = props["SLDUST" if chamber == "upper" else "SLDLST"]
            districts.append({
                "state": state,
                "stateName": next(name for abbr, name in STATE_INFO.values() if abbr == state),
                "chamber": chamber,
                "code": code,
                "geoid": props["GEOID"],
                "name": props["NAMELSAD"],
                "boundaryYear": 2024,
            })
    return sorted(districts, key=lambda d: (d["state"], d["chamber"], d["code"]))


def match_members(district: dict, roster: dict) -> tuple[list[dict], str]:
    state, chamber, code = district["state"], district["chamber"], district["code"]
    if code == "ZZZ":
        return [], "unassigned-area"
    candidate_keys = [normalized_label(code), normalized_label(district["name"])]
    if code.startswith("00") and code[-1].isalpha():
        candidate_keys.append(normalized_label(code[-1]))
    members = []
    for label in candidate_keys:
        members = roster.get((state, chamber, label), [])
        if members:
            return members, "exact"
    # Some states elect A/B or numbered subdistrict members from a Census
    # parent district. Keep this distinction visible in the UI.
    if code.isdigit():
        parent = str(int(code))
        for (member_state, member_chamber, label), group in roster.items():
            if member_state == state and member_chamber == chamber and re.fullmatch(
                rf"{re.escape(parent)}[a-z]", label
            ):
                members.extend(group)
        if members:
            return members, "parent-district"
    return [], "unmatched"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--census-gpkg", type=Path, required=True)
    parser.add_argument("--people-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--tile-metadata-root", type=Path,
        default=PROJECT_ROOT.parent / "state-rep-map-visualizationo" / "public" / "tiles",
    )
    parser.add_argument("--as-of", type=date.fromisoformat, default=date.today())
    args = parser.parse_args()

    roster = load_roster(args.people_root, args.as_of)
    districts = load_districts(args.census_gpkg, GEOJSON_DIR)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = defaultdict(list)
    per_state = defaultdict(list)
    match_counts = defaultdict(int)
    verification_counts = defaultdict(int)
    for district in districts:
        members, match_type = match_members(district, roster)
        district["members"] = members
        district["matchType"] = match_type
        match_counts[match_type] += 1
        for member in members:
            verification_counts[member["verification"]] += 1
        per_state[district["state"]].append(district)
        if match_type == "unmatched":
            report[district["state"]].append({
                "chamber": district["chamber"], "geoid": district["geoid"],
                "code": district["code"], "name": district["name"],
            })
    for state, records in per_state.items():
        (args.output_dir / f"{state}.json").write_text(json.dumps(records, separators=(",", ":")))
    state_list = []
    for fips, (state, name) in STATE_INFO.items():
        metadata_path = args.tile_metadata_root / "upper" / state / "metadata.json"
        if not metadata_path.exists():
            raise FileNotFoundError(f"Missing state bounds: {metadata_path}")
        metadata = json.loads(metadata_path.read_text())
        state_list.append({
            "code": state,
            "name": name,
            "fips": fips,
            "bounds": [float(value) for value in metadata["bounds"].split(",")],
            "upperDistricts": sum(d["chamber"] == "upper" for d in per_state[state]),
            "lowerDistricts": sum(d["chamber"] == "lower" for d in per_state[state]),
        })
    (args.output_dir / "states.json").write_text(json.dumps(state_list, indent=2))
    (args.output_dir / "manifest.json").write_text(json.dumps({
        "asOf": args.as_of.isoformat(),
        "states": sorted(per_state),
        "districts": len(districts),
        "matchedDistricts": sum(d["matchType"] in ("exact", "parent-district") for d in districts),
        "unmatchedDistricts": sum(len(items) for items in report.values()),
        "matchTypes": dict(sorted(match_counts.items())),
        "memberVerification": dict(sorted(verification_counts.items())),
    }, indent=2))
    (args.output_dir / "match-report.json").write_text(json.dumps(report, indent=2))
    print((args.output_dir / "manifest.json").read_text())


if __name__ == "__main__":
    main()
