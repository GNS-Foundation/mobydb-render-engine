import { verifyProvenance } from "./verify.js";

const CONFIG = {
    render_url: window.MOBYDB_RENDER_URL
        || "https://mobydb-render-engine-production.up.railway.app",
    api_key:    window.MOBYDB_DEMO_KEY
        || "",
    max_cells_per_fetch: 65536,
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
        const body = await resp.json();
        return body;
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
                attribution: "© OpenStreetMap contributors",
            },
        },
        layers: [
            { id: "osm", type: "raster", source: "osm", paint: { "raster-opacity": 0.85 } },
        ],
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    },
    center: [12.5, 42.0],
    zoom: 7.5,
    minZoom: 7,
    maxZoom: 11,
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

map.on("load", () => {
    map.addSource("cells", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
    });

    // Fill layer — teal→red on load property
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
                0.9, 0.32,
            ],
        },
    });

    // Stroke layer — nearly invisible by default; pops on selection
    map.addLayer({
        id: "cells-stroke",
        type: "line",
        source: "cells",
        paint: {
            "line-color": [
                "case", ["boolean", ["feature-state", "selected"], false],
                "#4ade80", "rgba(255, 255, 255, 0.06)",
            ],
            "line-width": [
                "case", ["boolean", ["feature-state", "selected"], false],
                2.5, 0.3,
            ],
        },
    });

    map.on("click", "cells-fill", onCellClick);
    map.on("mouseenter", "cells-fill", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "cells-fill", () => map.getCanvas().style.cursor = "");

    map.on("moveend", debounce(refreshCells, 400));

    refreshCells();
    healthCheck().then(updateServerStatus);
});

// -----------------------------------------------------------------------------
// Cell fetching
// -----------------------------------------------------------------------------

function zoomToResolution(z) {
    // Zoom tuned so the viewport bbox produces < 4000 candidate cells at
    // the chosen resolution (server cap), and matches what we seed:
    //   zoom 6-8:  res 6   (overview hexagons cover Italy)
    //   zoom 9-11: res 9   (city-level detail)
    //
    // Below zoom 6 we'd exceed the server cap even at res 6; the map
    // minZoom is set to 6 to prevent this.
    if (z < 9) return 6;
    return 9;
}

async function refreshCells() {
    const bounds = map.getBounds();
    const zoom   = map.getZoom();
    const res    = zoomToResolution(zoom);

    // Estimate bbox cell count client-side before hitting the server.
    // Constants calibrated from actual server-reported cell counts (not from
    // h3 area math which undercounts cell perimeter overlap).
    // At res 6 the polyfill of a 10°×5° bbox returns ~150,000 cells → ~3000/deg².
    // At res 9 a 1°×0.5° bbox returns ~6000 cells → ~12000/deg².
    const dLat = bounds.getNorth() - bounds.getSouth();
    const dLng = bounds.getEast()  - bounds.getWest();
    const areaDeg2 = Math.abs(dLat * dLng);
    const cellsPerDeg2 = res === 6 ? 3000 : res === 9 ? 12000 : 1000;
    const estimatedCount = Math.ceil(areaDeg2 * cellsPerDeg2);

    if (estimatedCount > CONFIG.max_cells_per_fetch) {
        // Too big — clear the overlay and show a hint instead of a failed request.
        map.getSource("cells")?.setData({ type: "FeatureCollection", features: [] });
        showHint(`viewport too large at res ${res} — zoom in (estimated ${estimatedCount.toLocaleString()} cells)`);
        return;
    }
    hideHint();

    if (lastFetchAbort) lastFetchAbort.abort();
    const ctrl = new AbortController();
    lastFetchAbort = ctrl;

    try {
        const { inner, server_ms } = await mcpCall("query_cells_in_region", {
            viewport: {
                mode: "bounding_box",
                south_west: { lat: bounds.getSouth(), lng: bounds.getWest() },
                north_east: { lat: bounds.getNorth(), lng: bounds.getEast() },
                resolution: res,
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
                    owner: payload.owner ?? "unknown",
                },
            };
        });

        map.getSource("cells").setData({
            type: "FeatureCollection",
            features,
        });

        updateCostCounter();
    } catch (e) {
        if (e.name === "AbortError") return;
        console.error("refreshCells failed:", e);
        // Clear stale cells so the user doesn't see phantom data
        map.getSource("cells")?.setData({ type: "FeatureCollection", features: [] });
        showHint(`server: ${e.message.slice(0, 80)}`);
        updateServerStatus(null, e.message);
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
    const owner = payload.owner || "unknown";
    const load  = (payload.value ?? 0).toFixed(4);
    const writerShort = cs.identity_pk.slice(0, 16) + "…";
    const hashShort   = cs.content_hash.slice(0, 16) + "…";
    const sigShort    = cs.signature.slice(0, 16) + "…";
    const rootShort   = p.epoch.merkle_root.slice(0, 16) + "…";
    const parentShort = p.epoch.parent_root ? p.epoch.parent_root.slice(0, 16) + "…" : "genesis";

    const proofRows = p.merkle_proof.map((h, i) =>
        `<div><span class="idx">${i}</span>${h.slice(0, 32)}…</div>`
    ).join("");

    $("audit").classList.remove("audit-empty");
    $("audit").innerHTML = `
        <h2>audit bundle <span class="h3hex">${cs.h3_cell}</span></h2>

        <div class="audit-section">
            <div class="audit-row"><span class="audit-label">city</span><span class="audit-val normal">${owner}</span></div>
            <div class="audit-row"><span class="audit-label">epoch</span><span class="audit-val normal">${cs.epoch_id} · ${EPOCH_DATES[cs.epoch_id] || ""}</span></div>
            <div class="audit-row"><span class="audit-label">grid load</span><span class="audit-val normal">${load} per unit</span></div>
            <div class="audit-row"><span class="audit-label">measurement</span><span class="audit-val normal">${payload.measurement || "—"}</span></div>
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

// -----------------------------------------------------------------------------
// Epoch slider
// -----------------------------------------------------------------------------

$("epoch-slider").addEventListener("input", e => {
    currentEpoch = Number(e.target.value);
    $("epoch-num").textContent = currentEpoch;
    $("epoch-date").textContent = EPOCH_DATES[currentEpoch] || "";
});
$("epoch-slider").addEventListener("change", () => {
    refreshCells();
});
$("epoch-num").textContent = currentEpoch;
$("epoch-date").textContent = EPOCH_DATES[currentEpoch];

// -----------------------------------------------------------------------------
// Cost counter
// -----------------------------------------------------------------------------

function updateCostCounter() {
    $("cc-cells").textContent = state.cells_fetched.toLocaleString();
    $("cc-kb").textContent = (state.bytes_received / 1024).toFixed(1);
    $("cc-srv").textContent = state.server_ms_sum.toFixed(0);

    // Every returned cell carries its own ed25519 signature — one per cell.
    // Every cell on the map could yield a merkle proof on demand (the proof
    // travels with the provenance bundle, not the viewport response; we count
    // it as "proof-addressable" rather than "proof-attached").
    $("cc-sigs").textContent = state.cells_fetched.toLocaleString();
    $("cc-proofs").textContent = state.cells_fetched.toLocaleString();
    $("cc-epochs").textContent = state.epochs_touched.size.toLocaleString();
}

function estimateTilesInViewport(_bounds, _zoom) {
    // kept as a stub for future use; previously used for the tile-pyramid
    // comparison that was removed because it's an apples-to-oranges framing.
    return 0;
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
// Map-overlay hint (shown when viewport is too big or on transient errors)
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
        transition: opacity 200ms ease;
    `;
    document.getElementById("map").appendChild(hintEl);
    return hintEl;
}

function showHint(msg) {
    const el = ensureHintEl();
    el.textContent = msg;
    el.style.opacity = "1";
    el.style.display = "block";
}
function hideHint() {
    if (hintEl) hintEl.style.display = "none";
}

if (!CONFIG.api_key) {
    console.warn("MOBYDB_DEMO_KEY not set — add to window.MOBYDB_DEMO_KEY before app.js loads");
}
