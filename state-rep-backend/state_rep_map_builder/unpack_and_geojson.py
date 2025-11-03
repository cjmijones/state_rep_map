import zipfile
# import tempfile
import geopandas as gpd
# from pathlib import Path
import click
from state_rep_map_builder.config import RAW_DIR, GEOJSON_DIR, TMP_DIR

print(f"RAW_DIR: {RAW_DIR}")
print(f"GEOJSON_DIR: {GEOJSON_DIR}")
print(f"TMP_DIR: {TMP_DIR}")


@click.command()
@click.option("--level", "-l", type=click.Choice(["upper", "lower"]), required=True)
def unpack_and_geojson(level: str):
    """Unpack Census shapefile ZIPs and convert to GeoJSON."""

    print(f"Running Unpack Function for: {level}")
    input_root = RAW_DIR / level
    output_root = GEOJSON_DIR / level

    print(f"Input root: {input_root}")
    print(f"Output root: {output_root}")
    output_root.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)

    zip_files = list(input_root.glob("*.zip"))
    print(f"Found {len(zip_files)} zip files in {input_root}")

    for zip_path in input_root.glob("*.zip"):
        state_code = zip_path.stem.split("_")[2]
        state_abbr = get_state_abbr(state_code)
        if not state_abbr:
            print(f"⚠️  Skipping {zip_path.name} — unknown FIPS {state_code}")
            continue

        temp_dir = TMP_DIR / f"{state_abbr}_{level}"
        temp_dir.mkdir(parents=True, exist_ok=True)

        print(f"📦 Extracting {zip_path.name} → {temp_dir}")
        with zipfile.ZipFile(zip_path, "r") as zip_ref:
            zip_ref.extractall(temp_dir)

        # 🔍 search recursively
        shp_files = list(temp_dir.rglob("*.shp"))
        print(f"🔍 Found {len(shp_files)} shapefile(s) in {temp_dir}")

        if not shp_files:
            print(f"❌ No .shp found in {zip_path.name}")
            continue

        shp_file = shp_files[0]
        gdf = gpd.read_file(shp_file)

        if gdf.empty:
            print(f"⚠️ Empty GeoDataFrame for {state_abbr}, skipping.")
            continue

        out_dir = output_root / state_abbr
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{state_abbr}_{level}.geojson"

        print(f"🗺️ Converting {state_abbr} {level} → GeoJSON at {out_path}")
        gdf.to_file(out_path, driver="GeoJSON")

        if out_path.exists():
            print(f"✅ Saved {out_path}")
        else:
            print(f"❌ Output not written: {out_path}")


def get_state_abbr(fips: str):
    """Map FIPS codes to state abbreviations."""
    mapping = {
        "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA",
        "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
        "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN",
        "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME",
        "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS",
        "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
        "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
        "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
        "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
        "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI",
        "56": "WY", "72": "PR"
    }
    return mapping.get(fips)

if __name__ == "__main__":
    unpack_and_geojson.callback(level="upper")
    unpack_and_geojson.callback(level="lower")