#!/usr/bin/env node
/**
 * P99 latency benchmark for the MobyDB Render Engine.
 *
 * Measures two latency layers for every call:
 *   - total_ms:  client wall-clock (includes network round-trip + everything)
 *   - server_ms: server-reported `_meta.render_ms` (DB + tool dispatch only,
 *                no HTTP framing, no network transit)
 *
 * Network = total - server, so we can separate infra-bound latency from
 * service-bound latency.
 *
 * Workload: query_cells_in_region with a parent-cell viewport at H3 res 6
 * covering the Rome area, target resolution 9 (~49 child cells, of which
 * 15 are seeded).
 *
 * No dependencies — uses Node 18+ built-in fetch and performance API.
 *
 * Usage:
 *   RENDER_URL=https://mobydb-render-engine-production.up.railway.app \
 *   AUTH_API_KEY=<64-hex> \
 *   node scripts/bench/p99.mjs
 *
 * Flags (optional):
 *   --iterations N   total calls (default 1000)
 *   --warmup N       discarded from stats (default 50)
 *   --concurrency N  parallel in-flight (default 1, serial)
 */

import { performance } from "node:perf_hooks";

// --- Config ---
const RENDER_URL = process.env.RENDER_URL;
const AUTH_API_KEY = process.env.AUTH_API_KEY;

if (!RENDER_URL || !AUTH_API_KEY) {
    console.error("RENDER_URL and AUTH_API_KEY must be set in env");
    process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const ITERATIONS  = args.iterations  ?? 1000;
const WARMUP      = args.warmup      ?? 50;
const CONCURRENCY = args.concurrency ?? 1;

// Bbox around Roma covering all 15 seeded cells (seeder clustered them
// via grid_disk(3) from 41.9028, 12.4964 at H3 res 9). A ±0.05° box is
// ~5-6 km each way and covers the whole res-9 grid_disk cleanly, while
// staying small enough that we don't pull in hundreds of unrelated cells.
const ROME_BBOX = {
    south_west: { lat: 41.86, lng: 12.45 },
    north_east: { lat: 41.95, lng: 12.55 },
};
const TARGET_RES = 9;

const ENDPOINT = `${RENDER_URL.replace(/\/+$/, "")}/mcp`;
const REQUEST_BODY = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
        name: "query_cells_in_region",
        arguments: {
            viewport: {
                mode: "bounding_box",
                south_west: ROME_BBOX.south_west,
                north_east: ROME_BBOX.north_east,
                resolution: TARGET_RES,
            },
            limit: 4096,
        },
    },
});

// --- Run ---
async function main() {
    console.log("=".repeat(70));
    console.log("MobyDB Render Engine — P99 benchmark");
    console.log("=".repeat(70));
    console.log(`  endpoint     : ${ENDPOINT}`);
    console.log(`  iterations   : ${ITERATIONS}  (warmup ${WARMUP} discarded)`);
    console.log(`  concurrency  : ${CONCURRENCY}`);
    console.log(`  workload     : query_cells_in_region bbox(${ROME_BBOX.south_west.lat},${ROME_BBOX.south_west.lng} → ${ROME_BBOX.north_east.lat},${ROME_BBOX.north_east.lng}) → res${TARGET_RES}`);
    console.log();

    // Sanity: one call to confirm auth + seed data
    const preflight = await callOnce();
    if (!preflight.ok) {
        console.error(`preflight failed: ${preflight.error}`);
        process.exit(1);
    }
    console.log(`  preflight    : server ${preflight.serverMs.toFixed(2)} ms, total ${preflight.totalMs.toFixed(2)} ms`);
    console.log(`  cell count   : ${preflight.cellCount}`);
    console.log();

    if (preflight.cellCount === 0) {
        console.warn("⚠ preflight returned 0 cells — is the seed tenant populated?");
    }

    const totals = [];
    const servers = [];
    const errors = [];

    const startWall = performance.now();

    if (CONCURRENCY === 1) {
        for (let i = 0; i < ITERATIONS; i++) {
            const r = await callOnce();
            if (r.ok) {
                totals.push(r.totalMs);
                if (r.serverMs != null) servers.push(r.serverMs);
            } else {
                errors.push(r.error);
            }
            if ((i + 1) % 100 === 0) {
                process.stdout.write(`  ${i + 1}/${ITERATIONS}  `);
                process.stdout.write(`(${(percentile(totals.slice(WARMUP), 50)).toFixed(1)} p50 total)\r`);
            }
        }
    } else {
        // Concurrent batches — simpler than a full worker pool
        let launched = 0;
        const inflight = new Set();
        while (launched < ITERATIONS) {
            while (inflight.size < CONCURRENCY && launched < ITERATIONS) {
                const p = callOnce().then(r => {
                    if (r.ok) {
                        totals.push(r.totalMs);
                        if (r.serverMs != null) servers.push(r.serverMs);
                    } else {
                        errors.push(r.error);
                    }
                    inflight.delete(p);
                });
                inflight.add(p);
                launched++;
            }
            await Promise.race(inflight);
        }
        await Promise.all(inflight);
    }

    const wallMs = performance.now() - startWall;
    console.log();
    console.log();

    // Drop warmup samples
    const t = totals.slice(WARMUP).sort((a, b) => a - b);
    const s = servers.slice(WARMUP).sort((a, b) => a - b);

    console.log("-".repeat(70));
    console.log("  RESULTS");
    console.log("-".repeat(70));
    console.log(`  samples kept  : ${t.length}  (discarded warmup ${Math.min(WARMUP, totals.length)}, errors ${errors.length})`);
    console.log(`  wall time     : ${(wallMs / 1000).toFixed(2)} s  → throughput ${(t.length / (wallMs / 1000)).toFixed(1)} req/s`);
    console.log();

    printTable("total (client wall-clock, ms)", t);
    printTable("server render_ms  (DB + tool dispatch)", s);

    if (t.length > 0 && s.length > 0) {
        const networkP50 = percentile(t, 50) - percentile(s, 50);
        const networkP95 = percentile(t, 95) - percentile(s, 95);
        const networkP99 = percentile(t, 99) - percentile(s, 99);
        console.log();
        console.log("  network (total − server, positive = transit, ms)");
        console.log(`    p50           : ${networkP50.toFixed(1)}`);
        console.log(`    p95           : ${networkP95.toFixed(1)}`);
        console.log(`    p99           : ${networkP99.toFixed(1)}`);
    }

    if (errors.length > 0) {
        console.log();
        console.log("  errors (first 5):");
        errors.slice(0, 5).forEach(e => console.log(`    ${e}`));
    }

    console.log();
}

// --- Helpers ---

async function callOnce() {
    const t0 = performance.now();
    try {
        const resp = await fetch(ENDPOINT, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-mobydb-api-key": AUTH_API_KEY,
            },
            body: REQUEST_BODY,
        });
        const totalMs = performance.now() - t0;

        if (!resp.ok) {
            return { ok: false, error: `HTTP ${resp.status}`, totalMs };
        }

        const body = await resp.json();
        if (body.error) {
            return { ok: false, error: `JSON-RPC ${body.error.code}: ${body.error.message}`, totalMs };
        }

        const serverMs = body.result?._meta?.render_ms ?? null;

        // Parse the tool's own result (JSON-inside-string)
        let cellCount = null;
        try {
            const inner = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
            cellCount = inner.count ?? inner.cells?.length ?? null;
        } catch { /* ignore parse errors for inner */ }

        return { ok: true, totalMs, serverMs, cellCount };
    } catch (e) {
        const totalMs = performance.now() - t0;
        return { ok: false, error: String(e.message || e), totalMs };
    }
}

function percentile(sortedArr, p) {
    if (sortedArr.length === 0) return NaN;
    const idx = Math.min(
        sortedArr.length - 1,
        Math.ceil((p / 100) * sortedArr.length) - 1,
    );
    return sortedArr[Math.max(0, idx)];
}

function mean(arr) {
    if (arr.length === 0) return NaN;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function printTable(label, sortedArr) {
    if (sortedArr.length === 0) {
        console.log(`  ${label}: (no samples)`);
        return;
    }
    console.log(`  ${label}`);
    console.log(`    min           : ${sortedArr[0].toFixed(1)}`);
    console.log(`    p50           : ${percentile(sortedArr, 50).toFixed(1)}`);
    console.log(`    p90           : ${percentile(sortedArr, 90).toFixed(1)}`);
    console.log(`    p95           : ${percentile(sortedArr, 95).toFixed(1)}`);
    console.log(`    p99           : ${percentile(sortedArr, 99).toFixed(1)}`);
    console.log(`    max           : ${sortedArr[sortedArr.length - 1].toFixed(1)}`);
    console.log(`    mean          : ${mean(sortedArr).toFixed(1)}`);
    console.log();
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const val = argv[i + 1];
            if (val && !val.startsWith("--")) {
                out[key] = Number.isNaN(Number(val)) ? val : Number(val);
                i++;
            } else {
                out[key] = true;
            }
        }
    }
    return out;
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
