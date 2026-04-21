# P99 baseline — Railway us-east4

Measured: 2026-04-21T09:00Z
Service: mobydb-render-engine-production.up.railway.app
Client: MacBook Pro, Rome, Italy
Network path: Rome → Railway us-east4 (GCP)

## Setup
- Seeded data: 3 epochs × 30 cells × 3 Italian cities (only Rome cells hit by this benchmark)
- Workload: query_cells_in_region, bbox 41.895-41.911N 12.488-12.505E, H3 res 9
- Returned 15 cells per call (full Rome seeded cluster in viewport)
- 1000 serial calls, 50 discarded as warmup, 950 kept
- 4 errors (HTTP 503) — 0.4% error rate, likely transient

## Server-side (render_ms, excludes HTTP framing + network)

| percentile | ms    |
|------------|-------|
| min        | 15.9  |
| p50        | 20.8  |
| p90        | 28.5  |
| p95        | 32.0  |
| p99        | 39.7  |
| max        | 57.1  |
| mean       | 21.8  |

## Total (client wall-clock from Rome)

| percentile | ms    |
|------------|-------|
| min        | 143.2 |
| p50        | 155.5 |
| p90        | 181.3 |
| p95        | 255.9 |
| p99        | 345.8 |
| max        | 403.7 |
| mean       | 167.2 |

## Network transit (total − server, Italy ↔ us-east4)

| percentile | ms    |
|------------|-------|
| p50        | 134.7 |
| p95        | 223.9 |
| p99        | 306.0 |

## Comparison to reference benchmarks (full compositor, local)

| Environment                   | p99 (ms) |
|-------------------------------|----------|
| Apple M4 10P+4E (local)       | 17.5     |
| Hetzner CCX13 (local)         | 40.8     |
| Linux 1-vCPU container        | 59.5     |
| **Railway us-east4 (server)** | **39.7** |

## Notes
- Compositor not yet integrated into the deployed service (Week 3 roadmap).
  Current workload is read + sign + Merkle; adding compositor should lift
  server p99 to ~50-80ms band.
- us-east4 is not EU-compliant for Terna. Hetzner Milan migration at Week 9
  eliminates the 135ms p50 network component.
