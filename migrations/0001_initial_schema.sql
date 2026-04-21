-- =============================================================================
-- 0001_initial_schema.sql
-- MobyDB Render Engine — initial schema
-- =============================================================================
-- This migration establishes the multi-tenant spacetime-addressed schema
-- used by the render engine. Key decisions (Section 3 of migration doc):
--
--   * Composite primary key: (tenant_id, h3_cell, epoch_id)
--   * Row-Level Security keyed off app.current_tenant_id session variable
--   * h3_cell stored as BIGINT (u64 H3 index reinterpreted as i64)
--   * epoch_id is a monotonic BIGINT per tenant (not globally unique)
--   * identity_pk is the Ed25519 public key (32 bytes, BYTEA)
--
-- This is the *render engine* layer. The underlying MobyDB store may have a
-- different internal format; this schema is the view the render engine
-- reads/writes against Postgres on Railway Phase 1.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Note: PostGIS is NOT required. H3 indexing is sufficient for our workload.
-- If geographic helpers are later needed, add in a follow-up migration.

-- -----------------------------------------------------------------------------
-- Tenants
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
    tenant_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug          TEXT NOT NULL UNIQUE,                -- e.g. 'terna', 'fibercop'
    display_name  TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Phase 2 migration flag: once a tenant has been migrated to a dedicated
    -- Hetzner deployment, this record is kept for audit/routing but marked.
    status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'migrated'))
);

COMMENT ON TABLE tenants IS
    'Render-engine tenants. Populated manually; no self-serve signup in Phase 1.';

-- -----------------------------------------------------------------------------
-- Epochs (per-tenant monotonic clock)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epochs (
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    epoch_id        BIGINT NOT NULL,                   -- monotonic per tenant, from 0
    sealed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    merkle_root     BYTEA NOT NULL,                    -- 32 bytes, blake3 root of all cells in epoch
    parent_root     BYTEA,                             -- 32 bytes, root of epoch_id - 1; NULL for genesis
    cell_count      BIGINT NOT NULL DEFAULT 0,
    genesis_hash    BYTEA,                             -- 32 bytes, GEP genesis hash (for tenant 0 only)
    PRIMARY KEY (tenant_id, epoch_id),
    CHECK (length(merkle_root) = 32),
    CHECK (parent_root IS NULL OR length(parent_root) = 32)
);

COMMENT ON TABLE epochs IS
    'Sealed epochs per tenant. Each epoch has a Merkle root over all cell states '
    'written during that epoch. Rolling is driven by gns_roll_epoch / perception layer.';

-- -----------------------------------------------------------------------------
-- Cell states — the hot path of the render engine
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell_states (
    tenant_id       UUID   NOT NULL,
    h3_cell         BIGINT NOT NULL,                   -- H3 index; u64 reinterpreted as i64
    epoch_id        BIGINT NOT NULL,
    identity_pk     BYTEA  NOT NULL,                   -- 32 bytes Ed25519; writer identity
    payload         JSONB  NOT NULL,                   -- opaque cell state (validated at write)
    content_hash    BYTEA  NOT NULL,                   -- 32 bytes blake3(canonical(payload))
    signature       BYTEA  NOT NULL,                   -- 64 bytes Ed25519(content_hash, identity_sk)
    written_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, h3_cell, epoch_id),
    FOREIGN KEY (tenant_id, epoch_id) REFERENCES epochs(tenant_id, epoch_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id)           REFERENCES tenants(tenant_id)          ON DELETE CASCADE,

    CHECK (length(identity_pk)  = 32),
    CHECK (length(content_hash) = 32),
    CHECK (length(signature)    = 64)
);

COMMENT ON TABLE cell_states IS
    'Spacetime-addressed cell states. Composite PK (tenant_id, h3_cell, epoch_id) '
    'is the render engine address. One row = one cell state at one epoch.';

-- Indices for render engine query patterns
-- (1) Latest epoch per cell for a tenant — hot path for get_cell_state
CREATE INDEX IF NOT EXISTS idx_cell_states_tenant_cell_epoch_desc
    ON cell_states (tenant_id, h3_cell, epoch_id DESC);

-- (2) Epoch scan — hot path for query_cells_in_region and audit
CREATE INDEX IF NOT EXISTS idx_cell_states_tenant_epoch
    ON cell_states (tenant_id, epoch_id);

-- (3) Writer-identity lookups (provenance queries)
CREATE INDEX IF NOT EXISTS idx_cell_states_identity
    ON cell_states (tenant_id, identity_pk);

-- -----------------------------------------------------------------------------
-- Attestations — third-party signed claims about a cell state
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attestations (
    attestation_id  UUID   NOT NULL DEFAULT uuid_generate_v4(),
    tenant_id       UUID   NOT NULL,
    h3_cell         BIGINT NOT NULL,
    epoch_id        BIGINT NOT NULL,
    attester_pk     BYTEA  NOT NULL,                   -- 32 bytes
    claim           JSONB  NOT NULL,
    claim_hash      BYTEA  NOT NULL,
    signature       BYTEA  NOT NULL,                   -- 64 bytes Ed25519(claim_hash)
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,

    PRIMARY KEY (tenant_id, attestation_id),
    FOREIGN KEY (tenant_id, h3_cell, epoch_id)
        REFERENCES cell_states(tenant_id, h3_cell, epoch_id) ON DELETE CASCADE,

    CHECK (length(attester_pk) = 32),
    CHECK (length(claim_hash)  = 32),
    CHECK (length(signature)   = 64)
);

CREATE INDEX IF NOT EXISTS idx_attestations_target
    ON attestations (tenant_id, h3_cell, epoch_id);

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------
-- The render engine sets `SET LOCAL app.current_tenant_id = '<uuid>'` at the
-- start of every transaction (see tenancy.rs). RLS policies then filter every
-- query by that session variable. Fail-closed: no default tenant.

ALTER TABLE tenants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE epochs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_states  ENABLE ROW LEVEL SECURITY;
ALTER TABLE attestations ENABLE ROW LEVEL SECURITY;

-- Force RLS even for table owners (prevents accidental bypass)
ALTER TABLE tenants      FORCE ROW LEVEL SECURITY;
ALTER TABLE epochs       FORCE ROW LEVEL SECURITY;
ALTER TABLE cell_states  FORCE ROW LEVEL SECURITY;
ALTER TABLE attestations FORCE ROW LEVEL SECURITY;

-- tenants: a tenant can only see its own row
CREATE POLICY tenant_isolation_tenants ON tenants
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_epochs ON epochs
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_cell_states ON cell_states
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_attestations ON attestations
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- -----------------------------------------------------------------------------
-- Helper: seed the CI tenant row
-- -----------------------------------------------------------------------------
-- The tenant row is schema-concern (its existence is a FK target for test
-- fixtures) and is safe to create idempotently in the migration.
--
-- Epochs are application-concern and are NOT seeded here — the seed-data
-- binary or the render service creates epoch rows when it has a real
-- Merkle root to insert. Seeding a placeholder epoch with a zero root here
-- would break `get_provenance` verification for epoch 0.
DO $$
BEGIN
    -- Temporarily set the RLS session var so the INSERT passes policy checks
    -- when this migration is applied by a non-superuser role.
    PERFORM set_config('app.current_tenant_id', '00000000-0000-0000-0000-000000000001', true);
    INSERT INTO tenants (tenant_id, slug, display_name)
    VALUES ('00000000-0000-0000-0000-000000000001', 'ci-tenant', 'CI Tenant')
    ON CONFLICT (tenant_id) DO NOTHING;
END $$;
