"""Shared settings for the data pipeline."""
from pathlib import Path

# west, south, east, north (degrees). Jasper townsite sits near the top middle.
BBOX = (-118.30, 52.57, -117.66, 52.99)
GRID = 1024            # pixels per side for imagery and indices
DEM_N = 512            # pixels per side for the elevation model
START, END = "2024-05-25", "2024-10-20"
FIRE_START = "2024-07-22"

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"                     # downloads and intermediates (git-ignored)
OUT = ROOT.parent / "data"             # what the web app loads
