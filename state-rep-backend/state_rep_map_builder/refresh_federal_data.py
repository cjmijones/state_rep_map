"""Refresh the 50-state Congress roster and recent official recorded votes.

Writes one atomic JSON snapshot for a local browser demo. The previous good
snapshot remains in place if any required source or validation step fails.
"""

from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from .probe_federal_sources import (
    HOUSE_ROOT, fetch, load_states, parse_house_vote, parse_senate_vote,
    senate_sources, text, utc_now, write_atomically,
)


HOUSE_ROSTER = "https://clerk.house.gov/xml/lists/MemberData.xml"
SENATE_ROSTER = "https://www.senate.gov/legislative/LIS_MEMBER/cvc_member_data.xml"
SENATE_CONTACT = "https://www.senate.gov/general/contact_information/senators_cfm.xml"


def party(code: str) -> str:
    return {"D": "Democratic", "R": "Republican", "I": "Independent"}.get(code, code or "Unknown")


def resource(url: str, resources: list[dict[str, Any]]) -> ET.Element:
    raw, metadata = fetch(url)
    resources.append(metadata)
    return ET.fromstring(raw)


def read_house(states: list[dict[str, Any]], geoids: list[str], resources: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str]:
    root = resource(HOUSE_ROSTER, resources)
    if root.tag != "MemberData":
        raise ValueError("House roster XML has an unexpected root")
    state_by_code = {state["code"]: state for state in states}
    state_by_fips = {state["fips"]: state for state in states}
    districts = {
        geoid: {
            "geoid": geoid,
            "state": state_by_fips[geoid[:2]]["code"], "stateName": state_by_fips[geoid[:2]]["name"],
            "code": geoid[2:], "name": "At-large district" if geoid[2:] == "00" else f"District {int(geoid[2:])}",
            "members": [],
        }
        for geoid in geoids
    }
    found_ids: set[str] = set()
    used_districts: set[str] = set()
    for node in root.findall("./members/member"):
        state_district = text(node, "statedistrict")
        code, number = state_district[:2], state_district[2:]
        if code not in state_by_code:
            continue
        if not re.fullmatch(r"\d{2}", number):
            raise ValueError(f"Invalid House district code: {state_district!r}")
        info = node.find("member-info")
        if info is None:
            raise ValueError(f"House member {state_district} has no details")
        member_id = text(info, "bioguideID")
        name = text(info, "official-name")
        geoid = state_by_code[code]["fips"] + number
        if geoid not in districts:
            raise ValueError(f"House member {state_district} has no matching 119th district shape")
        if geoid in used_districts:
            raise ValueError(f"Duplicate House roster district: {state_district}")
        used_districts.add(geoid)
        if not member_id and not name:
            districts[geoid]["vacancyNote"] = text(info, "footnote") or "Seat listed as vacant by the House Clerk."
            continue
        if not member_id or not name or member_id in found_ids:
            raise ValueError(f"Invalid or duplicate House member for {state_district}")
        found_ids.add(member_id)
        districts[geoid]["members"].append({
            "id": member_id, "name": name, "party": party(text(info, "party")),
            "phone": text(info, "phone"),
            "officialUrl": f"https://bioguide.congress.gov/search/bio/{member_id}",
        })
    if not 400 <= len(found_ids) <= 435:
        raise ValueError(f"Unexpected House member count: {len(found_ids)}")
    return sorted(districts.values(), key=lambda record: (record["stateName"], record["code"])), root.attrib.get("publish-date", "")


def read_senate(states: list[dict[str, Any]], resources: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str]:
    root = resource(SENATE_ROSTER, resources)
    contacts = resource(SENATE_CONTACT, resources)
    if root.tag != "senators" or contacts.tag != "contact_information":
        raise ValueError("Senate roster XML has an unexpected root")
    contact_by_id = {text(node, "bioguide_id"): node for node in contacts.findall("member")}
    state_by_code = {state["code"]: state for state in states}
    records = {
        state["fips"]: {"geoid": state["fips"], "state": state["code"], "stateName": state["name"],
                         "code": state["code"], "name": state["name"], "members": []}
        for state in states
    }
    found_ids: set[str] = set()
    found_lis_ids: set[str] = set()
    for node in root.findall("senator"):
        code = text(node, "state")
        if code not in state_by_code:
            continue
        member_id = text(node, "bioguideId")
        lis_id = node.attrib.get("lis_member_id", "")
        name = " ".join(part for part in (text(node, "name/first"), text(node, "name/last")) if part)
        contact = contact_by_id.get(member_id)
        if not member_id or not lis_id or not name or member_id in found_ids or lis_id in found_lis_ids or contact is None:
            raise ValueError(f"Invalid Senate member/contact join for {code}: {member_id}")
        found_ids.add(member_id)
        found_lis_ids.add(lis_id)
        records[state_by_code[code]["fips"]]["members"].append({
            "id": member_id, "lisId": lis_id, "name": name, "party": party(text(node, "party")),
            "phone": text(contact, "phone"), "officialUrl": text(contact, "website"),
            "seatClass": text(contact, "class"),
        })
    if not 95 <= len(found_ids) <= 100 or any(len(record["members"]) > 2 for record in records.values()):
        raise ValueError(f"Unexpected Senate member distribution: {len(found_ids)} members")
    for record in records.values():
        record["members"].sort(key=lambda member: member["seatClass"])
    return sorted(records.values(), key=lambda record: record["stateName"]), text(root, "lastUpdate/date")


def read_votes(chamber: str, args: argparse.Namespace, resources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if chamber == "senate":
        menu_url, base = senate_sources(args.congress, args.session)
        menu = resource(menu_url, resources)
        rolls = sorted({int(text(node, "vote_number")) for node in menu.findall("./votes/vote")}, reverse=True)
        urls = [(roll, f"{base}/vote_{args.congress}_{args.session}_{roll:05d}.xml") for roll in rolls[:args.vote_limit]]
    else:
        index_url = f"{HOUSE_ROOT}/{args.year}/index.asp"
        raw, metadata = fetch(index_url)
        resources.append(metadata)
        rolls = sorted({int(value) for value in re.findall(rb"rollnumber=(\d+)", raw, re.IGNORECASE)}, reverse=True)
        urls = [(roll, f"{HOUSE_ROOT}/{args.year}/roll{roll:03d}.xml") for roll in rolls[:args.vote_limit]]
    if not urls:
        raise ValueError(f"No {chamber} roll calls found")
    votes = []
    for roll, url in urls:
        raw, metadata = fetch(url)
        resources.append(metadata)
        parsed = parse_senate_vote(raw, args.congress, args.session, roll) if chamber == "senate" else parse_house_vote(raw, args.year, roll)
        votes.append({
            "roll": roll, "date": parsed["date"], "question": parsed["question"],
            "result": parsed["voteResult"], "document": parsed["document"],
            "description": parsed.get("description", ""), "voteType": parsed.get("voteType", ""),
            "sourceUrl": url,
            "positions": {member["id"]: member["vote"] for member in parsed["members"]},
        })
    return votes


def run(args: argparse.Namespace) -> dict[str, Any]:
    states = load_states()
    geography = json.loads(args.geography.read_text(encoding="utf-8"))
    house_geoids = geography["house"]
    if geography.get("congress") != args.congress or geography.get("boundaryYear") != 2025 or len(house_geoids) != 435 or len(geography["senate"]) != 50:
        raise ValueError("Federal geography manifest is missing or does not match the 119th Congress")
    resources: list[dict[str, Any]] = []
    house, house_as_of = read_house(states, house_geoids, resources)
    senate, senate_as_of = read_senate(states, resources)
    house_votes = read_votes("house", args, resources)
    senate_votes = read_votes("senate", args, resources)
    return {
        "generatedAt": utc_now(), "congress": args.congress, "session": args.session,
        "boundaryYear": 2025, "rosterAsOf": {"house": house_as_of, "senate": senate_as_of},
        "resources": resources, "house": house, "senate": senate,
        "votes": {"house": house_votes, "senate": senate_votes},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--geography", type=Path, required=True)
    parser.add_argument("--congress", type=int, default=119)
    parser.add_argument("--session", type=int, default=2)
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--vote-limit", type=int, default=10)
    args = parser.parse_args()
    if (args.congress, args.session, args.year) != (119, 2, 2026):
        parser.error("Current roster and boundary join is checked only for the 119th Congress, second session (2026)")
    if not 1 <= args.vote_limit <= 30:
        parser.error("vote-limit must be between 1 and 30")
    snapshot = run(args)
    write_atomically(args.output, snapshot)
    print(json.dumps({"output": str(args.output), "houseMembers": sum(len(item["members"]) for item in snapshot["house"]),
                      "senateMembers": sum(len(item["members"]) for item in snapshot["senate"]),
                      "recentVotes": {key: len(value) for key, value in snapshot["votes"].items()}}, indent=2))


if __name__ == "__main__":
    main()
