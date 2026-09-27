"""Build a bounded Washington legislative vote and committee agenda pilot.

The bill sample comes from bills the legislature reports as passed in the
specified date window. This is not a complete roll-call archive.
"""

from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlencode

from .probe_federal_sources import fetch, utc_now, write_atomically


ROOT = "https://wslwebservices.leg.wa.gov"
NS = {"w": "http://WSLWebServices.leg.wa.gov/"}


def field(node: ET.Element, name: str) -> str:
    return (node.findtext(f"w:{name}", default="", namespaces=NS) or "").strip()


def request(service: str, operation: str, **params: str) -> tuple[ET.Element, dict]:
    url = f"{ROOT}/{service}.asmx/{operation}?{urlencode(params)}"
    raw, source = fetch(url, timeout=60)
    return ET.fromstring(raw), source


def member_crosswalk(roster: Path, biennium: str) -> tuple[dict[str, str], dict]:
    root, source = request("sponsorservice", "GetSponsors", biennium=biennium)
    if not root.tag.endswith("ArrayOfMember"):
        raise ValueError("Unexpected Washington sponsor response")
    official: dict[tuple[str, str, int], set[str]] = {}
    for node in root.findall("w:Member", NS):
        if not field(node, "Name") or not field(node, "District"):
            continue
        key = (field(node, "Name").casefold(), "upper" if field(node, "Agency") == "Senate" else "lower", int(field(node, "District")))
        official.setdefault(key, set()).add(field(node, "Id"))
    matches: dict[str, str] = {}
    unmatched = []
    for district in json.loads(roster.read_text()):
        chamber = district["chamber"]
        number = int(district["code"])
        for member in district["members"]:
            ids = official.get((member["name"].casefold(), chamber, number), set())
            if len(ids) == 1:
                matches[member["id"]] = next(iter(ids))
            else:
                unmatched.append({"id": member["id"], "name": member["name"], "chamber": chamber, "district": number})
    return matches, {"source": source, "matched": len(matches), "unmatched": unmatched}


def selected_bills(biennium: str, begin: str, end: str, per_chamber: int) -> tuple[list[tuple[str, str]], dict]:
    root, source = request("legislationservice", "GetLegislationPassedLegislatureWithinTimeFrame", beginDate=begin, endDate=end)
    if not root.tag.endswith("ArrayOfLegislationInfo"):
        raise ValueError("Unexpected Washington passed-legislation response")
    by_chamber: dict[str, dict[str, str]] = {"House": {}, "Senate": {}}
    for node in root.findall("w:LegislationInfo", NS):
        agency, number = field(node, "OriginalAgency"), field(node, "BillNumber")
        bill = field(node, "BillId")
        if agency in by_chamber and field(node, "Biennium") == biennium and re.match(r"^[A-Z0-9]*[HS]B\s+\d+", bill) and number.isdigit():
            by_chamber[agency][number] = bill
    selected = [(number, bill) for agency in ("House", "Senate")
                for number, bill in sorted(by_chamber[agency].items(), key=lambda item: int(item[0]), reverse=True)[:per_chamber]]
    if not selected:
        raise ValueError("No Washington House or Senate bills were returned for the pilot window")
    return selected, source


def bill_rolls(number: str, biennium: str) -> tuple[list[dict], dict]:
    root, source = request("legislationservice", "GetRollCalls", biennium=biennium, billNumber=number)
    if not root.tag.endswith("ArrayOfRollCall"):
        raise ValueError(f"Unexpected Washington roll-call response for bill {number}")
    rows = []
    for node in root.findall("w:RollCall", NS):
        chamber = "upper" if field(node, "Agency") == "Senate" else "lower"
        positions = {}
        for vote in node.findall("./w:Votes/w:Vote", NS):
            member_id = field(vote, "MemberId")
            if member_id:
                if member_id in positions:
                    raise ValueError(f"Washington roll for bill {number} repeats member {member_id}")
                positions[member_id] = field(vote, "VOte") or field(vote, "Vote")
        if not positions:
            raise ValueError(f"Washington roll for bill {number} has no individual positions")
        declared = sum(int(node.findtext(f"w:{label}/w:Count", default="0", namespaces=NS) or "0")
                       for label in ("YeaVotes", "NayVotes", "AbsentVotes", "ExcusedVotes"))
        if declared and declared != len(positions):
            raise ValueError(f"Washington roll for bill {number} declares {declared} votes but lists {len(positions)}")
        rows.append({"id": f"{biennium}-{chamber}-{number}-{field(node, 'SequenceNumber')}",
                     "chamber": chamber, "bill": field(node, "BillId"), "billNumber": number,
                     "date": field(node, "VoteDate")[:10], "motion": field(node, "Motion"),
                     "sequence": field(node, "SequenceNumber"), "positions": positions,
                     "sourceUrl": source["sourceURL"]})
    return rows, source


def committee_agendas(begin: str, end: str) -> tuple[list[dict], list[dict]]:
    root, source = request("committeemeetingservice", "GetCommitteeMeetings", beginDate=begin, endDate=end)
    if not root.tag.endswith("ArrayOfCommitteeMeeting"):
        raise ValueError("Unexpected Washington committee-meeting response")
    rows = []
    resources = [source]
    meetings = root.findall("w:CommitteeMeeting", NS)
    def get_items(node: ET.Element) -> tuple[list[str], dict]:
        agenda_id = field(node, "AgendaId")
        details, details_source = request("committeemeetingservice", "GetCommitteeMeetingItems", agendaId=agenda_id)
        if not details.tag.endswith("ArrayOfCommitteeMeetingItem"):
            raise ValueError(f"Unexpected Washington agenda items for {agenda_id}")
        items = [field(item, "ItemDescription") or field(item, "BillId") for item in details.findall("w:CommitteeMeetingItem", NS)]
        return [item for item in items if item], details_source
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(get_items, node): node for node in meetings}
        for future in as_completed(futures):
            node = futures[future]
            items, item_source = future.result()
            resources.append(item_source)
            agency = field(node, "Agency")
            committees = [field(item, "Name") for item in node.findall("./w:Committees/w:Committee", NS)]
            rows.append({"id": field(node, "AgendaId"), "chamber": "upper" if agency == "Senate" else "lower",
                         "committee": ", ".join(name for name in committees if name),
                         "date": field(node, "Date"), "room": field(node, "Room"),
                         "status": "Cancelled" if field(node, "Cancelled") == "true" else "Scheduled",
                         "revisedAt": field(node, "RevisedDate") if not field(node, "RevisedDate").startswith("0001-") else "",
                         "items": items, "sourceUrl": item_source["sourceURL"]})
    return sorted(rows, key=lambda row: row["date"]), resources


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--roster", type=Path, required=True)
    parser.add_argument("--biennium", default="2025-26")
    parser.add_argument("--bill-begin", default="2026-01-12")
    parser.add_argument("--bill-end", default="2026-03-31")
    parser.add_argument("--agenda-begin", default="2026-03-02")
    parser.add_argument("--agenda-end", default="2026-03-08")
    parser.add_argument("--bills-per-chamber", type=int, default=30)
    args = parser.parse_args()
    if not 1 <= args.bills_per_chamber <= 100:
        parser.error("bills-per-chamber must be between 1 and 100")
    crosswalk, crosswalk_info = member_crosswalk(args.roster, args.biennium)
    bills, bill_source = selected_bills(args.biennium, args.bill_begin, args.bill_end, args.bills_per_chamber)
    rolls = []
    roll_sources = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(bill_rolls, number, args.biennium): number for number, _ in bills}
        for future in as_completed(futures):
            bill_rows, source = future.result()
            rolls.extend(bill_rows)
            roll_sources.append(source)
    meetings, meeting_sources = committee_agendas(args.agenda_begin, args.agenda_end)
    snapshot = {"generatedAt": utc_now(), "state": "WA", "biennium": args.biennium,
                "coverage": {"description": "Bounded official Washington pilot; not a complete vote archive",
                             "billSelection": "Highest-numbered House and Senate bills from the official passed-legislature query, up to the requested limit per chamber",
                             "billPassageDateRange": [args.bill_begin, args.bill_end],
                             "agendaDateRange": [args.agenda_begin, args.agenda_end],
                             "selectedBills": [bill for _, bill in bills]},
                "memberCrosswalk": crosswalk, "crosswalkStatus": crosswalk_info,
                "billSource": bill_source, "rollSources": sorted(roll_sources, key=lambda item: item["sourceURL"]),
                "agendaSources": meeting_sources,
                "rolls": sorted(rolls, key=lambda row: (row["date"], row["sequence"]), reverse=True),
                "meetings": meetings}
    write_atomically(args.output, snapshot, compact=True)
    print(json.dumps({"output": str(args.output), "matchedMembers": len(crosswalk),
                      "selectedBills": len(bills), "rolls": len(rolls), "meetings": len(meetings)}, indent=2))


if __name__ == "__main__":
    main()
