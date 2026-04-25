//! Error types for the lab-client.
//!
//! These map cleanly to MCP JSON-RPC error codes and HTTP status codes via
//! a translator in `mcp-server::error` (a sibling of `core_to_jsonrpc`).

use thiserror::Error;

pub type LabClientResult<T> = Result<T, LabClientError>;

#[derive(Debug, Error)]
pub enum LabClientError {
    /// Caller supplied an h3_cell that isn't a 15-character hex string.
    #[error("invalid H3 cell: {0}")]
    InvalidH3Cell(String),

    /// Caller supplied a model_version that's empty or malformed.
    #[error("invalid model_version: {0}")]
    InvalidModelVersion(String),

    /// Caller asked for a `limit` outside the allowed range.
    #[error("limit out of range: requested {requested}, max {max}")]
    LimitOutOfRange { requested: u32, max: u32 },

    /// Configuration was missing or malformed at construction time.
    #[error("configuration error: {0}")]
    Configuration(String),

    /// Underlying Postgres error.
    #[error("database error: {0}")]
    Database(String),

    /// Row → domain-type conversion failed (e.g. unexpected column shape).
    #[error("row decoding error: {0}")]
    Decoding(String),

    /// JSON serialization/deserialization failure (chain JSON, etc.).
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    /// Catch-all for unexpected conditions. Avoid in normal paths.
    #[error("unexpected: {0}")]
    Other(String),
}

impl From<sqlx::Error> for LabClientError {
    fn from(e: sqlx::Error) -> Self {
        LabClientError::Database(e.to_string())
    }
}
