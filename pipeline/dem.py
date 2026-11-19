"""Step 2: elevation from the Copernicus GLO-30 DEM, resampled to DEM_N x DEM_N.

Saved as a PNG (red = high byte, green = low byte) because some static hosts'
drag-and-drop deploys reject raw binary files.
"""
import json
import math

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.transform import from_bounds
from rasterio.warp import reproject

from config import BBOX, DEM_N, OUT

URL = "https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif"


def tile_names():
    w, s, e, n = BBOX
    for lat in range(math.floor(s), math.floor(n) + 1):
        for lon in range(math.floor(w), math.floor(e) + 1):
            ns = f"N{lat:02d}" if lat >= 0 else f"S{-lat:02d}"
            ew = f"W{-lon:03d}" if lon < 0 else f"E{lon:03d}"
            yield f"Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM"


def grid(size):
    srcs = [rasterio.open(URL.format(n=t)) for t in tile_names()]
    mosaic, tr = merge(srcs, bounds=BBOX)
    out = np.zeros((size, size), np.float32)
    reproject(mosaic[0], out, src_transform=tr, src_crs="EPSG:4326",
              dst_transform=from_bounds(*BBOX, size, size), dst_crs="EPSG:4326",
              resampling=Resampling.bilinear)
    return out



def main():
    (OUT / "tex").mkdir(parents=True, exist_ok=True)
    z = grid(DEM_N)
    zi = np.round(z).astype(np.uint16)
    rgb = np.dstack([zi >> 8, zi & 255, np.zeros_like(zi)]).astype(np.uint8)
    Image.fromarray(rgb).save(OUT / "dem.png", optimize=True)

    meta = {"file": "dem.png", "size": DEM_N, "min": int(zi.min()), "max": int(zi.max())}
    (OUT.parent / "pipeline" / "raw" / "dem.json").write_text(json.dumps(meta))
    print(meta)


if __name__ == "__main__":
    main()
