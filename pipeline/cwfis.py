"""Step 0: fire data from the Canadian Wildland Fire Information System (CWFIS).

- 2024 hotspots (satellite heat detections), cut down to the study area
- the 2024 National Burned Area Composite, keeping the Jasper fire's perimeter
"""
import csv
import io
import json
import urllib.request
import zipfile

import numpy as np
import shapefile                      # pyshp
from pyproj import Transformer
from shapely import transform
from shapely.geometry import box, mapping, shape

from config import BBOX, RAW

HOTSPOTS = "https://cwfis.cfs.nrcan.gc.ca/downloads/hotspots/archive/2024_hotspots.zip"
NBAC = "https://cwfis.cfs.nrcan.gc.ca/downloads/nbac/NBAC_2024_20260513.zip"


def download(url, dest):
    if not dest.exists():
        print("downloading", url)
        urllib.request.urlretrieve(url, dest)
    return dest


def hotspots():
    w, s, e, n = BBOX
    with zipfile.ZipFile(download(HOTSPOTS, RAW / "hotspots_2024.zip")) as z:
        name = next(f for f in z.namelist() if f.endswith(".csv"))
        rows = csv.DictReader(io.TextIOWrapper(z.open(name), "utf-8"))
        keep = [r for r in rows
                if s < float(r["lat"]) < n and w < float(r["lon"]) < e and r["rep_date"][:7] in ("2024-07", "2024-08")]
    with open(RAW / "jasper_hotspots.csv", "w", newline="") as f:
        out = csv.DictWriter(f, fieldnames=keep[0].keys())
        out.writeheader()
        out.writerows(keep)
    print("hotspots kept", len(keep))


def perimeter():
    zpath = download(NBAC, RAW / "nbac_2024.zip")
    with zipfile.ZipFile(zpath) as z:
        z.extractall(RAW / "nbac")
    base = next((RAW / "nbac").glob("*.shp")).with_suffix("")
    tr = Transformer.from_crs(base.with_suffix(".prj").read_text(), "EPSG:4326", always_xy=True)
    aoi = box(*BBOX)
    to_ll = lambda xy: np.column_stack(tr.transform(xy[:, 0], xy[:, 1]))
    best = None
    for sr in shapefile.Reader(str(base)).iterShapeRecords():
        # cheap bounding-box test first; only reproject shapes that might be in the study area
        if not transform(box(*sr.shape.bbox), to_ll).intersects(aoi):
            continue
        g = transform(shape(sr.shape.__geo_interface__), to_ll)
        if g.intersects(aoi) and (best is None or sr.record["POLY_HA"] > best[0]["POLY_HA"]):
            best = (sr.record.as_dict(), g)
    rec, g = best
    (RAW / "perimeter.json").write_text(json.dumps({"props": {k: str(v) for k, v in rec.items()}, "geom": mapping(g)}))
    print("perimeter", round(rec["POLY_HA"]), "ha")


if __name__ == "__main__":
    RAW.mkdir(parents=True, exist_ok=True)
    hotspots()
    perimeter()
