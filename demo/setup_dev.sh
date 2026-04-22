#!/usr/bin/env bash
# =============================================================================
# demo/setup_dev.sh
# =============================================================================
# One-shot dev environment setup for the demo app.
#
# The demo is served from `cd demo && python3 -m http.server 8000`, so files
# outside demo/ (like the OSM fixtures) aren't reachable via ../path/. This
# script creates a symlink from demo/fixtures -> ../fixtures so transmission
# line GeoJSON can be loaded at runtime without leaving the serve root.
#
# Usage (from repo root):
#   ./demo/setup_dev.sh
#
# Idempotent. Safe to re-run.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -L fixtures ]]; then
    echo "  demo/fixtures symlink already exists -> $(readlink fixtures)"
elif [[ -e fixtures ]]; then
    echo "error: demo/fixtures exists but is not a symlink; remove manually" >&2
    exit 1
else
    ln -s ../fixtures fixtures
    echo "  created: demo/fixtures -> ../fixtures"
fi

if [[ ! -f fixtures/osm/transmission_lines.geojson ]]; then
    echo "error: fixtures/osm/transmission_lines.geojson missing" >&2
    echo "  run: python3 fixtures/osm/fetch.py" >&2
    exit 1
fi

echo "  transmission_lines.geojson: $(wc -c < fixtures/osm/transmission_lines.geojson | tr -d ' ') bytes"
echo "  substations.geojson:        $(wc -c < fixtures/osm/substations.geojson      | tr -d ' ') bytes"

echo ""
echo "ready. next:"
echo "  cd demo"
echo "  python3 -m http.server 8000"
echo "  open http://localhost:8000"
