//! seed-data — load synthetic cell states + epochs into MobyDB for demos.
//!
//! Generates ~90 cell states across 3 epochs for the seed tenant
//! (00000000-0000-0000-0000-000000000001), geographically clustered around
//! three Italian cities (Rome, Milan, Naples) at H3 resolution 9.
//!
//! Each cell state is Ed25519-signed by one of three deterministically-derived
//! "substation" identities — enough to demonstrate multi-writer provenance
//! without being a real grid topology.
//!
//! Idempotent: re-running skips rows that already exist (ON CONFLICT DO NOTHING).
//!
//! Run with:
//!     DATABASE_URL=<postgres url> cargo run --bin seed-data
//!
//! The DATABASE_URL here should be the POSTGRES-role URL (not render_app),
//! because seeding involves INSERTs without the RLS session var being set
//! by the app layer — we explicitly SET LOCAL for each tenant write.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signer, SigningKey};
use h3o::{LatLng, Resolution};
use rand::{rngs::StdRng, Rng, SeedableRng};
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tracing::{info, warn};
use uuid::Uuid;

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const TENANT_ID: &str = "00000000-0000-0000-0000-000000000001";
const H3_RESOLUTION: u8 = 9;
const DETERMINISTIC_SEED: u64 = 20260421;
const EPOCH_COUNT: i64 = 3;

/// Three Italian cities — (name, lat, lng, cells_per_epoch)
const CITIES: &[(&str, f64, f64, u32)] = &[
    ("roma", 41.9028, 12.4964, 15),
    ("milano", 45.4642, 9.1900, 10),
    ("napoli", 40.8518, 14.2681, 5),
];

/// Three substation identities — seeds are deterministic so signatures are
/// reproducible across runs (useful for debugging & fixtures).
const SUBSTATIONS: &[(&str, u64)] = &[
    ("substation_a_grid_north", 0xA000_0000_0000_0001),
    ("substation_b_grid_south", 0xB000_0000_0000_0002),
    ("substation_c_distribution_ring", 0xC000_0000_0000_0003),
];

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_target(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .context("DATABASE_URL must be set (use the postgres-role URL, not render_app)")?;

    let tenant: Uuid = TENANT_ID.parse()?;

    info!("connecting to database");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&database_url)
        .await
        .context("connect to database")?;

    info!("verifying seed tenant exists");
    verify_tenant_exists(&pool, &tenant).await?;

    // Generate substation keypairs deterministically
    let substations: Vec<(String, SigningKey)> = SUBSTATIONS
        .iter()
        .map(|(name, seed)| {
            let mut rng = StdRng::seed_from_u64(*seed);
            let mut key_bytes = [0u8; 32];
            rng.fill(&mut key_bytes);
            let signing_key = SigningKey::from_bytes(&key_bytes);
            (name.to_string(), signing_key)
        })
        .collect();

    info!(
        substation_count = substations.len(),
        "derived substation identities"
    );
    for (name, key) in &substations {
        let pk = key.verifying_key();
        info!(
            name = %name,
            pk = %hex::encode(pk.to_bytes()),
            "substation ready"
        );
    }

    // Generate cells across the three cities at resolution 9
    let mut rng = StdRng::seed_from_u64(DETERMINISTIC_SEED);
    let all_cells: Vec<u64> = CITIES
        .iter()
        .flat_map(|(city, lat, lng, count)| {
            generate_cells_around(*lat, *lng, H3_RESOLUTION, *count, &mut rng)
                .into_iter()
                .inspect(move |&c| {
                    tracing::debug!(city = %city, h3 = format!("{c:x}"), "generated cell");
                })
        })
        .collect();

    info!(cell_count = all_cells.len(), "cell fixtures prepared");

    // Write per-epoch
    let mut parent_root: Option<[u8; 32]> = None;
    for epoch_id in 0..EPOCH_COUNT {
        let sealed_at = base_time() + chrono::Duration::minutes(epoch_id * 30);

        info!(epoch_id, sealed_at = %sealed_at, "writing epoch");
        let new_root = write_epoch(
            &pool,
            &tenant,
            epoch_id,
            sealed_at,
            parent_root,
            &all_cells,
            &substations,
        )
        .await?;

        info!(
            epoch_id,
            merkle_root = %hex::encode(new_root),
            cells = all_cells.len(),
            "epoch sealed"
        );
        parent_root = Some(new_root);
    }

    info!(
        tenant = %tenant,
        epochs = EPOCH_COUNT,
        cells_per_epoch = all_cells.len(),
        total_rows = EPOCH_COUNT as usize * all_cells.len(),
        "seed complete"
    );

    Ok(())
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/// Generate `count` H3 cells clustered around (lat, lng) at the given resolution.
/// Randomness is injected via the shared RNG so the fixture is reproducible.
fn generate_cells_around(
    center_lat: f64,
    center_lng: f64,
    resolution: u8,
    count: u32,
    rng: &mut StdRng,
) -> Vec<u64> {
    let res = Resolution::try_from(resolution).expect("valid resolution 0-15");
    let center_cell: h3o::CellIndex = LatLng::new(center_lat, center_lng)
        .expect("valid lat/lng")
        .to_cell(res);

    // Use grid_disk with small k — produces a deterministic set; shuffle + take.
    let mut disk: Vec<h3o::CellIndex> = center_cell.grid_disk::<Vec<_>>(3);
    shuffle(&mut disk, rng);

    disk.into_iter()
        .take(count as usize)
        .map(u64::from)
        .collect()
}

/// Shuffle in-place using Fisher-Yates.
fn shuffle<T>(slice: &mut [T], rng: &mut StdRng) {
    for i in (1..slice.len()).rev() {
        let j = rng.gen_range(0..=i);
        slice.swap(i, j);
    }
}

/// Base time for fixtures — midday UTC on the seeding date.
fn base_time() -> DateTime<Utc> {
    chrono::DateTime::parse_from_rfc3339("2026-04-01T12:00:00Z")
        .expect("parse")
        .with_timezone(&Utc)
}

// -----------------------------------------------------------------------------
// Writer
// -----------------------------------------------------------------------------

/// Write all cell states for one epoch, compute the Merkle root, insert the
/// epoch row, and return the root.
async fn write_epoch(
    pool: &PgPool,
    tenant: &Uuid,
    epoch_id: i64,
    sealed_at: DateTime<Utc>,
    parent_root: Option<[u8; 32]>,
    cells: &[u64],
    substations: &[(String, SigningKey)],
) -> Result<[u8; 32]> {
    // Sort cells for deterministic Merkle root construction. This mirrors
    // how the render engine's merkle::proof_for builds the tree.
    let mut ordered: Vec<u64> = cells.to_vec();
    ordered.sort();

    let mut content_hashes: Vec<[u8; 32]> = Vec::with_capacity(ordered.len());

    // Single transaction for the whole epoch: cells + epoch row atomically.
    let mut tx = pool.begin().await?;

    // Set the tenant session var so any RLS policies fire correctly when this
    // role is non-superuser. Harmless when running as postgres (bypasses RLS).
    sqlx::query("SELECT set_config('app.current_tenant_id', $1, true)")
        .bind(tenant.to_string())
        .execute(&mut *tx)
        .await?;

    // Epoch row must exist before cell_states rows (FK constraint). Insert a
    // placeholder with a zero root; update it at the end with the real root.
    //
    // Actually we want transactional atomicity: use a DEFERRABLE constraint? No.
    // Simpler: compute Merkle root first (doesn't need DB), insert epoch, then
    // insert cells. The reason we can do it in this order: we sign each cell
    // off the content_hash of its payload, not off the Merkle root.

    // --- Phase 1: generate + hash + sign every cell's payload ---
    #[derive(Clone)]
    struct CellRow {
        h3: i64,
        identity_pk: [u8; 32],
        payload: serde_json::Value,
        content_hash: [u8; 32],
        signature: [u8; 64],
    }

    let mut rows: Vec<CellRow> = Vec::with_capacity(ordered.len());

    for (idx, &h3) in ordered.iter().enumerate() {
        // Pick a substation deterministically by cell index.
        let (_name, signing_key) = &substations[idx % substations.len()];
        let identity_pk = signing_key.verifying_key().to_bytes();

        // Payload: synthetic grid telemetry.
        let payload = json!({
            "epoch":           epoch_id,
            "measurement":     "grid_load_pu",
            "value":           load_for_cell(h3, epoch_id),
            "quality":         "measured",
            "unit":            "per_unit",
            "timestamp":       sealed_at.to_rfc3339(),
            "h3_resolution":   H3_RESOLUTION,
        });

        // Canonical JSON → blake3 content_hash
        let canonical = render_core::tools::canonical_json(&payload)
            .map_err(|e| anyhow::anyhow!("canonical_json: {e}"))?;
        let content_hash: [u8; 32] = *blake3::hash(canonical.as_bytes()).as_bytes();

        // Ed25519 sign the content_hash
        let signature: [u8; 64] = signing_key.sign(&content_hash).to_bytes();

        rows.push(CellRow {
            h3: h3 as i64,
            identity_pk,
            payload,
            content_hash,
            signature,
        });

        content_hashes.push(content_hash);
    }

    // --- Phase 2: Merkle root over sorted content_hashes ---
    let merkle_root = merkle_root(&content_hashes);

    // --- Phase 3: insert epoch row first (FK requirement) ---
    let parent = parent_root.map(|r| r.to_vec());
    let epoch_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM epochs WHERE tenant_id = $1 AND epoch_id = $2)",
    )
    .bind(tenant)
    .bind(epoch_id)
    .fetch_one(&mut *tx)
    .await?;

    if epoch_exists {
        warn!(
            epoch_id,
            "epoch already exists — skipping insert, cells will ON CONFLICT skip too"
        );
    } else {
        sqlx::query(
            r#"
            INSERT INTO epochs (tenant_id, epoch_id, sealed_at, merkle_root, parent_root, cell_count)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(tenant)
        .bind(epoch_id)
        .bind(sealed_at)
        .bind(merkle_root.to_vec())
        .bind(parent)
        .bind(rows.len() as i64)
        .execute(&mut *tx)
        .await?;
    }

    // --- Phase 4: insert cell_states (idempotent via ON CONFLICT) ---
    let mut inserted = 0usize;
    let mut skipped = 0usize;
    for row in &rows {
        let affected = sqlx::query(
            r#"
            INSERT INTO cell_states
                (tenant_id, h3_cell, epoch_id, identity_pk, payload, content_hash, signature)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (tenant_id, h3_cell, epoch_id) DO NOTHING
            "#,
        )
        .bind(tenant)
        .bind(row.h3)
        .bind(epoch_id)
        .bind(row.identity_pk.to_vec())
        .bind(&row.payload)
        .bind(row.content_hash.to_vec())
        .bind(row.signature.to_vec())
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if affected > 0 {
            inserted += 1;
        } else {
            skipped += 1;
        }
    }

    tx.commit().await?;

    info!(epoch_id, inserted, skipped, "cell inserts complete");

    Ok(merkle_root)
}

/// Verify the seed tenant row exists. If not, migration 0001 hasn't been applied.
async fn verify_tenant_exists(pool: &PgPool, tenant: &Uuid) -> Result<()> {
    // As postgres role we bypass RLS — this works regardless of session var.
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tenants WHERE tenant_id = $1)")
            .bind(tenant)
            .fetch_one(pool)
            .await?;
    if !exists {
        bail!("seed tenant {tenant} not found — apply migration 0001 first");
    }
    Ok(())
}

// -----------------------------------------------------------------------------
// Merkle root construction (matches mobydb_client::merkle order & pad rule)
// -----------------------------------------------------------------------------

/// Compute the Merkle root over an ordered list of 32-byte leaves.
/// Odd layers duplicate the last node (Bitcoin-style).
/// Empty input returns the zero hash.
fn merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
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

// -----------------------------------------------------------------------------
// Synthetic telemetry helper
// -----------------------------------------------------------------------------

/// Deterministic pseudo-random load value in [0.0, 1.5] per-unit, derived from
/// (h3_cell, epoch_id). Stable across runs.
fn load_for_cell(h3: u64, epoch_id: i64) -> f64 {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&h3.to_be_bytes());
    hasher.update(&epoch_id.to_be_bytes());
    let h = hasher.finalize();
    let b = h.as_bytes();
    let n = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
    // Map to [0.0, 1.5]
    (n as f64 / u32::MAX as f64) * 1.5
}
