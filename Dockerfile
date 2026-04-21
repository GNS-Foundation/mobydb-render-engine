# =============================================================================
# MobyDB Render Engine — production Dockerfile
# =============================================================================
# Multi-stage build:
#   1. chef      — cache dependency layer via cargo-chef
#   2. builder   — build the workspace
#   3. runtime   — minimal debian:bookworm-slim with only the mcp-server binary
#
# Build args:
#   GIT_SHA     — short git SHA, embedded into the binary for /health reporting
#   BUILD_TIME  — ISO-8601 timestamp
# =============================================================================

ARG RUST_VERSION=1.88
ARG DEBIAN_VERSION=bookworm

# -----------------------------------------------------------------------------
# Stage 1: plan dependencies (cargo-chef)
# -----------------------------------------------------------------------------
FROM rust:${RUST_VERSION}-${DEBIAN_VERSION} AS chef
RUN cargo install cargo-chef --locked --version 0.1.68
WORKDIR /build

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# -----------------------------------------------------------------------------
# Stage 2: build (deps cached separately from source)
# -----------------------------------------------------------------------------
FROM chef AS builder
COPY --from=planner /build/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json

COPY . .
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}
RUN cargo build --release --bin mcp-server --locked
RUN strip /build/target/release/mcp-server

# -----------------------------------------------------------------------------
# Stage 3: runtime (slim)
# -----------------------------------------------------------------------------
FROM debian:${DEBIAN_VERSION}-slim AS runtime

# Minimal runtime deps: ca-certificates (TLS), tini (PID 1), libpq NOT needed
# (sqlx uses rustls, not libpq)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN groupadd --system --gid 10001 app \
    && useradd  --system --uid 10001 --gid app --home-dir /app --shell /sbin/nologin app

WORKDIR /app
COPY --from=builder /build/target/release/mcp-server /usr/local/bin/mcp-server
COPY --from=builder /build/migrations /app/migrations

USER app:app

# Railway injects PORT; we honor MCP_SERVER_PORT first but fall back to PORT
ENV MCP_SERVER_HOST=0.0.0.0
EXPOSE 8080

# Rebuild bust keys — written into the image for /health introspection
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["mcp-server"]
