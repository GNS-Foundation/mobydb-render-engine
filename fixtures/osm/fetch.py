#!/usr/bin/env python3
# =============================================================================
# fixtures/osm/fetch.py
# =============================================================================
# Refreshes OSM power infrastructure fixtures by querying Overpass API.
#
# Writes:
#   - substations.geojson       : Point features (nodes + way centroids)
#   - transmission_lines.geojson: LineString features (way geometry)
#
# Usage:
#   cd fixtures/osm/
#   python3 fetch.py
#
# Notes:
#   - Overpass requests can take 1-3 minutes for region-scale queries.
#   - Default regions: Lazio (IT-62) + Lombardia (IT-25). Edit REGIONS to extend.
#   - Data is OpenStreetMap contributors, ODbL. Preserve attribution when
#     distributing downstream features derived from this data.
#   - Query uses ISO3166-2 area codes, which are stable. If Overpass changes
#     schema, rewrite the area qualifier.
# =============================================================================

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
FIXTURES_DIR = Path(__file__).resolve().parent
REGIONS = [
    ("IT-62", "Lazio"),
    ("IT-25", "Lombardia"),
]


def _build_region_qualifier(regions):
    """Build an Overpass QL union of area blocks and return the '.regions' alias."""
    lines = ["("]
    for code, _ in regions:
        lines.append(f'  area["ISO3166-2"="{code}"];')
    lines.append(")->.regions;")
    return "\n".join(lines)


def _run_overpass(query: str) -> dict:
    """POST a query to Overpass; return parsed JSON."""
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(OVERPASS_URL, data=data)
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read())


def fetch_substations() -> dict:
    print("Fetching substations (node + way) ...", flush=True)
    region_q = _build_region_qualifier(REGIONS)
    query = f"""[out:json][timeout:180];
{region_q}
(
  node["power"="substation"](area.regions);
  way["power"="substation"](area.regions);
);
out center;"""
    return _run_overpass(query)


def fetch_lines() -> dict:
    print("Fetching transmission lines (way, full geometry) ...", flush=True)
    region_q = _build_region_qualifier(REGIONS)
    query = f"""[out:json][timeout:240];
{region_q}
way["power"="line"](area.regions);
out geom;"""
    return _run_overpass(query)


def _coords_from_element(e):
    """Pull (lat, lon) from a node (direct) or way (center) element."""
    if e["type"] == "node":
        return e.get("lat"), e.get("lon")
    if e["type"] == "way":
        c = e.get("center") or {}
        return c.get("lat"), c.get("lon")
    return None, None


def convert_substations(raw: dict) -> dict:
    features = []
    for e in raw.get("elements", []):
        lat, lon = _coords_from_element(e)
        if lat is None or lon is None:
            continue
        tags = e.get("tags") or {}
        props = {
            "osm_id": f"{e['type']}/{e['id']}",
            "operator": tags.get("operator"),
            "ref": tags.get("ref"),
            "voltage": tags.get("voltage"),
            "name": tags.get("name"),
            "substation_type": tags.get("substation"),
        }
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {k: v for k, v in props.items() if v is not None},
        })

    return {
        "type": "FeatureCollection",
        "metadata": {
            "source": "OpenStreetMap (Overpass API)",
            "license": "ODbL",
            "query_date": raw.get("osm3s", {}).get("timestamp_osm_base"),
            "regions": [name for _, name in REGIONS],
            "feature_type": "power=substation",
        },
        "features": features,
    }


def convert_lines(raw: dict) -> dict:
    features = []
    for e in raw.get("elements", []):
        if e["type"] != "way":
            continue
        geom_nodes = e.get("geometry")
        if not geom_nodes or len(geom_nodes) < 2:
            continue
        coords = [[pt["lon"], pt["lat"]] for pt in geom_nodes]

        tags = e.get("tags") or {}
        voltage_kv = None
        v = tags.get("voltage")
        if v:
            parts = [p.strip() for p in v.split(";") if p.strip().isdigit()]
            if parts:
                voltage_kv = max(int(p) for p in parts) // 1000

        props = {
            "osm_id": f"way/{e['id']}",
            "operator": tags.get("operator"),
            "voltage_kv": voltage_kv,
            "name": tags.get("name"),
            "circuits": tags.get("circuits"),
            "cables": tags.get("cables"),
        }
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {k: v for k, v in props.items() if v is not None},
        })

    return {
        "type": "FeatureCollection",
        "metadata": {
            "source": "OpenStreetMap (Overpass API)",
            "license": "ODbL",
            "query_date": raw.get("osm3s", {}).get("timestamp_osm_base"),
            "regions": [name for _, name in REGIONS],
            "feature_type": "power=line",
        },
        "features": features,
    }


def _write(path: Path, obj: dict) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  wrote {path.name}: {len(obj['features'])} features, "
          f"{path.stat().st_size / 1024:.1f} kB")


def main():
    print(f"Overpass API: {OVERPASS_URL}")
    print(f"Regions: {', '.join(f'{n} ({c})' for c, n in REGIONS)}")
    print()

    try:
        raw_subs = fetch_substations()
        sub_geo = convert_substations(raw_subs)
        _write(FIXTURES_DIR / "substations.geojson", sub_geo)

        raw_lines = fetch_lines()
        line_geo = convert_lines(raw_lines)
        _write(FIXTURES_DIR / "transmission_lines.geojson", line_geo)

        print("\n✓ fetch complete")
    except Exception as exc:
        print(f"\n✗ fetch failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
