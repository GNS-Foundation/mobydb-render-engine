//! Configuration loaded from environment variables.
//!
//! See `.env.example` for the canonical list. Every variable here has a
//! sensible default (dev-oriented); production overrides come from Railway.

use std::env;
use uuid::Uuid;

#[allow(dead_code)] // tenancy_strict (Week 4), max_viewport_cells + default_h3_resolution (Week 2)
pub struct Config {
    // Runtime
    pub env: String,
    pub rust_log: String,
    pub mcp_server_host: String,
    pub mcp_server_port: u16,
    pub mcp_transport: String,

    // Database
    pub database_url: String,
    pub database_pool_max: u32,
    pub database_pool_min: u32,
    pub database_connect_timeout_sec: u64,
    pub database_idle_timeout_sec: u64,
    pub database_migrate_on_start: bool,

    // Tenancy
    pub tenancy_session_var: String,
    pub tenant_id_default: Uuid,
    pub tenancy_strict: bool,

    // Auth
    pub auth_api_key: Option<String>,
    pub auth_api_key_header: String,
    /// Optional second API key for a public rate-limited demo surface.
    /// Requests using this key are still tenant-scoped to TENANT_ID_DEFAULT,
    /// but are subject to a per-minute rate limit to prevent abuse of the
    /// public URL (e.g. demo.mobydb.com).
    pub auth_demo_api_key: Option<String>,
    /// Rate limit in requests per minute for the demo key. Applies globally
    /// (single shared bucket) since there is a single demo key.
    pub auth_demo_rate_limit_per_min: u32,
    pub oauth_enabled: bool,
    pub oauth_issuer: String,
    pub oauth_audience: String,
    pub oauth_jwks_url: String,
    pub oauth_jwks_cache_sec: u64,
    pub oauth_tenant_claim: String,

    // Limits
    pub max_viewport_cells: usize,
    pub default_h3_resolution: u8,
    pub render_p99_budget_ms: u64,

    // Observability
    pub metrics_enabled: bool,

    // Deployment metadata
    pub git_sha: String,
    pub build_time: String,
    pub railway_environment: Option<String>,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        // Railway sets PORT; we prefer MCP_SERVER_PORT but fall back.
        let port: u16 = env_or("MCP_SERVER_PORT", "")
            .parse()
            .ok()
            .or_else(|| env_or("PORT", "").parse().ok())
            .unwrap_or(8080);

        let default_tenant = env_or("TENANT_ID_DEFAULT", "00000000-0000-0000-0000-000000000000");
        let tenant_id_default = Uuid::parse_str(&default_tenant)
            .map_err(|e| anyhow::anyhow!("TENANT_ID_DEFAULT invalid UUID: {e}"))?;

        Ok(Self {
            env: env_or("ENV", "development"),
            rust_log: env_or("RUST_LOG", "info"),
            mcp_server_host: env_or("MCP_SERVER_HOST", "0.0.0.0"),
            mcp_server_port: port,
            mcp_transport: env_or("MCP_TRANSPORT", "http"),

            database_url: env::var("DATABASE_URL")
                .map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?,
            database_pool_max: env_or("DATABASE_POOL_MAX", "20").parse().unwrap_or(20),
            database_pool_min: env_or("DATABASE_POOL_MIN", "2").parse().unwrap_or(2),
            database_connect_timeout_sec: env_or("DATABASE_CONNECT_TIMEOUT_SEC", "10")
                .parse()
                .unwrap_or(10),
            database_idle_timeout_sec: env_or("DATABASE_IDLE_TIMEOUT_SEC", "300")
                .parse()
                .unwrap_or(300),
            database_migrate_on_start: bool_env("DATABASE_MIGRATE_ON_START", true),

            tenancy_session_var: env_or("TENANCY_SESSION_VAR", "app.current_tenant_id"),
            tenant_id_default,
            tenancy_strict: bool_env("TENANCY_STRICT", true),

            auth_api_key: env::var("AUTH_API_KEY").ok().filter(|s| !s.is_empty()),
            auth_api_key_header: env_or("AUTH_API_KEY_HEADER", "x-mobydb-api-key"),
            auth_demo_api_key: env::var("AUTH_DEMO_API_KEY").ok().filter(|s| !s.is_empty()),
            auth_demo_rate_limit_per_min: env_or("AUTH_DEMO_RATE_LIMIT_PER_MIN", "100")
                .parse()
                .unwrap_or(100),
            oauth_enabled: bool_env("OAUTH_ENABLED", false),
            oauth_issuer: env_or("OAUTH_ISSUER", ""),
            oauth_audience: env_or("OAUTH_AUDIENCE", ""),
            oauth_jwks_url: env_or("OAUTH_JWKS_URL", ""),
            oauth_jwks_cache_sec: env_or("OAUTH_JWKS_CACHE_SEC", "3600")
                .parse()
                .unwrap_or(3600),
            oauth_tenant_claim: env_or("OAUTH_TENANT_CLAIM", "tenant_id"),

            max_viewport_cells: env_or("MAX_VIEWPORT_CELLS", "4096").parse().unwrap_or(4096),
            default_h3_resolution: env_or("DEFAULT_H3_RESOLUTION", "9").parse().unwrap_or(9),
            render_p99_budget_ms: env_or("RENDER_P99_BUDGET_MS", "50").parse().unwrap_or(50),

            metrics_enabled: bool_env("METRICS_ENABLED", true),

            git_sha: env_or("GIT_SHA", "unknown"),
            build_time: env_or("BUILD_TIME", "unknown"),
            railway_environment: env::var("RAILWAY_ENVIRONMENT")
                .ok()
                .filter(|s| !s.is_empty()),
        })
    }
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn bool_env(key: &str, default: bool) -> bool {
    env::var(key)
        .ok()
        .and_then(|s| match s.to_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
        .unwrap_or(default)
}
