//! MCP (Model Context Protocol) message types.
//!
//! Implements JSON-RPC 2.0 per the MCP spec. Method handlers are in
//! `http.rs`; this module is just the on-wire envelope.
//!
//! Spec: <https://modelcontextprotocol.io/specification/>

use serde::{Deserialize, Serialize};
use serde_json::Value;

// -----------------------------------------------------------------------------
// JSON-RPC 2.0 envelope
// -----------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
    /// None = notification (no response expected)
    pub id: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
    pub id: Value,
}

impl JsonRpcResponse {
    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            result: Some(result),
            error: None,
            id,
        }
    }
    pub fn err(id: Value, err: JsonRpcError) -> Self {
        Self {
            jsonrpc: "2.0",
            result: None,
            error: Some(err),
            id,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcError {
    // Standard codes
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    // MCP / application codes (range -32000..=-32099 reserved for server use)
    pub const UNAUTHORIZED: i32 = -32001;
    pub const FORBIDDEN: i32 = -32003;
    pub const NOT_FOUND: i32 = -32004;
    pub const CONFLICT: i32 = -32009;
    #[allow(dead_code)] // reserved for rate-limit middleware (Week 5)
    pub const RATE_LIMITED: i32 = -32029;

    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}

// -----------------------------------------------------------------------------
// MCP initialize handshake
// -----------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // we accept the handshake but don't currently negotiate client capabilities
pub struct InitializeParams {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    #[serde(default)]
    pub capabilities: Value,
    #[serde(rename = "clientInfo", default)]
    pub client_info: Value,
}

#[derive(Debug, Serialize)]
pub struct InitializeResult {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: &'static str,
    pub capabilities: ServerCapabilities,
    #[serde(rename = "serverInfo")]
    pub server_info: ServerInfo,
}

#[derive(Debug, Serialize)]
pub struct ServerCapabilities {
    pub tools: ToolsCapability,
}

#[derive(Debug, Serialize)]
pub struct ToolsCapability {
    #[serde(rename = "listChanged")]
    pub list_changed: bool,
}

#[derive(Debug, Serialize)]
pub struct ServerInfo {
    pub name: &'static str,
    pub version: &'static str,
}

pub const PROTOCOL_VERSION: &str = "2024-11-05";
pub const SERVER_NAME: &str = "mobydb-render-engine";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

// -----------------------------------------------------------------------------
// tools/list & tools/call
// -----------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct ToolsListResult {
    pub tools: Vec<ToolDefinition>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

#[derive(Debug, Deserialize)]
pub struct ToolsCallParams {
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Serialize)]
pub struct ToolsCallResult {
    pub content: Vec<ContentBlock>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "isError")]
    pub is_error: Option<bool>,
    /// Server-side metadata. Not part of the MCP spec's required fields, but
    /// the spec allows extension properties on tool results. Leading-underscore
    /// namespace marks it as server-specific so clients can ignore it safely.
    #[serde(skip_serializing_if = "Option::is_none", rename = "_meta")]
    pub meta: Option<ToolsCallMeta>,
}

#[derive(Debug, Serialize)]
pub struct ToolsCallMeta {
    /// Wall-clock time the server spent handling this tool call, in milliseconds.
    /// Measured from just-after-auth to just-before-response-serialization —
    /// covers tool dispatch, DB round-trip, and result assembly. Excludes HTTP
    /// framing and network transit.
    pub render_ms: f64,
    /// Tool name (redundant with params.name but convenient for log grepping).
    pub tool: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ContentBlock {
    Text { text: String },
}

impl ToolsCallResult {
    pub fn text_json(v: &Value) -> Self {
        Self {
            content: vec![ContentBlock::Text {
                text: serde_json::to_string(v).unwrap_or_else(|_| "{}".into()),
            }],
            is_error: None,
            meta: None,
        }
    }
    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            content: vec![ContentBlock::Text { text: msg.into() }],
            is_error: Some(true),
            meta: None,
        }
    }
    pub fn with_meta(mut self, meta: ToolsCallMeta) -> Self {
        self.meta = Some(meta);
        self
    }
}
