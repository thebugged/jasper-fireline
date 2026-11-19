"""Step 4: a 10 m close-up of the townsite, before and after the fire.

The ~42 m study grid is too coarse to say anything about single buildings,
so we re-read the town alone at Sentinel-2's native 10 m: NIR and SWIR for the
burn index, and red/green/blue for a sharper close-up texture.
"""
import math

import numpy as np
from pystac_client import Client

from config import RAW
from s2 import read_band

TOWN_BBOX = (-118.110, 52.858, -118.040, 52.895)
PRE, POST = "S2B_11UMU_20240720_0_L2A", "S2B_11UMU_20240905_0_L2A"


def main():
    w, s, e, n = TOWN_BBOX
    width = round((e - w) * 111320 * math.cos(math.radians((s + n) / 2)) / 10)
    height = round((n - s) * 110570 / 10)
    items = {i.id: i for i in Client.open("https://earth-search.aws.element84.com/v1").search(
        collections=["sentinel-2-l2a"], ids=[PRE, POST]).items()}
    out = {}
    for tag, iid in (("pre", PRE), ("post", POST)):
        for b in ("nir", "swir22", "scl", "red", "green", "blue"):
            out[f"{tag}_{b}"] = read_band(items[iid].assets[b].href, width, TOWN_BBOX, height)
    np.savez_compressed(RAW / "town.npz", bbox=np.array(TOWN_BBOX), **out)
    print("town grid", width, "x", height)


if __name__ == "__main__":
    main()
