//! Pure tool implementations.
//!
//! Each function takes a `&dyn MobyDbClient` + input + returns output. No MCP,
//! no HTTP, no telemetry — that lives in the transport layer (`mcp-server`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tracing::instrument;

use crate::{
    Attestation, CellState, CoreError, CoreResult, EpochId, H3Cell, MobyDbClient, Provenance,
    RenderedViewport, TenantId, Viewport,
};

// -----------------------------------------------------------------------------
// render_viewport
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RenderViewportInput {
    pub viewport: Viewport,
    #[serde(default)]
    pub epoch_id: Option<EpochId>,
    #[serde(default = "default_max_cells")]
    pub max_cells: usize,
}

fn default_max_cells() -> usize {
    4096
}

#[instrument(skip(client))]
pub async fn render_viewport(
    client: &dyn MobyDbClient,
    tenant: &TenantId,
    input: RenderViewportInput,
) -> CoreResult<RenderedViewport> {
    let start = Instant::now();

    let cells = client
        .query_cells_in_region(tenant, &input.viewport, input.epoch_id, input.max_cells)
        .await?;

    // Resolve epoch — if caller didn't specify, use the latest epoch we have.
    let epoch_id = match input.epoch_id {
        Some(e) => e,
        None => client.latest_epoch(tenant).await?.epoch_id,
    };

    let render_ms = start.elapsed().as_secs_f64() * 1000.0;
    let cell_count = cells.len();

    Ok(RenderedViewport {
        tenant_id: *tenant,
        viewport: input.viewport,
        epoch_id,
        cell_count,
        cells,
        render_ms,
    })
}

// -----------------------------------------------------------------------------
// get_cell_state
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GetCellStateInput {
    pub h3_cell: H3Cell,
    #[serde(default)]
    pub epoch_id: Option<EpochId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GetCellStateOutput {
    pub cell_state: Option<CellState>,
}

#[instrument(skip(client))]
pub async fn get_cell_state(
    client: &dyn MobyDbClient,
    tenant: &TenantId,
    input: GetCellStateInput,
) -> CoreResult<GetCellStateOutput> {
    let cell_state = client
        .get_cell_state(tenant, input.h3_cell, input.epoch_id)
        .await?;
    Ok(GetCellStateOutput { cell_state })
}

// -----------------------------------------------------------------------------
// query_cells_in_region
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct QueryCellsInRegionInput {
    pub viewport: Viewport,
    #[serde(default)]
    pub epoch_id: Option<EpochId>,
    #[serde(default = "default_max_cells")]
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct QueryCellsInRegionOutput {
    pub cells: Vec<CellState>,
    pub count: usize,
}

#[instrument(skip(client))]
pub async fn query_cells_in_region(
    client: &dyn MobyDbClient,
    tenant: &TenantId,
    input: QueryCellsInRegionInput,
) -> CoreResult<QueryCellsInRegionOutput> {
    let cells = client
        .query_cells_in_region(tenant, &input.viewport, input.epoch_id, input.limit)
        .await?;
    let count = cells.len();
    Ok(QueryCellsInRegionOutput { cells, count })
}

// -----------------------------------------------------------------------------
// get_provenance
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GetProvenanceInput {
    pub h3_cell: H3Cell,
    pub epoch_id: EpochId,
}

#[instrument(skip(client))]
pub async fn get_provenance(
    client: &dyn MobyDbClient,
    tenant: &TenantId,
    input: GetProvenanceInput,
) -> CoreResult<Provenance> {
    client
        .get_provenance(tenant, input.h3_cell, input.epoch_id)
        .await
}

// -----------------------------------------------------------------------------
// verify_attestation
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VerifyAttestationInput {
    pub attestation: Attestation,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VerifyAttestationOutput {
    pub signature_valid: bool,
    pub claim_hash_valid: bool,
    pub cell_exists: bool,
    pub not_expired: bool,
    /// Overall verdict (AND of all above flags).
    pub verified: bool,
}

#[instrument(skip(client))]
pub async fn verify_attestation(
    client: &dyn MobyDbClient,
    tenant: &TenantId,
    input: VerifyAttestationInput,
) -> CoreResult<VerifyAttestationOutput> {
    let a = &input.attestation;

    // 1. Claim hash consistency: blake3(canonical_json(claim)) == claim_hash
    let canonical = canonical_json(&a.claim)?;
    let computed = blake3::hash(canonical.as_bytes());
    let claim_hash_valid = computed.as_bytes() == a.claim_hash.as_bytes();

    // 2. Ed25519 signature: verify(attester_pk, claim_hash, signature)
    let signature_valid = verify_ed25519(
        a.attester_pk.as_bytes(),
        a.claim_hash.as_bytes(),
        a.signature.as_bytes(),
    );

    // 3. Cell referenced actually exists at (tenant, h3, epoch)
    let cell_exists = client
        .get_cell_state(tenant, a.h3_cell, Some(a.epoch_id))
        .await?
        .is_some();

    // 4. Not expired
    let not_expired = match a.expires_at {
        None => true,
        Some(t) => t > chrono::Utc::now(),
    };

    let verified = claim_hash_valid && signature_valid && cell_exists && not_expired;

    Ok(VerifyAttestationOutput {
        signature_valid,
        claim_hash_valid,
        cell_exists,
        not_expired,
        verified,
    })
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/// Deterministic JSON serialization for hashing. Sorts object keys and excludes
/// null fields — matches GCRUMBS / GNS `canonicalJson` convention.
pub fn canonical_json(v: &serde_json::Value) -> CoreResult<String> {
    fn walk(v: &serde_json::Value, out: &mut String) -> Result<(), CoreError> {
        match v {
            serde_json::Value::Null => out.push_str("null"),
            serde_json::Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            serde_json::Value::Number(n) => out.push_str(&n.to_string()),
            serde_json::Value::String(s) => {
                out.push_str(&serde_json::to_string(s).map_err(CoreError::Serde)?);
            }
            serde_json::Value::Array(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    walk(x, out)?;
                }
                out.push(']');
            }
            serde_json::Value::Object(m) => {
                out.push('{');
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                let mut first = true;
                for k in keys {
                    let val = &m[k];
                    // Skip null fields for GNS-compatible canonicalization
                    if val.is_null() {
                        continue;
                    }
                    if !first {
                        out.push(',');
                    }
                    first = false;
                    out.push_str(&serde_json::to_string(k).map_err(CoreError::Serde)?);
                    out.push(':');
                    walk(val, out)?;
                }
                out.push('}');
            }
        }
        Ok(())
    }
    let mut s = String::new();
    walk(v, &mut s)?;
    Ok(s)
}

fn verify_ed25519(pubkey: &[u8; 32], message: &[u8], sig: &[u8; 64]) -> bool {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let vk = match VerifyingKey::from_bytes(pubkey) {
        Ok(k) => k,
        Err(_) => return false,
    };
    let signature = Signature::from_bytes(sig);
    vk.verify(message, &signature).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_json_sorts_keys_and_drops_nulls() {
        let v = json!({
            "b": 2,
            "a": 1,
            "z": null,
            "nested": { "y": 2, "x": 1 }
        });
        let c = canonical_json(&v).unwrap();
        assert_eq!(c, r#"{"a":1,"b":2,"nested":{"x":1,"y":2}}"#);
    }

    #[test]
    fn canonical_json_arrays_preserve_order() {
        let v = json!([3, 1, 2]);
        assert_eq!(canonical_json(&v).unwrap(), "[3,1,2]");
    }
}
