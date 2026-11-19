"""Step 1: pull every Sentinel-2 pass over the study area onto one lon/lat grid.

For each scene we keep the bands we need (true colour, NIR, SWIR) plus the scene
classification layer, so later steps can mask cloud and compute burn indices.
Output: raw/scenes/<date>.npz
"""
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT
from pystac_client import Client

from config import BBOX, GRID, RAW, START, END

BANDS = ["red", "green", "blue", "nir", "swir22", "scl"]


def read_band(href, size, bbox=BBOX, height=None):
    height = height or size
    dst = from_bounds(*bbox, size, height)
    with rasterio.open(href) as src, WarpedVRT(
        src, crs="EPSG:4326", transform=dst, width=size, height=height,
        resampling=Resampling.nearest if href.endswith("SCL.tif") else Resampling.bilinear,
    ) as vrt:
        return vrt.read(1)


def main():
    out = RAW / "scenes"
    out.mkdir(parents=True, exist_ok=True)
    items = Client.open("https://earth-search.aws.element84.com/v1").search(
        collections=["sentinel-2-l2a"], bbox=BBOX, datetime=f"{START}/{END}",
        query={"eo:cloud_cover": {"lt": 60}},
    ).items()
    def fetch(it):
        # some dates have two processing versions (…_0 and …_1); keep one file per date+id
        date = it.datetime.date().isoformat()
        f = out / f"{date}_{it.id.rsplit('_', 2)[-2]}.npz"
        if not f.exists():
            np.savez_compressed(f, **{b: read_band(it.assets[b].href, GRID) for b in BANDS})
        scl = np.load(f)["scl"]
        valid = scl > 0
        cloud = np.isin(scl, [3, 8, 9, 10])   # SCL: 3 shadow, 8/9 cloud, 10 cirrus
        stats = {"date": date, "id": it.id, "file": f.name, "valid": round(float(valid.mean()), 3),
                 "cloud": round(float(cloud[valid].mean()), 3) if valid.any() else 1.0}
        print(stats, flush=True)
        return stats

    with ThreadPoolExecutor(6) as pool:
        log = list(pool.map(fetch, sorted(items, key=lambda i: i.datetime)))
    (RAW / "scenes.json").write_text(json.dumps(log, indent=1))


if __name__ == "__main__":
    sys.exit(main())
