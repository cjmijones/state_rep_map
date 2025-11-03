from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = PROJECT_ROOT / "raw_sld_shapes"
GEOJSON_DIR = PROJECT_ROOT / "data" / "geojson"
MBTILES_DIR = PROJECT_ROOT / "data" / "mbtiles"
TILES_DIR = PROJECT_ROOT / "data" / "tiles"
TMP_DIR = PROJECT_ROOT / "data" / "tmp"

MIN_ZOOM = 3
MAX_ZOOM = 11