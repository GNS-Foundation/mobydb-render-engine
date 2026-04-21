//! Request authentication.
//!
//! Two schemes, tried in order:
//!   1. Bearer token (OAuth2 JWT) — if `OAUTH_ENABLED=1`
//!   2. API key header — if `AUTH_API_KEY` is configured
//!
//! On success produces an `AuthContext` containing the resolved tenant. On
//! failure returns an opaque 401.
//!
//! v0.1 JWKS caching is naive (Mutex<Option<CachedJwks>> with TTL). A refined
//! version will use `Arc<RwLock<..>>` + background refresh.

use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, warn};
use uuid::Uuid;

use crate::config::Config;
use render_core::TenantId;

#[derive(Clone)]
#[allow(dead_code)] // scheme + subject consumed in Week 4 (authz) and Week 5 (log enrichment)
pub struct AuthContext {
    pub tenant: TenantId,
    pub scheme: AuthScheme,
    pub subject: Option<String>,
}

#[derive(Clone, Debug)]
pub enum AuthScheme {
    ApiKey,
    OAuth2,
    /// Development fallback: no auth configured at all; uses TENANT_ID_DEFAULT.
    /// Hard-error in production via cfg.env guard.
    None,
}

#[derive(Clone)]
pub struct AuthState {
    pub cfg: Arc<Config>,
    pub jwks: Arc<Mutex<Option<CachedJwks>>>,
    pub http: reqwest::Client,
}

pub struct CachedJwks {
    pub set: JwkSet,
    pub fetched_at: std::time::Instant,
}

impl AuthState {
    pub fn new(cfg: Arc<Config>) -> Self {
        Self {
            cfg,
            jwks: Arc::new(Mutex::new(None)),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
        }
    }
}

pub struct AuthError(pub StatusCode, pub &'static str);

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

pub async fn authenticate(
    headers: &HeaderMap,
    state: &AuthState,
) -> Result<AuthContext, AuthError> {
    let cfg = &state.cfg;

    // ---- 1. OAuth2 bearer ----
    if cfg.oauth_enabled {
        if let Some(tok) = extract_bearer(headers) {
            return verify_oauth(&tok, state).await.map_err(|e| {
                warn!(error = %e, "oauth verification failed");
                AuthError(StatusCode::UNAUTHORIZED, "invalid token")
            });
        }
        if cfg.auth_api_key.is_none() {
            // OAuth is the only configured scheme, and the caller didn't send
            // a token.
            return Err(AuthError(StatusCode::UNAUTHORIZED, "bearer token required"));
        }
    }

    // ---- 2. API key ----
    if let Some(expected) = cfg.auth_api_key.as_ref() {
        match headers.get(cfg.auth_api_key_header.as_str()) {
            Some(v) => {
                let v = v.to_str().unwrap_or("");
                if constant_time_eq(v.as_bytes(), expected.as_bytes()) {
                    return Ok(AuthContext {
                        tenant: TenantId::new(cfg.tenant_id_default),
                        scheme: AuthScheme::ApiKey,
                        subject: None,
                    });
                }
                return Err(AuthError(StatusCode::UNAUTHORIZED, "invalid api key"));
            }
            None => return Err(AuthError(StatusCode::UNAUTHORIZED, "missing api key")),
        }
    }

    // ---- 3. Dev fallback (no auth configured) ----
    if cfg.env == "production" {
        // In production, NO AUTH is a deployment error. Fail closed.
        return Err(AuthError(StatusCode::UNAUTHORIZED, "no auth configured"));
    }
    debug!("no auth configured, falling back to default tenant (dev/test only)");
    Ok(AuthContext {
        tenant: TenantId::new(cfg.tenant_id_default),
        scheme: AuthScheme::None,
        subject: None,
    })
}

fn extract_bearer(headers: &HeaderMap) -> Option<String> {
    let h = headers.get("authorization")?.to_str().ok()?;
    let prefix = "Bearer ";
    if h.len() > prefix.len() && h[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(h[prefix.len()..].trim().to_string())
    } else {
        None
    }
}

async fn verify_oauth(token: &str, state: &AuthState) -> anyhow::Result<AuthContext> {
    let cfg = &state.cfg;

    // 1. Get JWKS (cached or fresh)
    let jwks = get_jwks(state).await?;

    // 2. Decode header, find key by kid
    let header = decode_header(token)?;
    let kid = header
        .kid
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("token header missing kid"))?;
    let jwk = jwks
        .find(kid)
        .ok_or_else(|| anyhow::anyhow!("no JWK matches kid {kid}"))?;

    // 3. Build decoding key
    let decoding_key = DecodingKey::from_jwk(jwk)?;

    // 4. Validate
    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[cfg.oauth_issuer.as_str()]);
    validation.set_audience(&[cfg.oauth_audience.as_str()]);

    // Accept RS256/ES256/EdDSA as the common enterprise set
    validation.algorithms = vec![Algorithm::RS256, Algorithm::ES256, Algorithm::EdDSA];

    let data = decode::<serde_json::Value>(token, &decoding_key, &validation)?;
    let claims = &data.claims;

    // 5. Resolve tenant from configured claim
    let tenant_str = claims
        .get(&cfg.oauth_tenant_claim)
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            anyhow::anyhow!("token missing tenant claim `{}`", cfg.oauth_tenant_claim)
        })?;
    let tenant =
        Uuid::parse_str(tenant_str).map_err(|e| anyhow::anyhow!("tenant claim not a UUID: {e}"))?;

    let subject = claims.get("sub").and_then(|v| v.as_str()).map(String::from);

    Ok(AuthContext {
        tenant: TenantId::new(tenant),
        scheme: AuthScheme::OAuth2,
        subject,
    })
}

async fn get_jwks(state: &AuthState) -> anyhow::Result<JwkSet> {
    let ttl = std::time::Duration::from_secs(state.cfg.oauth_jwks_cache_sec);
    let mut guard = state.jwks.lock().await;
    let needs_fetch = match guard.as_ref() {
        Some(c) => c.fetched_at.elapsed() > ttl,
        None => true,
    };
    if needs_fetch {
        let url = &state.cfg.oauth_jwks_url;
        let resp = state.http.get(url).send().await?.error_for_status()?;
        let set: JwkSet = resp.json().await?;
        *guard = Some(CachedJwks {
            set,
            fetched_at: std::time::Instant::now(),
        });
    }
    Ok(guard.as_ref().unwrap().set.clone())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}
