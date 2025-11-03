import subprocess
# from pathlib import Path
import click
from state_rep_map_builder.config import GEOJSON_DIR, MBTILES_DIR, MIN_ZOOM, MAX_ZOOM

@click.command()
@click.option("--level", "-l", type=click.Choice(["upper", "lower"]), required=True)
def build_mbtiles(level: str):
    """Convert GeoJSONs into MBTiles using Tippecanoe."""

    print(f"Running Build MBTiles Function for: {level}")
    input_root = GEOJSON_DIR / level
    output_root = MBTILES_DIR / level
    output_root.mkdir(parents=True, exist_ok=True)

    for geojson_file in input_root.rglob("*.geojson"):
        state_abbr = geojson_file.stem.split("_")[0]
        out_path = output_root / f"{state_abbr}_{level}.mbtiles"

        print(f"🧱 Building {out_path.name} from {geojson_file.name}...")

        cmd = [
            "tippecanoe",
            "-o", str(out_path),
            "--layer", f"{state_abbr}_{level}",
            f"--minimum-zoom={MIN_ZOOM}",
            f"--maximum-zoom={MAX_ZOOM}",
            "--detect-shared-borders",
            "--drop-densest-as-needed",
            str(geojson_file),
        ]

        try:
            subprocess.run(cmd, check=True)
            print(f"✅ Created {out_path}")
        except subprocess.CalledProcessError as e:
            print(f"❌ Tippecanoe failed for {geojson_file.name}: {e}")

if __name__ == "__main__":
    build_mbtiles.callback(level="upper")
    build_mbtiles.callback(level="lower")
