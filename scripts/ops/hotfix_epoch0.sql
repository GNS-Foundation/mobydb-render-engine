-- =============================================================================
-- hotfix_epoch0.sql  (ONE-TIME, not a versioned migration)
-- =============================================================================
-- Original migration 0001 inserted a placeholder epoch-0 row with a zero
-- Merkle root. The seed-data binary then wrote 30 real cells under epoch 0
-- but could not overwrite the epoch row (ON CONFLICT DO NOTHING on epochs),
-- so get_provenance for any epoch-0 cell returns a valid proof path against
-- the WRONG stored root. Verification fails.
--
-- This hotfix deletes epoch 0 + its cells for the seed tenant. The seed-data
-- binary (which is deterministic) is then re-run; it recreates epoch 0 with
-- the correct Merkle root. Epoch 1's parent_root already points to the
-- correct epoch-0 root (the seeder held it in memory when writing epoch 1),
-- so the chain becomes self-consistent after re-seeding.
--
-- Run manually:
--   psql "$RAILWAY_DB_URL" -v ON_ERROR_STOP=1 -f migrations/hotfix_epoch0.sql
--   DATABASE_URL="$RAILWAY_DB_URL" cargo run --bin seed-data
-- =============================================================================

BEGIN;

DO $$
DECLARE
    seed_tenant UUID := '00000000-0000-0000-0000-000000000001';
    deleted_cells INT;
    deleted_epochs INT;
BEGIN
    PERFORM set_config('app.current_tenant_id', seed_tenant::text, true);

    DELETE FROM cell_states
    WHERE tenant_id = seed_tenant AND epoch_id = 0;
    GET DIAGNOSTICS deleted_cells = ROW_COUNT;

    DELETE FROM epochs
    WHERE tenant_id = seed_tenant AND epoch_id = 0;
    GET DIAGNOSTICS deleted_epochs = ROW_COUNT;

    RAISE NOTICE 'Deleted % cell_states and % epoch rows at epoch 0',
        deleted_cells, deleted_epochs;
END $$;

COMMIT;
