"""Create a 50-state, two-chamber source audit queue from roster profile links.

Profile domains are discovery leads, not proof of a vote or agenda feed. Only
the Washington pilot is marked as a working importer. A source-verified entry
has an inspected index and sample record but no map importer yet.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

from .probe_federal_sources import load_states, utc_now, write_atomically


KNOWN = {
    "WA": {"url": "https://wslwebservices.leg.wa.gov/", "notes": "Official XML member, bill roll-call, and committee meeting services; bounded pilot implemented."},
    "CA": {"url": "https://downloads.leginfo.legislature.ca.gov/", "notes": "Official bulk tables include bill detail votes and committee agendas; parser and current-session coverage still need validation."},
    "NY": {"url": "https://legislation.nysenate.gov/", "notes": "Official Senate API has bill votes and agendas; free API key needed. Assembly feed still needs review."},
    "ME": {"url": "https://legislature.maine.gov/", "notes": "House HTML roll-call index and member-level detail sample verified; member identity join, Senate votes, and agenda extraction still need validation."},
}


def run(data_dir: Path) -> dict:
    states = []
    for state in load_states():
        code = state["code"]
        districts = json.loads((data_dir / f"{code}.json").read_text())
        chambers = {}
        for chamber in ("upper", "lower"):
            if code == "NE" and chamber == "lower":
                continue
            profiles = [member.get("officialUrl") for district in districts if district["chamber"] == chamber for member in district["members"]]
            hosts = Counter(urlparse(url).hostname for url in profiles if url and urlparse(url).hostname)
            me_house = code == "ME" and chamber == "lower"
            chambers[chamber] = {
                "voteFeed": "pilot" if code == "WA" else "source-verified" if me_house else "unverified",
                "committeeAgendaFeed": "pilot" if code == "WA" else "unverified",
                "floorAgendaFeed": "unverified",
                "profileDomainLeads": [f"https://{host}/" for host, _ in hosts.most_common(4)],
                "sampleOfficialProfile": next((url for url in profiles if url), ""),
                "verifiedVoteIndexUrl": "https://wslwebservices.leg.wa.gov/legislationservice.asmx?op=GetRollCalls" if code == "WA" else "https://www.legislature.maine.gov/house/Documents/RollCalls" if me_house else "",
                "verifiedAgendaIndexUrl": "https://wslwebservices.leg.wa.gov/committeemeetingservice.asmx?op=GetCommitteeMeetings" if code == "WA" else "",
            }
            if code == "WA" or me_house:
                chambers[chamber]["verifiedVoteSampleUrl"] = (
                    "https://wslwebservices.leg.wa.gov/legislationservice.asmx/GetRollCalls?biennium=2025-26&billNumber=1217"
                    if code == "WA" else
                    "https://www.mainelegislature.org/LawMakerWeb/rollcall.asp?ID=280095676&chamber=H&serialnumber=1"
                )
        states.append({"code": code, "name": state["name"], "chambers": chambers,
                       "knownOfficialSource": KNOWN.get(code)})
    return {"generatedAt": utc_now(), "meaning": "Source discovery queue; source-verified means an index and member-level sample were inspected, while pilot means a working importer",
            "counts": {"states": len(states), "chambers": sum(1 if state["code"] == "NE" else 2 for state in states),
                       "pilotStates": 1}, "states": states}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    snapshot = run(args.data_dir)
    write_atomically(args.output, snapshot)
    print(json.dumps({"output": str(args.output), **snapshot["counts"]}, indent=2))


if __name__ == "__main__":
    main()
