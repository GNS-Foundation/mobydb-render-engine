/* =====================================================================
 * twin_overlay.js — GEIANT Mini-Twin integration for the demo map
 * ---------------------------------------------------------------------
 * Adds three things to the existing demo:
 *   1. Toggle button (top-right) to activate the Twin overlay layer
 *   2. Color overlay on H3 cells (verde/giallo/rosso) when active
 *   3. New section in the audit panel: live telemetry + AI Inspector
 *
 * Follows the pattern of lab_overlay.js: standalone module, listens to
 * `audit-open` on window.mobydbBus, scoped CSS namespace, appends to
 * the audit panel without modifying app.js.
 *
 * Backend: https://geiant-mini-twin-api-production.up.railway.app
 *   GET  /v1/twin/state?cell=<h3>
 *   GET  /v1/twin/timeseries?cell=<h3>&hours=24
 *   GET  /v1/twin/all_latest
 *   POST /v1/ai-inspect
 *
 * Drop-in. Add to map.html after lab_tile_preview.js:
 *   <script type="module" src="./twin_overlay.js"></script>
 * ===================================================================== */

(function () {
    'use strict';

    if (typeof window === 'undefined') return;

    // ---------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------
    const TWIN_API = 'https://geiant-mini-twin-api-production.up.railway.app';
    const NS = 'mdb-twin';
    const SECTION_CLASS = `${NS}-audit-section`;
    const REFRESH_INTERVAL_MS = 30_000;

    // Threshold for cell coloring (based on payload values).
    // Calibrated against simulate_state() patterns:
    //   - load_factor ranges 0.55 (3am) to 1.20 (peak 19-21h)
    //   - voltage deviation typically ±2% under normal conditions
    //   - temperature 35-45°C nominal, >55°C is warning, >60°C critical
    const THRESHOLDS = {
        loadWarning:  1.00,  // load_mw / nominal_load_mw > 1.00 → giallo
        loadCritical: 1.15,  // > 1.15 → rosso
        voltDevWarn:  0.04,  // |voltage - nominal| / nominal > 4% → giallo
        voltDevCrit:  0.06,  // > 6% → rosso
        tempWarn:     55,    // °C → giallo
        tempCrit:     60,    // °C → rosso
    };

    // ---------------------------------------------------------------
    // Style injection — scoped, matches lab_overlay tokens
    // ---------------------------------------------------------------
    const css = `
    :root {
        --${NS}-bg:        rgba(14, 18, 24, 0.92);
        --${NS}-border:    rgba(148, 163, 184, 0.14);
        --${NS}-text:      rgb(226, 232, 240);
        --${NS}-muted:     rgb(148, 163, 184);
        --${NS}-ok:        #00c853;
        --${NS}-wa:        #ffab00;
        --${NS}-vi:        #ef4444;
        --${NS}-cyan:      #0099cc;
        --${NS}-cyan-bg:   rgba(0, 153, 204, 0.12);
    }

    /* Toggle button (top-right) ---------------------------------- */
    .${NS}-toggle {
        position: fixed !important;
        top: 124px;
        right: 16px;
        z-index: 50;
        background: var(--${NS}-bg);
        color: var(--${NS}-text);
        border: 1px solid var(--${NS}-border);
        border-radius: 4px;
        padding: 8px 12px;
        font: 400 11px/1.2 "Space Mono", "JetBrains Mono", ui-monospace, monospace;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        cursor: pointer;
        backdrop-filter: blur(8px);
        transition: all 0.18s ease;
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 180px;
    }
    .${NS}-toggle:hover {
        border-color: var(--${NS}-cyan);
        color: var(--${NS}-cyan);
    }
    .${NS}-toggle[data-active="true"] {
        background: var(--${NS}-cyan-bg);
        border-color: var(--${NS}-cyan);
        color: var(--${NS}-cyan);
    }
    .${NS}-toggle .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--${NS}-muted);
    }
    .${NS}-toggle[data-active="true"] .dot {
        background: var(--${NS}-cyan);
        box-shadow: 0 0 8px var(--${NS}-cyan);
        animation: ${NS}-pulse 2s ease-in-out infinite;
    }
    @keyframes ${NS}-pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.4; }
    }
    .${NS}-toggle .count {
        margin-left: auto;
        font-size: 10px;
        color: var(--${NS}-muted);
    }

    /* Audit panel section --------------------------------------- */
    .${NS}-audit-section {
        margin-top: 14px;
        padding-top: 12px;
        border-top: 1px solid var(--${NS}-border);
        font: 300 12px/1.4 "DM Sans", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
        color: var(--${NS}-text);
    }
    .${NS}-audit-section header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
    }
    .${NS}-audit-section h5 {
        margin: 0;
        font: 400 11px/1 "DM Sans", system-ui, sans-serif;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--${NS}-muted);
    }
    .${NS}-status-pill {
        font: 600 10px/1 "Space Mono", "JetBrains Mono", ui-monospace, monospace;
        letter-spacing: 0.04em;
        padding: 4px 8px;
        border-radius: 3px;
        border: 1px solid currentColor;
    }
    .${NS}-status-pill[data-status="OK"]       { color: var(--${NS}-ok); }
    .${NS}-status-pill[data-status="WARNING"]  { color: var(--${NS}-wa); }
    .${NS}-status-pill[data-status="CRITICAL"] { color: var(--${NS}-vi); }
    .${NS}-status-pill[data-status="LOADING"]  { color: var(--${NS}-muted); }

    .${NS}-metrics {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px 12px;
        margin: 10px 0;
    }
    .${NS}-metric {
        background: rgba(148, 163, 184, 0.04);
        padding: 6px 8px;
        border-radius: 3px;
    }
    .${NS}-metric-label {
        font: 600 9px/1 "Space Mono", monospace;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--${NS}-muted);
        margin-bottom: 3px;
    }
    .${NS}-metric-value {
        font: 400 14px/1 "DM Sans", system-ui, sans-serif;
        color: var(--${NS}-text);
    }
    .${NS}-metric-unit {
        font-size: 11px;
        color: var(--${NS}-muted);
        margin-left: 2px;
    }

    .${NS}-anomaly {
        margin: 8px 0;
        padding: 8px 10px;
        border-radius: 3px;
        background: rgba(239, 68, 68, 0.08);
        border-left: 2px solid var(--${NS}-vi);
        font-size: 11px;
        line-height: 1.4;
    }
    .${NS}-anomaly[data-severity="warning"] {
        background: rgba(255, 171, 0, 0.08);
        border-left-color: var(--${NS}-wa);
    }
    .${NS}-anomaly-head {
        font-weight: 600;
        margin-bottom: 4px;
        text-transform: uppercase;
        font-size: 10px;
        letter-spacing: 0.04em;
    }

    .${NS}-disclaimer {
        font: 400 10px/1.4 "Space Mono", monospace;
        color: var(--${NS}-muted);
        background: rgba(148, 163, 184, 0.04);
        padding: 6px 8px;
        border-radius: 3px;
        margin-top: 6px;
    }

    .${NS}-sig {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--${NS}-border);
        font: 400 10px/1.5 "Space Mono", monospace;
        color: var(--${NS}-muted);
    }
    .${NS}-sig code {
        color: var(--${NS}-cyan);
        word-break: break-all;
    }

    /* AI Inspector button --------------------------------------- */
    .${NS}-ai-button {
        margin-top: 10px;
        width: 100%;
        background: var(--${NS}-cyan-bg);
        color: var(--${NS}-cyan);
        border: 1px solid var(--${NS}-cyan);
        border-radius: 3px;
        padding: 8px;
        font: 400 11px/1 "DM Sans", system-ui, sans-serif;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        cursor: pointer;
        transition: all 0.18s ease;
    }
    .${NS}-ai-button:hover {
        background: rgba(0, 153, 204, 0.20);
    }
    .${NS}-ai-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    /* AI Modal -------------------------------------------------- */
    .${NS}-modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 100;
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
    }
    .${NS}-modal {
        background: var(--${NS}-bg);
        border: 1px solid var(--${NS}-border);
        border-radius: 6px;
        max-width: 640px;
        width: 100%;
        max-height: 80vh;
        overflow-y: auto;
        padding: 20px 24px;
        font: 300 13px/1.5 "DM Sans", system-ui, sans-serif;
        color: var(--${NS}-text);
    }
    .${NS}-modal-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 16px;
    }
    .${NS}-modal-head h3 {
        margin: 0;
        font: 400 16px/1.3 "DM Sans", system-ui, sans-serif;
        color: var(--${NS}-cyan);
    }
    .${NS}-modal-head .meta {
        font: 400 10px/1.5 "Space Mono", monospace;
        color: var(--${NS}-muted);
        margin-top: 4px;
    }
    .${NS}-close {
        background: transparent;
        border: none;
        color: var(--${NS}-muted);
        font-size: 20px;
        cursor: pointer;
        padding: 0;
        width: 24px;
        height: 24px;
    }
    .${NS}-close:hover { color: var(--${NS}-text); }

    .${NS}-suggestions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 12px 0;
    }
    .${NS}-suggestion {
        font: 400 11px/1.3 "DM Sans", system-ui, sans-serif;
        background: rgba(148, 163, 184, 0.08);
        color: var(--${NS}-text);
        border: 1px solid var(--${NS}-border);
        border-radius: 12px;
        padding: 5px 10px;
        cursor: pointer;
        transition: all 0.15s ease;
    }
    .${NS}-suggestion:hover {
        border-color: var(--${NS}-cyan);
        color: var(--${NS}-cyan);
    }

    .${NS}-textarea {
        width: 100%;
        min-height: 70px;
        background: rgba(0, 0, 0, 0.3);
        color: var(--${NS}-text);
        border: 1px solid var(--${NS}-border);
        border-radius: 3px;
        padding: 10px;
        font: 400 13px/1.4 "DM Sans", system-ui, sans-serif;
        resize: vertical;
        box-sizing: border-box;
    }
    .${NS}-textarea:focus {
        outline: none;
        border-color: var(--${NS}-cyan);
    }
    .${NS}-submit {
        margin-top: 10px;
        background: var(--${NS}-cyan);
        color: black;
        border: none;
        border-radius: 3px;
        padding: 9px 16px;
        font: 600 11px/1 "DM Sans", system-ui, sans-serif;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        cursor: pointer;
    }
    .${NS}-submit:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .${NS}-loading {
        margin: 16px 0;
        font: 400 12px/1 "Space Mono", monospace;
        color: var(--${NS}-cyan);
    }
    .${NS}-loading::after {
        content: '';
        display: inline-block;
        width: 8px;
        height: 8px;
        margin-left: 6px;
        border-radius: 50%;
        background: var(--${NS}-cyan);
        animation: ${NS}-pulse 1s ease-in-out infinite;
    }

    .${NS}-ai-response {
        background: rgba(0, 153, 204, 0.06);
        border-left: 2px solid var(--${NS}-cyan);
        padding: 12px 14px;
        border-radius: 3px;
        margin: 14px 0;
        white-space: pre-wrap;
        line-height: 1.6;
    }
    .${NS}-ai-attestation {
        font: 400 10px/1.6 "Space Mono", monospace;
        color: var(--${NS}-muted);
        background: rgba(148, 163, 184, 0.04);
        padding: 10px 12px;
        border-radius: 3px;
        margin-top: 10px;
    }
    .${NS}-ai-attestation .ok {
        color: var(--${NS}-ok);
        font-weight: 600;
    }
    .${NS}-ai-attestation code {
        color: var(--${NS}-cyan);
        word-break: break-all;
    }
    .${NS}-ai-attestation .chain-arrow {
        color: var(--${NS}-muted);
        margin: 0 4px;
    }
    `;

    function injectStyles() {
        if (document.getElementById(`${NS}-styles`)) return;
        const style = document.createElement('style');
        style.id = `${NS}-styles`;
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ---------------------------------------------------------------
    // API helpers
    // ---------------------------------------------------------------
    async function fetchTwinState(cell) {
        const r = await fetch(`${TWIN_API}/v1/twin/state?cell=${encodeURIComponent(cell)}`);
        if (!r.ok) throw new Error(`twin/state HTTP ${r.status}`);
        return r.json();
    }
    async function fetchAllLatest() {
        const r = await fetch(`${TWIN_API}/v1/twin/all_latest`);
        if (!r.ok) throw new Error(`twin/all_latest HTTP ${r.status}`);
        return r.json();
    }
    async function postAiInspect(cell, question) {
        const r = await fetch(`${TWIN_API}/v1/ai-inspect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cell, question }),
        });
        if (!r.ok) {
            const txt = await r.text();
            throw new Error(`ai-inspect HTTP ${r.status}: ${txt.slice(0, 200)}`);
        }
        return r.json();
    }

    // ---------------------------------------------------------------
    // Cell status from payload
    // ---------------------------------------------------------------
    function classifyCell(payload) {
        if (payload.anomaly_active) {
            return payload.anomaly_severity === 'critical' ? 'CRITICAL' : 'WARNING';
        }
        const loadFrac = payload.load_mw / payload.nominal_load_mw;
        const voltDev = Math.abs(payload.voltage_kv - payload.voltage_class) / payload.voltage_class;
        if (loadFrac > THRESHOLDS.loadCritical || voltDev > THRESHOLDS.voltDevCrit
            || payload.temperature_celsius > THRESHOLDS.tempCrit) {
            return 'CRITICAL';
        }
        if (loadFrac > THRESHOLDS.loadWarning || voltDev > THRESHOLDS.voltDevWarn
            || payload.temperature_celsius > THRESHOLDS.tempWarn) {
            return 'WARNING';
        }
        return 'OK';
    }

    function statusColor(status) {
        return {
            OK:       'rgba(0, 200, 83, 0.30)',
            WARNING:  'rgba(255, 171, 0, 0.40)',
            CRITICAL: 'rgba(239, 68, 68, 0.50)',
        }[status] || 'rgba(148, 163, 184, 0.20)';
    }

    function statusOutline(status) {
        return {
            OK:       'rgba(0, 200, 83, 0.7)',
            WARNING:  'rgba(255, 171, 0, 0.85)',
            CRITICAL: 'rgba(239, 68, 68, 0.95)',
        }[status] || 'rgba(148, 163, 184, 0.5)';
    }

    // ---------------------------------------------------------------
    // Map overlay (Twin colors on cells)
    // ---------------------------------------------------------------
    let overlayActive = false;
    let overlayData = null;     // { cells: [...] }
    let mapInstance = null;
    let refreshTimer = null;

    function getMap() {
        if (mapInstance) return mapInstance;
        // Check various places app.js might expose the map
        return window.mobydbMap
            || window.map
            || (window.mobydbState && window.mobydbState.map)
            || null;
    }

    function buildGeoJSON(cells) {
        const h3 = window.h3;
        if (!h3 || !h3.cellToBoundary) {
            console.warn(`${NS}: h3-js not available — overlay disabled`);
            return { type: 'FeatureCollection', features: [] };
        }
        const features = [];
        for (const c of cells) {
            const boundary = h3.cellToBoundary(c.h3_cell);  // [[lat,lng], ...]
            // Flip to [lng, lat] for GeoJSON
            const ring = boundary.map(([lat, lng]) => [lng, lat]);
            ring.push(ring[0]);
            const status = classifyCell(c.payload);
            features.push({
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [ring] },
                properties: {
                    h3_cell: c.h3_cell,
                    status,
                    voltage_kv: c.payload.voltage_kv,
                    load_mw: c.payload.load_mw,
                    temperature_celsius: c.payload.temperature_celsius,
                    anomaly_active: c.payload.anomaly_active,
                },
            });
        }
        return { type: 'FeatureCollection', features };
    }

    function applyMapOverlay(map, geojson) {
        const sourceId = `${NS}-source`;
        const fillId = `${NS}-fill`;
        const lineId = `${NS}-line`;

        const existing = map.getSource(sourceId);
        if (existing) {
            existing.setData(geojson);
            return;
        }

        map.addSource(sourceId, { type: 'geojson', data: geojson });

        map.addLayer({
            id: fillId,
            type: 'fill',
            source: sourceId,
            paint: {
                'fill-color': [
                    'match',
                    ['get', 'status'],
                    'OK',       'rgba(0, 200, 83, 0.30)',
                    'WARNING',  'rgba(255, 171, 0, 0.45)',
                    'CRITICAL', 'rgba(239, 68, 68, 0.55)',
                    'rgba(148, 163, 184, 0.20)',
                ],
                'fill-outline-color': 'rgba(255, 255, 255, 0.4)',
            },
        });

        map.addLayer({
            id: lineId,
            type: 'line',
            source: sourceId,
            paint: {
                'line-color': [
                    'match',
                    ['get', 'status'],
                    'OK',       'rgba(0, 200, 83, 0.7)',
                    'WARNING',  'rgba(255, 171, 0, 0.9)',
                    'CRITICAL', 'rgba(239, 68, 68, 0.95)',
                    'rgba(148, 163, 184, 0.5)',
                ],
                'line-width': 1.5,
            },
        });

        // Click on a twin cell → emit audit-open like a normal substation click
        map.on('click', fillId, (e) => {
            if (!e.features || !e.features.length) return;
            const cell = e.features[0].properties.h3_cell;
            try {
                window.mobydbBus.dispatchEvent(
                    new CustomEvent('audit-open', {
                        detail: { cell, source: 'twin-overlay' },
                    })
                );
            } catch (err) {
                console.warn(`${NS}: failed to dispatch audit-open`, err);
            }
        });
        map.on('mouseenter', fillId, () => {
            map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', fillId, () => {
            map.getCanvas().style.cursor = '';
        });
    }

    function removeMapOverlay(map) {
        const fillId = `${NS}-fill`;
        const lineId = `${NS}-line`;
        const sourceId = `${NS}-source`;
        if (map.getLayer(fillId)) map.removeLayer(fillId);
        if (map.getLayer(lineId)) map.removeLayer(lineId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    }

    async function refreshOverlay() {
        if (!overlayActive) return;
        try {
            const data = await fetchAllLatest();
            overlayData = data;
            const map = getMap();
            if (map && data && data.cells) {
                const geojson = buildGeoJSON(data.cells);
                applyMapOverlay(map, geojson);
                updateToggleCount(data.count);
            }
        } catch (err) {
            console.warn(`${NS}: refresh failed`, err);
        }
    }

    function startOverlay() {
        overlayActive = true;
        refreshOverlay();
        if (!refreshTimer) {
            refreshTimer = setInterval(refreshOverlay, REFRESH_INTERVAL_MS);
        }
    }

    function stopOverlay() {
        overlayActive = false;
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
        const map = getMap();
        if (map) removeMapOverlay(map);
        updateToggleCount(null);
    }

    // ---------------------------------------------------------------
    // Toggle button
    // ---------------------------------------------------------------
    function injectToggleButton() {
        if (document.querySelector(`.${NS}-toggle`)) return;
        const btn = document.createElement('button');
        btn.className = `${NS}-toggle`;
        btn.dataset.active = 'false';
        btn.innerHTML = `
            <span class="dot"></span>
            <span class="label">Twin Telemetry</span>
            <span class="count"></span>
        `;
        btn.addEventListener('click', () => {
            const isActive = btn.dataset.active === 'true';
            if (isActive) {
                btn.dataset.active = 'false';
                stopOverlay();
            } else {
                btn.dataset.active = 'true';
                startOverlay();
            }
        });
        document.body.appendChild(btn);
    }

    function updateToggleCount(count) {
        const btn = document.querySelector(`.${NS}-toggle`);
        if (!btn) return;
        const span = btn.querySelector('.count');
        if (!span) return;
        span.textContent = count != null ? `${count} cells` : '';
    }

    // ---------------------------------------------------------------
    // Audit panel section (per-cell view)
    // ---------------------------------------------------------------
    function findAuditHost() {
        return document.querySelector('#audit')
            || document.querySelector('#audit-panel')
            || document.querySelector('[data-role="audit-panel"]')
            || document.querySelector('.audit-panel');
    }

    function clearTwinSection(host) {
        host.querySelectorAll(`.${SECTION_CLASS}`).forEach(n => n.remove());
    }

    function renderShell(status, statusText) {
        const section = document.createElement('section');
        section.className = SECTION_CLASS;
        section.innerHTML = `
            <header>
                <h5>twin · grid telemetry</h5>
                <span class="${NS}-status-pill" data-status="${status}">${statusText}</span>
            </header>
            <div class="${NS}-body"></div>
        `;
        return section;
    }

    function fmt(v, digits) {
        if (v == null) return '—';
        const n = Number(v);
        if (!Number.isFinite(n)) return '—';
        return digits != null ? n.toFixed(digits) : String(n);
    }

    function renderTwinDetail(record) {
        const p = record.payload;
        const status = classifyCell(p);
        const statusText = status === 'OK' ? 'nominal'
            : status === 'WARNING' ? 'warning'
            : status === 'CRITICAL' ? 'critical' : status.toLowerCase();

        const anomalyHTML = p.anomaly_active ? `
            <div class="${NS}-anomaly" data-severity="${p.anomaly_severity || 'warning'}">
                <div class="${NS}-anomaly-head">${p.anomaly_type || 'anomaly'} · ${p.anomaly_severity || ''}</div>
                <div>${p.anomaly_description || ''}</div>
            </div>
        ` : '';

        const recordHash = (record.record_hash || '').replace(/^blake3:/, '').slice(0, 16);
        const sigShort = (record.signature || '').replace(/^ed25519:/, '').slice(0, 16);
        const pubShort = (record.pubkey || '').slice(0, 12);

        return {
            status,
            statusText,
            html: `
                <div class="${NS}-metrics">
                    <div class="${NS}-metric">
                        <div class="${NS}-metric-label">voltage</div>
                        <div class="${NS}-metric-value">${fmt(p.voltage_kv, 2)}<span class="${NS}-metric-unit"> kV</span></div>
                    </div>
                    <div class="${NS}-metric">
                        <div class="${NS}-metric-label">current</div>
                        <div class="${NS}-metric-value">${fmt(p.current_a, 1)}<span class="${NS}-metric-unit"> A</span></div>
                    </div>
                    <div class="${NS}-metric">
                        <div class="${NS}-metric-label">load</div>
                        <div class="${NS}-metric-value">${fmt(p.load_mw, 1)}<span class="${NS}-metric-unit"> MW · ${fmt(p.nominal_load_mw, 0)} nom</span></div>
                    </div>
                    <div class="${NS}-metric">
                        <div class="${NS}-metric-label">transformer</div>
                        <div class="${NS}-metric-value">${fmt(p.temperature_celsius, 1)}<span class="${NS}-metric-unit"> °C</span></div>
                    </div>
                </div>
                ${anomalyHTML}
                <div class="${NS}-sig">
                    pubkey  <code>${pubShort}…</code> · twin-runtime-v1<br>
                    hash    <code>${recordHash}…</code><br>
                    signed  <code>${sigShort}…</code> ed25519
                </div>
                <button class="${NS}-ai-button" data-cell="${record.h3_cell}">
                    [AI] interroga questa cella
                </button>
                <div class="${NS}-disclaimer">
                    Telemetria simulata · pre-sidecar · pattern derivati da dati pubblici Terna zona Centro
                </div>
            `,
        };
    }

    function renderError(msg) {
        return {
            status: 'CRITICAL',
            statusText: 'fetch failed',
            html: `<div class="${NS}-disclaimer">Twin API error: ${msg}</div>`,
        };
    }

    function renderEmpty() {
        return {
            status: 'LOADING',
            statusText: 'no data',
            html: `<div class="${NS}-disclaimer">No twin record for this cell.</div>`,
        };
    }

    // ---------------------------------------------------------------
    // AI Inspector modal
    // ---------------------------------------------------------------
    const SUGGESTIONS = [
        "Qual è lo stato attuale e ci sono anomalie?",
        "Confronta le ultime 24 ore con la media settimanale",
        "Quale rischio operativo prevedi per le prossime 6 ore?",
        "Cosa è cambiato rispetto al periodo precedente?",
    ];

    function openAiModal(cell) {
        // Remove any existing modal first
        document.querySelectorAll(`.${NS}-modal-backdrop`).forEach(n => n.remove());

        const backdrop = document.createElement('div');
        backdrop.className = `${NS}-modal-backdrop`;
        backdrop.innerHTML = `
            <div class="${NS}-modal" role="dialog" aria-modal="true">
                <div class="${NS}-modal-head">
                    <div>
                        <h3>AI Inspector</h3>
                        <div class="meta">cella <code>${cell}</code> · firma Ed25519 · gpt-4o · Sweden Central</div>
                    </div>
                    <button class="${NS}-close" aria-label="close">×</button>
                </div>
                <div class="${NS}-modal-body">
                    <div class="${NS}-suggestions">
                        ${SUGGESTIONS.map(s =>
                            `<button class="${NS}-suggestion">${s}</button>`
                        ).join('')}
                    </div>
                    <textarea class="${NS}-textarea" placeholder="Domanda libera (italiano consigliato)..."></textarea>
                    <button class="${NS}-submit">Interroga AI</button>
                    <div class="${NS}-result"></div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        const modal = backdrop.querySelector(`.${NS}-modal`);
        const textarea = backdrop.querySelector(`.${NS}-textarea`);
        const submit = backdrop.querySelector(`.${NS}-submit`);
        const result = backdrop.querySelector(`.${NS}-result`);
        const closeBtn = backdrop.querySelector(`.${NS}-close`);

        function close() { backdrop.remove(); }
        closeBtn.addEventListener('click', close);
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) close();
        });
        document.addEventListener('keydown', function onKey(e) {
            if (e.key === 'Escape') {
                close();
                document.removeEventListener('keydown', onKey);
            }
        });

        backdrop.querySelectorAll(`.${NS}-suggestion`).forEach(btn => {
            btn.addEventListener('click', () => {
                textarea.value = btn.textContent.trim();
                textarea.focus();
            });
        });

        submit.addEventListener('click', async () => {
            const q = textarea.value.trim();
            if (q.length < 3) {
                textarea.focus();
                return;
            }
            submit.disabled = true;
            result.innerHTML = `<div class="${NS}-loading">L'AI sta consultando i dati firmati</div>`;
            try {
                const t0 = performance.now();
                const resp = await postAiInspect(cell, q);
                const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
                renderAiResult(result, resp, elapsed);
            } catch (err) {
                result.innerHTML = `
                    <div class="${NS}-disclaimer" style="color: var(--${NS}-vi);">
                        Error: ${err.message || err}
                    </div>
                `;
            } finally {
                submit.disabled = false;
            }
        });

        // Auto-focus textarea
        setTimeout(() => textarea.focus(), 50);
    }

    function renderAiResult(host, resp, elapsed) {
        const hash = (resp.record_hash || '').replace(/^blake3:/, '').slice(0, 24);
        const sig = (resp.signature || '').replace(/^ed25519:/, '').slice(0, 24);
        const pub = (resp.pubkey || '').slice(0, 16);
        const chainStr = (resp.chain || []).join(
            ` <span class="chain-arrow">→</span> `
        );

        host.innerHTML = `
            <div class="${NS}-ai-response">${resp.response}</div>
            <div class="${NS}-ai-attestation">
                <div><span class="ok">✓ Risposta firmata Ed25519</span> · ${elapsed}s · ${resp.tokens_in}↓ ${resp.tokens_out}↑ tokens</div>
                <div>model      <code>${resp.model}</code> · ${resp.provider}</div>
                <div>pubkey     <code>${pub}…</code></div>
                <div>hash       <code>${hash}…</code></div>
                <div>signature  <code>${sig}…</code></div>
                <div>chain      ${chainStr}</div>
                <div style="margin-top:6px; opacity:0.7">${resp.sim_disclaimer || ''}</div>
            </div>
        `;
    }

    // ---------------------------------------------------------------
    // Audit panel handler
    // ---------------------------------------------------------------
    // ---------------------------------------------------------------
    // Extract H3 cell ID from various event detail shapes.
    // The host app's `audit-open` may pass:
    //   - {cell: "881e..."}                              (string, our convention)
    //   - {cell: {h3_cell: "8b1e...", ...}}              (full cell object)
    //   - {cell: {cell_state: {h3_cell: "..."}, ...}}    (deeply nested)
    // It may also pass a res-11 cell when our twin DB has res-8.
    // We roll up to res-8 if needed via h3.cellToParent.
    // ---------------------------------------------------------------
    function extractCellId(evt) {
        const detail = evt && evt.detail;
        if (!detail) return null;

        let raw = detail.cell;
        // String case
        if (typeof raw === 'string') return rollupRes8(raw);
        // Object case — try common shapes
        if (raw && typeof raw === 'object') {
            const candidate = raw.h3_cell
                || (raw.cell_state && raw.cell_state.h3_cell)
                || raw.id
                || null;
            if (candidate) return rollupRes8(candidate);
        }
        // Direct h3 field on detail itself
        if (typeof detail.h3_cell === 'string') return rollupRes8(detail.h3_cell);
        return null;
    }

    function rollupRes8(h3id) {
        // H3 strings: 15 chars = res 11, 13 chars = res 9, 12 chars = res 8.
        // Roll up to res-8 via h3-js if available.
        if (typeof h3id !== 'string' || !h3id) return h3id;
        const h3 = window.h3;
        if (!h3 || !h3.cellToParent || !h3.getResolution) return h3id;
        try {
            const res = h3.getResolution(h3id);
            if (res === 8) return h3id;
            if (res > 8) return h3.cellToParent(h3id, 8);
            return h3id; // res < 8, no rollup possible
        } catch (e) {
            console.warn(`${NS}: rollupRes8 failed for ${h3id}`, e);
            return h3id;
        }
    }

    let inflightCell = null;

    async function onAuditOpen(evt) {
        const cell = extractCellId(evt);
        if (!cell || typeof cell !== 'string') {
            // Silently ignore — host app's audit-open had no cell info we can use
            return;
        }
        const host = findAuditHost();
        if (!host) return;

        clearTwinSection(host);
        const loadingShell = renderShell('LOADING', 'fetching…');
        loadingShell.querySelector(`.${NS}-body`).innerHTML =
            `<div class="${NS}-disclaimer">Loading twin telemetry…</div>`;
        host.appendChild(loadingShell);

        inflightCell = cell;
        try {
            const record = await fetchTwinState(cell);
            if (inflightCell !== cell) return;  // user moved on

            clearTwinSection(host);
            const r = record && record.h3_cell
                ? renderTwinDetail(record)
                : renderEmpty();
            const section = renderShell(r.status, r.statusText);
            section.querySelector(`.${NS}-body`).innerHTML = r.html;
            host.appendChild(section);

            // Wire up the AI button
            const aiBtn = section.querySelector(`.${NS}-ai-button`);
            if (aiBtn) {
                aiBtn.addEventListener('click', () => openAiModal(cell));
            }
        } catch (err) {
            if (inflightCell !== cell) return;
            // 404 is expected for cells that aren't in our 60-cell twin set —
            // render a softer "no twin data for this cell" instead of an error.
            const is404 = err && (err.message || '').includes('404');
            clearTwinSection(host);
            const r = is404
                ? {
                    status: 'LOADING',
                    statusText: 'no twin data',
                    html: `<div class="${NS}-disclaimer">
                        Questa cella non è nel set delle 60 celle Rome del mini-twin demo.
                        Seleziona una cella nell'area centrale di Roma per vedere la telemetria simulata.
                    </div>`,
                }
                : renderError(err.message || String(err));
            const section = renderShell(r.status, r.statusText);
            section.querySelector(`.${NS}-body`).innerHTML = r.html;
            host.appendChild(section);
        }
    }

    // ---------------------------------------------------------------
    // Boot
    // ---------------------------------------------------------------
    function boot() {
        injectStyles();
        injectToggleButton();

        const bus = window.mobydbBus;
        if (!bus) {
            console.warn(`${NS}: window.mobydbBus not found — audit panel integration disabled`);
        } else {
            bus.addEventListener('audit-open', onAuditOpen);
        }

        // Expose minimal API for debugging
        window.mobydbTwin = {
            startOverlay,
            stopOverlay,
            refresh: refreshOverlay,
            isActive: () => overlayActive,
            api: TWIN_API,
        };

        console.log(`${NS}: ready · backend ${TWIN_API}`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
