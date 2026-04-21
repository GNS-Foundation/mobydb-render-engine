//! mobydb-client
//!
//! Concrete Postgres/sqlx implementation of the `MobyDbClient` trait defined
//! in `render-core`. Responsible for:
//!
//!   * Connection pool management (sqlx::PgPool)
//!   * Setting the per-transaction RLS session variable `app.current_tenant_id`
//!   * Query construction + row → domain-type mapping
//!   * Merkle proof construction for provenance queries
//!
//! This crate has NO knowledge of MCP, HTTP, or auth. The transport layer
//! (mcp-server) is responsible for resolving a TenantId from the request and
//! passing it to every call.

pub mod merkle;
pub mod postgres;

pub use postgres::PostgresMobyDb;
