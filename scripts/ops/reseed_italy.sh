#!/usr/bin/env bash
# =============================================================================
# scripts/ops/reseed_italy.sh
# =============================================================================
# One-shot ops script. Clears existing seed-tenant data and loads the new
# OSM-based fixture: real substations in Lazio + Lombardia, ~4,200 cells
# at H3 res 11, across 10 epochs.
#
# Not a versioned migration — live-DB ops only. Safe to run multiple times;
# the seeder itself is deterministic and idempotent, but this script drops
# existing cells + epochs first so Merkle roots and cell counts come out
# consistent with the new generator.
#
# Preconditions:
#   - DATABASE_URL points at a Postgres role with superuser (for DELETE + INSERT)
#   - The seed tenant (00000000-0000-0000-0000-000000000001) exists
#     (migration 0001 creates it)
#   - fixtures/osm/substations.geojson exists (run fixtures/osm/fetch.py to
#     refresh from Overpass if needed)
#
# Usage:
#   export DATABASE_URL=<postgres-role URL>
#   ./scripts/ops/reseed_italy.sh
# =============================================================================
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "error: DATABASE_URL must be set" >&2
    exit 1
fi

if ! command -v psql >/dev/null; then
    echo "error: psql not in PATH" >&2
    exit 1
fi
if ! command -v cargo >/dev/null; then
    echo "error: cargo not in PATH" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ ! -f "$REPO_ROOT/fixtures/osm/substations.geojson" ]]; then
    echo "error: fixtures/osm/substations.geojson missing" >&2
    echo "  run: python3 fixtures/osm/fetch.py" >&2
    exit 1
fi

echo "==> clearing existing seed-tenant cells and epochs"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DO $$
DECLARE
    seed_tenant UUID := '00000000-0000-0000-0000-000000000001';
    deleted_cells INT;
    deleted_epochs INT;
BEGIN
    PERFORM set_config('app.current_tenant_id', seed_tenant::text, true);

    DELETE FROM cell_states WHERE tenant_id = seed_tenant;
    GET DIAGNOSTICS deleted_cells = ROW_COUNT;

    DELETE FROM epochs WHERE tenant_id = seed_tenant;
    GET DIAGNOSTICS deleted_epochs = ROW_COUNT;

    RAISE NOTICE 'cleared % cell_states rows and % epoch rows', deleted_cells, deleted_epochs;
END $$;
COMMIT;
SQL

echo
echo "==> running seed-data binary (OSM substations + 10 epochs)"
cd "$REPO_ROOT"
DATABASE_URL="$DATABASE_URL" cargo run --bin seed-data --release

echo
echo "==> verification"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SET app.current_tenant_id = '00000000-0000-0000-0000-000000000001';

SELECT COUNT(*) AS total_cells FROM cell_states
 WHERE tenant_id = '00000000-0000-0000-0000-000000000001';

SELECT COUNT(*) AS total_epochs FROM epochs
 WHERE tenant_id = '00000000-0000-0000-0000-000000000001';

SELECT
    COALESCE(payload->>'operator', '(unspecified)') AS operator,
    COUNT(*) AS cells_at_epoch_0
FROM cell_states
WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
  AND epoch_id = 0
GROUP BY payload->>'operator'
ORDER BY cells_at_epoch_0 DESC
LIMIT 12;
SQL

echo
echo "==> reseed complete"
