"""Build 50-state congressional and Senate-state PMTiles from Census files.

The 119th Congressional District file is the current representation plan for
this snapshot. Pass a different Congress and boundary year when those seats
take office; do not silently substitute an upcoming election plan.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import urllib.request
from pathlib import Path

from .probe_federal_sources import load_states, write_atomically


ROOT = "https://www2.census.gov/geo/tiger"


def download(url: str, destination: Path) -> None:
    with urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": "StatehouseAtlas/0.1"}),
        timeout=90,
    ) as response, destination.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)


def build(kind: str, source: Path, output_dir: Path, states: list[dict], work: Path) -> list[str]:
    source_path = work / f"{kind}.geojsonl"
    fips = ",".join(repr(state["fips"]) for state in states)
    where = f"STATEFP IN ({fips})"
    if kind == "federal-house":
        where += " AND CD119FP <> 'ZZ'"
        fields = "STATEFP,CD119FP,GEOID,NAMELSAD"
        expected = 435
    else:
        fields = "STATEFP,GEOID,NAME,STUSPS"
        expected = 50
    subprocess.run([
        "ogr2ogr", "-f", "GeoJSONSeq", "-lco", "RS=NO", "-t_srs", "EPSG:4326",
        "-select", fields, str(source_path), f"/vsizip/{source}", "-where", where,
    ], check=True)
    with source_path.open(encoding="utf-8") as features:
        geoids = [json.loads(line)["properties"]["GEOID"] for line in features]
    count = len(geoids)
    if count != expected:
        raise ValueError(f"{kind}: expected {expected} 50-state shapes, found {count}")
    if len(set(geoids)) != count:
        raise ValueError(f"{kind}: duplicate GEOIDs")
    archive = work / f"{kind}.pmtiles"
    with (work / f"{kind}.log").open("w", encoding="utf-8") as log:
        subprocess.run([
            "tippecanoe", "--force", "--output", str(archive), "--layer", kind,
            "--minimum-zoom=3", "--maximum-zoom=11", "--detect-shared-borders",
            "--no-feature-limit", "--no-tile-size-limit", str(source_path),
        ], check=True, stdout=log, stderr=log)
    if archive.open("rb").read(7) != b"PMTiles":
        raise ValueError(f"{kind}: invalid PMTiles archive")
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / archive.name
    os.replace(archive, target)
    print(f"{kind}: {count} shapes -> {target} ({target.stat().st_size:,} bytes)")
    return geoids


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--boundary-year", type=int, default=2025)
    parser.add_argument("--congress", type=int, default=119)
    args = parser.parse_args()
    if args.congress != 119:
        parser.error("This builder has not been checked for a Congress other than 119")
    states = load_states()
    geography: dict[str, object] = {"congress": args.congress, "boundaryYear": args.boundary_year}
    with tempfile.TemporaryDirectory() as temporary:
        work = Path(temporary)
        for kind, suffix in (("federal-house", f"cd{args.congress}"), ("federal-senate", "state")):
            url = f"{ROOT}/GENZ{args.boundary_year}/shp/cb_{args.boundary_year}_us_{suffix}_500k.zip"
            zip_path = work / f"{kind}.zip"
            download(url, zip_path)
            geography["house" if kind == "federal-house" else "senate"] = build(kind, zip_path, args.output_dir, states, work)
    write_atomically(args.manifest, geography)


if __name__ == "__main__":
    main()
