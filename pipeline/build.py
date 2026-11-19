"""Step 5: turn the downloads into what the web app loads (data/story.json + textures).

Burn detection uses the Normalized Burn Ratio, NBR = (NIR - SWIR2) / (NIR + SWIR2).
Healthy forest has high NBR; burned ground has low NBR. dNBR = NBR_before - NBR_after,
and the usual severity breaks (Key & Benson, USGS FIREMON) are applied to it.
"""
import csv
import json
import math
from datetime import datetime, timedelta

import numpy as np
from scipy import ndimage
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from shapely import contains_xy, prepare
from shapely.geometry import shape

from config import BBOX, GRID, OUT, RAW

TEX = OUT / "tex"
# Clear passes picked for the timeline (cloud < ~25% over the area). 22 Jul is the
# morning of the day the fire started; 1 Aug is the first look after, partly under smoke.
PASSES = ["2024-07-07_0", "2024-07-20_0", "2024-07-22_0", "2024-08-01_0",
          "2024-08-04_0", "2024-08-19_0", "2024-08-31_0", "2024-09-05_0", "2024-09-10_1"]
PRE = ["2024-07-05_0", "2024-07-07_0", "2024-07-10_0", "2024-07-15_0", "2024-07-17_0", "2024-07-20_0"]
POST = ["2024-08-19_0", "2024-09-05_0", "2024-09-08_0", "2024-09-10_1"]
FIRE_DAY = "2024-07-22"
# dNBR severity classes and colours (unburned below 0.10)
SEVERITY = [(0.10, "low", (246, 211, 101)), (0.27, "moderate-low", (240, 151, 55)),
            (0.44, "moderate-high", (214, 72, 38)), (0.66, "high", (122, 18, 26))]
BURNED = 0.27   # dNBR above this counts as burned for area and building stats

w, s, e, n = BBOX
PX_KM2 = ((e - w) * 111.32 * math.cos(math.radians((s + n) / 2)) / GRID) * ((n - s) * 110.57 / GRID)
lon_c = w + (np.arange(GRID) + 0.5) / GRID * (e - w)
lat_c = n - (np.arange(GRID) + 0.5) / GRID * (n - s)
LON, LAT = np.meshgrid(lon_c, lat_c)


def load(name):
    return np.load(RAW / "scenes" / f"{name}.npz")


def clear_mask(scl):
    # SCL: 0 no data, 1 saturated, 3 cloud shadow, 8/9 cloud, 10 cirrus
    return ~np.isin(scl, [0, 1, 3, 8, 9, 10])


def nbr(d):
    nir, sw = d["nir"].astype(np.float32), d["swir22"].astype(np.float32)
    with np.errstate(invalid="ignore", divide="ignore"):
        v = (nir - sw) / (nir + sw)
    return np.where(clear_mask(d["scl"]), v, np.nan)


def stretch(rgb, lo=None, hi=None):
    rgb = rgb.astype(np.float32)
    lo = np.nanpercentile(rgb, 1) if lo is None else lo
    hi = np.nanpercentile(rgb, 99.3) if hi is None else hi
    x = np.clip((rgb - lo) / (hi - lo), 0, 1) ** 0.72
    return (x * 255).astype(np.uint8)


def save_jpg(arr, path, q=80):
    Image.fromarray(arr).save(path, quality=q, optimize=True, progressive=True)


def perimeter():
    p = json.loads((RAW / "perimeter.json").read_text())
    g = shape(p["geom"]).simplify(0.0002)   # ~20 m, far below the 40 m grid
    prepare(g)
    return g, p["props"]


def rings(geom, tol=0.0006):
    g = geom.simplify(tol)
    polys = [g] if g.geom_type == "Polygon" else list(g.geoms)
    return [[[round(x, 5), round(y, 5)] for x, y in p.exterior.coords] for p in polys if p.area > 1e-5]


def main():
    TEX.mkdir(parents=True, exist_ok=True)
    peri, props = perimeter()
    inside = rasterize([peri.buffer(0.004)], out_shape=(GRID, GRID),   # ~300 m buffer
                       transform=from_bounds(*BBOX, GRID, GRID)).astype(bool)
    near = peri.buffer(0.02)
    prepare(near)

    # ---------- textures for each timeline pass
    # one fixed stretch for all passes so colours are comparable through the summer
    ref = load("2024-07-07_0")
    tc_lo = float(np.percentile(np.dstack([ref["red"], ref["green"], ref["blue"]]), 1))
    tc_hi = float(np.percentile(np.dstack([ref["red"], ref["green"], ref["blue"]]), 97.5))
    ir_lo = float(np.percentile(np.dstack([ref["swir22"], ref["nir"], ref["red"]]), 1))
    ir_hi = float(np.percentile(np.dstack([ref["swir22"], ref["nir"], ref["red"]]), 99.5))

    pre_nbr = np.nanmedian(np.stack([nbr(load(p)) for p in PRE]), axis=0)
    passes = []
    for name in PASSES:
        d = load(name)
        date = name[:10]
        save_jpg(stretch(np.dstack([d["red"], d["green"], d["blue"]]), tc_lo, tc_hi), TEX / f"tc_{date}.jpg")
        save_jpg(stretch(np.dstack([d["swir22"], d["nir"], d["red"]]), ir_lo, ir_hi), TEX / f"ir_{date}.jpg")
        dn = pre_nbr - nbr(d)
        clear_in = np.isfinite(dn) & inside
        burned = clear_in & (dn > BURNED)
        cover = clear_in.sum() / inside.sum()
        passes.append({
            "date": date, "tc": f"tex/tc_{date}.jpg", "ir": f"tex/ir_{date}.jpg",
            "after": date > FIRE_DAY,
            "clear_pct": round(100 * float(cover)),
            # burned km² among clear pixels, scaled up to the whole perimeter so cloudy passes stay comparable
            "burned_km2": round(float(burned.sum() / max(cover, 1e-6) * PX_KM2)),
        })
        print(passes[-1])

    # ---------- burn severity from the median of clear post-fire passes
    post_nbr = np.nanmedian(np.stack([nbr(load(p)) for p in POST]), axis=0)
    dnbr = pre_nbr - post_nbr
    rgba = np.zeros((GRID, GRID, 4), np.uint8)
    cls_area = {}
    for i, (lo, label, col) in enumerate(SEVERITY):
        hi = SEVERITY[i + 1][0] if i + 1 < len(SEVERITY) else 9
        m = inside & (dnbr >= lo) & (dnbr < hi)
        rgba[m] = (*col, 235)
        cls_area[label] = round(float(m.sum() * PX_KM2), 1)
    Image.fromarray(rgba).save(TEX / "severity.png", optimize=True)
    burned_km2 = round(float((inside & (dnbr > BURNED)).sum() * PX_KM2))
    print("severity km²", cls_area, "burned", burned_km2)

    # ---------- hotspots: satellite fire detections (times are UTC in the file, shown in MDT)
    hs = []
    with open(RAW / "jasper_hotspots.csv") as f:
        for r in csv.DictReader(f):
            lon, lat = float(r["lon"]), float(r["lat"])
            t = datetime.fromisoformat(r["rep_date"]) - timedelta(hours=6)
            if t < datetime(2024, 7, 22, 12) or t > datetime(2024, 7, 26):
                continue
            if not contains_xy(near, lon, lat):
                continue
            hs.append({"lon": round(lon, 4), "lat": round(lat, 4), "t": t.strftime("%Y-%m-%dT%H:%M"),
                       "frp": round(float(r["frp"] or 0), 1)})
    hs.sort(key=lambda h: h["t"])
    print("hotspots", len(hs), hs[0]["t"], hs[-1]["t"])

    # ---------- buildings, roads, rail from OSM; town buildings get a 10 m burn reading
    osm = json.loads((RAW / "osm.json").read_text())
    town = np.load(RAW / "town.npz")
    tb = town["bbox"]
    def tnbr(tag):
        nir, sw = town[f"{tag}_nir"].astype(np.float32), town[f"{tag}_swir22"].astype(np.float32)
        return (nir - sw) / np.maximum(nir + sw, 1)
    town_dnbr = tnbr("pre") - tnbr("post")
    th, tw = town_dnbr.shape
    # Burn index on a rooftop barely moves when a house burns, so instead of reading the
    # index at each building we measure how far each building is from burned ground.
    scar = ndimage.binary_opening(town_dnbr > BURNED, iterations=2)
    px_x = (tb[2] - tb[0]) * 111320 * math.cos(math.radians((tb[1] + tb[3]) / 2)) / tw
    px_y = (tb[3] - tb[1]) * 110570 / th
    dist_m = ndimage.distance_transform_edt(~scar, sampling=(px_y, px_x))

    buildings, roads, rail = [], [], []
    for el in osm["elements"]:
        t = el.get("tags", {})
        if "building" in t:
            if "center" in el:
                lon, lat = el["center"]["lon"], el["center"]["lat"]
            else:   # ways come back with their outline; use its mean as the position
                lon = sum(p["lon"] for p in el["geometry"]) / len(el["geometry"])
                lat = sum(p["lat"] for p in el["geometry"]) / len(el["geometry"])
            b = {"lon": round(lon, 5), "lat": round(lat, 5)}
            if tb[0] <= lon <= tb[2] and tb[1] <= lat <= tb[3]:
                x = int((lon - tb[0]) / (tb[2] - tb[0]) * tw)
                y = int((tb[3] - lat) / (tb[3] - tb[1]) * th)
                b["dist_m"] = int(round(float(dist_m[min(y, th - 1), min(x, tw - 1)])))
                b["town"] = True
            else:
                b["town"] = False
            b["in_perimeter"] = bool(contains_xy(peri, lon, lat))
            buildings.append(b)
        elif "geometry" in el:
            coords = [[round(p["lon"], 5), round(p["lat"], 5)] for p in el["geometry"]]
            if "railway" in t:
                rail.append({"coords": coords})
            else:
                roads.append({"coords": coords, "kind": t["highway"], "name": t.get("name", t.get("ref", ""))})
    # 10 m true-colour patches of the townsite, stretched like the main passes
    # (stretched on the town itself, which has no snow to set the white point)
    ref_town = np.dstack([town["pre_red"], town["pre_green"], town["pre_blue"]])
    t_lo, t_hi = float(np.percentile(ref_town, 1)), float(np.percentile(ref_town, 99.5))
    for tag in ("pre", "post"):
        rgb = np.dstack([town[f"{tag}_red"], town[f"{tag}_green"], town[f"{tag}_blue"]])
        save_jpg(stretch(rgb, t_lo, t_hi), TEX / f"town_{tag}.jpg", q=85)
    tbs = [b for b in buildings if b["town"]]
    print("buildings", len(buildings), "town", len(tbs), "<=50 m", sum(b["dist_m"] <= 50 for b in tbs), "<=200 m", sum(b["dist_m"] <= 200 for b in tbs))

    # first detections mark where the fire was first seen from orbit
    first = [h for h in hs if h["t"] < "2024-07-23T06:00"]

    meta = json.loads((RAW / "dem.json").read_text())
    story = {
        "title": "Jasper wildfire, July 2024",
        "bbox": list(BBOX),
        "dem": meta,
        "perimeter": rings(peri),
        "perimeter_ha": round(float(props["POLY_HA"])),
        "burned_km2": burned_km2,
        "severity_km2": cls_area,
        "burned_threshold": BURNED,
        "passes": passes,
        "hotspots": hs,
        "first_hotspots": len(first),
        "town_bbox": [float(v) for v in tb],
        "buildings": buildings,
        "roads": roads,
        "rail": rail,
        "places": [
            {"name": "Jasper", "lon": -118.0824, "lat": 52.8752, "kind": "town"},
            {"name": "Jasper Park Lodge", "lon": -118.0574, "lat": 52.8869, "kind": "local"},
            {"name": "Maligne Canyon", "lon": -118.0077, "lat": 52.9206},
            {"name": "Wabasso Campground", "lon": -117.9915, "lat": 52.7667},
            {"name": "Athabasca Falls", "lon": -117.8835, "lat": 52.6644},
            {"name": "Pyramid Mountain", "lon": -118.1494, "lat": 52.9511, "ele": 2766, "kind": "peak"},
            {"name": "The Whistlers", "lon": -118.1331, "lat": 52.827, "ele": 2464, "kind": "peak"},
            {"name": "Mount Edith Cavell", "lon": -118.0572, "lat": 52.6673, "ele": 3363, "kind": "peak"},
            {"name": "Signal Mountain", "lon": -117.9669, "lat": 52.8594, "ele": 2311, "kind": "peak"},
        ],
        "sources": [
            {"label": "Sentinel-2 L2A imagery (Copernicus / ESA), via Earth Search on AWS", "url": "https://registry.opendata.aws/sentinel-2-l2a-cogs/"},
            {"label": "Copernicus GLO-30 elevation model", "url": "https://registry.opendata.aws/copernicus-dem/"},
            {"label": "National Burned Area Composite 2024 (Natural Resources Canada)", "url": "https://cwfis.cfs.nrcan.gc.ca/datamart/metadata/nbac"},
            {"label": "Fire hotspots 2024, Canadian Wildland Fire Information System", "url": "https://cwfis.cfs.nrcan.gc.ca/downloads/hotspots/"},
            {"label": "Buildings, roads and rail: OpenStreetMap contributors", "url": "https://www.openstreetmap.org/copyright"},
            {"label": "Parks Canada: timeline of the Jasper wildfire", "url": "https://parks.canada.ca/pn-np/ab/jasper/visit/feu-alert-fire/feudeforet-jasper-wildfire/chronologie-timeline"},
            {"label": "Structures lost (358 of 1,113): 2024 Jasper wildfire overview", "url": "https://en.wikipedia.org/wiki/2024_Jasper_wildfire"},
            {"label": "dNBR severity breaks: Key & Benson, FIREMON (USDA Forest Service)", "url": "https://www.fs.usda.gov/rm/pubs_series/rmrs/gtr/rmrs_gtr164.pdf"},
        ],
    }
    (OUT / "story.json").write_text(json.dumps(story, separators=(",", ":")))
    print("story.json", round((OUT / "story.json").stat().st_size / 1e3), "kB")


if __name__ == "__main__":
    main()
