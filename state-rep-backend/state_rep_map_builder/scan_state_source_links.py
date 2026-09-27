"""Scan official-profile domains for vote and agenda discovery links.

This is a breadth-first discovery pass, not feed verification. Each candidate
still needs a sample record, identifier, session, and chamber coverage check.
"""

from __future__ import annotations

import argparse
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

from .probe_federal_sources import fetch, utc_now, write_atomically


PATTERNS = {
    "votes": re.compile(r"\b(roll.?calls?|votes?|voting records?|journal)\b", re.I),
    "agenda": re.compile(r"\b(agendas?|calendars?|schedules?|hearings?|meetings?)\b", re.I),
}


class Links(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.href = ""
        self.words: list[str] = []
        self.links: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            self.href = dict(attrs).get("href") or ""
            self.words = []

    def handle_data(self, data: str) -> None:
        if self.href:
            self.words.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self.href:
            self.links.append((self.href, re.sub(r"\s+", " ", " ".join(self.words)).strip()))
            self.href = ""


def scan(url: str) -> dict:
    try:
        raw, source = fetch(url, timeout=18)
        page = Links()
        page.feed(raw[:800_000].decode("utf-8", "replace"))
        candidates: dict[str, list[dict]] = {"votes": [], "agenda": []}
        seen = set()
        for href, label in page.links:
            target = urljoin(url, href)
            if not target.startswith("https://") and not target.startswith("http://"):
                continue
            if target in seen:
                continue
            seen.add(target)
            haystack = f"{label} {urlparse(target).path.replace('-', ' ')}"
            for kind, pattern in PATTERNS.items():
                if pattern.search(haystack) and len(candidates[kind]) < 8:
                    candidates[kind].append({"url": target, "label": label[:120]})
        return {"status": "fetched", "source": source, "candidates": candidates}
    except Exception as error:
        return {"status": "fetch-failed", "error": f"{type(error).__name__}: {error}",
                "candidates": {"votes": [], "agenda": []}}


def run(inventory: dict, max_hosts: int, workers: int) -> dict:
    urls = {url for state in inventory["states"] for chamber in state["chambers"].values()
            for url in chamber["profileDomainLeads"][:max_hosts]}
    results = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(scan, url): url for url in urls}
        for future in as_completed(futures):
            results[futures[future]] = future.result()
    by_state = []
    for state in inventory["states"]:
        chambers = {}
        for chamber, info in state["chambers"].items():
            inspected = info["profileDomainLeads"][:max_hosts]
            chambers[chamber] = {"inspectedRoots": inspected,
                                 "voteCandidates": [candidate for url in inspected for candidate in results[url]["candidates"]["votes"]],
                                 "agendaCandidates": [candidate for url in inspected for candidate in results[url]["candidates"]["agenda"]]}
        by_state.append({"code": state["code"], "chambers": chambers})
    return {"generatedAt": utc_now(), "status": "candidate-discovery-only",
            "meaning": "Homepage links from official-profile domains; no vote or agenda feed has been verified by this scan",
            "inspectedRootCount": len(urls), "fetchedRootCount": sum(row["status"] == "fetched" for row in results.values()),
            "roots": results, "states": by_state}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-hosts-per-chamber", type=int, default=2)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    if not 1 <= args.max_hosts_per_chamber <= 4 or not 1 <= args.workers <= 8:
        parser.error("Host and worker limits are out of range")
    result = run(json.loads(args.inventory.read_text()), args.max_hosts_per_chamber, args.workers)
    write_atomically(args.output, result)
    print(json.dumps({"output": str(args.output), "inspectedRoots": result["inspectedRootCount"],
                      "fetchedRoots": result["fetchedRootCount"]}, indent=2))


if __name__ == "__main__":
    main()
