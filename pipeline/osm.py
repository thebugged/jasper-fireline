"""Step 3: buildings, roads and rail from OpenStreetMap via the Overpass API."""
import json
import sys
import urllib.parse
import urllib.request

from config import BBOX, RAW

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
w, s, e, n = BBOX
Q = f"""
[out:json][timeout:180];
(
  way["building"]({s},{w},{n},{e});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]({s},{w},{n},{e});
  way["railway"="rail"]({s},{w},{n},{e});
);
out center geom;
"""


def main():
    body = urllib.parse.urlencode({"data": Q}).encode()
    for url in MIRRORS:
        try:
            with urllib.request.urlopen(url, body, timeout=240) as r:
                data = json.load(r)
            break
        except Exception as ex:  # try the next mirror
            print(f"{url}: {ex}", file=sys.stderr)
    else:
        sys.exit("no Overpass mirror reachable")
    (RAW / "osm.json").write_text(json.dumps(data))
    kinds = {}
    for el in data["elements"]:
        t = el.get("tags", {})
        k = "building" if "building" in t else "rail" if "railway" in t else "road"
        kinds[k] = kinds.get(k, 0) + 1
    print(kinds)


if __name__ == "__main__":
    main()
