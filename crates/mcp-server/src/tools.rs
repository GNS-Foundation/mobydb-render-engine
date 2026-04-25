//! MCP tool registry.
//!
//! Each tool is a `(name, description, input_schema, handler)` tuple. The
//! handler takes the JSON `arguments` + auth context and returns a JSON
//! result or an error.
//!
//! The five v1 tools:
//!   * render_viewport
//!   * get_cell_state
//!   * query_cells_in_region
//!   * get_provenance
//!   * verify_attestation

use futures::future::BoxFuture;
use schemars::schema_for;
use serde_json::Value;
use std::sync::Arc;

use render_core::{
    tools::{
        GetCellStateInput, GetProvenanceInput, QueryCellsInRegionInput, RenderViewportInput,
        VerifyAttestationInput,
    },
    MobyDbClient, TenantId,
};

use lab_client::LabClient;

use crate::{
    auth::AuthContext,
    error::core_to_jsonrpc,
    mcp::{JsonRpcError, ToolDefinition},
};

pub type ToolFuture = BoxFuture<'static, Result<Value, JsonRpcError>>;
type ToolFn = dyn Fn(Value, TenantId, Arc<dyn MobyDbClient>) -> ToolFuture + Send + Sync;

pub struct ToolRegistry {
    tools: Vec<ToolEntry>,
}

struct ToolEntry {
    def: ToolDefinition,
    run: Arc<ToolFn>,
}

impl ToolRegistry {
    pub fn build(db: Arc<dyn MobyDbClient>, lab: Option<Arc<dyn LabClient>>) -> Self {
        let db_rv = db.clone();
        let db_gc = db.clone();
        let db_qc = db.clone();
        let db_gp = db.clone();
        let db_va = db.clone();

        let tools = vec![
            // ---- render_viewport ----
            ToolEntry {
                def: ToolDefinition {
                    name: "render_viewport".into(),
                    description: "Render a viewport of the spacetime grid. Returns cell states \
                         (and, in future versions, composited payload) for all cells \
                         within the given viewport at the given epoch."
                        .into(),
                    input_schema: serde_json::to_value(schema_for!(RenderViewportInput))
                        .expect("schema"),
                },
                run: Arc::new(move |args, tenant, _db_arg| {
                    let db = db_rv.clone();
                    Box::pin(async move {
                        let input: RenderViewportInput =
                            serde_json::from_value(args).map_err(|e| {
                                JsonRpcError::new(JsonRpcError::INVALID_PARAMS, e.to_string())
                            })?;
                        let result = render_core::tools::render_viewport(&*db, &tenant, input)
                            .await
                            .map_err(|e| core_to_jsonrpc(&e))?;
                        Ok(serde_json::to_value(result).unwrap())
                    })
                }),
            },
            // ---- get_cell_state ----
            ToolEntry {
                def: ToolDefinition {
                    name: "get_cell_state".into(),
                    description: "Get the state of a specific H3 cell. If epoch_id is omitted, \
                         returns the state at the latest epoch that has a write for \
                         this cell (null if never written)."
                        .into(),
                    input_schema: serde_json::to_value(schema_for!(GetCellStateInput))
                        .expect("schema"),
                },
                run: Arc::new(move |args, tenant, _db_arg| {
                    let db = db_gc.clone();
                    Box::pin(async move {
                        let input: GetCellStateInput =
                            serde_json::from_value(args).map_err(|e| {
                                JsonRpcError::new(JsonRpcError::INVALID_PARAMS, e.to_string())
                            })?;
                        let result = render_core::tools::get_cell_state(&*db, &tenant, input)
                            .await
                            .map_err(|e| core_to_jsonrpc(&e))?;
                        Ok(serde_json::to_value(result).unwrap())
                    })
                }),
            },
            // ---- query_cells_in_region ----
            ToolEntry {
                def: ToolDefinition {
                    name: "query_cells_in_region".into(),
                    description: "List cell states in a region (H3 parent + target resolution, \
                         or lat/lng bounding box). Returns at most `limit` cells; \
                         exceeding the limit is an error, not silent truncation."
                        .into(),
                    input_schema: serde_json::to_value(schema_for!(QueryCellsInRegionInput))
                        .expect("schema"),
                },
                run: Arc::new(move |args, tenant, _db_arg| {
                    let db = db_qc.clone();
                    Box::pin(async move {
                        let input: QueryCellsInRegionInput =
                            serde_json::from_value(args).map_err(|e| {
                                JsonRpcError::new(JsonRpcError::INVALID_PARAMS, e.to_string())
                            })?;
                        let result =
                            render_core::tools::query_cells_in_region(&*db, &tenant, input)
                                .await
                                .map_err(|e| core_to_jsonrpc(&e))?;
                        Ok(serde_json::to_value(result).unwrap())
                    })
                }),
            },
            // ---- get_provenance ----
            ToolEntry {
                def: ToolDefinition {
                    name: "get_provenance".into(),
                    description: "Get the full provenance bundle for a cell at an epoch: \
                         cell state + attestations + Merkle proof against the epoch \
                         root + epoch metadata. Used for EU AI Act audit trail."
                        .into(),
                    input_schema: serde_json::to_value(schema_for!(GetProvenanceInput))
                        .expect("schema"),
                },
                run: Arc::new(move |args, tenant, _db_arg| {
                    let db = db_gp.clone();
                    Box::pin(async move {
                        let input: GetProvenanceInput =
                            serde_json::from_value(args).map_err(|e| {
                                JsonRpcError::new(JsonRpcError::INVALID_PARAMS, e.to_string())
                            })?;
                        let result = render_core::tools::get_provenance(&*db, &tenant, input)
                            .await
                            .map_err(|e| core_to_jsonrpc(&e))?;
                        Ok(serde_json::to_value(result).unwrap())
                    })
                }),
            },
            // ---- verify_attestation ----
            ToolEntry {
                def: ToolDefinition {
                    name: "verify_attestation".into(),
                    description: "Verify an attestation: claim-hash consistency, Ed25519 \
                         signature, referenced cell existence, and expiration. \
                         Returns per-check booleans + overall verdict."
                        .into(),
                    input_schema: serde_json::to_value(schema_for!(VerifyAttestationInput))
                        .expect("schema"),
                },
                run: Arc::new(move |args, tenant, _db_arg| {
                    let db = db_va.clone();
                    Box::pin(async move {
                        let input: VerifyAttestationInput =
                            serde_json::from_value(args).map_err(|e| {
                                JsonRpcError::new(JsonRpcError::INVALID_PARAMS, e.to_string())
                            })?;
                        let result = render_core::tools::verify_attestation(&*db, &tenant, input)
                            .await
                            .map_err(|e| core_to_jsonrpc(&e))?;
                        Ok(serde_json::to_value(result).unwrap())
                    })
                }),
            },
            // ---- query_predictions ----
            // Reads SignedPredictionRecords from the GEIANT Lab Supabase
            // via the lab-client crate. The trust root for these records
            // is GEIANT_LAB_ROOT_PUBKEY — DISTINCT from the render
            // engine's primary trust root. Returns NOT_FOUND when no
            // lab client is configured (LAB_DATABASE_URL unset).
            ToolEntry {
                def: ToolDefinition {
                    name: "query_predictions".into(),
                    description: "Return signed AI prediction records from the GEIANT \
                         Lab for a given H3 cell. Each record carries an Ed25519 \
                         signature over canonical JSON plus an embedded 3-level \
                         delegation chain back to the GEIANT Lab root. Trust \
                         root is distinct from the render engine's primary root; \
                         clients displaying both must distinguish them."
                        .into(),
                    input_schema: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "h3_cell": {
                                "type": "string",
                                "description": "H3 cell index, 15-character lowercase hex string"
                            },
                            "epoch": {
                                "type": "integer",
                                "description": "Optional epoch filter (lab convention: epoch 0 = 2024-01-01 UTC)"
                            },
                            "model_version": {
                                "type": "string",
                                "description": "Optional model_version filter (e.g. 'sen1floods11@918b9f140bb1')"
                            },
                            "limit": {
                                "type": "integer",
                                "description": "Max records to return (default 100, max 1000)",
                                "default": 100
                            },
                            "include_chain": {
                                "type": "boolean",
                                "description": "Include embedded delegation chain JSONs (default true)",
                                "default": true
                            }
                        },
                        "required": ["h3_cell"]
                    }),
                },
                run: {
                    let lab = lab.clone();
                    Arc::new(move |args, _tenant, _db_arg| {
                        let lab = lab.clone();
                        Box::pin(async move {
                            let lab = lab.ok_or_else(|| {
                                JsonRpcError::new(
                                    JsonRpcError::INTERNAL_ERROR,
                                    "lab client not configured (LAB_DATABASE_URL unset)",
                                )
                            })?;

                            let h3_cell = args
                                .get("h3_cell")
                                .and_then(|v| v.as_str())
                                .ok_or_else(|| {
                                    JsonRpcError::new(
                                        JsonRpcError::INVALID_PARAMS,
                                        "h3_cell required",
                                    )
                                })?
                                .to_string();
                            let epoch = args.get("epoch").and_then(|v| v.as_i64());
                            let model_version =
                                args.get("model_version").and_then(|v| v.as_str()).map(String::from);
                            let limit = args
                                .get("limit")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(100) as u32;
                            let include_chain = args
                                .get("include_chain")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true);

                            let records = lab
                                .fetch_signed_predictions(
                                    &h3_cell,
                                    epoch,
                                    model_version.as_deref(),
                                    limit,
                                    include_chain,
                                )
                                .await
                                .map_err(|e| lab_err_to_jsonrpc(&e))?;

                            Ok(serde_json::json!({
                                "records": records,
                                "trust_root": {
                                    "root_pubkey": lab_client::GEIANT_LAB_ROOT_PUBKEY,
                                    "label": "GEIANT Lab",
                                },
                            }))
                        })
                    })
                },
            },
        ];

        Self { tools }
    }

    pub fn list(&self) -> Vec<ToolDefinition> {
        self.tools.iter().map(|t| t.def.clone()).collect()
    }

    pub async fn call(
        &self,
        name: &str,
        args: &Value,
        _auth: &AuthContext,
        tenant: TenantId,
        db: Arc<dyn MobyDbClient>,
    ) -> Result<Value, JsonRpcError> {
        let entry = self
            .tools
            .iter()
            .find(|t| t.def.name == name)
            .ok_or_else(|| {
                JsonRpcError::new(
                    JsonRpcError::METHOD_NOT_FOUND,
                    format!("unknown tool: {name}"),
                )
            })?;
        (entry.run)(args.clone(), tenant, db).await
    }
}

// ---------------------------------------------------------------------------
// Lab client error mapping
// ---------------------------------------------------------------------------

fn lab_err_to_jsonrpc(e: &lab_client::LabClientError) -> JsonRpcError {
    use lab_client::LabClientError;
    let (code, msg) = match e {
        LabClientError::InvalidH3Cell(_)
        | LabClientError::InvalidModelVersion(_)
        | LabClientError::LimitOutOfRange { .. } => {
            (JsonRpcError::INVALID_PARAMS, e.to_string())
        }
        LabClientError::Configuration(_) => {
            (JsonRpcError::INTERNAL_ERROR, e.to_string())
        }
        LabClientError::Database(_)
        | LabClientError::Decoding(_)
        | LabClientError::Serde(_)
        | LabClientError::Other(_) => {
            (JsonRpcError::INTERNAL_ERROR, e.to_string())
        }
    };
    JsonRpcError::new(code, msg)
}
