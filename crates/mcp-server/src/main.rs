//! MobyDB Render Engine — MCP server binary.
//!
//! Transports:
//!   * HTTP (default, Railway target) — JSON-RPC 2.0 over POST /mcp
//!   * stdio (flag-selected, for local agents) — one JSON-RPC message per line
//!
//! Auth:
//!   * API key header (bootstrap, CI, dev)
//!   * OAuth2 bearer token (staging/prod, JWT against configured JWKS)
//!
//! Healthz:
//!   * GET /health → {status, git_sha, build_time, db_healthy}
//!   * GET /metrics → Prometheus exposition (if enabled)

mod auth;
mod config;
mod error;
mod http;
mod mcp;
mod rate_limit;
mod tenancy;
mod tools;

use std::sync::Arc;
use tracing::{info, warn};

use config::Config;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Load env from .env if present (dev only; in prod Railway provides env)
    let _ = dotenvy::dotenv();

    // 2. Load + validate config
    let cfg = Config::from_env()?;

    // 3. Init tracing
    init_tracing(&cfg);

    info!(
        git_sha  = %cfg.git_sha,
        env      = %cfg.env,
        transport = %cfg.mcp_transport,
        "mobydb-render-engine starting",
    );

    // 4. Connect to MobyDB (Postgres)
    let db_cfg = mobydb_client::postgres::Config {
        database_url: cfg.database_url.clone(),
        pool_max: cfg.database_pool_max,
        pool_min: cfg.database_pool_min,
        connect_timeout: std::time::Duration::from_secs(cfg.database_connect_timeout_sec),
        idle_timeout: Some(std::time::Duration::from_secs(
            cfg.database_idle_timeout_sec,
        )),
        tenancy_session_var: cfg.tenancy_session_var.clone(),
    };
    let db = mobydb_client::PostgresMobyDb::connect(db_cfg).await?;

    // 5. Run migrations if configured (dev/CI only; prod uses external apply)
    if cfg.database_migrate_on_start {
        info!("applying migrations on startup");
        db.run_migrations().await?;
    }

    let db: Arc<dyn render_core::MobyDbClient> = Arc::new(db);

    // 6. Quick DB health sanity check before opening the port
    if let Err(e) = db.health().await {
        warn!(error = %e, "database health check failed at startup");
    }

    // 7. Construct the optional lab client (GEIANT Lab Supabase). This
    //    is None when LAB_DATABASE_URL is unset — the query_predictions
    //    MCP tool returns an error in that case but the rest of the
    //    server runs normally.
    let lab: Option<std::sync::Arc<dyn lab_client::LabClient>> =
        if let Some(url) = cfg.lab_database_url.clone() {
            info!("connecting to GEIANT Lab Supabase");
            let lab_cfg = lab_client::Config {
                database_url: url,
                pool_max: 5,
                connect_timeout: std::time::Duration::from_secs(10),
            };
            match lab_client::PostgresLabClient::connect(lab_cfg).await {
                Ok(client) => {
                    info!("lab client ready");
                    Some(std::sync::Arc::new(client) as std::sync::Arc<dyn lab_client::LabClient>)
                }
                Err(e) => {
                    warn!(error = %e, "failed to connect to lab database; query_predictions will be unavailable");
                    None
                }
            }
        } else {
            warn!("LAB_DATABASE_URL not set; query_predictions MCP tool will be unavailable");
            None
        };

    // 8. Dispatch by transport
    match cfg.mcp_transport.as_str() {
        "http" => http::serve(cfg, db, lab).await,
        "stdio" => {
            anyhow::bail!("stdio transport not yet implemented in v0.1 — use http")
        }
        other => anyhow::bail!("unknown transport: {other}"),
    }
}

fn init_tracing(cfg: &Config) {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(cfg.rust_log.clone()));

    let fmt_layer = if cfg.env == "production" {
        fmt::layer()
            .json()
            .with_current_span(true)
            .with_span_list(false)
            .boxed()
    } else {
        fmt::layer()
            .with_target(true)
            .with_file(false)
            .with_line_number(false)
            .boxed()
    };

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt_layer)
        .init();
}
