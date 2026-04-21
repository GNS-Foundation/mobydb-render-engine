# MobyDB Render Engine — Integration Guide

One page. No buzzwords. If you have 5 minutes, read this and you'll know
whether to evaluate further.

## What it is

A tenant-scoped spacetime key-value store with built-in cryptographic
provenance. Every write is Ed25519-signed by a named identity; every read
comes with a Merkle proof that lets the caller verify the record was part
of a sealed epoch — offline, with no trust in the server.

The API is [Model Context Protocol](https://modelcontextprotocol.io) over
HTTP. Any MCP-aware client (Claude Desktop, Anthropic SDK, LangChain,
custom) can call it directly; a standard HTTP/JSON-RPC client works just
as well.

## What you address

Every record in the store lives at `(tenant, H3 cell, epoch)`.

- **Tenant** is a UUID; calls are authenticated and RLS-scoped to your
  tenant. Data never crosses tenants.
- **H3 cell** is a 64-bit cell index from [Uber H3](https://h3geo.org) —
  hexagonal geospatial addressing, 16 resolutions. Resolution 9 is ~0.1 km²;
  resolution 12 is ~0.3 m².
- **Epoch** is a monotonic integer. Each epoch seals a Merkle root over all
  writes in that epoch and chains to the previous root. Once sealed,
  history is tamper-evident.

Writes carry a JSON payload, the caller's Ed25519 public key, and a
signature over `blake3(canonical_json(payload))`. You choose the payload
schema; the protocol doesn't care.

## What you get back

Five MCP tools, described in full by `tools/list`:

- `render_viewport` — read all cells in a geographic viewport at an epoch
- `get_cell_state` — read one cell; optionally pin the epoch
- `query_cells_in_region` — same as render_viewport, bounded result set
- `get_provenance` — full audit bundle: cell + attestations + Merkle proof + epoch chain
- `verify_attestation` — check that a third-party attestation is consistent + signed

The audit bundle from `get_provenance` is the product. It contains
everything an offline verifier needs: the cell state, its Ed25519
signature, the cell's `leaf_index` at the sealed epoch, the Merkle
`proof` path, and the stored `merkle_root`. Anyone can reconstruct
the tree locally and verify tamper-evidence — no live connection
to the service.

A reference TypeScript client with a `verifyProofLocally()` helper
is at `scripts/clients/typescript/client.ts`.

## Calling it

```bash
curl -X POST https://mobydb-render-engine-production.up.railway.app/mcp \
  -H "content-type: application/json" \
  -H "x-mobydb-api-key: $YOUR_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "get_cell_state",
      "arguments": { "h3_cell": "891e8052a0bffff" }
    }
  }'
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"cell_state\":{\"content_hash\":\"785ce92d...\",\"epoch_id\":2,\"h3_cell\":\"891e8052a0bffff\",\"identity_pk\":\"1396c883...\",\"payload\":{...},\"signature\":\"86c6d5ec...\",\"tenant_id\":\"00000000-...\",\"written_at\":\"2026-04-21T08:23:53Z\"}}"
    }],
    "_meta": { "render_ms": 22.3, "tool": "get_cell_state" }
  }
}
```

Content is MCP-canonical: a single `text` block containing a JSON string.
Clients parse it with `JSON.parse(result.content[0].text)`. The `_meta`
field reports server-side wall-clock time (no network, no HTTP framing).

## Authentication

Two modes supported; one is active at a time:

- **API key** — `x-mobydb-api-key` header. Rotatable. Good for SSO-internal
  service-to-service calls. Currently in use.
- **OAuth2 JWT** — `Authorization: Bearer <jwt>` against a configured JWKS
  endpoint. For end-user flows or federated enterprise IdPs. Code present,
  not yet validated against a live IdP; targeted Week 4.

Keys and tokens never leave the server. The API key is compared in
constant time to prevent timing-based extraction.

## Latency (measured)

From Rome, serial, 950 calls after warmup, against Railway us-east4:

| Layer                                     | p50    | p95    | p99    |
|-------------------------------------------|--------|--------|--------|
| Server-side (render_ms)                   | 21 ms  | 32 ms  | 40 ms  |
| Total (client wall-clock, cross-Atlantic) | 156 ms | 256 ms | 346 ms |

The server-side number is close to our Hetzner CCX13 reference benchmark
(41 ms p99 with the full compositor). Network accounts for the remainder;
local deployment (EU region) eliminates that component.

For context: reference benchmarks on the compositor engine, compiled
locally with no network:

| Environment                   | p99 (ms) |
|-------------------------------|----------|
| Apple M4 (local)              | 17.5     |
| Hetzner CCX13 (local)         | 40.8     |
| Linux 1-vCPU container        | 59.5     |

Reproduce with `node scripts/bench/p99.mjs`.

## Isolation

Data is isolated three ways, in order of importance:

1. **Row-level security** enforced by Postgres at query time. The service
   runs as a non-superuser role (`render_app`) under which RLS policies
   are not bypassable. Every query carries `SET LOCAL app.current_tenant_id`;
   no session-var, no results.
2. **Explicit tenant predicate** on every SQL query. RLS is defense in
   depth; the application never relies on it as the sole filter.
3. **Composite primary key** — `(tenant_id, h3_cell, epoch_id)`. Even
   with both previous layers bypassed, cross-tenant joins would require
   an attacker to guess another tenant's UUID.

Multi-tenancy has been verified end-to-end with a dedicated integration
test that runs in CI against a fresh Postgres instance.

## Data residency

Current: Railway us-east4 (Google Cloud Virginia) + Railway Postgres EU.

Phase 2 migration (targeted Week 9, before any EU-regulated production
traffic): Hetzner Milan. Both the service and the database land under
EU data residency. This is the form intended for Italian grid operators
and other entities subject to Italian data law; it is not today's form.

## EU AI Act compliance

The Render Engine is built to be a compliance artifact under the EU AI
Act (Regulation (EU) 2024/1689), specifically:

- **Article 13 (transparency)** — every agent decision is bound to a
  verifiable record with known provenance.
- **Article 15 (accuracy / robustness / cybersecurity)** — Ed25519
  signatures and Merkle chains are tamper-evident; RLS enforces access
  control; the audit trail cannot be rewritten without detection.
- **Articles 24-25 (post-market monitoring)** — `get_provenance` produces
  a serializable bundle that regulators can archive and independently
  verify, with no live connection to the service.

Full compliance mapping document is in the Week 10 deliverable.

## Source, license, support

- Repository: `github.com/GNS-Foundation/mobydb-render-engine`
- License: dual — BSL 1.1 for the commercial service tier, MIT/Apache-2.0
  for the core protocol crates and client libraries
- Spec: `draft-ayerbe-trip-protocol-03` (IETF Internet-Draft, active)
- Contact: camilo@ulissy.app
