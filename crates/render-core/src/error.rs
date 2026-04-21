//! Error types for the render engine core layer.
//!
//! These errors are designed to map cleanly to both MCP JSON-RPC error codes
//! and HTTP status codes. See `mcp-server::error` for the mapping.

use thiserror::Error;

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("invalid H3 cell: {0}")]
    InvalidH3Cell(String),

    #[error("invalid H3 resolution: {0} (must be 0-15)")]
    InvalidH3Resolution(u8),

    #[error("viewport exceeds max cells: requested {requested}, max {max}")]
    ViewportTooLarge { requested: usize, max: usize },

    #[error("epoch not found: tenant={tenant}, epoch={epoch}")]
    EpochNotFound { tenant: String, epoch: i64 },

    #[error("cell state not found: tenant={tenant}, h3={h3:#x}, epoch={epoch:?}")]
    CellNotFound {
        tenant: String,
        h3: u64,
        epoch: Option<i64>,
    },

    #[error("attestation signature invalid")]
    InvalidSignature,

    #[error("attestation references missing cell: tenant={tenant}, h3={h3:#x}, epoch={epoch}")]
    AttestationDangling { tenant: String, h3: u64, epoch: i64 },

    #[error("tenant not set in session (RLS fail-closed)")]
    TenantNotSet,

    #[error("database error: {0}")]
    Database(String),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("unexpected: {0}")]
    Other(String),
}

impl From<anyhow::Error> for CoreError {
    fn from(e: anyhow::Error) -> Self {
        CoreError::Other(e.to_string())
    }
}
