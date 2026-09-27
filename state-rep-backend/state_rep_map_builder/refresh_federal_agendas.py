"""Refresh official federal floor and committee notices for the map sidebar."""

from __future__ import annotations

import argparse
import html
import json
import re
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin

from .probe_federal_sources import fetch, text, utc_now, write_atomically


HOUSE_FLOOR = "https://docs.house.gov/floor/"
HOUSE_COMMITTEE = "https://docs.house.gov/Committee/Calendar/ByWeek.aspx"
SENATE_FLOOR = "https://www.senate.gov/legislative/schedule/floor_schedule.xml"
SENATE_COMMITTEE = "https://www.senate.gov/general/committee_schedules/hearings.xml"


class PlainText(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def clean_markup(value: str) -> str:
    parser = PlainText()
    parser.feed(value)
    return re.sub(r"\s+", " ", html.unescape(" ".join(parser.parts))).strip()


def house_floor(resources: list[dict]) -> list[dict]:
    raw, source = fetch(HOUSE_FLOOR)
    resources.append(source)
    page = raw.decode("utf-8", "replace")
    links = re.findall(r'href=["\']([^"\']*Download\.aspx\?file=[^"\']+\.xml[^"\']*)', page, re.I)
    weekly = [urljoin(HOUSE_FLOOR, html.unescape(link)) for link in links if "billsthisweek" in link.lower()]
    if not weekly:
        raise ValueError("House floor page has no weekly XML link")
    url = weekly[0]
    data, source = fetch(url)
    resources.append(source)
    root = ET.fromstring(data)
    if root.tag != "floorschedule":
        raise ValueError("Unexpected House floor agenda XML")
    week = root.attrib.get("week-date", "")
    updated = root.attrib.get("update-date", "")
    rows = []
    for category in root.findall("category"):
        label = category.attrib.get("type", "")
        for node in category.findall("./floor-items/floor-item"):
            if node.attrib.get("remove-date"):
                continue
            document = text(node, "legis-num")
            title = re.sub(r"\s+", " ", text(node, "floor-text") or document).strip()
            if not title:
                continue
            rows.append({"id": f"house-floor-{week}-{node.attrib.get('id', document)}", "chamber": "house",
                         "kind": "floor", "date": week, "time": "", "title": title, "document": document,
                         "status": label or "May be considered", "updatedAt": node.attrib.get("publish-date") or updated,
                         "sourceUrl": url})
    return rows


def senate_floor(resources: list[dict]) -> list[dict]:
    raw, source = fetch(SENATE_FLOOR)
    resources.append(source)
    root = ET.fromstring(raw)
    if root.tag != "CongressSessionDayConvenings":
        raise ValueError("Unexpected Senate floor schedule XML")
    latest = root.find("LegislativeDay[last()]/SessionDay")
    if latest is None:
        raise ValueError("Senate floor schedule has no session day")
    next_date = text(latest, "NextConveneDate")
    if not next_date:
        return []
    return [{"id": f"senate-floor-{next_date}", "chamber": "senate", "kind": "floor",
             "date": next_date[:10], "time": next_date, "title": "Senate next convenes",
             "document": "", "status": "Scheduled convening; business may change",
             "updatedAt": text(latest, "LastUpdateDate"), "sourceUrl": SENATE_FLOOR}]


def senate_committee(resources: list[dict]) -> list[dict]:
    raw, source = fetch(SENATE_COMMITTEE)
    resources.append(source)
    root = ET.fromstring(raw)
    if root.tag != "css_meetings_scheduled":
        raise ValueError("Unexpected Senate committee schedule XML")
    rows = []
    for node in root.findall("meeting"):
        meeting_id = text(node, "identifier")
        day = text(node, "date_iso_8601")
        if not meeting_id or not day:
            continue
        rows.append({"id": f"senate-committee-{meeting_id}", "chamber": "senate", "kind": "committee",
                     "date": day, "time": text(node, "time_iso_8601") or text(node, "time"),
                     "title": text(node, "matter") or text(node, "type"), "document": text(node, "committee"),
                     "status": text(node, "type"), "updatedAt": text(node, "last_update_iso_8601"),
                     "sourceUrl": "https://www.senate.gov/committees/hearings_meetings.htm",
                     "room": text(node, "room")})
    return rows


def house_committee(resources: list[dict], today: date) -> list[dict]:
    rows = []
    for offset in (0, 7):
        sunday = today - timedelta(days=(today.weekday() + 1) % 7) + timedelta(days=offset)
        saturday = sunday + timedelta(days=6)
        url = f"{HOUSE_COMMITTEE}?WeekOf={sunday:%m%d%Y}_{saturday:%m%d%Y}"
        raw, source = fetch(url)
        resources.append(source)
        page = raw.decode("utf-8", "replace")
        ids = set(re.findall(r"ByEvent\.aspx\?EventID=(\d+)", page, re.I))
        for event_id in sorted(ids):
            detail_url = f"https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID={event_id}"
            detail, source = fetch(detail_url)
            resources.append(source)
            content = detail.decode("utf-8", "replace")
            panel = content.split('id="previewPanel"', 1)[-1]
            heading = re.search(r"<h1[^>]*>(.*?)</h1>", panel, re.I | re.S)
            when = re.search(r'class="meetingTime"[^>]*>(.*?)</p>', panel, re.I | re.S)
            if not heading or not when:
                raise ValueError(f"House committee event {event_id} has no title or date")
            title = clean_markup(re.split(r"<small\b", heading.group(1), flags=re.I)[0])
            committee = re.search(r"<small[^>]*>.*?<p>(.*?)</p>", heading.group(1), re.I | re.S)
            when_text = clean_markup(when.group(1))
            day = datetime.strptime(when_text.split(" (", 1)[0], "%A, %B %d, %Y").date().isoformat()
            status = re.search(r'class="status-alert"[^>]*>(.*?)</strong>', panel, re.I | re.S)
            updated = re.search(r"Last Updated:\s*(.*?)</p>", panel, re.I | re.S)
            rows.append({"id": f"house-committee-{event_id}", "chamber": "house", "kind": "committee",
                         "date": day, "time": when_text.split("(")[-1].rstrip(")") if "(" in when_text else "",
                         "title": title, "document": clean_markup(committee.group(1)) if committee else "House committee",
                         "status": clean_markup(status.group(1)) if status else "Scheduled",
                         "updatedAt": clean_markup(updated.group(1)) if updated else "", "sourceUrl": detail_url})
    return list({row["id"]: row for row in rows}.values())


def run(output: Path) -> dict:
    previous = json.loads(output.read_text()) if output.exists() else {}
    resources: list[dict] = []
    today = date.today()
    items = house_floor(resources) + senate_floor(resources) + senate_committee(resources) + house_committee(resources, today)
    old = {item["id"]: item for item in previous.get("items", [])}
    changes = [{"id": item["id"], "change": "added" if item["id"] not in old else "updated"}
               for item in items if old.get(item["id"]) != item]
    changes.extend({"id": key, "change": "removed"} for key in old.keys() - {item["id"] for item in items})
    return {"generatedAt": utc_now(), "coverage": {"house": ["floor", "committee"],
            "senate": ["floor convening", "committee"]}, "resources": resources,
            "items": sorted(items, key=lambda item: (item["date"], item["chamber"], item["kind"])),
            "changes": changes}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.output)
    write_atomically(args.output, result)
    print(json.dumps({"output": str(args.output), "items": len(result["items"]), "changes": len(result["changes"])}, indent=2))


if __name__ == "__main__":
    main()
