# Data pipeline

Builds everything in `../data/` from public sources. Run the steps in order from this folder:

| Step | Script | What it does |
|---|---|---|
| 0 | `cwfis.py` | Downloads the 2024 fire hotspots and National Burned Area Composite from CWFIS, keeps the Jasper area |
| 1 | `s2.py` | Reads every Sentinel-2 L2A pass (May–Oct 2024, <60% cloud) onto one 1,024 px lon/lat grid |
| 2 | `dem.py` | Copernicus GLO-30 elevation, packed into `data/dem.png` |
| 3 | `osm.py` | Buildings, main roads and rail from OpenStreetMap (Overpass API) |
| 4 | `town.py` | The townsite at Sentinel-2's native 10 m, before and after |
| 5 | `build.py` | Burn indices, burned area per pass, severity map, textures, hotspot list, building distances → `data/story.json` |

Downloads and intermediates go to `raw/` (git-ignored, about 400 MB). Settings such as the study area and grid size are in `config.py`.

The walkthrough of the analysis (with charts and validation) is in `../analysis.ipynb`.
