# Architecture — MobyDB Render Engine v0.1

## Design principles

1. **Pure-function tool implementations.** Every tool is an `async fn` in
   `render-core::tools` that takes a `&dyn MobyDbClient` plus input and
   returns output. No MCP, HTTP, or logging in the core. This lets us test
   tools without any transport, and swap transports (HTTP ↔ stdio) without
   touching logic.

2. **Tenant scoping at two layers.** Every `MobyDbClient` method takes an
   explicit `&TenantId`, AND every query runs in a transaction that has set
   the `app.current_tenant_id` session variable. The trait signature is
   defense-in-depth; the RLS policy is the enforcement. Tests cover both
   layers.

3. **Composite PK, not UUID surrogate.** The primary key is
   `(tenant_id, h3_cell, epoch_id)`. This is the *address* of a cell state,
   not a row id. No UUID lookups — reads are always positional in spacetime.

4. **Fail closed.** If the tenant session var isn't set, RLS returns zero
   rows. If the signature doesn't verify, `verify_attestation` returns
   false with reason. If no auth scheme is configured in production, the
   server returns 401 on every request.

5. **Adapter layers stay thin.** h3o geometry APIs change between minor
   versions; the adapter is one function (`viewport_to_cells`). rmcp / MCP
   spec changes; the adapter is `crates/mcp-server/src/mcp.rs`. Most of the
   code doesn't know or care.

## Data model

### `tenants`

One row per customer. Slug for URL/log use, display name for UI. `status`
tracks migration to Phase 2 dedicated infra (`active | suspended | migrated`).

### `epochs` — monotonic per tenant

A tenant's epoch id starts at 0 (genesis) and increases by 1 on each seal. An
epoch's `merkle_root` is blake3 over the ordered list of `content_hash`
values for every cell written at that epoch, ordered by `h3_cell ASC`
(deterministic sort, independent of insertion time). `parent_root` chains
epochs: verifying a historical state means verifying a path of roots back to
genesis.

### `cell_states` — the hot path

One row per (tenant, h3, epoch). `identity_pk` is the writer's Ed25519 public
key; `signature` is Ed25519(content_hash, writer_sk). `payload` is opaque
JSONB — the render engine doesn't interpret it.

Indices:
- `(tenant_id, h3_cell, epoch_id DESC)` — latest-per-cell (get_cell_state, default)
- `(tenant_id, epoch_id)` — epoch scan (query_cells_in_region, audit)
- `(tenant_id, identity_pk)` — writer-identity lookups (provenance by writer)

### `attestations` — third-party claims

Structurally similar to cell_states but writes are from *third parties*
attesting about a specific cell. `claim_hash` = blake3(canonical_json(claim)),
`signature` = Ed25519(claim_hash, attester_sk). Deleting the cell cascades to
its attestations (FK ON DELETE CASCADE).

## Merkle proof protocol

Construction: leaves are the `content_hash` values in sorted order. Inner
nodes are blake3(left || right). Odd layers duplicate the last node
(Bitcoin-style). Proof is the sibling path leaf-to-root.

Verification is side-independent: the verifier doesn't need the tree, only
the leaf's position (derived from its rank in the epoch's sorted cell list)
and the proof. See `mobydb_client::merkle::verify_proof`.

Why blake3: faster than SHA256, constant-time, SIMD-friendly. Used
consistently across GNS stack (breadcrumbs, content hashes, merkle).

## Canonical JSON

For any payload that needs a reproducible hash, we use:
- Object keys sorted lexicographically
- `null` fields dropped (not serialized)
- Arrays in given order (not sorted)
- Numbers serialized by serde's default

This matches the GCRUMBS / GNS `canonicalJson` convention used across the
stack (breadcrumb signing, delegation certs, attestations). See
`render_core::tools::canonical_json` + its unit tests.

## Request lifecycle (HTTP transport)

```
 1. POST /mcp with JSON-RPC envelope
 2. Middleware: request_id, CORS, tracing
 3. auth::authenticate → AuthContext (tenant, scheme, subject)
 4. JSON-RPC parse, method dispatch
 5. If tools/call: ToolRegistry.call(name, args, tenant, db)
 6. Tool function runs on &dyn MobyDbClient:
     a. Begin transaction
     b. SELECT set_config('app.current_tenant_id', $1, true)
     c. Execute tool query
     d. Commit
 7. Result serialized as JSON-RPC response
 8. Metrics: histogram with tool_name, outcome labels
 9. If elapsed > p99 budget: warn log
```

## Error taxonomy

`render_core::CoreError` variants map to JSON-RPC codes in
`mcp-server::error::core_to_jsonrpc`:

| CoreError                    | JSON-RPC code | HTTP analog |
|------------------------------|--------------:|------------:|
| InvalidH3Cell / Resolution   |        -32602 |         422 |
| ViewportTooLarge             |        -32602 |         422 |
| EpochNotFound / CellNotFound |        -32004 |         404 |
| InvalidSignature             |        -32003 |         403 |
| TenantNotSet                 |        -32001 |         401 |
| Database / Serde / Other     |        -32603 |         500 |

Within `tools/call`, application-level errors go into the `ToolsCallResult`
envelope (`isError: true`, message in `content[0].text`). Only protocol-level
errors (unknown tool, malformed params) become JSON-RPC-level errors.

## Why not [...]

**Why not rmcp?** The Rust MCP SDK is fine but its API shifts across minor
versions. The MCP protocol itself is stable JSON-RPC 2.0 with a fixed method
set. Implementing the protocol directly over Axum is ~200 lines and gives us
full control over error shapes, middleware integration, and batching. If
rmcp stabilizes we can migrate the HTTP handler without changing anything
else.

**Why not PostGIS?** The render engine workload is H3-native: all spatial
indexing is already in the H3 cell id. PostGIS would be overhead without
benefit. For downstream customers who need PostGIS interop, MobyDB exposes
a `ST_*` compatibility shim upstream — not this service's concern.

**Why sqlx and not diesel?** Pure async, compile-time query checking when we
want it (`query!` macro), no ORM gravity. Tool functions emit raw SQL; the
trait defines the shape.

**Why not schema-per-tenant from day one?** RLS-on-shared-schema is the
right default at 1-50 tenants with similar-sized workloads. Schema-per-tenant
costs us cross-tenant queries (which we sometimes want for internal
metrics) and adds migration complexity. Week 11 has a plan for migrating if
workload shape demands it.

## Open questions (tracked as TODOs in source)

- **Merkle proof position encoding** — currently implicit (caller computes
  leaf index from cell's rank in epoch). Tuple `(sibling_hash, is_right)`
  would be more ergonomic; v0.2 candidate.
- **Bbox coverage approximation** — grid_disk over-covers; exact polygon
  coverage waits on h3o::geom stabilization.
- **Authz scoping** — per-tool required scope is stubbed in the registry
  but not enforced; Week 4 lands it.
- **Stdio transport** — stub in main.rs, not implemented.
