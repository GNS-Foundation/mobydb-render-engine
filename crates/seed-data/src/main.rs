//! seed-data — ingest OSM power infrastructure into MobyDB.
//!
//! Reads `fixtures/osm/substations.geojson` (real OpenStreetMap substations in
//! Lazio + Lombardia) and seeds an H3 res-11 cell per substation across 10
//! epochs with synthetic grid-load telemetry.
//!
//! Each substation becomes its own Ed25519 identity, derived deterministically
//! from the OSM id. This means the `writer_pk` in every audit bundle maps back
//! to a specific real substation in the real grid — so clicking on a cell in
//! the demo and seeing `operator: Terna S.p.A.` or `operator: Acea Distribuzione`
//! is not synthetic framing, it's the genuine operator tag from OSM.
//!
//! Transmission lines (`fixtures/osm/transmission_lines.geojson`) are NOT
//! seeded as cells — they're polylines, rendered as an overlay by the demo
//! frontend directly from the GeoJSON.
//!
//! Idempotent: re-running ON CONFLICT DO NOTHING. For a clean reseed,
//! run `scripts/ops/reseed_italy.sh` first.
//!
//! Run:
//!   DATABASE_URL=<postgres-role URL> cargo run --bin seed-data

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signer, SigningKey};
use h3o::{CellIndex, LatLng, Resolution};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, QueryBuilder};
use tracing::{info, warn};
use uuid::Uuid;

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const TENANT_ID: &str = "00000000-0000-0000-0000-000000000001";
const H3_RESOLUTION: u8 = 11;
const EPOCH_COUNT: i64 = 10;

/// Batch size for INSERT — 100 rows × 7 bind params = 700 params per statement,
/// well under Postgres' ~32k parameter limit.
const BATCH_SIZE: usize = 100;

/// Path (relative to repo root) to the processed substations GeoJSON.
const SUBSTATIONS_FIXTURE: &str = "fixtures/osm/substations.geojson";

// -----------------------------------------------------------------------------
// GeoJSON types (minimal subset we need)
// -----------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct FeatureCollection {
    features: Vec<Feature>,
}

#[derive(Debug, Deserialize)]
struct Feature {
    geometry: Geometry,
    properties: SubstationProps,
}

#[derive(Debug, Deserialize)]
struct Geometry {
    #[serde(rename = "type")]
    _geom_type: String,
    /// Point geometries come in as [lon, lat]
    coordinates: [f64; 2],
}

#[derive(Debug, Deserialize, Clone)]
struct SubstationProps {
    osm_id: String,
    #[serde(default)]
    operator: Option<String>,
    #[serde(default)]
    #[serde(rename = "ref")]
    ref_: Option<String>,
    #[serde(default)]
    voltage: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    substation_type: Option<String>,
}

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

    // --- locate + load fixture ---
    let fixture_path = resolve_fixture_path(SUBSTATIONS_FIXTURE)?;
    info!(path = %fixture_path.display(), "loading OSM substations fixture");
    let fc: FeatureCollection = {
        let bytes = std::fs::read(&fixture_path)
            .with_context(|| format!("read fixture {}", fixture_path.display()))?;
        serde_json::from_slice(&bytes).context("parse substations.geojson")?
    };
    info!(count = fc.features.len(), "substations loaded");

    // --- convert features into seed units ---
    let substations = build_substations(&fc.features)?;
    info!(
        usable = substations.len(),
        discarded = fc.features.len() - substations.len(),
        "substations ready to seed"
    );

    // --- connect DB ---
    info!("connecting to database");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&database_url)
        .await
        .context("connect to database")?;

    verify_tenant_exists(&pool, &tenant).await?;

    // --- summary of operators we're about to seed ---
    log_operator_summary(&substations);

    // --- seed 10 epochs ---
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
            &substations,
        )
        .await?;

        info!(
            epoch_id,
            merkle_root = %hex::encode(root),
            cells = substations.len(),
            "epoch sealed"
        );
        parent_root = Some(root);
    }

    info!(
        tenant = %tenant,
        epochs = EPOCH_COUNT,
        cells_per_epoch = substations.len(),
        total_rows = (EPOCH_COUNT as usize) * substations.len(),
        "seed complete"
    );

    Ok(())
}

// -----------------------------------------------------------------------------
// Fixture resolution
// -----------------------------------------------------------------------------

/// Resolve `fixtures/osm/substations.geojson` relative to wherever the binary
/// was invoked. Walks up from CWD looking for the fixture, so it works from
/// the workspace root AND from the crate directory.
fn resolve_fixture_path(relative: &str) -> Result<PathBuf> {
    let mut cwd = std::env::current_dir().context("cwd")?;
    loop {
        let candidate = cwd.join(relative);
        if candidate.exists() {
            return Ok(candidate);
        }
        if !cwd.pop() {
            bail!(
                "could not find fixture `{relative}` (searched upward from CWD); \
                 run from repo root, or set CWD to a directory containing it"
            );
        }
    }
}

// -----------------------------------------------------------------------------
// Substation modelling
// -----------------------------------------------------------------------------

#[derive(Clone)]
struct Substation {
    osm_id: String,
    h3: u64,
    lat: f64,
    lon: f64,
    props: SubstationProps,
    signing_key: SigningKey,
    /// Mapped load baseline based on voltage class (0.7..1.2 range).
    base_load_pu: f64,
}

fn build_substations(features: &[Feature]) -> Result<Vec<Substation>> {
    let res = Resolution::try_from(H3_RESOLUTION).expect("valid H3 resolution");
    let mut out = Vec::with_capacity(features.len());

    for f in features {
        let [lon, lat] = f.geometry.coordinates;

        // Some OSM entries can have out-of-range coords; skip them
        let lat_lng = match LatLng::new(lat, lon) {
            Ok(ll) => ll,
            Err(_) => {
                warn!(osm_id = %f.properties.osm_id, lat, lon, "skipping invalid coords");
                continue;
            }
        };
        let cell: CellIndex = lat_lng.to_cell(res);

        // Deterministic signing key from osm_id — this is the key property that
        // makes the demo credible: `writer_pk` always maps back to the exact
        // same real-world substation.
        let signing_key = derive_signing_key(&f.properties.osm_id);

        // Base load heuristic from voltage tag (per-unit values). Higher
        // voltage classes carry higher load proxies.
        let base_load_pu = voltage_to_base_load(f.properties.voltage.as_deref());

        out.push(Substation {
            osm_id: f.properties.osm_id.clone(),
            h3: u64::from(cell),
            lat,
            lon,
            props: f.properties.clone(),
            signing_key,
            base_load_pu,
        });
    }

    // Deduplicate by H3 cell — multiple substations in the same res-11 cell
    // are rare but possible (e.g. a campus with two separate entries). Keep
    // first for now; a future improvement is to aggregate.
    out.sort_by_key(|s| s.h3);
    let before = out.len();
    out.dedup_by_key(|s| s.h3);
    let after = out.len();
    if before != after {
        info!(
            collapsed = before - after,
            "merged duplicates in same H3 cell"
        );
    }

    Ok(out)
}

/// Derive a deterministic Ed25519 keypair from a stable OSM identifier.
/// blake3(osm_id) → 32 bytes → SigningKey.
fn derive_signing_key(osm_id: &str) -> SigningKey {
    let h = blake3::hash(osm_id.as_bytes());
    let bytes: [u8; 32] = *h.as_bytes();
    SigningKey::from_bytes(&bytes)
}

/// Map voltage string (may be "380000", "132000;220000", etc.) to a base load.
/// Unknown voltages fall back to 0.90 (medium).
fn voltage_to_base_load(v: Option<&str>) -> f64 {
    let Some(s) = v else { return 0.90 };
    // Take the max voltage value if multiple are listed
    let max_kv = s
        .split(';')
        .filter_map(|part| part.trim().parse::<u64>().ok())
        .max()
        .map(|raw| raw / 1000)
        .unwrap_or(0);

    match max_kv {
        v if v >= 380 => 1.15,
        v if v >= 220 => 1.05,
        v if v >= 132 => 0.95,
        v if v >= 60 => 0.85,
        v if v >= 20 => 0.80,
        _ => 0.90,
    }
}

fn log_operator_summary(subs: &[Substation]) {
    use std::collections::BTreeMap;
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for s in subs {
        let key = s
            .props
            .operator
            .as_deref()
            .map(|o| o.to_string())
            .unwrap_or_else(|| "(unspecified)".to_string());
        *counts.entry(key).or_insert(0) += 1;
    }
    let mut sorted: Vec<_> = counts.into_iter().collect();
    sorted.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    info!("operator breakdown (top 10):");
    for (op, n) in sorted.iter().take(10) {
        info!("  {op:<40} {n}");
    }
}

// -----------------------------------------------------------------------------
// Temporal structure
// -----------------------------------------------------------------------------

/// Epoch 0 = 2026-04-01 06:00 UTC; +12h per epoch. 10 epochs = 5 days.
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

/// Synthetic grid_load_pu for a substation at an epoch.
/// = voltage_baseline × diurnal × (1 + small_per_cell_noise)
fn cell_value(sub: &Substation, epoch_id: i64) -> f64 {
    let diurnal = diurnal_factor(epoch_id);

    // Stable per-(cell, epoch) noise in [-0.10, +0.10]
    let mut hasher = blake3::Hasher::new();
    hasher.update(&sub.h3.to_be_bytes());
    hasher.update(&epoch_id.to_be_bytes());
    let h = hasher.finalize();
    let b = h.as_bytes();
    let n = u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64 / u32::MAX as f64;
    let noise = (n - 0.5) * 0.20;

    (sub.base_load_pu * diurnal * (1.0 + noise)).clamp(0.0, 2.0)
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
    substations: &[Substation],
) -> Result<[u8; 32]> {
    // Canonical leaf order — matches how the server builds Merkle proofs.
    let mut ordered: Vec<&Substation> = substations.iter().collect();
    ordered.sort_by_key(|s| s.h3 as i64);

    struct Row<'a> {
        sub: &'a Substation,
        payload: Value,
        identity_pk: [u8; 32],
        content_hash: [u8; 32],
        signature: [u8; 64],
    }

    let mut rows: Vec<Row<'_>> = Vec::with_capacity(ordered.len());
    let mut content_hashes: Vec<[u8; 32]> = Vec::with_capacity(ordered.len());

    for sub in &ordered {
        let identity_pk = sub.signing_key.verifying_key().to_bytes();

        // Payload mirrors the OSM tags the demo will surface in the audit panel,
        // plus the synthetic telemetry value.
        let mut payload = json!({
            "asset_class":    "substation",
            "measurement":    "grid_load_pu",
            "value":          cell_value(sub, epoch_id),
            "unit":           "per_unit",
            "quality":        "simulated_on_real_topology",
            "epoch":          epoch_id,
            "h3_resolution":  H3_RESOLUTION,
            "timestamp":      sealed_at.to_rfc3339(),
            "osm_id":         sub.osm_id,
            "location": {
                "lat": sub.lat,
                "lon": sub.lon,
            },
        });

        // Conditionally add OSM operator/ref/voltage/name/type so the
        // audit panel can show "operator: Terna S.p.A. · ref: XYZ · 380 kV"
        if let Value::Object(ref mut map) = payload {
            if let Some(op) = &sub.props.operator {
                map.insert("operator".into(), Value::String(op.clone()));
            }
            if let Some(rf) = &sub.props.ref_ {
                map.insert("ref".into(), Value::String(rf.clone()));
            }
            if let Some(v) = &sub.props.voltage {
                map.insert("voltage".into(), Value::String(v.clone()));
            }
            if let Some(name) = &sub.props.name {
                map.insert("name".into(), Value::String(name.clone()));
            }
            if let Some(st) = &sub.props.substation_type {
                map.insert("substation_type".into(), Value::String(st.clone()));
            }
        }

        let canonical = render_core::tools::canonical_json(&payload)
            .map_err(|e| anyhow::anyhow!("canonical_json: {e}"))?;
        let content_hash: [u8; 32] = *blake3::hash(canonical.as_bytes()).as_bytes();
        let signature: [u8; 64] = sub.signing_key.sign(&content_hash).to_bytes();

        rows.push(Row {
            sub,
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
            "epoch already exists — skipping epoch insert; cell inserts ON CONFLICT skip"
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
                .push_bind(row.sub.h3 as i64)
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
// Merkle root (same as before)
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
