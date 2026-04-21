//! Per-request tenancy.
//!
//! For v0.1, the tenant is fully determined by the auth context (JWT claim or
//! default). This module exists so that future routing (header override in
//! admin contexts, proxying from a parent tenant to child, etc.) has a home
//! without being grafted into the http module.

use render_core::TenantId;

use crate::auth::AuthContext;

/// Resolve the effective tenant for this request. v0.1: identity function.
pub fn resolve(auth: &AuthContext) -> TenantId {
    auth.tenant
}
