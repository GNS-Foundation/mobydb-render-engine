//! lab-client
//!
//! Read-only client to the GEIANT Lab's `predictions` table — a separate
//! Postgres database from the render-engine's primary store. The lab database
//! holds Ed25519-signed AI prediction records produced by the GEIANT Lab
//! pipeline (Sentinel-2 + Prithvi-EO inference, etc.), each with an embedded
//! 3-level delegation chain back to the GEIANT Lab root pubkey.
//!
//! Trust model:
//!   - The lab's trust root is DISTINCT from the render-engine's primary
//!     trust root. Records returned by this client are anchored in the
//!     GEIANT Lab root (`h9TRb07XyhDu06h40PSEwcIOn-Z_Md_3GfShCm67vUs`),
//!     which is exposed via [`GEIANT_LAB_ROOT_PUBKEY`].
//!   - Frontends that mix records from this client with cell states from
//!     the primary `MobyDbClient` MUST display both trust roots honestly
//!     to the user.
//!
//! This crate has NO knowledge of MCP, HTTP, or auth. The transport layer
//! (mcp-server) is responsible for plumbing the lab pool through and
//! exposing it as MCP tools and/or HTTP routes.

pub mod client;
pub mod error;
pub mod postgres;
pub mod types;

pub use client::{LabClient, GEIANT_LAB_ROOT_PUBKEY};
pub use error::{LabClientError, LabClientResult};
pub use postgres::{Config, PostgresLabClient};
pub use types::*;
