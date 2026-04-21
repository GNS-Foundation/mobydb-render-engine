# MobyDB Render Engine — Engineering Roadmap

**Version:** v0.1
**Horizon:** 12 weeks, 20 April 2026 → 13 July 2026
**Target gates:**
 - Week 1 end: first `get_cell_state` round trip against Railway MobyDB
 - Week 2 end: all 5 v1 MCP tools live with real data
 - Week 6 end: first customer-facing demo endpoint stood up per NDA
 - Week 8 end: first pilot contract in production
 - Week 10 end: EU AI Act compliance package shipped (ahead of 2 August deadline)
 - Week 12 end: v1.0 release cut, MCP Registry publication

**Owner legend:**
 - `[Claude]` — code/doc/artifact that Claude produces directly
 - `[Camilo]` — Camilo executes (infra, review, decisions)
 - `[Together]` — pair session, live iteration

This roadmap is the engineering track. External dependencies (investor
meeting, IP clearance, partner calls, customer surfacing) run asynchronously
and are tracked in the migration doc's parallel track table.

---

## Week 0 — Foundation (this week)

**Goal:** Repo exists, CI runs green, local dev bootstraps in under 10 min.

| # | Deliverable | Owner | Acceptance |
|---|---|---|---|
| 0.1 | `git init` + push to `github.com/GNS-Foundation/mobydb-render-engine` (private) | [Camilo] | Remote origin reachable; initial commit on main |
| 0.2 | Week-0 scaffold committed (workspace Cargo.toml, rust-toolchain, .gitignore, Dockerfile, railway.json, .dockerignore) | [Claude] ✅ | `cargo check --workspace` succeeds on Camilo's Mac |
| 0.3 | `.env.example` canonical (8 grouped sections, every var documented) | [Claude] ✅ | File present; Camilo's local `.env` derived from it boots the binary |
| 0.4 | `.github/workflows/ci.yml` — fmt, clippy, test (with ephemeral Postgres), deny, docker | [Claude] ✅ | First PR turns CI green end-to-end |
| 0.5 | `migrations/0001_initial_schema.sql` — composite PK, RLS, seed CI tenant | [Claude] ✅ | `sqlx migrate run` applies cleanly; CI job passes |
| 0.6 | Railway project created; Postgres plugin on EU-West; env wired | [Camilo] | `DATABASE_URL` present in Railway service env |
| 0.7 | Supabase `kaqwkxfaclyqjlfhxrmt` service-key confirmed accessible from render-engine credentials | [Camilo] | Smoke: `curl` with `SUPABASE_SERVICE_KEY` returns 200 |
| 0.8 | `README.md` with 10-min onboarding (clone → `.env` → `cargo run`) | [Claude] ✅ | New engineer can boot the server following only the README |

**Exit:** `git push` → CI green → `cargo run` locally boots the server → `curl /health` returns 200.

---

## Week 1 — Smallest End-to-End Slice

**Goal:** One real tool (`get_cell_state`) works against a real Railway MobyDB. Proves the pipe.

| # | Deliverable | Owner | Acceptance |
|---|---|---|---|
| 1.1 | `render-core` crate — types, tool fns, `MobyDbClient` trait, canonical_json, Ed25519 verify | [Claude] ✅ | `cargo test -p render-core` passes; `canonical_json` + merkle roundtrip tests green |
| 1.2 | `mobydb-client` crate — sqlx Postgres impl, RLS session var management, merkle proof builder | [Claude] ✅ | Integration test against Postgres service container passes |
| 1.3 | `mcp-server` binary — config, auth, JSON-RPC dispatcher, tool registry, `/health`, `/metrics` | [Claude] ✅ | `curl -X POST /mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` lists 5 tools |
| 1.4 | First Railway deployment `render-dev-claude` | [Together] | `curl https://render-dev-claude.up.railway.app/health` returns `{"status":"ok"}` |
| 1.5 | Seed-data loader script — inserts 100 cell states into a dev tenant for smoke testing | [Claude] | `cargo run --bin seed-dev-data` produces 100 rows across 3 epochs |
| 1.6 | End-to-end smoke test — MCP client calls `get_cell_state` and receives valid response | [Together] | Shell script in `tests/smoke.sh` passes against staging |

**Exit:** A TypeScript MCP client on Camilo's laptop can call `get_cell_state` against the Railway deployment and receive a signed cell state.

---

## Week 2 — All Five v1 Tools Live

**Goal:** Every tool in the v1 surface returns real data from Railway MobyDB. End of "does it work at all."

| # | Deliverable | Owner | Acceptance |
|---|---|---|---|
| 2.1 | `query_cells_in_region` — bbox + parent-cell modes, with enforce-limit semantics | [Claude] | Integration test: 1000 cells in Rome bbox returns correctly |
| 2.2 | `get_provenance` — cell + attestations + Merkle proof + epoch metadata, proof verifiable against root | [Claude] | Test: proof verifies against epoch root using standalone `verify_proof` |
| 2.3 | `verify_attestation` — 4 checks (claim hash, signature, cell exists, not expired) | [Claude] | Test with fixture attestation: valid case returns all true, tampered signature returns false |
| 2.4 | `render_viewport` — v0.1 returns raw cell states; compositor stub flagged as v0.2 target | [Claude] | Returns `RenderedViewport` with non-empty `cells` for seeded region |
| 2.5 | Per-tool authz gate scaffolding — hook point where scopes/roles will plug in | [Claude] | Middleware exists, currently permits all authenticated; TODO tagged for Week 4 |
| 2.6 | MCP Registry submission prep — manifest, versioning, schema validation | [Claude] | Dry-run publish succeeds locally |

**Exit:** External MCP client can exercise all 5 tools against Railway. All tools have at least one passing integration test.

---

## Week 3 — Compositor Integration + P99 Validation

**Goal:** Fold the 4-week compositor work from `~/mobydb-refmeasure/` into the repo. Re-validate P99 on the new code path.

| # | Deliverable | Owner | Acceptance |
|---|---|---|---|
| 3.1 | `crates/compositor/` — move refmeasure code in, wire as workspace member | [Camilo] | `cargo build -p compositor --release` succeeds; SIMD path enabled |
| 3.2 | `render_viewport` upgraded — calls compositor instead of returning raw cells | [Claude] | Output shape stays compatible; existing test updated |
| 3.3 | Benchmark harness — Criterion-based, reproduces M4 / Hetzner / Linux-constrained runs | [Claude] | `cargo bench -p compositor` produces latency histograms |
| 3.4 | P99 measurement on Railway — render 10k cells, 1000 iterations, compare to local | [Together] | P99 within 2× of Hetzner CCX13 number (40.8 ms target) |
| 3.5 | Flame-graph profiling run; top-3 hotspots documented | [Claude] | `docs/perf/week3-flamegraph.md` committed with findings |

**Exit:** Render engine on Railway measures P99 ≤ 90 ms at 10k-cell workloads, regression-tested in CI.

---

## Week 4 — Auth Hardening + Multi-Tenant Deploy Pattern

**Goal:** OAuth2 production-grade; per-customer instance-per-customer pattern validated.

| # | Deliverable | Owner | Acceptance |
|---|---|---|---|
| 4.1 | OAuth2 full JWKS lifecycle — refresh-on-miss, background rotation, kid rollover test | [Claude] | Test kills JWKS endpoint mid-request and verifies cached key still works for TTL |
| 4.2 | Per-tool authz — scope-based, declarative per-tool required scopes | [Claude] | Tool can be marked `requires_scope("provenance.read")`; test rejects insufficient token |
| 4.3 | Tenant provisioning CLI — `cargo run --bin provision-tenant --slug foo --name "Foo Corp"` | [Claude] | Creates tenant row + genesis epoch; idempotent |
| 4.4 | Second Railway service `render-dev-tenant2` — shared Postgres, proves RLS isolation | [Together] | Two services with different TENANT_ID_DEFAULT; cross-tenant queries return 0 rows |
| 4.5 | RLS penetration test — deliberately try to read other-tenant rows via SQL injection in payload, cell_id, epoch | [Claude] | All attempts return 0 rows; test committed as `tests/rls_isolation.rs` |

**Exit:** OAuth2 flow validated against a real IdP (staging GEIANT). Two tenants isolated in shared DB. Authz gate live.

---

## Week 5 — Observability + Load Testing

**Goal:** You can see what the server is doing at 10 RPS without SSHing into it.

| # | Deliverable | Owner | Acceptance |
|---|---|---|---|
| 5.1 | OTLP export wired end-to-end | [Claude] | Traces appear in Grafana Cloud (or equivalent) tagged with tenant_id + tool |
| 5.2 | Structured log enrichment — every log line has request_id, tenant_id, tool, elapsed_ms | [Claude] | `jq` filter on a staging log dump extracts all per-tool p50/p95/p99 |
| 5.3 | Prometheus dashboards — latency, throughput, error rate, DB pool saturation | [Claude] | Dashboard JSON committed in `docs/ops/grafana-render-engine.json` |
| 5.4 | Load test harness — k6 or `wrk` against staging, 100 RPS for 10 minutes | [Together] | No memory leak, P99 stable, error rate < 0.1% |
| 5.5 | Runbook `docs/ops/RUNBOOK.md` — top-5 alert conditions, response steps | [Claude] | Covers DB pool exhaust, JWKS fetch failure, migration stuck, OOM, rollback |

**Exit:** 100 RPS sustained at P99 target. All alerts have a documented response. Grafana dashboard is the primary eye on the service.

---

## Week 6 — Customer-Facing SDK + Demo Data

**Goal:** A prospect can sit down with the playbook and integrate in under 2 hours.

| # | Deliverable | Owner | Acceptance |
|---|---|---|---|
| 6.1 | TypeScript MCP client package — `@geiant/mobydb-render-client` | [Claude] | `npm install + 20 LOC` demo from README works against staging |
| 6.2 | Python client (thin wrapper around `mcp` Python SDK) | [Claude] | `pip install` + quickstart produces a cell state readout |
| 6.3 | Demo data loader — real-shaped Terna grid telemetry (synthetic, derived from public substation locations) | [Claude] | 50k cells across 10 epochs for Italian Peninsula; loader is idempotent |
| 6.4 | Demo notebook — "EU AI Act audit trail for a grid operator" with real provenance proofs | [Claude] | Jupyter notebook in `docs/demos/` runs end-to-end in < 60 s |
| 6.5 | Public docs landing — `docs.mobydb.com/render-engine` — API, quickstart, architecture | [Together] | Live URL; lighthouse > 90 on all scores |

**Exit:** First customer decision-maker can self-serve a sandbox token and see value in under 2 hours.

---

## Week 7 — First Pilot Preparation

**Goal:** Customer-specific tenant provisioned, playbook-signed NDA-gated docs active.

| # | Deliverable | Owner | Acceptance |
|---|---|---|---|
| 7.1 | Customer-specific tenant + seed dataset loaded from their test data | [Together] | Tenant UUID issued; seed ingestion produces > 10k cell states |
| 7.2 | SLA instrumentation — error budget tracking, per-tenant P99 alerting | [Claude] | Dashboard per-tenant; alert fires on burn rate > 2× budget |
| 7.3 | Data-residency verification report — physical region of every data plane | [Claude] | `docs/compliance/data-residency.md` with attestation from Railway region config |
| 7.4 | DPIA (Data Protection Impact Assessment) template | [Claude] | Draft covers MobyDB + Render Engine + GEIANT Hive as processors |
| 7.5 | Penetration test run — internal, at least OWASP Top 10 + MCP-specific attack surface | [Claude] | Report in `docs/security/pentest-week7.md`; critical findings fixed |

**Exit:** Customer has a tenant, credentials, and a validated data path. Pilot contract can be signed on engineering merits.

---

## Week 8 — Pilot Hardening

**Goal:** Whatever the customer breaks in week 7, fix and ship by end of week 8.

| # | Deliverable | Owner | Acceptance |
|---|---|---|---|
| 8.1 | Top-3 customer feedback items triaged + fixed | [Together] | Each fix has a test; each test fails on HEAD~1 and passes on HEAD |
| 8.2 | Zero-downtime deploy procedure documented + rehearsed | [Claude] | `docs/ops/deploy.md`; rehearsal produces no 5xx during deploy |
| 8.3 | Backup + point-in-time restore validated on Railway Postgres | [Camilo] | Restore drill: snapshot from T-1h restored to new project, all rows match |
| 8.4 | Pilot contract attachments — technical SLA exhibit, security questionnaire responses | [Claude] | Word-ready appendix covers uptime, response times, data handling |
| 8.5 | First paid invoice issued + paid | [Camilo] | Cash in bank; revenue recognized |

**Exit:** First paying customer in production. Pre-EU-AI-Act-deadline (Aug 2) hard milestone met.

---

## Week 9 — Hetzner Phase 2 Runbook

**Goal:** When a customer triggers Phase 2 (Italy residency / hardware isolation / cost), the migration is a runbook, not a project.

| # | Deliverable | Owner | Acceptance |
|---|---|---|---|
| 9.1 | Hetzner CCX13 baseline deployment — same image, same migrations, different infra | [Together] | Service on Hetzner passes the same smoke tests as Railway |
| 9.2 | Migration runbook — data sync, DNS cutover, rollback path | [Claude] | `docs/ops/phase2-migration.md`; dry-run against staging tenant completes < 30 min |
| 9.3 | Infrastructure-as-code — Terraform or Ansible for Hetzner provisioning | [Claude] | `terraform apply` from empty account produces a working deployment |
| 9.4 | VPN / private network setup documented — customer VPC peering templates | [Claude] | IPSec + WireGuard templates, both tested |
| 9.5 | Cost model spreadsheet — Railway vs Hetzner per customer profile | [Claude] | `docs/commercial/cost-model.xlsx` usable for pricing conversations |

**Exit:** Second customer (or first, if they trigger) can migrate to dedicated infra on a named-day SLA.

---

## Week 10 — EU AI Act Compliance Package

**Goal:** The thing that's been load-bearing in every pitch is now a real, shippable product feature.

| # | Deliverable | Owner | Acceptance |
|---|---|---|---|
| 10.1 | Audit export — signed ZIP of all provenance + attestations for a tenant/time window | [Claude] | 1M-cell export completes < 5 min; signature verifies offline |
| 10.2 | GNS-AIP delegation cert integration — render engine verifies agent delegation before tool call | [Claude] | Test: call with expired delegation cert is rejected with clear error |
| 10.3 | MCP AuthZen SARC Context field injection — tenant_id, h3_cell, epoch_id, delegation hash | [Claude] | Context field populated per MCP spec extension; forwarded to downstream tools |
| 10.4 | Compliance documentation package — AI Act Art. 14 mapping, transparency obligations | [Claude] | `docs/compliance/eu-ai-act-mapping.md` with article-by-article coverage |
| 10.5 | Third-party legal review (external; external dependency) | [Camilo] | External counsel sign-off (or noted gap list) |

**Exit:** EU AI Act enforcement (2 August 2026) lands with render engine positioned as a ready-made compliance layer. At least one customer cites AI Act as pilot motivation.

---

## Week 11 — Performance Round 2

**Goal:** Push P99 down below the Week 3 target. Convert perf headroom into either more $/tenant or larger per-call workloads.

| # | Deliverable | Owner | Acceptance |
|---|---|---|---|
| 11.1 | Read-through cache layer — LRU in front of `get_cell_state` + `get_provenance` | [Claude] | Hit rate > 70% on realistic workload; invalidation on epoch roll |
| 11.2 | SIMD compositor path enabled on production (verified — `lscpu` says AVX2/NEON) | [Camilo] | Benchmark shows 2-3× uplift on viewport render |
| 11.3 | DB query plan audit — EXPLAIN ANALYZE on each tool's hot query | [Claude] | No seq scans on 100k+ row tables; indices cover all WHERE patterns |
| 11.4 | Concurrent request fan-out for `query_cells_in_region` | [Claude] | 10k-cell viewport returns < 2× single-cell latency |
| 11.5 | Updated P99 measurement report | [Claude] | `docs/perf/week11-p99.md` replaces Week 3 number as the new public benchmark |

**Exit:** P99 improved by ≥ 30% on reference workloads. Public benchmark post updated.

---

## Week 12 — v1.0 Release

**Goal:** Ship v1.0. Stop being a prototype.

| # | Deliverable | Owner | Acceptance |
|---|---|---|---|
| 12.1 | Version bump to 1.0.0 across workspace, Docker image, Registry manifest | [Claude] | `cargo workspaces version 1.0.0` + committed |
| 12.2 | MCP Registry publication — `com.geiant/mcp-render-engine` v1.0.0 | [Together] | Entry live at registry.modelcontextprotocol.io |
| 12.3 | Cargo publish (public) — `render-core` + `mobydb-client` crates | [Claude] | `cargo publish --dry-run` passes; mcp-server stays private |
| 12.4 | CHANGELOG.md + migration guide for 0.x → 1.0 | [Claude] | Doc covers every breaking change with before/after example |
| 12.5 | Launch post — Substack + LinkedIn, tied to first customer quote if available | [Camilo] | Post live; at least 1 inbound lead directly cites the post within 72h |
| 12.6 | Post-mortem + next-12-weeks planning session | [Together] | `docs/postmortem-q2-2026.md` committed |

**Exit:** v1.0 shipped. First paying customer reference-able. Plan for Q3 locked.

---

## Risk register (engineering)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Railway outage during pilot | Medium | High | Week 9 Hetzner runbook is the escape hatch; backup to Hetzner warm-standby from Week 8 onward |
| MobyDB query performance degrades beyond 10M rows | Medium | High | Partitioning plan in Week 11; Q3 candidate is per-tenant schema isolation |
| rmcp / MCP protocol spec churn breaks HTTP transport | Low | Medium | Protocol layer hand-rolled; any spec change is a localized fix, not a dep bump |
| h3o minor-version breaks geom API (already encountered) | Low | Low | Adapter function `viewport_to_cells` isolates all h3o surface |
| OAuth IdP of customer choice doesn't match JWT assumptions | Medium | Medium | Week 4 includes second IdP smoke test; customer-specific issuer added as config in Week 7 |
| EU AI Act interpretation shifts before 2 Aug | High | Medium | Week 10 legal review; package structured so compliance claims are evidence-backed, not assertions |

---

## What's NOT on this roadmap (deferred by design)

These are real things the render engine will eventually need. None of them block the 12-week plan.

- **Streaming tools** — `list_live_updates` (MCP subscription). v2 target.
- **Write tools** — current engine is read-only to the outside world; writes come through GNS breadcrumb ingestion upstream. v2 target if customer demand.
- **Geographic coverage exact polygon** — `h3o::geom` adapter when the geom API stabilizes. v0.2 target.
- **Per-tenant schema isolation** — moving from RLS-only to schema-per-tenant. Q3 2026 if needed.
- **Multi-region active-active** — single-region is fine through end-of-year.
- **stdio transport** — currently only HTTP. Stub exists; implement when a concrete agent customer wants it.
- **Rate limiting** — middleware stub; real policy when we see abuse patterns.
- **Soft delete / retention policies** — regulatory ask, not yet a customer ask.

---

*End of roadmap v0.1. This document is the source of truth for engineering priorities through 13 July 2026. Update inline as reality disagrees.*
