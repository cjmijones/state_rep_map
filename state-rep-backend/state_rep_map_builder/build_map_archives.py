"""Generate two compact PMTiles archives for the local browser map.

The current represented plan is selected per chamber. The 2024 exceptions are
listed in build_demo_data.py and should be revisited when the new legislators
take office. The Census source GeoPackage is downloaded separately.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from .build_demo_data import PRE_ELECTION_2024, STATE_INFO
from .config import GEOJSON_DIR


def build_input(gpkg: Path, chamber: str, destination: Path) -> int:
    table = f"State Legislative Districts - {'Upper' if chamber == 'upper' else 'Lower'}"
    code_field = "SLDUST" if chamber == "upper" else "SLDLST"
    exceptions = {state for state, selected in PRE_ELECTION_2024 if selected == chamber}
    fips_codes = [
        fips for fips, (state, _) in STATE_INFO.items()
        if state not in exceptions and not (state == "NE" and chamber == "lower")
    ]
    where = f"STATEFP IN ({','.join(repr(code) for code in fips_codes)}) AND {code_field} <> 'ZZZ'"
    cmd = [
        "ogr2ogr", "-f", "GeoJSONSeq", "-lco", "RS=NO", "-t_srs", "EPSG:4326",
        "-select", f"STATEFP,{code_field},GEOID,NAMELSAD,LSY",
        str(destination), str(gpkg), table, "-where", where,
    ]
    subprocess.run(cmd, check=True)
    count = sum(1 for _ in destination.open())
    with destination.open("a") as out:
        for state in sorted(exceptions):
            path = GEOJSON_DIR / chamber / state / f"{state}_{chamber}.geojson"
            for feature in json.loads(path.read_text())["features"]:
                props = feature["properties"]
                if props[code_field] == "ZZZ":
                    continue
                feature["properties"] = {
                    key: props[key]
                    for key in ("STATEFP", code_field, "GEOID", "NAMELSAD", "LSY")
                }
                out.write(json.dumps(feature, separators=(",", ":")) + "\n")
                count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--census-gpkg", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        for chamber in ("upper", "lower"):
            source = Path(work) / f"{chamber}.geojsonl"
            count = build_input(args.census_gpkg, chamber, source)
            target = args.output_dir / f"{chamber}.pmtiles"
            cmd = [
                "tippecanoe", "--force", "--output", str(target),
                "--layer", chamber,
                "--minimum-zoom=3", "--maximum-zoom=11",
                "--detect-shared-borders", "--drop-densest-as-needed",
                str(source),
            ]
            with (Path(work) / f"{chamber}.log").open("w") as log:
                subprocess.run(cmd, check=True, stdout=log, stderr=log)
            if target.open("rb").read(7) != b"PMTiles":
                raise RuntimeError(f"Invalid PMTiles archive: {target}")
            print(f"{chamber}: {count} Census district polygons -> {target} ({target.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
