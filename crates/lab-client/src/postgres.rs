//! Postgres / sqlx implementation of `LabClient`.
//!
//! Connects to the GEIANT Lab's Supabase via a pooled sqlx connection.
//! All queries are read-only; the `LAB_DATABASE_URL` should point to a
//! role with `SELECT` only on `public.predictions`.
//!
//! ## Cryptographic note on timestamp formatting
//!
//! The `acquisition_timestamp` and `signed_at` fields are part of the
//! canonically-signed content. The lab's Python signer formats them via
//! `datetime.isoformat()` on a tz-aware UTC datetime, which produces
//! exactly:
//!
//! ```text
//! 2026-02-13T10:09:09.832000+00:00
//! ```
//!
//! Note specifically:
//!   - `T` separator, not space
//!   - exactly 6 microsecond digits, zero-padded
//!   - literal `+00:00` suffix (NOT `Z`, NOT `UTC`)
//!
//! `chrono`'s `to_rfc3339()` produces `2026-02-13T10:09:09.832000Z` instead
//! — the trailing `Z` would break offline signature verification by even
//! one byte. We use a hand-rolled format string to match Python exactly.
//! See `format_canonical_ts`.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow};
use sqlx::Row;
use std::str::FromStr;
use std::time::Duration;
use tracing::{debug, info};

use crate::{
    CellEpochPair, H3CellHex, InputAttestation, LabClient, LabClientError,
    LabClientResult, ModelAttestation, OutputAttestation, RuntimeFingerprint,
    SignedPredictionRecord,
};

const HARD_LIMIT_MAX: u32 = 1000;

/// Configuration for constructing a `PostgresLabClient`.
pub struct Config {
    /// Postgres connection string. Recommended: a Supabase role with
    /// `SELECT` only on `public.predictions`.
    pub database_url: String,
    /// Max connections in the pool. Default 5 — read-only, low traffic.
    pub pool_max: u32,
    /// Connect timeout. Default 5s.
    pub connect_timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            database_url: String::new(),
            pool_max: 5,
            connect_timeout: Duration::from_secs(5),
        }
    }
}

pub struct PostgresLabClient {
    pool: PgPool,
}

impl PostgresLabClient {
    /// Create a new client by connecting to the lab database.
    pub async fn connect(cfg: Config) -> LabClientResult<Self> {
        if cfg.database_url.is_empty() {
            return Err(LabClientError::Configuration(
                "database_url is empty".into(),
            ));
        }

        info!(pool_max = cfg.pool_max, "connecting to lab database");

        // Supabase transaction-mode poolers (port 6543) reuse backend
        // connections across transactions, which breaks sqlx's per-connection
        // prepared-statement cache (collisions on names like "sqlx_s_1").
        // Disable the cache for this client. Performance impact is negligible
        // for our query volume (a few queries per render-engine request).
        let opts = PgConnectOptions::from_str(&cfg.database_url)
            .map_err(|e| LabClientError::Configuration(format!(
                "invalid database_url: {e}"
            )))?
            .statement_cache_capacity(0);

        let pool = PgPoolOptions::new()
            .max_connections(cfg.pool_max)
            .acquire_timeout(cfg.connect_timeout)
            .connect_with(opts)
            .await?;

        let client = Self { pool };
        // Sanity-check the connection + presence of the `predictions` table
        // before declaring this client healthy. Surfaces config mistakes
        // (wrong DB, wrong role, missing table) at construction time
        // rather than at first request.
        client.health().await?;
        info!("lab database connection ready");
        Ok(client)
    }

    /// Expose the underlying pool for callers that need to reuse it
    /// (e.g. ad-hoc queries in tests). Production callers should go
    /// through the trait methods.
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}

#[async_trait]
impl LabClient for PostgresLabClient {
    async fn fetch_signed_predictions(
        &self,
        h3_cell: &str,
        epoch: Option<i64>,
        model_version: Option<&str>,
        limit: u32,
        include_chain: bool,
    ) -> LabClientResult<Vec<SignedPredictionRecord>> {
        validate_h3_cell(h3_cell)?;
        if let Some(mv) = model_version {
            validate_model_version(mv)?;
        }
        validate_limit(limit)?;

        // Build the query dynamically based on which optional filters
        // are set. We fall through to the `else` branch when both
        // filters are omitted, which is the most permissive case (most
        // recent records for the cell across all epochs and models).
        let rows: Vec<PgRow> = match (epoch, model_version) {
            (Some(ep), Some(mv)) => {
                sqlx::query(
                    "SELECT * FROM predictions \
                     WHERE h3_cell = $1 AND epoch = $2 AND model_version = $3 \
                     ORDER BY epoch DESC, model_version ASC LIMIT $4",
                )
                .bind(h3_cell)
                .bind(ep)
                .bind(mv)
                .bind(limit as i64)
                .fetch_all(&self.pool)
                .await?
            }
            (Some(ep), None) => {
                sqlx::query(
                    "SELECT * FROM predictions \
                     WHERE h3_cell = $1 AND epoch = $2 \
                     ORDER BY epoch DESC, model_version ASC LIMIT $3",
                )
                .bind(h3_cell)
                .bind(ep)
                .bind(limit as i64)
                .fetch_all(&self.pool)
                .await?
            }
            (None, Some(mv)) => {
                sqlx::query(
                    "SELECT * FROM predictions \
                     WHERE h3_cell = $1 AND model_version = $2 \
                     ORDER BY epoch DESC, model_version ASC LIMIT $3",
                )
                .bind(h3_cell)
                .bind(mv)
                .bind(limit as i64)
                .fetch_all(&self.pool)
                .await?
            }
            (None, None) => {
                sqlx::query(
                    "SELECT * FROM predictions \
                     WHERE h3_cell = $1 \
                     ORDER BY epoch DESC, model_version ASC LIMIT $2",
                )
                .bind(h3_cell)
                .bind(limit as i64)
                .fetch_all(&self.pool)
                .await?
            }
        };

        debug!(rows = rows.len(), "fetched signed predictions");

        rows.into_iter()
            .map(|row| row_to_record(row, include_chain))
            .collect()
    }

    async fn list_cells_for_model(
        &self,
        model_version: &str,
        limit: u32,
    ) -> LabClientResult<Vec<CellEpochPair>> {
        validate_model_version(model_version)?;
        validate_limit(limit)?;

        let rows = sqlx::query(
            "SELECT h3_cell, epoch FROM predictions \
             WHERE model_version = $1 \
             ORDER BY h3_cell ASC, epoch ASC LIMIT $2",
        )
        .bind(model_version)
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await?;

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let h3_str: String = row.try_get("h3_cell").map_err(decoding)?;
            let h3 = H3CellHex::from_str(&h3_str).ok_or_else(|| {
                LabClientError::Decoding(format!(
                    "invalid h3_cell from DB: {h3_str}"
                ))
            })?;
            out.push(CellEpochPair {
                h3_cell: h3,
                epoch: row.try_get("epoch").map_err(decoding)?,
            });
        }
        Ok(out)
    }

    async fn health(&self) -> LabClientResult<()> {
        // A single-row sanity probe: confirm the table exists AND we can
        // SELECT from it under the configured role.
        let _: i64 = sqlx::query_scalar("SELECT 1::bigint")
            .fetch_one(&self.pool)
            .await?;
        let _: Option<i64> = sqlx::query_scalar(
            "SELECT 1::bigint FROM predictions LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn validate_h3_cell(s: &str) -> LabClientResult<()> {
    if s.len() != 15 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(LabClientError::InvalidH3Cell(s.to_string()));
    }
    Ok(())
}

fn validate_model_version(s: &str) -> LabClientResult<()> {
    if s.is_empty() || s.len() > 200 {
        return Err(LabClientError::InvalidModelVersion(s.to_string()));
    }
    Ok(())
}

fn validate_limit(n: u32) -> LabClientResult<()> {
    if n == 0 || n > HARD_LIMIT_MAX {
        return Err(LabClientError::LimitOutOfRange {
            requested: n,
            max: HARD_LIMIT_MAX,
        });
    }
    Ok(())
}

fn decoding(e: sqlx::Error) -> LabClientError {
    LabClientError::Decoding(e.to_string())
}

// ---------------------------------------------------------------------------
// Row decoder
// ---------------------------------------------------------------------------

fn row_to_record(
    row: PgRow,
    include_chain: bool,
) -> LabClientResult<SignedPredictionRecord> {
    // Postgres TIMESTAMPTZ → chrono::DateTime<Utc>
    let acq: DateTime<Utc> =
        row.try_get("acquisition_timestamp").map_err(decoding)?;
    let signed_at: DateTime<Utc> = row.try_get("signed_at").map_err(decoding)?;

    let output_shape: Vec<i32> =
        row.try_get("output_shape").map_err(decoding)?;
    let cloud: f64 = row.try_get("cloud_cover_percent").map_err(decoding)?;

    let record = SignedPredictionRecord {
        h3_cell: row.try_get("h3_cell").map_err(decoding)?,
        epoch: row.try_get("epoch").map_err(decoding)?,
        model_version: row.try_get("model_version").map_err(decoding)?,
        input: InputAttestation {
            input_tile_hash: row
                .try_get("input_tile_hash")
                .map_err(decoding)?,
            stac_item_id: row.try_get("stac_item_id").map_err(decoding)?,
            acquisition_timestamp: format_canonical_ts(acq),
            cloud_cover_percent: cloud,
        },
        model: ModelAttestation {
            repo_id: row.try_get("model_repo_id").map_err(decoding)?,
            commit_hash: row.try_get("model_commit_hash").map_err(decoding)?,
            weight_sha256: row
                .try_get("model_weight_sha256")
                .map_err(decoding)?,
            parameter_count: row
                .try_get("model_parameter_count")
                .map_err(decoding)?,
        },
        output: OutputAttestation {
            raw_output_sha256: row
                .try_get("raw_output_sha256")
                .map_err(decoding)?,
            argmax_output_sha256: row
                .try_get("argmax_output_sha256")
                .map_err(decoding)?,
            binary_output_sha256: row
                .try_get("binary_output_sha256")
                .map_err(decoding)?,
            output_shape,
        },
        runtime: RuntimeFingerprint {
            gpu_name: row.try_get("gpu_name").map_err(decoding)?,
            cuda_driver_version: row
                .try_get("cuda_driver_version")
                .map_err(decoding)?,
            cuda_version: row.try_get("cuda_version").map_err(decoding)?,
            torch_version: row.try_get("torch_version").map_err(decoding)?,
        },
        record_version: row.try_get("record_version").map_err(decoding)?,
        signer_public_key: row
            .try_get("signer_public_key")
            .map_err(decoding)?,
        signature_bytes: row.try_get("signature_bytes").map_err(decoding)?,
        delegation_chain_hash: row
            .try_get("delegation_chain_hash")
            .map_err(decoding)?,
        signed_at: format_canonical_ts(signed_at),
        root_cert_json: if include_chain {
            row.try_get("root_cert_json").ok()
        } else {
            None
        },
        lab_cert_json: if include_chain {
            row.try_get("lab_cert_json").ok()
        } else {
            None
        },
        runtime_cert_json: if include_chain {
            row.try_get("runtime_cert_json").ok()
        } else {
            None
        },
    };

    Ok(record)
}

/// Format a UTC DateTime to match Python's `datetime.isoformat()` output
/// for tz-aware UTC datetimes. See module docs for why this matters.
///
/// Output shape: `2026-02-13T10:09:09.832000+00:00` (always 6 microsecond
/// digits, literal `+00:00` suffix).
pub(crate) fn format_canonical_ts(ts: DateTime<Utc>) -> String {
    // chrono's `%.6f` pads to 6 fractional digits. We append the
    // literal "+00:00" because chrono's `%z`/`%:z` work on offset types
    // but here we know we're always UTC.
    ts.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
}

#[cfg(test)]
mod ts_tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn format_matches_python_microseconds() {
        // 2026-02-13 10:09:09.832000 UTC
        let ts = Utc
            .with_ymd_and_hms(2026, 2, 13, 10, 9, 9)
            .unwrap()
            .with_nanosecond(832_000_000)
            .unwrap();
        assert_eq!(
            format_canonical_ts(ts),
            "2026-02-13T10:09:09.832000+00:00"
        );
    }

    #[test]
    fn format_matches_python_zero_microseconds() {
        let ts = Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap();
        assert_eq!(
            format_canonical_ts(ts),
            "2024-01-01T00:00:00.000000+00:00"
        );
    }

    #[test]
    fn format_matches_python_padded_microseconds() {
        // 832 microseconds (not 832000). Python emits "00.000832".
        let ts = Utc
            .with_ymd_and_hms(2026, 2, 13, 10, 9, 9)
            .unwrap()
            .with_nanosecond(832_000)
            .unwrap();
        assert_eq!(
            format_canonical_ts(ts),
            "2026-02-13T10:09:09.000832+00:00"
        );
    }
}

// chrono's `with_nanosecond` lives on `Timelike`, not `DateTime`.
#[cfg(test)]
use chrono::Timelike;
