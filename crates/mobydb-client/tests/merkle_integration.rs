//! Integration test: Merkle proof from `get_provenance` actually reconstructs
//! the stored epoch root.
//!
//! This is the correctness check the audit-trail positioning hinges on.
//! The pure-math `verify_proof` function has unit tests in `merkle.rs`;
//! this test closes the remaining gap by running the full pipeline:
//!
//!     in-memory fixture  →  PostgresMobyDb.get_provenance  →  verify_proof  →  assert == stored root
//!
//! Gated on `DATABASE_URL` being set. Skips if missing (so `cargo test --workspace`
//! still works on dev machines without a local Postgres).
//!
//! CI runs this automatically since the test job provides DATABASE_URL.

use std::time::Duration;

use ed25519_dalek::{Signer, SigningKey};
use mobydb_client::merkle;
use mobydb_client::postgres::{Config, PostgresMobyDb};
use rand::{rngs::StdRng, Rng, SeedableRng};
use render_core::{EpochId, H3Cell, MobyDbClient, TenantId};
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

/// Distinct tenant for this test so it doesn't conflict with CI seed or
/// other tests running in parallel.
const TEST_TENANT: &str = "00000000-0000-0000-0000-0000deadbeef";

#[tokio::test]
async fn merkle_proof_round_trip_against_real_db() {
    // --- 0. Gate on DATABASE_URL ---
    let Ok(database_url) = std::env::var("DATABASE_URL") else {
        eprintln!("DATABASE_URL not set — skipping integration test");
        return;
    };

    // --- 1. Admin-level pool to set up the fixture (bypasses RLS as postgres) ---
    let admin_pool = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&database_url)
        .await
        .expect("connect admin pool");

    let tenant_uuid: Uuid = TEST_TENANT.parse().unwrap();

    // Clean + (re)create the test tenant
    setup_test_tenant(&admin_pool, &tenant_uuid).await;

    // --- 2. Write fixture: 10 cells, 1 epoch ---
    let cell_count = 10;
    let (expected_root, test_cell_h3) =
        write_test_epoch(&admin_pool, &tenant_uuid, cell_count).await;

    // --- 3. Fetch provenance via the trait (this is what the MCP server does) ---
    let client = PostgresMobyDb::connect(Config {
        database_url: database_url.clone(),
        pool_max: 2,
        pool_min: 1,
        connect_timeout: Duration::from_secs(10),
        idle_timeout: Some(Duration::from_secs(60)),
        tenancy_session_var: "app.current_tenant_id".into(),
    })
    .await
    .expect("connect client");

    let provenance = client
        .get_provenance(
            &TenantId::new(tenant_uuid),
            H3Cell::from_i64(test_cell_h3),
            EpochId::new(0),
        )
        .await
        .expect("get_provenance");

    // --- 4. Assertions ---
    assert_eq!(
        provenance.epoch.merkle_root.as_bytes(),
        &expected_root,
        "stored epoch root must match what the fixture computed",
    );

    // Find the leaf index — the fixture sorted cells ASC by h3_cell to build
    // the tree, so we recreate that order and find our cell's rank.
    let leaf_idx = fetch_leaf_index(&admin_pool, &tenant_uuid, test_cell_h3).await;

    // Reconstruct the root from (content_hash, proof, leaf_idx, leaf_count)
    let content_hash = *provenance.cell_state.content_hash.as_bytes();
    let verified = merkle::verify_proof(
        &content_hash,
        leaf_idx,
        cell_count,
        &provenance.merkle_proof,
        &expected_root,
    );

    assert!(
        verified,
        "merkle proof failed to reconstruct the stored root.\n\
         leaf_idx={leaf_idx}, leaf_count={cell_count}\n\
         content_hash={}\n\
         expected_root={}\n\
         proof_len={}",
        hex::encode(content_hash),
        hex::encode(expected_root),
        provenance.merkle_proof.len(),
    );

    // Clean up
    teardown_test_tenant(&admin_pool, &tenant_uuid).await;
}

// -----------------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------------

async fn setup_test_tenant(pool: &PgPool, tenant: &Uuid) {
    // Best-effort cleanup first (handles re-runs)
    teardown_test_tenant(pool, tenant).await;

    sqlx::query(
        "INSERT INTO tenants (tenant_id, slug, display_name) VALUES ($1, $2, $3)",
    )
    .bind(tenant)
    .bind(format!("merkle-test-{}", tenant.simple()))
    .bind("Merkle Integration Test")
    .execute(pool)
    .await
    .expect("insert test tenant");
}

async fn teardown_test_tenant(pool: &PgPool, tenant: &Uuid) {
    // cell_states cascade when tenant is deleted; epochs do too via FK CASCADE
    let _ = sqlx::query("DELETE FROM tenants WHERE tenant_id = $1")
        .bind(tenant)
        .execute(pool)
        .await;
}

/// Write `cell_count` signed cell states into epoch 0, compute the Merkle root,
/// insert the epoch row, return (root, first_cell_h3).
async fn write_test_epoch(
    pool: &PgPool,
    tenant: &Uuid,
    cell_count: usize,
) -> ([u8; 32], i64) {
    // Deterministic — reproducible test
    let mut rng = StdRng::seed_from_u64(0xDEADBEEF);
    let mut key_bytes = [0u8; 32];
    rng.fill(&mut key_bytes);
    let signing_key = SigningKey::from_bytes(&key_bytes);
    let identity_pk = signing_key.verifying_key().to_bytes();

    // Generate cell_count distinct H3 indices. We don't need real H3 topology
    // for this test — we just need BIGINTs that pass the PK uniqueness.
    // Start at a known prefix and increment so sorting is predictable. The
    // literal has bit 63 set (would overflow positive i64), so construct as
    // u64 and reinterpret — same convention as real H3 cell storage.
    let cells: Vec<i64> = (0..cell_count as u64)
        .map(|i| (0x891e_8052_0000_0000_u64 + i * 0x10) as i64)
        .collect();
    let mut ordered = cells.clone();
    ordered.sort();

    // Phase 1: build signed rows in the same order we'll build the Merkle tree
    struct Row {
        h3: i64,
        content_hash: [u8; 32],
        signature: [u8; 64],
        payload: serde_json::Value,
    }

    let mut rows = Vec::with_capacity(ordered.len());
    let mut content_hashes: Vec<[u8; 32]> = Vec::with_capacity(ordered.len());

    for &h3 in &ordered {
        let payload = json!({ "test_cell": h3, "epoch": 0 });
        let canonical = render_core::tools::canonical_json(&payload).unwrap();
        let content_hash: [u8; 32] = *blake3::hash(canonical.as_bytes()).as_bytes();
        let signature: [u8; 64] = signing_key.sign(&content_hash).to_bytes();

        rows.push(Row {
            h3,
            content_hash,
            signature,
            payload,
        });
        content_hashes.push(content_hash);
    }

    // Phase 2: Merkle root (same algorithm as the render engine)
    let merkle_root = build_merkle_root(&content_hashes);

    // Phase 3: insert epoch then cells
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_tenant_id', $1, true)")
        .bind(tenant.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO epochs (tenant_id, epoch_id, sealed_at, merkle_root, parent_root, cell_count) \
         VALUES ($1, 0, NOW(), $2, NULL, $3)",
    )
    .bind(tenant)
    .bind(merkle_root.to_vec())
    .bind(cell_count as i64)
    .execute(&mut *tx)
    .await
    .unwrap();

    for row in &rows {
        sqlx::query(
            "INSERT INTO cell_states \
             (tenant_id, h3_cell, epoch_id, identity_pk, payload, content_hash, signature) \
             VALUES ($1, $2, 0, $3, $4, $5, $6)",
        )
        .bind(tenant)
        .bind(row.h3)
        .bind(identity_pk.to_vec())
        .bind(&row.payload)
        .bind(row.content_hash.to_vec())
        .bind(row.signature.to_vec())
        .execute(&mut *tx)
        .await
        .unwrap();
    }

    tx.commit().await.unwrap();

    // Return the root + the middle cell's H3 (tests a non-edge leaf)
    let test_h3 = ordered[ordered.len() / 2];
    (merkle_root, test_h3)
}

/// Find the target cell's index in the sorted leaf list for this epoch.
async fn fetch_leaf_index(pool: &PgPool, tenant: &Uuid, target_h3: i64) -> usize {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT h3_cell FROM cell_states \
         WHERE tenant_id = $1 AND epoch_id = 0 \
         ORDER BY h3_cell ASC",
    )
    .bind(tenant)
    .fetch_all(pool)
    .await
    .unwrap();

    rows.iter()
        .position(|(h3,)| *h3 == target_h3)
        .expect("target cell not found in epoch leaf set")
}

/// Duplicate of the in-seeder Merkle builder — kept local so the test doesn't
/// depend on the seed-data crate (keeps the test crate lean).
fn build_merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return [0u8; 32];
    }
    let mut layer: Vec<[u8; 32]> = leaves.to_vec();
    while layer.len() > 1 {
        if layer.len() % 2 == 1 {
            let last = *layer.last().unwrap();
            layer.push(last);
        }
        let mut next = Vec::with_capacity(layer.len() / 2);
        for chunk in layer.chunks(2) {
            let mut hasher = blake3::Hasher::new();
            hasher.update(&chunk[0]);
            hasher.update(&chunk[1]);
            next.push(*hasher.finalize().as_bytes());
        }
        layer = next;
    }
    layer[0]
}
