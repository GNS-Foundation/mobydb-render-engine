# MobyDB Render Engine

**MCP-native spacetime rendering engine for audit-grade geospatial AI.**

First commercial product of the GNS Foundation / GEIANT stack. Validated P99
rendering performance across Apple M4 (17.5 ms), Hetzner CCX13 (40.8 ms), and
a constrained Linux container (59.5 ms). Licensed per deployment to enterprise
customers under the EU AI Act.

Status: **v0.1, pre-release**. First pilot target Q2 2026.

---

## What it is

A Rust service that speaks the Model Context Protocol (MCP) natively and
exposes five read-tools over a multi-tenant spacetime-addressed datastore
(MobyDB). Every tool call returns cryptographic provenance: Ed25519 signatures
+ blake3 Merkle roots + per-tenant epoch chain.

The five v1 tools:

- `render_viewport` — render cell states for a viewport
- `get_cell_state` — read one cell at one epoch
- `query_cells_in_region` — list cells in bbox or under parent H3
- `get_provenance` — full audit bundle for a cell (state + attestations + Merkle proof)
- `verify_attestation` — verify a third-party claim about a cell

Transport is HTTP JSON-RPC 2.0 (Railway target). stdio transport is stubbed
for local-agent use and will land in a minor version.

## Architecture at a glance

```
              ┌────────────────┐
              │  MCP Client    │ (Claude, enterprise agent, TS SDK)
              └────────┬───────┘
                       │  JSON-RPC 2.0 over HTTP
                       ▼
              ┌────────────────┐
              │   mcp-server   │  Axum, auth (OAuth2 + API key), tool registry
              └────────┬───────┘
                       │
                       ▼
              ┌────────────────┐
              │  render-core   │  Types, pure tool fns, canonical JSON, Ed25519
              └────────┬───────┘
                       │
                       ▼
              ┌────────────────┐
              │ mobydb-client  │  sqlx, RLS session-var, Merkle proof construction
              └────────┬───────┘
                       │
                       ▼
              ┌────────────────┐
              │   Postgres     │  composite PK (tenant, h3, epoch), RLS forced
              └────────────────┘
```

Workspace layout:

```
mobydb-render-engine/
├── crates/
│   ├── render-core/       # types + pure tool implementations + MobyDbClient trait
│   ├── mobydb-client/     # sqlx Postgres impl, merkle proof builder
│   └── mcp-server/        # binary: Axum HTTP, JSON-RPC 2.0, auth, tool registry
├── migrations/            # sqlx migrations (composite PK + RLS)
├── docs/
│   ├── ROADMAP.md         # 12-week engineering roadmap
│   └── ARCHITECTURE.md    # deeper design
├── .github/workflows/     # CI: fmt, clippy, test, deny, docker
├── Dockerfile             # multi-stage, cargo-chef caching
├── railway.json           # Railway deployment config
└── Cargo.toml             # workspace
```

---

## 10-minute local bootstrap

Requires: Rust 1.83 (pinned via `rust-toolchain.toml`), Docker, Postgres 16.

```bash
git clone git@github.com:GNS-Foundation/mobydb-render-engine.git
cd mobydb-render-engine

# 1. Start Postgres
docker run -d --name mobydb-pg \
    -e POSTGRES_USER=mobydb \
    -e POSTGRES_PASSWORD=dev \
    -e POSTGRES_DB=mobydb_render \
    -p 5432:5432 postgres:16

# 2. Local .env
cp .env.example .env
# Then edit DATABASE_URL → postgres://mobydb:dev@localhost:5432/mobydb_render

# 3. Apply migrations
cargo install sqlx-cli --version 0.8 --no-default-features --features rustls,postgres
sqlx migrate run

# 4. Run the server
cargo run --bin mcp-server
```

In a second terminal:

```bash
# Health
curl http://localhost:8080/health

# List tools (MCP JSON-RPC)
curl -s -X POST http://localhost:8080/mcp \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq .

# Get a cell state (will be null until you seed data)
curl -s -X POST http://localhost:8080/mcp \
    -H 'content-type: application/json' \
    -d '{
        "jsonrpc":"2.0","id":2,
        "method":"tools/call",
        "params":{
            "name":"get_cell_state",
            "arguments":{"h3_cell":"8928308280fffff"}
        }
    }' | jq .
```

---

## Development

**Format + lint:**

```bash
cargo fmt
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

**Test:**

```bash
# Unit tests (no DB)
cargo test -p render-core

# Integration tests (requires Postgres + migrations)
DATABASE_URL=postgres://mobydb:dev@localhost:5432/mobydb_render \
    cargo test --workspace
```

**Rebuild the Docker image:**

```bash
docker build -t mobydb-render-engine:dev \
    --build-arg GIT_SHA=$(git rev-parse --short HEAD) \
    --build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) .
```

---

## Deployment

**Railway (Phase 1):**

Push to `main`. Railway builds from `Dockerfile`, picks up `railway.json` for
healthcheck config, and exposes the service at `render-*.up.railway.app`.

Required env vars in Railway (see `.env.example` for full list):

- `DATABASE_URL` (from Railway Postgres plugin)
- `AUTH_API_KEY` or `OAUTH_*` group
- `TENANCY_STRICT=1` (production)
- `DATABASE_MIGRATE_ON_START=0` (production — apply migrations via CI)
- `ENV=production`

**Hetzner (Phase 2):**

Triggered per-customer. Runbook in `docs/ops/phase2-migration.md` (Week 9 deliverable).

---

## Tenancy model

Every request runs inside a Postgres transaction that sets:

```sql
SELECT set_config('app.current_tenant_id', '<uuid>', true);
```

RLS policies on all tables (`tenants`, `epochs`, `cell_states`, `attestations`)
filter rows by this session variable. `FORCE ROW LEVEL SECURITY` is enabled on
all tables — even table owners can't bypass RLS. If no tenant is set, queries
return zero rows (fail closed).

The tenant is resolved from:
1. OAuth2 JWT claim (configurable name, default `tenant_id`), if `OAUTH_ENABLED=1`
2. API key → maps to `TENANT_ID_DEFAULT` (single-tenant dev mode)
3. No auth + `ENV != production` → `TENANT_ID_DEFAULT` (dev fallback)
4. No auth + `ENV = production` → 401

---

## Roadmap

See `docs/ROADMAP.md` for the 12-week engineering plan.

---

## License

Proprietary. © 2026 ULISSY s.r.l. / GNS Foundation.

Contact: hello@ulissy.app · [mobydb.com](https://mobydb.com)
