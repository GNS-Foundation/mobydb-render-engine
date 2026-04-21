//! Postgres implementation of `MobyDbClient`.
//!
//! RLS protocol: every public method starts a transaction, sets the session
//! variable `app.current_tenant_id` to the tenant UUID, then runs the query.
//! The RLS policies on the tables (see `0001_initial_schema.sql`) filter rows
//! by that variable. If the variable isn't set, policies return zero rows —
//! fail closed.
//!
//! The session variable name is configurable via env (`TENANCY_SESSION_VAR`)
//! but defaults to `app.current_tenant_id`. We capture it at construction.

use async_trait::async_trait;
use sqlx::postgres::{PgPoolOptions, PgRow};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::time::Duration;
use tracing::instrument;

use render_core::{
    Attestation, CellState, CoreError, CoreResult, Epoch, EpochId, H3Cell,
    HexBytes32, HexBytes64, MobyDbClient, Provenance, TenantId, Viewport,
};

use crate::merkle;

// -----------------------------------------------------------------------------
// PostgresMobyDb
// -----------------------------------------------------------------------------

pub struct PostgresMobyDb {
    pool:               PgPool,
    tenancy_session_var: String,
}

pub struct Config {
    pub database_url:        String,
    pub pool_max:            u32,
    pub pool_min:            u32,
    pub connect_timeout:     Duration,
    pub idle_timeout:        Option<Duration>,
    pub tenancy_session_var: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            database_url:        std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://localhost/mobydb_render".into()),
            pool_max:            20,
            pool_min:            2,
            connect_timeout:     Duration::from_secs(10),
            idle_timeout:        Some(Duration::from_secs(300)),
            tenancy_session_var: "app.current_tenant_id".into(),
        }
    }
}

impl PostgresMobyDb {
    pub async fn connect(cfg: Config) -> anyhow::Result<Self> {
        // Defensive: validate session var name — only [a-z0-9_.] allowed.
        // It's interpolated into SET LOCAL statements; SQL injection here
        // would be catastrophic.
        if !cfg.tenancy_session_var.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.') {
            anyhow::bail!(
                "invalid tenancy session variable name: {}",
                cfg.tenancy_session_var
            );
        }

        let pool = PgPoolOptions::new()
            .max_connections(cfg.pool_max)
            .min_connections(cfg.pool_min)
            .acquire_timeout(cfg.connect_timeout)
            .idle_timeout(cfg.idle_timeout)
            .connect(&cfg.database_url)
            .await?;

        Ok(Self {
            pool,
            tenancy_session_var: cfg.tenancy_session_var,
        })
    }

    pub fn pool(&self) -> &PgPool { &self.pool }

    pub async fn run_migrations(&self) -> anyhow::Result<()> {
        sqlx::migrate!("../../migrations").run(&self.pool).await?;
        Ok(())
    }

    /// Open a transaction and set the RLS tenant session variable.
    /// This is the *only* way queries should hit the pool in this crate.
    async fn tx_with_tenant(
        &self,
        tenant: &TenantId,
    ) -> CoreResult<Transaction<'_, Postgres>> {
        let mut tx = self.pool.begin().await.map_err(db_err)?;
        // Using SET LOCAL: scoped to this transaction only. Safer than
        // SET SESSION because pooled connections are reused across tenants.
        //
        // We format the session var name (already validated in connect()) but
        // bind the tenant_id as a parameter. set_config() is also a safer
        // alternative because it takes a string value.
        let sql = format!(
            "SELECT set_config('{}', $1, true)",
            self.tenancy_session_var
        );
        sqlx::query(&sql)
            .bind(tenant.as_uuid().to_string())
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        Ok(tx)
    }
}

// -----------------------------------------------------------------------------
// Error mapping
// -----------------------------------------------------------------------------

fn db_err<E: std::fmt::Display>(e: E) -> CoreError {
    CoreError::Database(e.to_string())
}

// -----------------------------------------------------------------------------
// Row decoders
// -----------------------------------------------------------------------------

fn decode_cell_state(row: &PgRow) -> CoreResult<CellState> {
    let tenant_uuid: uuid::Uuid = row.try_get("tenant_id").map_err(db_err)?;
    let h3_i64: i64 = row.try_get("h3_cell").map_err(db_err)?;
    let epoch_i64: i64 = row.try_get("epoch_id").map_err(db_err)?;
    let identity_pk: Vec<u8> = row.try_get("identity_pk").map_err(db_err)?;
    let payload: serde_json::Value = row.try_get("payload").map_err(db_err)?;
    let content_hash: Vec<u8> = row.try_get("content_hash").map_err(db_err)?;
    let signature: Vec<u8> = row.try_get("signature").map_err(db_err)?;
    let written_at: chrono::DateTime<chrono::Utc> =
        row.try_get("written_at").map_err(db_err)?;

    Ok(CellState {
        tenant_id:    TenantId::new(tenant_uuid),
        h3_cell:      H3Cell::from_i64(h3_i64),
        epoch_id:     EpochId::new(epoch_i64),
        identity_pk:  HexBytes32::from_slice(&identity_pk)?,
        payload,
        content_hash: HexBytes32::from_slice(&content_hash)?,
        signature:    HexBytes64::from_slice(&signature)?,
        written_at,
    })
}

fn decode_epoch(row: &PgRow) -> CoreResult<Epoch> {
    let tenant_uuid: uuid::Uuid = row.try_get("tenant_id").map_err(db_err)?;
    let epoch_i64: i64 = row.try_get("epoch_id").map_err(db_err)?;
    let sealed_at: chrono::DateTime<chrono::Utc> =
        row.try_get("sealed_at").map_err(db_err)?;
    let merkle_root: Vec<u8> = row.try_get("merkle_root").map_err(db_err)?;
    let parent_root: Option<Vec<u8>> = row.try_get("parent_root").map_err(db_err)?;
    let cell_count: i64 = row.try_get("cell_count").map_err(db_err)?;

    Ok(Epoch {
        tenant_id:   TenantId::new(tenant_uuid),
        epoch_id:    EpochId::new(epoch_i64),
        sealed_at,
        merkle_root: HexBytes32::from_slice(&merkle_root)?,
        parent_root: parent_root
            .map(|b| HexBytes32::from_slice(&b))
            .transpose()?,
        cell_count,
    })
}

fn decode_attestation(row: &PgRow) -> CoreResult<Attestation> {
    let attestation_id: uuid::Uuid = row.try_get("attestation_id").map_err(db_err)?;
    let tenant_uuid:    uuid::Uuid = row.try_get("tenant_id").map_err(db_err)?;
    let h3_i64:         i64 = row.try_get("h3_cell").map_err(db_err)?;
    let epoch_i64:      i64 = row.try_get("epoch_id").map_err(db_err)?;
    let attester_pk:    Vec<u8> = row.try_get("attester_pk").map_err(db_err)?;
    let claim:          serde_json::Value = row.try_get("claim").map_err(db_err)?;
    let claim_hash:     Vec<u8> = row.try_get("claim_hash").map_err(db_err)?;
    let signature:      Vec<u8> = row.try_get("signature").map_err(db_err)?;
    let issued_at:      chrono::DateTime<chrono::Utc> =
        row.try_get("issued_at").map_err(db_err)?;
    let expires_at:     Option<chrono::DateTime<chrono::Utc>> =
        row.try_get("expires_at").map_err(db_err)?;

    Ok(Attestation {
        attestation_id,
        tenant_id:   TenantId::new(tenant_uuid),
        h3_cell:     H3Cell::from_i64(h3_i64),
        epoch_id:    EpochId::new(epoch_i64),
        attester_pk: HexBytes32::from_slice(&attester_pk)?,
        claim,
        claim_hash:  HexBytes32::from_slice(&claim_hash)?,
        signature:   HexBytes64::from_slice(&signature)?,
        issued_at,
        expires_at,
    })
}

// -----------------------------------------------------------------------------
// Trait impl
// -----------------------------------------------------------------------------

#[async_trait]
impl MobyDbClient for PostgresMobyDb {
    #[instrument(skip(self))]
    async fn latest_epoch(&self, tenant: &TenantId) -> CoreResult<Epoch> {
        let mut tx = self.tx_with_tenant(tenant).await?;
        let row = sqlx::query(
            r#"
            SELECT tenant_id, epoch_id, sealed_at, merkle_root, parent_root, cell_count
              FROM epochs
             WHERE tenant_id = $1
             ORDER BY epoch_id DESC
             LIMIT 1
            "#,
        )
        .bind(tenant.as_uuid())
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_err)?;

        tx.commit().await.map_err(db_err)?;

        match row {
            Some(r) => decode_epoch(&r),
            None => Err(CoreError::EpochNotFound {
                tenant: tenant.to_string(),
                epoch:  -1,
            }),
        }
    }

    #[instrument(skip(self))]
    async fn get_epoch(&self, tenant: &TenantId, epoch: EpochId) -> CoreResult<Epoch> {
        let mut tx = self.tx_with_tenant(tenant).await?;
        let row = sqlx::query(
            r#"
            SELECT tenant_id, epoch_id, sealed_at, merkle_root, parent_root, cell_count
              FROM epochs
             WHERE tenant_id = $1 AND epoch_id = $2
            "#,
        )
        .bind(tenant.as_uuid())
        .bind(epoch.as_i64())
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_err)?;

        tx.commit().await.map_err(db_err)?;

        match row {
            Some(r) => decode_epoch(&r),
            None => Err(CoreError::EpochNotFound {
                tenant: tenant.to_string(),
                epoch:  epoch.as_i64(),
            }),
        }
    }

    #[instrument(skip(self))]
    async fn get_cell_state(
        &self,
        tenant: &TenantId,
        h3: H3Cell,
        epoch: Option<EpochId>,
    ) -> CoreResult<Option<CellState>> {
        let mut tx = self.tx_with_tenant(tenant).await?;

        let row = match epoch {
            Some(e) => {
                sqlx::query(
                    r#"
                    SELECT tenant_id, h3_cell, epoch_id, identity_pk, payload,
                           content_hash, signature, written_at
                      FROM cell_states
                     WHERE tenant_id = $1 AND h3_cell = $2 AND epoch_id = $3
                    "#,
                )
                .bind(tenant.as_uuid())
                .bind(h3.as_i64())
                .bind(e.as_i64())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db_err)?
            }
            None => {
                sqlx::query(
                    r#"
                    SELECT tenant_id, h3_cell, epoch_id, identity_pk, payload,
                           content_hash, signature, written_at
                      FROM cell_states
                     WHERE tenant_id = $1 AND h3_cell = $2
                     ORDER BY epoch_id DESC
                     LIMIT 1
                    "#,
                )
                .bind(tenant.as_uuid())
                .bind(h3.as_i64())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db_err)?
            }
        };

        tx.commit().await.map_err(db_err)?;

        match row {
            Some(r) => Ok(Some(decode_cell_state(&r)?)),
            None => Ok(None),
        }
    }

    #[instrument(skip(self))]
    async fn query_cells_in_region(
        &self,
        tenant: &TenantId,
        viewport: &Viewport,
        epoch: Option<EpochId>,
        limit: usize,
    ) -> CoreResult<Vec<CellState>> {
        // Resolve viewport → list of H3 cells. This is done in-process via h3o
        // rather than in SQL (Postgres doesn't know H3).
        let cells = viewport_to_cells(viewport)?;

        if cells.len() > limit {
            return Err(CoreError::ViewportTooLarge {
                requested: cells.len(),
                max:       limit,
            });
        }

        if cells.is_empty() {
            return Ok(vec![]);
        }

        let cell_ids_i64: Vec<i64> = cells.iter().map(|c| c.as_i64()).collect();

        let mut tx = self.tx_with_tenant(tenant).await?;

        // Two query paths:
        //   * epoch pinned: straightforward IN(...) at that epoch.
        //   * latest per cell: DISTINCT ON (h3_cell) with ORDER BY h3, epoch DESC.
        let rows = match epoch {
            Some(e) => {
                sqlx::query(
                    r#"
                    SELECT tenant_id, h3_cell, epoch_id, identity_pk, payload,
                           content_hash, signature, written_at
                      FROM cell_states
                     WHERE tenant_id = $1 AND h3_cell = ANY($2) AND epoch_id = $3
                    "#,
                )
                .bind(tenant.as_uuid())
                .bind(&cell_ids_i64[..])
                .bind(e.as_i64())
                .fetch_all(&mut *tx)
                .await
                .map_err(db_err)?
            }
            None => {
                sqlx::query(
                    r#"
                    SELECT DISTINCT ON (h3_cell)
                           tenant_id, h3_cell, epoch_id, identity_pk, payload,
                           content_hash, signature, written_at
                      FROM cell_states
                     WHERE tenant_id = $1 AND h3_cell = ANY($2)
                     ORDER BY h3_cell, epoch_id DESC
                    "#,
                )
                .bind(tenant.as_uuid())
                .bind(&cell_ids_i64[..])
                .fetch_all(&mut *tx)
                .await
                .map_err(db_err)?
            }
        };

        tx.commit().await.map_err(db_err)?;

        rows.iter().map(decode_cell_state).collect()
    }

    #[instrument(skip(self))]
    async fn get_provenance(
        &self,
        tenant: &TenantId,
        h3: H3Cell,
        epoch: EpochId,
    ) -> CoreResult<Provenance> {
        let mut tx = self.tx_with_tenant(tenant).await?;

        // 1. cell state
        let cell_row = sqlx::query(
            r#"
            SELECT tenant_id, h3_cell, epoch_id, identity_pk, payload,
                   content_hash, signature, written_at
              FROM cell_states
             WHERE tenant_id = $1 AND h3_cell = $2 AND epoch_id = $3
            "#,
        )
        .bind(tenant.as_uuid())
        .bind(h3.as_i64())
        .bind(epoch.as_i64())
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_err)?
        .ok_or_else(|| CoreError::CellNotFound {
            tenant: tenant.to_string(),
            h3:     h3.as_u64(),
            epoch:  Some(epoch.as_i64()),
        })?;

        let cell_state = decode_cell_state(&cell_row)?;

        // 2. attestations
        let atts: Vec<Attestation> = sqlx::query(
            r#"
            SELECT attestation_id, tenant_id, h3_cell, epoch_id,
                   attester_pk, claim, claim_hash, signature, issued_at, expires_at
              FROM attestations
             WHERE tenant_id = $1 AND h3_cell = $2 AND epoch_id = $3
             ORDER BY issued_at ASC
            "#,
        )
        .bind(tenant.as_uuid())
        .bind(h3.as_i64())
        .bind(epoch.as_i64())
        .fetch_all(&mut *tx)
        .await
        .map_err(db_err)?
        .iter()
        .map(decode_attestation)
        .collect::<CoreResult<_>>()?;

        // 3. epoch
        let epoch_row = sqlx::query(
            r#"
            SELECT tenant_id, epoch_id, sealed_at, merkle_root, parent_root, cell_count
              FROM epochs
             WHERE tenant_id = $1 AND epoch_id = $2
            "#,
        )
        .bind(tenant.as_uuid())
        .bind(epoch.as_i64())
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?;
        let epoch_meta = decode_epoch(&epoch_row)?;

        // 4. merkle proof — fetch all content_hashes at this epoch ordered
        //    deterministically, then construct the path.
        let all_hashes: Vec<(i64, Vec<u8>)> = sqlx::query(
            r#"
            SELECT h3_cell, content_hash
              FROM cell_states
             WHERE tenant_id = $1 AND epoch_id = $2
             ORDER BY h3_cell ASC
            "#,
        )
        .bind(tenant.as_uuid())
        .bind(epoch.as_i64())
        .fetch_all(&mut *tx)
        .await
        .map_err(db_err)?
        .into_iter()
        .map(|r| {
            let h3: i64 = r.try_get("h3_cell").map_err(db_err)?;
            let hash: Vec<u8> = r.try_get("content_hash").map_err(db_err)?;
            Ok::<_, CoreError>((h3, hash))
        })
        .collect::<CoreResult<_>>()?;

        tx.commit().await.map_err(db_err)?;

        let merkle_proof = merkle::proof_for(&all_hashes, h3.as_i64())?;

        Ok(Provenance {
            tenant_id:    *tenant,
            h3_cell:      h3,
            epoch_id:     epoch,
            cell_state,
            attestations: atts,
            merkle_proof,
            epoch:        epoch_meta,
        })
    }

    #[instrument(skip(self))]
    async fn list_attestations(
        &self,
        tenant: &TenantId,
        h3: H3Cell,
        epoch: EpochId,
    ) -> CoreResult<Vec<Attestation>> {
        let mut tx = self.tx_with_tenant(tenant).await?;
        let rows = sqlx::query(
            r#"
            SELECT attestation_id, tenant_id, h3_cell, epoch_id,
                   attester_pk, claim, claim_hash, signature, issued_at, expires_at
              FROM attestations
             WHERE tenant_id = $1 AND h3_cell = $2 AND epoch_id = $3
             ORDER BY issued_at ASC
            "#,
        )
        .bind(tenant.as_uuid())
        .bind(h3.as_i64())
        .bind(epoch.as_i64())
        .fetch_all(&mut *tx)
        .await
        .map_err(db_err)?;
        tx.commit().await.map_err(db_err)?;
        rows.iter().map(decode_attestation).collect()
    }

    #[instrument(skip(self))]
    async fn health(&self) -> CoreResult<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(db_err)
    }
}

// -----------------------------------------------------------------------------
// Viewport → H3 cells
// -----------------------------------------------------------------------------

/// Resolve a viewport spec to the list of H3 cells it contains.
///
/// v0.1 implementation strategy:
/// * `ParentCell` — uses `h3o::CellIndex::children` (exact, stable API).
/// * `BoundingBox` — approximates by taking the bbox center, converting to
///   an H3 cell at the target resolution, then a `grid_disk` of k rings
///   large enough to cover the bbox diagonal. This is an over-approximation
///   (we may return cells slightly outside the bbox) but is fast, robust
///   across h3o minor versions, and caller-filterable. Precise polygon
///   coverage (h3o::geom) is a v0.2 target once the geom API stabilizes.
fn viewport_to_cells(v: &Viewport) -> CoreResult<Vec<H3Cell>> {
    use h3o::{CellIndex, LatLng as H3LatLng, Resolution};

    match v {
        Viewport::ParentCell { parent, target_resolution } => {
            let res = Resolution::try_from(*target_resolution)
                .map_err(|_| CoreError::InvalidH3Resolution(*target_resolution))?;
            let parent_cell = CellIndex::try_from(parent.as_u64())
                .map_err(|e| CoreError::InvalidH3Cell(e.to_string()))?;
            if parent_cell.resolution() > res {
                return Err(CoreError::Other(format!(
                    "target_resolution {} is coarser than parent resolution {}",
                    u8::from(res),
                    u8::from(parent_cell.resolution()),
                )));
            }
            Ok(parent_cell
                .children(res)
                .map(|c| H3Cell::new(u64::from(c)))
                .collect())
        }
        Viewport::BoundingBox { south_west, north_east, resolution } => {
            let res = Resolution::try_from(*resolution)
                .map_err(|_| CoreError::InvalidH3Resolution(*resolution))?;

            let center_lat = (south_west.lat + north_east.lat) / 2.0;
            let center_lng = (south_west.lng + north_east.lng) / 2.0;
            let center = H3LatLng::new(center_lat, center_lng)
                .map_err(|e| CoreError::Other(format!("invalid lat/lng: {e}")))?
                .to_cell(res);

            // Edge length at this resolution (km). Use it to size the disk.
            // Average edge length table — conservative upper bounds.
            let edge_km = avg_edge_km(u8::from(res));

            // Bbox diagonal in km (rough — treats lat/lng as planar)
            let dlat_km = (north_east.lat - south_west.lat).abs() * 111.0;
            let dlng_km = (north_east.lng - south_west.lng).abs()
                * 111.0 * (center_lat.to_radians().cos().max(0.01));
            let diag_km = (dlat_km * dlat_km + dlng_km * dlng_km).sqrt();

            // k rings to cover the diagonal. +1 margin for rounding.
            let k = ((diag_km / (edge_km * 2.0)).ceil() as u32) + 1;

            let cells: Vec<_> = center
                .grid_disk::<Vec<_>>(k)
                .into_iter()
                .map(|c| H3Cell::new(u64::from(c)))
                .collect();

            Ok(cells)
        }
    }
}

/// Approximate average edge length (km) for each H3 resolution.
/// Source: H3 documentation. Used only for grid_disk sizing.
fn avg_edge_km(res: u8) -> f64 {
    const EDGES_KM: [f64; 16] = [
        1107.712591, 418.676005, 158.244656, 59.810858, 22.606379,
        8.544408,    3.229483,   1.220630,   0.461355,  0.174376,
        0.065908,    0.024911,   0.009415,   0.003560,  0.001349,
        0.000509,
    ];
    EDGES_KM.get(res as usize).copied().unwrap_or(0.0005)
}
