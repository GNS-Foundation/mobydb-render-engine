//! `MobyDbClient` trait — the storage abstraction used by all render-engine
//! tool implementations.
//!
//! The trait lives in `render-core` (rather than `mobydb-client`) so that
//! `render-core::tools` can import it without a circular dependency. The
//! concrete Postgres implementation lives in the `mobydb-client` crate.
//!
//! Every method is tenant-scoped. The `&TenantId` argument is redundant with
//! the RLS session variable (which the client sets at transaction start), but
//! is passed explicitly so:
//!   1. Tests can assert the right tenant is in play without inspecting SQL.
//!   2. Log records carry a tenant_id tag even when the connection pool is
//!      reused across tenants.

use async_trait::async_trait;

use crate::{
    Attestation, CellState, CoreResult, Epoch, EpochId, H3Cell, Provenance, TenantId, Viewport,
};

#[async_trait]
pub trait MobyDbClient: Send + Sync + 'static {
    /// Return the latest sealed epoch for a tenant.
    async fn latest_epoch(&self, tenant: &TenantId) -> CoreResult<Epoch>;

    /// Fetch a specific epoch by id.
    async fn get_epoch(&self, tenant: &TenantId, epoch: EpochId) -> CoreResult<Epoch>;

    /// Get the cell state at (tenant, h3, epoch). If `epoch` is None, return
    /// the state at the latest epoch that has a write for this cell.
    async fn get_cell_state(
        &self,
        tenant: &TenantId,
        h3: H3Cell,
        epoch: Option<EpochId>,
    ) -> CoreResult<Option<CellState>>;

    /// List all cell states within a viewport at a given epoch. If `epoch` is
    /// None, use the latest epoch per cell.
    ///
    /// The returned vec MUST NOT exceed `limit`. If the natural result would
    /// exceed `limit`, implementations should return a `ViewportTooLarge`
    /// error rather than silently truncating.
    async fn query_cells_in_region(
        &self,
        tenant: &TenantId,
        viewport: &Viewport,
        epoch: Option<EpochId>,
        limit: usize,
    ) -> CoreResult<Vec<CellState>>;

    /// Get the full provenance bundle (cell state + attestations + merkle
    /// proof + epoch metadata) for a cell.
    async fn get_provenance(
        &self,
        tenant: &TenantId,
        h3: H3Cell,
        epoch: EpochId,
    ) -> CoreResult<Provenance>;

    /// Return all attestations for a cell. (Used by get_provenance internally
    /// and exposed here for testing.)
    async fn list_attestations(
        &self,
        tenant: &TenantId,
        h3: H3Cell,
        epoch: EpochId,
    ) -> CoreResult<Vec<Attestation>>;

    /// Healthcheck the underlying store. Returns Ok(()) on success.
    async fn health(&self) -> CoreResult<()>;
}
