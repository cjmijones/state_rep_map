import subprocess
from pathlib import Path
import click
from .config import MBTILES_DIR, TILES_DIR

@click.command()
@click.option("--level", "-l", type=click.Choice(["upper", "lower"]), required=True)
def export_tiles(level: str):
    """
    Export MBTiles into PBF tile directories using mbutil.
    """
    input_root = MBTILES_DIR / level
    output_root = TILES_DIR / level
    output_root.mkdir(parents=True, exist_ok=True)

    for mbtiles_path in input_root.rglob("*.mbtiles"):
        state_abbr = mbtiles_path.stem.split("_")[0]
        out_dir = output_root / state_abbr
        # out_dir.mkdir(parents=True, exist_ok=True)

        print(f"🧩 Exporting {state_abbr} {level} → {out_dir}")

        cmd = [
            "mb-util",
            "--image_format=pbf",
            str(mbtiles_path),
            str(out_dir),
        ]

        try:
            subprocess.run(cmd, check=True)
            print(f"✅ Exported {out_dir}")
        except subprocess.CalledProcessError as e:
            print(f"❌ mbutil failed for {state_abbr}: {e}")

if __name__ == "__main__":
    export_tiles.callback(level="upper")
    export_tiles.callback(level="lower")
