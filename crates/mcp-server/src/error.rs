//! Error mapping: render_core::CoreError → JSON-RPC error codes.

use crate::mcp::JsonRpcError;
use render_core::CoreError;

pub fn core_to_jsonrpc(e: &CoreError) -> JsonRpcError {
    let (code, msg) = match e {
        CoreError::InvalidH3Cell(_) | CoreError::InvalidH3Resolution(_) => {
            (JsonRpcError::INVALID_PARAMS, e.to_string())
        }

        CoreError::ViewportTooLarge { .. } => (JsonRpcError::INVALID_PARAMS, e.to_string()),

        CoreError::EpochNotFound { .. } | CoreError::CellNotFound { .. } => {
            (JsonRpcError::NOT_FOUND, e.to_string())
        }

        CoreError::AttestationDangling { .. } => (JsonRpcError::CONFLICT, e.to_string()),
        CoreError::InvalidSignature => (JsonRpcError::FORBIDDEN, e.to_string()),

        CoreError::TenantNotSet => (JsonRpcError::UNAUTHORIZED, e.to_string()),

        CoreError::Database(_) | CoreError::Serde(_) | CoreError::Other(_) => {
            (JsonRpcError::INTERNAL_ERROR, e.to_string())
        }
    };
    JsonRpcError::new(code, msg)
}
