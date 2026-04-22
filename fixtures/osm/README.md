# OSM Power Infrastructure Fixtures

Real OpenStreetMap power infrastructure data for Lazio (IT-62) and Lombardia
(IT-25) regions of Italy. Used by the MobyDB seed-data crate to seed the demo
tenant with realistic substations and transmission lines.

## Files

- `substations.geojson` — ~4,200 Point features (power=substation)
  - 47% tagged with `operator` (Enel, Terna, Acea, e-distribuzione, RFI, etc.)
  - 24% tagged with `voltage`
- `transmission_lines.geojson` — ~4,400 LineString features (power=line)
  - 70% tagged with `voltage_kv` (132/220/380/150/etc.)
  - 3% tagged with `operator` (sparse on lines; normal for OSM)
- `fetch.py` — reproduces both files from Overpass API (~2-3 min)

## Data provenance

- Source: OpenStreetMap contributors, via Overpass API
- License: Open Database License (ODbL)
- Fetched: see `metadata.query_date` inside each GeoJSON
- When redistributing products derived from this data, preserve attribution.

## Coverage caveats

OSM coverage is volunteer-driven and imperfect:
- Expect 60-80% completeness on HV transmission infrastructure in mapped regions
- Distribution-level assets (< 30 kV) are sparsely represented
- `operator` tagging is uneven; some substations are unlabeled
- Northern Italy (Lombardia) tends to have better coverage than other regions
