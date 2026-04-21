//! seed-data — load synthetic grid telemetry into MobyDB for demo use.
//!
//! Writes ~850 H3 cells covering Italy across 10 epochs, signed by 11
//! per-city substation identities (10 cities + national overview), with
//! plausibly-shaped grid load values (diurnal cycle + small per-cell
//! noise + per-city baseline).
//!
//! Coverage:
//!   - 10 Italian cities: Milano, Torino, Venezia, Genova, Bologna,
//!     Firenze, Roma, Napoli, Bari, Palermo
//!   - H3 res 9 (~0.1 km²) around each city — ~800 detail cells total
//!   - H3 res 6 (~36 km²) national overview polyfill of Italy bbox
//!   - 10 epochs spanning 5 simulated days (morning + evening each day)
//!
//! Idempotent: re-running against a tenant that already has data at these
//! (tenant, h3, epoch) keys will ON CONFLICT DO NOTHING per row. For a
//! clean reseed, run scripts/ops/reseed_italy.sh first.
//!
//! Run:
//!   DATABASE_URL=<postgres-role URL> cargo run --bin seed-data

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signer, SigningKey};
use h3o::{CellIndex, LatLng, Resolution};
use rand::{rngs::StdRng, Rng, SeedableRng};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, QueryBuilder};
use tracing::{info, warn};
use uuid::Uuid;

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const TENANT_ID: &str = "00000000-0000-0000-0000-000000000001";
const DETERMINISTIC_SEED: u64 = 20260421;

/// 10 Italian cities with grid relevance. Fields:
/// `(slug, lat, lng, detail_cell_count, base_load_pu)`
const CITIES: &[(&str, f64, f64, u32, f64)] = &[
    ("milano", 45.4642, 9.1900, 120, 1.15),
    ("torino", 45.0703, 7.6869, 90, 1.00),
    ("venezia", 45.4408, 12.3155, 60, 0.75),
    ("genova", 44.4056, 8.9463, 70, 0.85),
    ("bologna", 44.4949, 11.3426, 80, 0.90),
    ("firenze", 43.7696, 11.2558, 70, 0.85),
    ("roma", 41.9028, 12.4964, 110, 1.10),
    ("napoli", 40.8518, 14.2681, 90, 1.00),
    ("bari", 41.1171, 16.8719, 55, 0.80),
    ("palermo", 38.1157, 13.3615, 65, 0.90),
];

const DETAIL_RESOLUTION: u8 = 9;
const OVERVIEW_RESOLUTION: u8 = 6;

/// Italy bounding box for the res-6 overview layer.
/// (lat_min, lat_max, lng_min, lng_max)
const ITALY_BBOX: (f64, f64, f64, f64) = (35.5, 47.1, 6.6, 18.6);

const EPOCH_COUNT: i64 = 10;

/// Batch size for INSERT — 100 rows × 7 bind params = 700 params per
/// statement, well under Postgres' ~32k limit.
const BATCH_SIZE: usize = 100;

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
        .context("DATABASE_URL must be set (postgres-role URL, not render_app)")?;

    let tenant: Uuid = TENANT_ID.parse()?;

    info!("connecting to database");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&database_url)
        .await
        .context("connect to database")?;

    verify_tenant_exists(&pool, &tenant).await?;

    let substations = derive_substations();
    info!(count = substations.len(), "substation identities ready");
    for (owner, key) in &substations {
        info!(
            owner = %owner,
            name = %substation_name(owner),
            pk = %hex::encode(key.verifying_key().to_bytes()),
            "substation"
        );
    }

    let mut rng = StdRng::seed_from_u64(DETERMINISTIC_SEED);
    let cells = generate_all_cells(&mut rng);
    info!(
        total_cells = cells.len(),
        detail_cells = cells
            .iter()
            .filter(|c| c.resolution == DETAIL_RESOLUTION)
            .count(),
        overview_cells = cells
            .iter()
            .filter(|c| c.resolution == OVERVIEW_RESOLUTION)
            .count(),
        "cell topology prepared"
    );

    let mut parent_root: Option<[u8; 32]> = None;
    for epoch_id in 0..EPOCH_COUNT {
        let sealed_at = epoch_sealed_at(epoch_id);
        info!(epoch_id, sealed_at = %sealed_at, "writing epoch");

        let root = write_epoch(
            &pool,
            &tenant,
            epoch_id,
            sealed_at,
            parent_root,
            &cells,
            &substations,
        )
        .await?;

        info!(
            epoch_id,
            merkle_root = %hex::encode(root),
            cells = cells.len(),
            "epoch sealed"
        );
        parent_root = Some(root);
    }

    info!(
        tenant = %tenant,
        epochs = EPOCH_COUNT,
        cells_per_epoch = cells.len(),
        total_rows = (EPOCH_COUNT as usize) * cells.len(),
        "seed complete"
    );

    Ok(())
}

// -----------------------------------------------------------------------------
// Cell generation
// -----------------------------------------------------------------------------

#[derive(Clone)]
struct SeedCell {
    h3: u64,
    resolution: u8,
    /// City slug (for detail cells) or "overview" for the res-6 layer.
    owner: String,
}

fn generate_all_cells(rng: &mut StdRng) -> Vec<SeedCell> {
    let mut out: Vec<SeedCell> = Vec::new();

    // Detail cells — per-city grid_disk clusters at res 9
    for (slug, lat, lng, count, _base) in CITIES {
        let res = Resolution::try_from(DETAIL_RESOLUTION).expect("valid resolution");
        let center: CellIndex = LatLng::new(*lat, *lng).expect("valid latlng").to_cell(res);
        // grid_disk(k) yields 3k²+3k+1 cells; solve for k given target count.
        let k = ((*count as f64 / 3.0).sqrt().ceil() as u32).max(4);
        let mut disk: Vec<CellIndex> = center.grid_disk::<Vec<_>>(k);
        shuffle(&mut disk, rng);
        for c in disk.into_iter().take(*count as usize) {
            out.push(SeedCell {
                h3: u64::from(c),
                resolution: DETAIL_RESOLUTION,
                owner: slug.to_string(),
            });
        }
    }

    // Overview cells — res-6 polyfill of Italy bounding box
    let overview = generate_overview_cells();
    for c in overview {
        out.push(SeedCell {
            h3: c,
            resolution: OVERVIEW_RESOLUTION,
            owner: "overview".to_string(),
        });
    }

    // Deduplicate (unlikely overlap but cheap guarantee)
    out.sort_by_key(|c| c.h3);
    out.dedup_by_key(|c| c.h3);
    out
}

/// Generate H3 res-6 cells covering the Italy bounding box via polyfill.
fn generate_overview_cells() -> Vec<u64> {
    use geo::{Coord, LineString, Polygon};
    use h3o::geom::{ContainmentMode, TilerBuilder};

    let (lat_min, lat_max, lng_min, lng_max) = ITALY_BBOX;
    let ring = LineString::from(vec![
        Coord {
            x: lng_min,
            y: lat_min,
        },
        Coord {
            x: lng_max,
            y: lat_min,
        },
        Coord {
            x: lng_max,
            y: lat_max,
        },
        Coord {
            x: lng_min,
            y: lat_max,
        },
        Coord {
            x: lng_min,
            y: lat_min,
        },
    ]);
    let poly = Polygon::new(ring, vec![]);
    let res = Resolution::try_from(OVERVIEW_RESOLUTION).expect("valid res");

    let mut tiler = TilerBuilder::new(res)
        .containment_mode(ContainmentMode::IntersectsBoundary)
        .build();
    tiler.add(poly).expect("add polygon to tiler");
    tiler.into_coverage().map(u64::from).collect()
}

fn shuffle<T>(slice: &mut [T], rng: &mut StdRng) {
    for i in (1..slice.len()).rev() {
        let j = rng.gen_range(0..=i);
        slice.swap(i, j);
    }
}

// -----------------------------------------------------------------------------
// Substation identities
// -----------------------------------------------------------------------------

fn derive_substations() -> HashMap<String, SigningKey> {
    let mut out = HashMap::new();
    for (slug, _, _, _, _) in CITIES {
        let mut rng = StdRng::seed_from_u64(substation_seed(slug));
        let mut key_bytes = [0u8; 32];
        rng.fill(&mut key_bytes);
        out.insert(slug.to_string(), SigningKey::from_bytes(&key_bytes));
    }
    let mut rng = StdRng::seed_from_u64(substation_seed("national_grid_operations"));
    let mut key_bytes = [0u8; 32];
    rng.fill(&mut key_bytes);
    out.insert("overview".to_string(), SigningKey::from_bytes(&key_bytes));
    out
}

fn substation_seed(slug: &str) -> u64 {
    let h = blake3::hash(slug.as_bytes());
    let b = h.as_bytes();
    u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
}

fn substation_name(owner: &str) -> String {
    if owner == "overview" {
        "substation_italy_national_grid".to_string()
    } else {
        format!("substation_{owner}_grid_primary")
    }
}

// -----------------------------------------------------------------------------
// Temporal structure
// -----------------------------------------------------------------------------

fn epoch_sealed_at(epoch_id: i64) -> DateTime<Utc> {
    let base = chrono::DateTime::parse_from_rfc3339("2026-04-01T06:00:00Z")
        .expect("parse base")
        .with_timezone(&Utc);
    base + chrono::Duration::hours(12 * epoch_id)
}

/// Morning epochs (even) = 0.85×, evening epochs (odd) = 1.20×.
fn diurnal_factor(epoch_id: i64) -> f64 {
    if epoch_id % 2 == 0 {
        0.85
    } else {
        1.20
    }
}

fn cell_value(cell: &SeedCell, epoch_id: i64) -> f64 {
    let base = city_base_load(&cell.owner);
    let diurnal = diurnal_factor(epoch_id);

    let mut hasher = blake3::Hasher::new();
    hasher.update(&cell.h3.to_be_bytes());
    hasher.update(&epoch_id.to_be_bytes());
    let h = hasher.finalize();
    let b = h.as_bytes();
    let n = u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64 / u32::MAX as f64;
    let noise = (n - 0.5) * 0.20;

    (base * diurnal * (1.0 + noise)).clamp(0.0, 2.0)
}

fn city_base_load(owner: &str) -> f64 {
    if owner == "overview" {
        return 0.95;
    }
    for (slug, _, _, _, base) in CITIES {
        if *slug == owner {
            return *base;
        }
    }
    0.80
}

// -----------------------------------------------------------------------------
// Writer
// -----------------------------------------------------------------------------

async fn write_epoch(
    pool: &PgPool,
    tenant: &Uuid,
    epoch_id: i64,
    sealed_at: DateTime<Utc>,
    parent_root: Option<[u8; 32]>,
    cells: &[SeedCell],
    substations: &HashMap<String, SigningKey>,
) -> Result<[u8; 32]> {
    // Canonical leaf order — matches how the server builds Merkle proofs.
    let mut ordered: Vec<&SeedCell> = cells.iter().collect();
    ordered.sort_by_key(|c| c.h3 as i64);

    struct Row<'a> {
        cell: &'a SeedCell,
        payload: Value,
        identity_pk: [u8; 32],
        content_hash: [u8; 32],
        signature: [u8; 64],
    }

    let mut rows: Vec<Row<'_>> = Vec::with_capacity(ordered.len());
    let mut content_hashes: Vec<[u8; 32]> = Vec::with_capacity(ordered.len());

    for cell in &ordered {
        let signing_key = substations
            .get(&cell.owner)
            .ok_or_else(|| anyhow::anyhow!("no substation for owner {}", cell.owner))?;
        let identity_pk = signing_key.verifying_key().to_bytes();

        let payload = json!({
            "measurement":   "grid_load_pu",
            "value":         cell_value(cell, epoch_id),
            "unit":          "per_unit",
            "quality":       "measured",
            "epoch":         epoch_id,
            "h3_resolution": cell.resolution,
            "owner":         cell.owner,
            "timestamp":     sealed_at.to_rfc3339(),
        });

        let canonical = render_core::tools::canonical_json(&payload)
            .map_err(|e| anyhow::anyhow!("canonical_json: {e}"))?;
        let content_hash: [u8; 32] = *blake3::hash(canonical.as_bytes()).as_bytes();
        let signature: [u8; 64] = signing_key.sign(&content_hash).to_bytes();

        rows.push(Row {
            cell,
            payload,
            identity_pk,
            content_hash,
            signature,
        });
        content_hashes.push(content_hash);
    }

    let merkle_root = merkle_root(&content_hashes);

    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.current_tenant_id', $1, true)")
        .bind(tenant.to_string())
        .execute(&mut *tx)
        .await?;

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
            "epoch already exists — skipping epoch insert; cell inserts will ON CONFLICT skip"
        );
    } else {
        sqlx::query(
            "INSERT INTO epochs (tenant_id, epoch_id, sealed_at, merkle_root, parent_root, cell_count) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(tenant)
        .bind(epoch_id)
        .bind(sealed_at)
        .bind(merkle_root.to_vec())
        .bind(parent_root.map(|r| r.to_vec()))
        .bind(rows.len() as i64)
        .execute(&mut *tx)
        .await?;
    }

    let mut inserted = 0usize;
    let mut skipped = 0usize;
    for chunk in rows.chunks(BATCH_SIZE) {
        let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
            "INSERT INTO cell_states \
             (tenant_id, h3_cell, epoch_id, identity_pk, payload, content_hash, signature) ",
        );
        qb.push_values(chunk, |mut b, row| {
            b.push_bind(tenant)
                .push_bind(row.cell.h3 as i64)
                .push_bind(epoch_id)
                .push_bind(row.identity_pk.to_vec())
                .push_bind(&row.payload)
                .push_bind(row.content_hash.to_vec())
                .push_bind(row.signature.to_vec());
        });
        qb.push(" ON CONFLICT (tenant_id, h3_cell, epoch_id) DO NOTHING");
        let affected = qb.build().execute(&mut *tx).await?.rows_affected() as usize;
        inserted += affected;
        skipped += chunk.len() - affected;
    }

    tx.commit().await?;

    info!(epoch_id, inserted, skipped, "cells written");
    Ok(merkle_root)
}

async fn verify_tenant_exists(pool: &PgPool, tenant: &Uuid) -> Result<()> {
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
// Merkle root
// -----------------------------------------------------------------------------

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
