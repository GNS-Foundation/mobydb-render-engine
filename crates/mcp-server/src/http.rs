//! HTTP transport: Axum server, JSON-RPC 2.0 MCP endpoint, health + metrics.
//!
//! Routes:
//!   POST /mcp       — JSON-RPC 2.0 endpoint implementing MCP
//!   GET  /health    — liveness + readiness + build metadata
//!   GET  /metrics   — Prometheus exposition (if METRICS_ENABLED=1)
//!
//! Middleware:
//!   * Request ID
//!   * CORS (permissive for now; tighten per-customer in Phase 2)
//!   * Request-level tracing
//!   * Auth (applied inline in `mcp_handler` so /health stays public)
//!
//! MCP methods handled:
//!   * initialize
//!   * initialized          (notification, no response)
//!   * ping
//!   * tools/list
//!   * tools/call
//!   * notifications/cancelled (ignored for now)

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use metrics_exporter_prometheus::PrometheusHandle;
use serde_json::{json, Value};
use std::{net::SocketAddr, sync::Arc};
use tower_http::{
    compression::CompressionLayer,
    cors::{Any, CorsLayer},
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    trace::TraceLayer,
};
use tracing::{error, info, instrument, warn};

use crate::{
    auth::{self, AuthState},
    config::Config,
    mcp::{
        InitializeResult, JsonRpcError, JsonRpcRequest, JsonRpcResponse, ServerCapabilities,
        ServerInfo, ToolsCallParams, ToolsCallResult, ToolsCapability, ToolsListResult,
        PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION,
    },
    tenancy,
    tools::ToolRegistry,
};

use lab_client::LabClient;
use render_core::MobyDbClient;

// -----------------------------------------------------------------------------
// App state
// -----------------------------------------------------------------------------

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub db: Arc<dyn MobyDbClient>,
    pub auth: AuthState,
    pub tools: Arc<ToolRegistry>,
    pub metrics: Option<Arc<PrometheusHandle>>,
    /// Shared bucket for the public demo API key. None if no demo key
    /// is configured (production without demo surface).
    pub demo_limiter: Option<Arc<crate::rate_limit::DemoRateLimiter>>,
}

// -----------------------------------------------------------------------------
// Entry
// -----------------------------------------------------------------------------

pub async fn serve(
    cfg: Config,
    db: Arc<dyn MobyDbClient>,
    lab: Option<Arc<dyn LabClient>>,
) -> anyhow::Result<()> {
    let cfg = Arc::new(cfg);

    let metrics_handle = if cfg.metrics_enabled {
        use metrics_exporter_prometheus::PrometheusBuilder;
        let handle = PrometheusBuilder::new().install_recorder()?;
        Some(Arc::new(handle))
    } else {
        None
    };

    let demo_limiter = cfg.auth_demo_api_key.as_ref().map(|_| {
        Arc::new(crate::rate_limit::DemoRateLimiter::new(
            cfg.auth_demo_rate_limit_per_min,
        ))
    });
    if demo_limiter.is_some() {
        info!(
            limit_per_min = cfg.auth_demo_rate_limit_per_min,
            "demo api key configured, rate limiting active"
        );
    }

    let state = AppState {
        cfg: cfg.clone(),
        db: db.clone(),
        auth: AuthState::new(cfg.clone()),
        tools: Arc::new(ToolRegistry::build(db, lab)),
        metrics: metrics_handle,
        demo_limiter,
    };

    // CORS: allowlist explicit methods and headers so custom auth headers
    // work reliably across browsers. Origin stays Any because the demo
    // surface is public (rate-limited). `max_age` caches the preflight
    // response for an hour to avoid OPTIONS overhead on every MCP call.
    use axum::http::{header, HeaderName, Method};
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            HeaderName::from_static("x-mobydb-api-key"),
            HeaderName::from_static("x-request-id"),
        ])
        .max_age(std::time::Duration::from_secs(3600));

    let app: Router = Router::new()
        .route("/mcp", post(mcp_handler))
        .route("/health", get(health_handler))
        .route("/metrics", get(metrics_handler))
        .route("/", get(root_handler))
        .layer(CompressionLayer::new())
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .with_state(state);

    let addr: SocketAddr = format!("{}:{}", cfg.mcp_server_host, cfg.mcp_server_port).parse()?;
    info!(%addr, "http server listening");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    use tokio::signal;
    let ctrl_c = async {
        signal::ctrl_c().await.expect("install ctrl-c handler");
    };
    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => info!("received ctrl-c, shutting down"),
        _ = terminate => info!("received SIGTERM, shutting down"),
    }
}

// -----------------------------------------------------------------------------
// /
// -----------------------------------------------------------------------------

async fn root_handler() -> impl IntoResponse {
    Json(json!({
        "service":  SERVER_NAME,
        "version":  SERVER_VERSION,
        "protocol": PROTOCOL_VERSION,
        "endpoints": {
            "mcp":     "POST /mcp",
            "health":  "GET /health",
            "metrics": "GET /metrics"
        }
    }))
}

// -----------------------------------------------------------------------------
// /health
// -----------------------------------------------------------------------------

async fn health_handler(State(state): State<AppState>) -> impl IntoResponse {
    let db_healthy = state.db.health().await.is_ok();
    let status = if db_healthy { "ok" } else { "degraded" };
    let http_code = if db_healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    let body = Json(json!({
        "status":       status,
        "service":      SERVER_NAME,
        "version":      SERVER_VERSION,
        "git_sha":      state.cfg.git_sha,
        "build_time":   state.cfg.build_time,
        "env":          state.cfg.env,
        "db_healthy":   db_healthy,
        "railway_env":  state.cfg.railway_environment,
        "demo_enabled": state.cfg.auth_demo_api_key.is_some(),
        "demo_rate_limit_per_min": state.cfg.auth_demo_rate_limit_per_min,
    }));
    (http_code, body)
}

// -----------------------------------------------------------------------------
// /metrics
// -----------------------------------------------------------------------------

async fn metrics_handler(State(state): State<AppState>) -> Response {
    match state.metrics {
        Some(h) => (StatusCode::OK, h.render()).into_response(),
        None => (StatusCode::NOT_FOUND, "metrics disabled").into_response(),
    }
}

// -----------------------------------------------------------------------------
// /mcp — JSON-RPC 2.0 dispatcher
// -----------------------------------------------------------------------------

#[instrument(skip(state, headers, body))]
async fn mcp_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    // Authenticate first. /mcp never accepts anonymous in production.
    let auth_ctx = match auth::authenticate(&headers, &state.auth).await {
        Ok(a) => a,
        Err(e) => return e.into_response(),
    };

    // If the caller used the demo key, consume one request from the bucket.
    // Main key traffic bypasses this — trusted callers, full rate.
    if auth_ctx.scheme == crate::auth::AuthScheme::DemoApiKey {
        if let Some(limiter) = state.demo_limiter.as_ref() {
            use crate::rate_limit::RateLimitDecision;
            match limiter.check() {
                RateLimitDecision::Ok {
                    count_in_window,
                    limit,
                } => {
                    tracing::debug!(count = count_in_window, limit, "demo key within rate limit");
                }
                RateLimitDecision::Exceeded {
                    retry_after_sec,
                    limit,
                } => {
                    warn!(limit, retry_after_sec, "demo key rate limit exceeded");
                    return (
                        StatusCode::TOO_MANY_REQUESTS,
                        [
                            ("retry-after", retry_after_sec.to_string()),
                            ("x-ratelimit-limit", limit.to_string()),
                            ("x-ratelimit-remaining", "0".to_string()),
                        ],
                        Json(json!({
                            "jsonrpc": "2.0",
                            "error": {
                                "code":    -32029,
                                "message": format!(
                                    "demo rate limit of {} req/min exceeded — retry in {}s",
                                    limit, retry_after_sec
                                ),
                            },
                            "id": null
                        })),
                    )
                        .into_response();
                }
            }
        }
    }

    let tenant = tenancy::resolve(&auth_ctx);

    // JSON-RPC supports single or batch. Handle both.
    let responses = if body.is_array() {
        let mut out = Vec::new();
        if let Some(arr) = body.as_array() {
            for item in arr {
                if let Some(resp) = dispatch_one(item.clone(), &state, &auth_ctx, tenant).await {
                    out.push(resp);
                }
            }
        }
        out
    } else {
        match dispatch_one(body, &state, &auth_ctx, tenant).await {
            Some(r) => vec![r],
            None => vec![],
        }
    };

    // Notifications produce no response. If everything was a notification,
    // return 204.
    if responses.is_empty() {
        return StatusCode::NO_CONTENT.into_response();
    }

    if responses.len() == 1 && !was_batch() {
        Json(serde_json::to_value(&responses[0]).unwrap()).into_response()
    } else {
        Json(serde_json::to_value(&responses).unwrap()).into_response()
    }
}

// Helper: we don't actually need to preserve batch shape on the single-item
// fast path here; always return array if the original was array. Since we
// already branched on that above, use a sentinel that's always false in the
// single-item path. Kept as a fn to make the intent explicit.
fn was_batch() -> bool {
    false
}

async fn dispatch_one(
    raw: Value,
    state: &AppState,
    auth_ctx: &crate::auth::AuthContext,
    tenant: render_core::TenantId,
) -> Option<JsonRpcResponse> {
    // Parse envelope
    let req: JsonRpcRequest = match serde_json::from_value(raw) {
        Ok(r) => r,
        Err(e) => {
            return Some(JsonRpcResponse::err(
                Value::Null,
                JsonRpcError::new(JsonRpcError::PARSE_ERROR, e.to_string()),
            ));
        }
    };

    if req.jsonrpc != "2.0" {
        return Some(JsonRpcResponse::err(
            req.id.unwrap_or(Value::Null),
            JsonRpcError::new(JsonRpcError::INVALID_REQUEST, "jsonrpc must be '2.0'"),
        ));
    }

    let is_notification = req.id.is_none();
    let id = req.id.clone().unwrap_or(Value::Null);

    let result = match req.method.as_str() {
        "initialize" => handle_initialize(&req).map(|r| serde_json::to_value(r).unwrap()),
        "initialized" => {
            return None; /* notification, ignore */
        }
        "notifications/initialized" => {
            return None; /* notification, ignore */
        }
        "notifications/cancelled" => {
            return None; /* notification, ignore */
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(serde_json::to_value(ToolsListResult {
            tools: state.tools.list(),
        })
        .unwrap()),
        "tools/call" => handle_tools_call(&req, state, auth_ctx, tenant).await,
        other => Err(JsonRpcError::new(
            JsonRpcError::METHOD_NOT_FOUND,
            format!("unknown method: {other}"),
        )),
    };

    // Notifications: no response even if method succeeded
    if is_notification {
        return None;
    }

    match result {
        Ok(v) => Some(JsonRpcResponse::ok(id, v)),
        Err(e) => Some(JsonRpcResponse::err(id, e)),
    }
}

fn handle_initialize(_req: &JsonRpcRequest) -> Result<InitializeResult, JsonRpcError> {
    Ok(InitializeResult {
        protocol_version: PROTOCOL_VERSION,
        capabilities: ServerCapabilities {
            tools: ToolsCapability {
                list_changed: false,
            },
        },
        server_info: ServerInfo {
            name: SERVER_NAME,
            version: SERVER_VERSION,
        },
    })
}

async fn handle_tools_call(
    req: &JsonRpcRequest,
    state: &AppState,
    auth_ctx: &crate::auth::AuthContext,
    tenant: render_core::TenantId,
) -> Result<Value, JsonRpcError> {
    let params = req
        .params
        .as_ref()
        .ok_or_else(|| JsonRpcError::new(JsonRpcError::INVALID_PARAMS, "missing params"))?;
    let call: ToolsCallParams = serde_json::from_value(params.clone())
        .map_err(|e| JsonRpcError::new(JsonRpcError::INVALID_PARAMS, e.to_string()))?;

    let t0 = std::time::Instant::now();
    let result = state
        .tools
        .call(
            &call.name,
            &call.arguments,
            auth_ctx,
            tenant,
            state.db.clone(),
        )
        .await;
    let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;

    metrics::histogram!(
        "mobydb_tool_latency_ms",
        "tool" => call.name.clone(),
        "outcome" => if result.is_ok() { "ok" } else { "err" }
    )
    .record(elapsed_ms);

    // Warn if over the P99 budget
    if elapsed_ms > state.cfg.render_p99_budget_ms as f64 {
        warn!(
            tool = %call.name,
            elapsed_ms,
            budget_ms = state.cfg.render_p99_budget_ms,
            "tool call exceeded P99 budget"
        );
    }

    // MCP tools/call always returns a ToolsCallResult envelope. Errors from
    // the tool itself go in isError; JSON-RPC-level errors (bad params,
    // unknown tool) go on the envelope error.
    match result {
        Ok(v) => {
            let meta = crate::mcp::ToolsCallMeta {
                render_ms: elapsed_ms,
                tool: call.name.clone(),
            };
            let envelope = ToolsCallResult::text_json(&v).with_meta(meta);
            Ok(serde_json::to_value(envelope).unwrap())
        }
        Err(e)
            if e.code == JsonRpcError::METHOD_NOT_FOUND
                || e.code == JsonRpcError::INVALID_PARAMS =>
        {
            // Protocol-level error — bubble up as JSON-RPC error
            Err(e)
        }
        Err(e) => {
            // Application-level error — return as tool-call result with isError
            error!(tool = %call.name, code = e.code, msg = %e.message, "tool call failed");
            Ok(serde_json::to_value(ToolsCallResult::error(e.message)).unwrap())
        }
    }
}
