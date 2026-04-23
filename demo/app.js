// =============================================================================
// demo/app.js — MobyDB Render Engine · live demo (Session 2)
// =============================================================================
// Renders a map of real Italian power infrastructure (Lazio + Lombardia)
// sourced from OpenStreetMap, with per-substation H3 res-11 cells fetched
// live from the MobyDB MCP endpoint, signed per-cell with Ed25519 and sealed
// into merkle-chained epochs.
//
// Zoom model:
//   zoom <= 11   transmission lines only (380/220/132/…kV polylines)
//   zoom >= 12   transmission lines + MCP cells (res 11, ~5×7 km viewport)
//
// The server enforces a 65,536-cell viewport cap. At zoom 12+ over Rome's
// latitude, a full viewport polyfill at res 11 stays comfortably under.
// =============================================================================

import { verifyProvenance } from "./verify.js";

const CONFIG = {
    render_url: window.MOBYDB_RENDER_URL
        || "https://mobydb-render-engine-production.up.railway.app",
    api_key:    window.MOBYDB_DEMO_KEY || "",
    // Client-side safety guard. Server hard cap is 65,536 regardless.
    max_cells_per_fetch: 65536,
    // Zoom at which res-11 cell queries become viable. Empirical: at a
    // typical ~1700×900 viewport, zoom 12 still polyfills to ~180k candidates
    // (over the 65k server cap). Zoom 14 fits comfortably.
    cell_min_zoom: 14,
    // Path to static transmission line GeoJSON. The demo serves from demo/
    // (python3 -m http.server 8000 inside demo/), which can't reach ../fixtures.
    // setup_dev.sh creates a symlink: demo/fixtures -> ../fixtures
    transmission_lines_url: "./fixtures/osm/transmission_lines.geojson",
};

const EPOCH_DATES = [
    "Apr 1, 06:00", "Apr 1, 18:00",
    "Apr 2, 06:00", "Apr 2, 18:00",
    "Apr 3, 06:00", "Apr 3, 18:00",
    "Apr 4, 06:00", "Apr 4, 18:00",
    "Apr 5, 06:00", "Apr 5, 18:00",
];

let currentEpoch = 9;
let lastFetchAbort = null;

const state = {
    cells_fetched: 0,
    bytes_received: 0,
    server_ms_sum: 0,
    epochs_touched: new Set(),
};

const $ = id => document.getElementById(id);

// -----------------------------------------------------------------------------
// Operator normalization
// -----------------------------------------------------------------------------
// OSM tags operator names with wildly inconsistent casing: "Acea Distribuzione",
// "ACEA", "acea", "Areti", "Acea SpA" all refer to the same Rome DSO group.
// This map collapses variants into canonical display names.

const OPERATOR_ALIASES = [
    { pattern: /^(acea|areti)/i,           canonical: "Acea Distribuzione",  group: "acea" },
    { pattern: /^(e[-‐]?distribuzione|enel\s+distribuzione|enel\s+produzione|enel)\b/i,
                                           canonical: "Enel Distribuzione",  group: "enel" },
    { pattern: /^enel\s*$/i,               canonical: "Enel",                group: "enel" },
    { pattern: /^terna/i,                  canonical: "Terna S.p.A.",        group: "terna" },
    { pattern: /^unareti/i,                canonical: "Unareti S.p.A.",      group: "unareti" },
    { pattern: /^rete\s+ferroviaria|^rfi\b/i,
                                           canonical: "Rete Ferroviaria Italiana", group: "rfi" },
    { pattern: /^a2a/i,                    canonical: "A2A",                 group: "a2a" },
    { pattern: /^fs\s*$/i,                 canonical: "Ferrovie dello Stato", group: "rfi" },
    { pattern: /^italgen/i,                canonical: "Italgen",             group: "italgen" },
];

function normalizeOperator(raw) {
    if (!raw) return { display: "Unspecified operator", group: "unknown" };
    const trimmed = String(raw).trim();
    for (const { pattern, canonical, group } of OPERATOR_ALIASES) {
        if (pattern.test(trimmed)) return { display: canonical, group };
    }
    return { display: trimmed, group: "other" };
}

// -----------------------------------------------------------------------------
// Voltage helpers
// -----------------------------------------------------------------------------

// "380000" → 380 ; "132000;220000" → 220 (take max) ; null → null
function voltageToKv(raw) {
    if (!raw) return null;
    const parts = String(raw).split(";").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
    if (parts.length === 0) return null;
    return Math.round(Math.max(...parts) / 1000);
}

// -----------------------------------------------------------------------------
// MCP client
// -----------------------------------------------------------------------------

async function mcpCall(name, args, signal) {
    const body = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name, arguments: args },
    });

    const resp = await fetch(`${CONFIG.render_url}/mcp`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-mobydb-api-key": CONFIG.api_key,
        },
        body,
        signal,
    });

    const text = await resp.text();
    const bytes = new TextEncoder().encode(text).length;
    state.bytes_received += bytes;

    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${text}`);
    }
    const rpc = JSON.parse(text);
    if (rpc.error) {
        throw new Error(`${rpc.error.code}: ${rpc.error.message}`);
    }
    if (rpc.result.isError) {
        throw new Error(rpc.result.content?.[0]?.text || "tool error");
    }

    const serverMs = rpc.result._meta?.render_ms ?? 0;
    state.server_ms_sum += serverMs;

    const inner = JSON.parse(rpc.result.content[0].text);
    return { inner, server_ms: serverMs };
}

async function healthCheck() {
    try {
        const resp = await fetch(`${CONFIG.render_url}/health`);
        return await resp.json();
    } catch (e) {
        return null;
    }
}

// -----------------------------------------------------------------------------
// Map setup
// -----------------------------------------------------------------------------

const map = new maplibregl.Map({
    container: "map",
    style: {
        version: 8,
        sources: {
            osm: {
                type: "raster",
                tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                tileSize: 256,
                attribution: "© OpenStreetMap contributors · ODbL",
            },
        },
        layers: [
            { id: "osm", type: "raster", source: "osm", paint: { "raster-opacity": 0.80 } },
        ],
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    },
    // Rome center at zoom 14 → cells visible on page load; sits under the
    // empirical cell_min_zoom threshold comfortably.
    center: [12.48, 41.90],
    zoom: 14,
    minZoom: 8,     // Below 8, Lazio+Lombardia frame is too small to be useful.
    maxZoom: 16,    // Past 16, OSM raster starts looking blurry.
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

map.on("load", () => {
    // --- transmission lines source + layer (static, always visible) ---
    map.addSource("tx-lines", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        generateId: true,
    });

    // Voltage-colored polylines. 'voltage_kv' is normalized from payload before
    // injection (see loadTransmissionLines()). Missing voltage → neutral gray.
    map.addLayer({
        id: "tx-lines-layer",
        type: "line",
        source: "tx-lines",
        paint: {
            // Color and width are set per-feature in loadTransmissionLines().
            // Using [get] on pre-computed properties avoids MapLibre expression
            // pitfalls with mixed-type / missing fields.
            "line-color": ["get", "color"],
            "line-width": [
                "interpolate", ["linear"], ["zoom"],
                8,  ["get", "width_z8"],
                14, ["get", "width_z14"],
            ],
            "line-opacity": [
                "interpolate", ["linear"], ["zoom"],
                8, 0.55,
                12, 0.75,
                15, 0.85,
            ],
        },
    });

    // --- cells source (only populated at zoom >= cell_min_zoom) ---
    map.addSource("cells", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
    });

    map.addLayer({
        id: "cells-fill",
        type: "fill",
        source: "cells",
        paint: {
            "fill-color": [
                "interpolate", ["linear"], ["get", "load"],
                0.4, "#0f6e56",
                0.8, "#5dcaa5",
                1.0, "#c0dd97",
                1.2, "#ef9f27",
                1.5, "#d85a30",
            ],
            "fill-opacity": [
                "case", ["boolean", ["feature-state", "selected"], false],
                0.90, 0.55,
            ],
        },
    });

    map.addLayer({
        id: "cells-stroke",
        type: "line",
        source: "cells",
        paint: {
            "line-color": [
                "case", ["boolean", ["feature-state", "selected"], false],
                "#4ade80", "rgba(255, 255, 255, 0.15)",
            ],
            "line-width": [
                "case", ["boolean", ["feature-state", "selected"], false],
                2.5, 0.5,
            ],
        },
    });

    map.on("click", "cells-fill", onCellClick);
    map.on("mouseenter", "cells-fill", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "cells-fill", () => map.getCanvas().style.cursor = "");

    map.on("moveend", debounce(refreshCells, 400));
    map.on("zoomend", updateZoomReadout);

    loadTransmissionLines();
    refreshCells();
    updateZoomReadout();
    healthCheck().then(updateServerStatus);
});

// -----------------------------------------------------------------------------
// Transmission line loading
// -----------------------------------------------------------------------------

async function loadTransmissionLines() {
    try {
        const resp = await fetch(CONFIG.transmission_lines_url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const raw = await resp.json();

        // Pre-compute color and line widths per feature. MapLibre expressions
        // with conditional null-handling are fragile; pre-computing at ingest
        // time is simpler and more portable.
        const features = raw.features.map(f => {
            const p = f.properties || {};
            const kv = typeof p.voltage_kv === "number" ? p.voltage_kv : 0;

            let color, w8, w14;
            if (kv >= 380)      { color = "#d83232"; w8 = 1.8; w14 = 4.5; }
            else if (kv >= 220) { color = "#e06b2a"; w8 = 1.3; w14 = 3.2; }
            else if (kv >= 150) { color = "#f0a02d"; w8 = 0.9; w14 = 2.2; }
            else if (kv >= 132) { color = "#e5c246"; w8 = 0.9; w14 = 2.2; }
            else if (kv >= 60)  { color = "#7a8997"; w8 = 0.6; w14 = 1.6; }
            else                { color = "#5a6775"; w8 = 0.4; w14 = 1.2; }

            return {
                type: "Feature",
                geometry: f.geometry,
                properties: {
                    ...p,
                    color,
                    width_z8:  w8,
                    width_z14: w14,
                },
            };
        });

        map.getSource("tx-lines").setData({
            type: "FeatureCollection",
            features,
        });

        $("cc-lines").textContent = features.length.toLocaleString();
    } catch (e) {
        console.warn("transmission lines failed to load:", e);
        $("cc-lines").textContent = "—";
    }
}

// -----------------------------------------------------------------------------
// Cell fetching (MCP)
// -----------------------------------------------------------------------------

function shouldQueryCells(zoom) {
    // Strictly >= threshold. At zoom 13.9 the viewport still polyfills to ~70k
    // candidates at res 11 (over the 65k server cap), so we gate at >= 14.0
    // rather than > 13.
    return zoom >= CONFIG.cell_min_zoom;
}

async function refreshCells() {
    const zoom = map.getZoom();

    if (!shouldQueryCells(zoom)) {
        // At low zoom we only show lines. Clear any existing cells from the
        // previous high-zoom view.
        map.getSource("cells")?.setData({ type: "FeatureCollection", features: [] });
        __syncCellsToBus([]);
        showHint(`zoom in to ${CONFIG.cell_min_zoom}+ to load signed substation cells · transmission lines shown at all zooms`);
        return;
    }
    hideHint();

    const bounds = map.getBounds();

    if (lastFetchAbort) lastFetchAbort.abort();
    const ctrl = new AbortController();
    lastFetchAbort = ctrl;

    try {
        const { inner } = await mcpCall("query_cells_in_region", {
            viewport: {
                mode: "bounding_box",
                south_west: { lat: bounds.getSouth(), lng: bounds.getWest() },
                north_east: { lat: bounds.getNorth(), lng: bounds.getEast() },
                resolution: 11,
            },
            limit: CONFIG.max_cells_per_fetch,
            epoch_id: currentEpoch,
        }, ctrl.signal);

        state.cells_fetched += inner.cells.length;
        state.epochs_touched.add(currentEpoch);

        const features = inner.cells.map(c => {
            const boundary = h3.cellToBoundary(c.h3_cell, true);
            const payload = typeof c.payload === "string" ? JSON.parse(c.payload) : c.payload;
            return {
                type: "Feature",
                id: idFromH3(c.h3_cell),
                geometry: { type: "Polygon", coordinates: [boundary] },
                properties: {
                    h3_cell: c.h3_cell,
                    epoch_id: c.epoch_id,
                    load: payload.value ?? 0.5,
                    operator: payload.operator || "",
                },
            };
        });

        map.getSource("cells").setData({
            type: "FeatureCollection",
            features,
        });
        __syncCellsToBus(inner.cells);

        updateCostCounter();
    } catch (e) {
        if (e.name === "AbortError") return;
        console.error("refreshCells failed:", e);
        map.getSource("cells")?.setData({ type: "FeatureCollection", features: [] });
        __syncCellsToBus([]);
        // If the server rejected the viewport, tell user why in plain language.
        // This is NOT a server error — don't downgrade the status pill.
        if (e.message.includes("viewport exceeds max cells")) {
            showHint("viewport too large — zoom in further to load signed cells");
        } else {
            showHint(`server: ${e.message.slice(0, 80)}`);
            updateServerStatus(null, e.message);
        }
    }
}

function idFromH3(h3hex) {
    let h = 0;
    for (let i = 0; i < h3hex.length; i++) {
        h = ((h * 31) + h3hex.charCodeAt(i)) >>> 0;
    }
    return h;
}

// -----------------------------------------------------------------------------
// Cell click → audit panel
// -----------------------------------------------------------------------------

let selectedFeatureId = null;

async function onCellClick(e) {
    const feature = e.features[0];
    if (!feature) return;

    if (selectedFeatureId !== null) {
        map.setFeatureState({ source: "cells", id: selectedFeatureId }, { selected: false });
    }
    selectedFeatureId = feature.id;
    map.setFeatureState({ source: "cells", id: feature.id }, { selected: true });

    const h3hex = feature.properties.h3_cell;
    renderAuditLoading(h3hex);

    try {
        const { inner } = await mcpCall("get_provenance", {
            h3_cell: h3hex,
            epoch_id: currentEpoch,
        });
        renderAuditPanel(inner);
        window.mobydbBus?.dispatchEvent(new CustomEvent("audit-open", {
            detail: { cell: { h3_cell: h3hex, epoch: currentEpoch, ...inner } }
        }));
    } catch (e) {
        renderAuditError(h3hex, e.message);
    }
}

function renderAuditLoading(h3hex) {
    $("audit").classList.remove("audit-empty");
    $("audit").innerHTML = `
        <h2>loading audit bundle <span class="h3hex">${h3hex}</span></h2>
        <div style="color: #8a95a2; font-size: 11px; padding: 8px 0;">fetching signed provenance from render engine…</div>
    `;
}

function renderAuditError(h3hex, msg) {
    $("audit").innerHTML = `
        <h2>audit bundle failed <span class="h3hex">${h3hex}</span></h2>
        <div style="color: #ef4444; font-size: 11px;">${msg}</div>
    `;
}

function renderAuditPanel(p) {
    const cs = p.cell_state;
    const payload = typeof cs.payload === "string" ? JSON.parse(cs.payload) : cs.payload;

    const op = normalizeOperator(payload.operator);
    const load = (payload.value ?? 0).toFixed(4);
    const kv = voltageToKv(payload.voltage);

    const writerShort = cs.identity_pk.slice(0, 16) + "…";
    const hashShort   = cs.content_hash.slice(0, 16) + "…";
    const sigShort    = cs.signature.slice(0, 16) + "…";
    const rootShort   = p.epoch.merkle_root.slice(0, 16) + "…";
    const parentShort = p.epoch.parent_root ? p.epoch.parent_root.slice(0, 16) + "…" : "genesis";

    const proofRows = p.merkle_proof.map((h, i) =>
        `<div><span class="idx">${i}</span>${h.slice(0, 32)}…</div>`
    ).join("");

    // --- Asset section (new — surfaces real OSM tags) ---
    const assetRows = [];
    assetRows.push(`<div class="audit-row"><span class="audit-label">operator</span><span class="audit-val normal op-${op.group}">${op.display}</span></div>`);
    if (payload.name) {
        assetRows.push(`<div class="audit-row"><span class="audit-label">name</span><span class="audit-val normal">${escapeHtml(payload.name)}</span></div>`);
    }
    if (payload.ref) {
        assetRows.push(`<div class="audit-row"><span class="audit-label">ref</span><span class="audit-val normal">${escapeHtml(payload.ref)}</span></div>`);
    }
    if (kv !== null) {
        assetRows.push(`<div class="audit-row"><span class="audit-label">voltage</span><span class="audit-val normal">${kv} kV</span></div>`);
    }
    if (payload.substation_type) {
        assetRows.push(`<div class="audit-row"><span class="audit-label">type</span><span class="audit-val normal">${escapeHtml(payload.substation_type)}</span></div>`);
    }
    if (payload.osm_id) {
        const [type, id] = payload.osm_id.split("/");
        const osmUrl = `https://www.openstreetmap.org/${type}/${id}`;
        assetRows.push(`<div class="audit-row"><span class="audit-label">osm id</span><span class="audit-val normal"><a class="osm-link" href="${osmUrl}" target="_blank" rel="noopener">${payload.osm_id} ↗</a></span></div>`);
    }

    $("audit").classList.remove("audit-empty");
    $("audit").innerHTML = `
        <h2>audit bundle <span class="h3hex">${cs.h3_cell}</span></h2>

        <div class="audit-section">
            ${assetRows.join("")}
            <div class="audit-row"><span class="audit-label">epoch</span><span class="audit-val normal">${cs.epoch_id} · ${EPOCH_DATES[cs.epoch_id] || ""}</span></div>
            <div class="audit-row"><span class="audit-label">measurement</span><span class="audit-val normal">${payload.measurement || "grid_load_pu"} = ${load}</span></div>
        </div>

        <hr class="hrule">

        <div class="audit-section">
            <div class="audit-row"><span class="audit-label">writer pk</span><span class="audit-val">${writerShort}</span></div>
            <div class="audit-row"><span class="audit-label">content hash</span><span class="audit-val">${hashShort}</span></div>
            <div class="audit-row"><span class="audit-label">signature</span><span class="audit-val">${sigShort}</span></div>
        </div>

        <hr class="hrule">

        <div class="audit-section">
            <div class="audit-row"><span class="audit-label">leaf index</span><span class="audit-val normal">${p.leaf_index} of ${p.epoch.cell_count}</span></div>
            <div class="audit-row"><span class="audit-label">proof depth</span><span class="audit-val normal">${p.merkle_proof.length} hashes · blake3</span></div>
            <div class="audit-row"><span class="audit-label">epoch root</span><span class="audit-val">${rootShort}</span></div>
            <div class="audit-row"><span class="audit-label">parent root</span><span class="audit-val">${parentShort}</span></div>
        </div>

        <hr class="hrule">

        <div class="audit-section">
            <div style="font-size: 10px; color: #8a95a2; margin-bottom: 4px;">merkle proof preview</div>
            <div class="proof-list">${proofRows}</div>
        </div>

        <div class="verify-row">
            <button class="verify-btn" id="verify-btn">verify offline</button>
            <div class="verify-result" id="verify-result"></div>
        </div>
        <div class="verify-sub" id="verify-sub"></div>
    `;

    $("verify-btn").addEventListener("click", () => doVerify(p));
}

async function doVerify(p) {
    const btn = $("verify-btn");
    const res = $("verify-result");
    const sub = $("verify-sub");
    btn.disabled = true; btn.textContent = "verifying…";
    res.innerHTML = ""; sub.innerHTML = "";
    await new Promise(r => setTimeout(r, 120));

    const v = verifyProvenance(p);

    if (v.ok) {
        res.className = "verify-result ok";
        res.innerHTML = '<span class="check">✓</span> provenance verified offline';
        sub.innerHTML = `
            Ed25519 signature valid over blake3(payload)<br>
            ${p.merkle_proof.length}-hash path reconstructs root ${v.reconstructedHex.slice(0,16)}…<br>
            no server trust required — this runs only in your browser
        `;
    } else {
        res.className = "verify-result bad";
        res.innerHTML = `<span class="xmark">✕</span> verification failed`;
        sub.innerHTML = `sig=${v.sigOk} · root=${v.rootOk}` + (v.error ? `<br>${v.error}` : "");
    }
    btn.disabled = false; btn.textContent = "verify again";
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// -----------------------------------------------------------------------------
// Epoch slider
// -----------------------------------------------------------------------------

$("epoch-slider").addEventListener("input", e => {
    currentEpoch = Number(e.target.value);
    $("epoch-num").textContent = currentEpoch;
    $("epoch-date").textContent = EPOCH_DATES[currentEpoch] || "";
});
$("epoch-slider").addEventListener("change", () => {
    window.mobydbBus?.dispatchEvent(new CustomEvent("epoch", { detail: { epoch: currentEpoch } }));
    refreshCells();
});
$("epoch-num").textContent = currentEpoch;
$("epoch-date").textContent = EPOCH_DATES[currentEpoch];

// -----------------------------------------------------------------------------
// Cost counter + zoom readout
// -----------------------------------------------------------------------------

function updateCostCounter() {
    $("cc-cells").textContent = state.cells_fetched.toLocaleString();
    $("cc-kb").textContent = (state.bytes_received / 1024).toFixed(1);
    $("cc-srv").textContent = state.server_ms_sum.toFixed(0);

    // Every returned cell carries its own ed25519 signature. Every cell is
    // merkle-provable on demand via get_provenance.
    $("cc-sigs").textContent   = state.cells_fetched.toLocaleString();
    $("cc-proofs").textContent = state.cells_fetched.toLocaleString();
    $("cc-epochs").textContent = state.epochs_touched.size.toLocaleString();
}

function updateZoomReadout() {
    const z = map.getZoom();
    const el = $("zoom-readout");
    if (!el) return;
    el.textContent = z.toFixed(1);
    // Subtle signal about mode
    if (z >= CONFIG.cell_min_zoom) {
        el.classList.remove("zoom-low");
        el.classList.add("zoom-high");
    } else {
        el.classList.remove("zoom-high");
        el.classList.add("zoom-low");
    }
}

// -----------------------------------------------------------------------------
// Server status indicator
// -----------------------------------------------------------------------------

function updateServerStatus(health, error) {
    const dot = document.querySelector("#server-status .dot");
    const text = $("server-status-text");
    if (error) {
        dot.className = "dot dot-red";
        text.textContent = "error";
        return;
    }
    if (!health) {
        dot.className = "dot dot-amber";
        text.textContent = "no /health";
        return;
    }
    dot.className = "dot dot-green";
    const env = health.env === "production" ? "prod" : health.env;
    const demo = health.demo_enabled ? `· demo ${health.demo_rate_limit_per_min}/min` : "";
    text.textContent = `${env} ${demo}`;
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function debounce(fn, ms) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

// -----------------------------------------------------------------------------
// Map-overlay hint (shown when zoom too low, or on transient errors)
// -----------------------------------------------------------------------------

let hintEl = null;

function ensureHintEl() {
    if (hintEl) return hintEl;
    hintEl = document.createElement("div");
    hintEl.className = "map-hint";
    hintEl.style.cssText = `
        position: absolute; top: 80px; left: 50%; transform: translateX(-50%);
        z-index: 4; pointer-events: none;
        background: rgba(15, 22, 30, 0.92); backdrop-filter: blur(10px);
        border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
        padding: 8px 14px; font-size: 11px; color: #c6ced9;
        font-variant-numeric: tabular-nums;
        max-width: min(520px, calc(100vw - 40px)); text-align: center;
    `;
    document.getElementById("map").appendChild(hintEl);
    return hintEl;
}

function showHint(msg) {
    const el = ensureHintEl();
    el.textContent = msg;
    el.style.display = "block";
}
function hideHint() {
    if (hintEl) hintEl.style.display = "none";
}

if (!CONFIG.api_key) {
    console.warn("MOBYDB_DEMO_KEY not set — add to window.MOBYDB_DEMO_KEY before app.js loads");
}

// -----------------------------------------------------------------------------
// Session 3 integration surface
// Expose map, state, and an event bus so drop-in overlay modules
// (compliance_overlay.js, liveness_indicators.js) can subscribe without
// importing this ES module.
// -----------------------------------------------------------------------------

window.mobydbMap     = map;
window.mobydbBus     = new EventTarget();
window.mobydbState   = { cells: [], currentEpoch, seenEpochs: new Set([currentEpoch]) };
window.mobydbDemoKey = CONFIG.api_key || null;
window.mobydbConfig  = { apiBase: CONFIG.render_url || '', apiKey: CONFIG.api_key || null };

// Session 3: sync cells to shared state + notify subscribers.
function __syncCellsToBus(cells) {
    if (window.mobydbState) {
        window.mobydbState.cells = Array.isArray(cells) ? cells : [];
        window.mobydbState.currentEpoch = currentEpoch;
        window.mobydbState.seenEpochs?.add(currentEpoch);
    }
    window.mobydbBus?.dispatchEvent(new CustomEvent("cells", {
        detail: { cells: window.mobydbState?.cells || [] }
    }));
}
