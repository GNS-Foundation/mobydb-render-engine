//! render-core
//!
//! Types and pure tool implementations for the MobyDB Render Engine.
//!
//! This crate contains *no* transport code. Tool implementations are async
//! functions that take a `&dyn MobyDbClient` (from the `mobydb-client` crate,
//! which imports the trait defined here) and return domain types. This lets
//! the `mcp-server` crate wire the same functions to MCP, HTTP, or stdio
//! without duplicating logic.
//!
//! The five v1 tools:
//!   * render_viewport       — compositor path (placeholder in v0.1)
//!   * get_cell_state        — fetch state for an (h3, epoch)
//!   * query_cells_in_region — scan cells within an H3 parent / viewport
//!   * get_provenance        — chain of writes + attestations for a cell
//!   * verify_attestation    — check an attestation's signature

pub mod client;
pub mod error;
pub mod tools;
pub mod types;

pub use client::MobyDbClient;
pub use error::{CoreError, CoreResult};
pub use types::*;
