//! `LabClient` trait — read-only abstraction over the GEIANT Lab's
//! signed-predictions store.
//!
//! Like `render-core::MobyDbClient`, the trait lives in this crate so that
//! consumers (e.g. mcp-server) can take `Arc<dyn LabClient>` without
//! depending on the concrete sqlx implementation. The Postgres impl lives
//! in `lab-client::postgres`.
//!
//! The trait is intentionally narrow (3 methods) for v0.1. We add methods
//! when the consuming code (frontend integration, dashboards, etc.) shows
//! us specifically what's needed — speculative trait surface is a refactor
//! cost we'd rather defer.

use async_trait::async_trait;

use crate::{CellEpochPair, LabClientResult, SignedPredictionRecord};

/// Pinned base64url representation of the GEIANT Lab root pubkey.
///
/// This is the trust anchor for every record returned by a `LabClient`.
/// Verifiers downstream (browser-side `verify.js`, the Python auditor in
/// the lab repo, etc.) match against this exact string. Hard-coding it
/// here keeps the trait usable in `no-config` contexts (tests, demo
/// frontends, etc.).
pub const GEIANT_LAB_ROOT_PUBKEY: &str =
    "h9TRb07XyhDu06h40PSEwcIOn-Z_Md_3GfShCm67vUs";

#[async_trait]
pub trait LabClient: Send + Sync + 'static {
    /// Fetch signed prediction records for an H3 cell.
    ///
    /// Filtering:
    ///   - `h3_cell` (required): 15-character lowercase hex string.
    ///   - `epoch` (optional): when supplied, only records at that epoch.
    ///   - `model_version` (optional): when supplied, only records produced
    ///     by that model_version (e.g. "sen1floods11@918b9f140bb1").
    ///   - `limit`: hard cap on returned rows. Implementations MUST
    ///     enforce a max (1000 in the Postgres impl) and reject larger
    ///     requests with `LimitOutOfRange` rather than silently truncating.
    ///   - `include_chain`: when true, populates `root_cert_json`,
    ///     `lab_cert_json`, and `runtime_cert_json` on each record. When
    ///     false, those fields are `None` (lighter response).
    ///
    /// Returns records ordered by `(epoch DESC, model_version ASC)`.
    /// An empty vec means no matching records exist.
    async fn fetch_signed_predictions(
        &self,
        h3_cell: &str,
        epoch: Option<i64>,
        model_version: Option<&str>,
        limit: u32,
        include_chain: bool,
    ) -> LabClientResult<Vec<SignedPredictionRecord>>;

    /// List `(h3_cell, epoch)` pairs that have records for the given
    /// `model_version`. Used by frontends that want to draw a layer of
    /// available cells without fetching full records.
    ///
    /// Cheap query (two columns, optionally indexed). Returns at most
    /// `limit` pairs, ordered by `(h3_cell ASC, epoch ASC)`.
    async fn list_cells_for_model(
        &self,
        model_version: &str,
        limit: u32,
    ) -> LabClientResult<Vec<CellEpochPair>>;

    /// Liveness check — verifies the lab database is reachable and the
    /// expected `predictions` table exists. Returns Ok(()) on success.
    /// Used by the `mcp-server` startup path to surface
    /// LAB_DATABASE_URL misconfiguration early rather than at first
    /// request.
    async fn health(&self) -> LabClientResult<()>;
}
