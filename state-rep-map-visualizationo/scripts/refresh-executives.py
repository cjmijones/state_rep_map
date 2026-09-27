"""Refresh the 50-state governor and president snapshot from public directories.

Run: python scripts/refresh-executives.py
Requires only the Python standard library. The script fails before writing if any
state, official link, or president entry is missing.
"""

from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import Request, urlopen
from concurrent.futures import ThreadPoolExecutor
import html
import json
import re


ROOT = Path(__file__).resolve().parents[1]
STATES = json.loads((ROOT / "public/data/states.json").read_text())
NGA_API = "https://www.nga.org/wp-json/wp/v2/pages?slug=governors"
NGA_ROSTER = "https://www.nga.org/governors/"
USAGOV = "https://www.usa.gov/state-governor"
WHITE_HOUSE = "https://www.whitehouse.gov/administration/"


def fetch(url):
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; StatehouseAtlas/1.0)"})
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


class GovernorParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.records = {}
        self.item = None
        self.in_state = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = attrs.get("class", "").split()
        if tag == "li" and "current-governors__item" in classes:
            self.item = {}
        elif self.item is not None:
            if tag == "a" and "href" in attrs:
                self.item["ngaUrl"] = attrs["href"]
            elif tag == "img" and "alt" in attrs:
                self.item["name"] = attrs["alt"].strip()
            elif tag == "small" and "state" in classes:
                self.in_state = True

    def handle_data(self, data):
        if self.in_state and self.item is not None:
            self.item["stateName"] = data.strip()

    def handle_endtag(self, tag):
        if tag == "small":
            self.in_state = False
        elif tag == "li" and self.item is not None:
            if all(self.item.get(key) for key in ("stateName", "name", "ngaUrl")):
                self.records[self.item["stateName"]] = self.item
            self.item = None


class LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.official = {}
        self.president = None
        self.anchor = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag != "a":
            return
        if "url" in attrs.get("class", "").split() and attrs.get("id"):
            self.official[attrs["id"]] = attrs.get("href", "")
        self.anchor = {"url": attrs.get("href", ""), "text": ""}

    def handle_data(self, data):
        if self.anchor is not None:
            self.anchor["text"] += data

    def handle_endtag(self, tag):
        if tag == "a" and self.anchor is not None:
            label = html.unescape(self.anchor["text"]).strip()
            url = self.anchor["url"]
            if label.startswith("President ") and url.startswith("https://www.whitehouse.gov/administration/"):
                self.president = {"name": label.removeprefix("President "), "officialUrl": url}
            self.anchor = None


def main():
    pages = json.loads(fetch(NGA_API))
    if len(pages) != 1 or pages[0].get("slug") != "governors":
        raise ValueError("NGA governor directory response changed")
    roster = GovernorParser()
    roster.feed(pages[0]["content"]["rendered"])
    links = LinkParser()
    links.feed(fetch(USAGOV))
    administration = LinkParser()
    administration.feed(fetch(WHITE_HOUSE))

    governors = []
    for state in STATES:
        entry = roster.records.get(state["name"])
        official_url = links.official.get(state["code"])
        if not entry or not official_url or not official_url.startswith("https://"):
            raise ValueError(f"Missing governor or official state site for {state['name']}")
        governors.append({"state": state["code"], "stateName": state["name"], "fips": state["fips"],
                          "name": entry["name"], "ngaUrl": entry["ngaUrl"], "officialUrl": official_url})
    if len(governors) != 50 or len({item["state"] for item in governors}) != 50:
        raise ValueError("Expected exactly 50 distinct state governors")

    def add_party(governor):
        profile = fetch(governor["ngaUrl"])
        match = re.search(r'<label class="label">Party</label>\s*([^<]+)', profile)
        if not match:
            raise ValueError(f"Missing NGA party label for {governor['state']}")
        party = html.unescape(match.group(1)).strip()
        if party == "Democratic":
            party = "Democrat"
        if party not in ("Democrat", "Republican", "Independent"):
            raise ValueError(f"Unexpected NGA party label for {governor['state']}: {party}")
        governor["party"] = party
        return governor

    with ThreadPoolExecutor(max_workers=5) as pool:
        governors = list(pool.map(add_party, governors))
    if not administration.president:
        raise ValueError("White House president profile missing")
    president = administration.president
    president["contactUrl"] = "https://www.whitehouse.gov/contact/"
    snapshot = {"generatedAt": datetime.now(timezone.utc).isoformat(),
                "sources": {"governors": NGA_ROSTER, "officialSites": USAGOV, "president": WHITE_HOUSE},
                "governors": governors, "president": president}
    destination = ROOT / "public/data/executives.json"
    temporary = destination.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(destination)
    print(f"Wrote {len(governors)} governors and President {president['name']} to {destination}")


if __name__ == "__main__":
    main()
