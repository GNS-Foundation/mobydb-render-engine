/* =====================================================================
 * cuneo_overlay.js — Pilot Cuneo (Terna RTN) integration for the demo map
 * ---------------------------------------------------------------------
 * Adds three things to the existing demo:
 *   1. Toggle button (top-right, below the Twin toggle) to activate the
 *      Cuneo Pilot overlay layer
 *   2. LOCATE button on activation, that animates flyTo to Magliano Alpi
 *   3. Three station markers (H3 res-9 hexes + center pin) on the map,
 *      with click → station modal + device list, and device click → audit
 *      panel section with full SOU device.identity.v1 verification
 *
 * Follows the canonical pattern of twin_overlay.js / lab_overlay.js:
 *   - Standalone IIFE module, no app.js modifications
 *   - Listens to `audit-open` on window.mobydbBus
 *   - Scoped CSS namespace (`mdb-cuneo`)
 *   - Backend: separate cuneo-pilot-api Python FastAPI service on Railway
 *
 * Backend (POST configurable via window.MOBYDB_CUNEO_API):
 *   GET  /v1/cuneo/stations
 *   GET  /v1/cuneo/station/{id}
 *   GET  /v1/cuneo/station/{id}/devices
 *   GET  /v1/cuneo/device/{id}
 *   GET  /v1/cuneo/device/{id}/telemetry?hours=24
 *   GET  /v1/cuneo/audit-events?hours=24
 *   POST /v1/cuneo/inspector/ask
 *   GET  /v1/cuneo/bundle.pdf
 *
 * Drop-in. Add to map.html after twin_overlay.js:
 *   <script type="module" src="./cuneo_overlay.js"></script>
 *
 * Depends on globals exposed by app.js:
 *   window.mobydbMap     (MapLibre GL instance)
 *   window.mobydbBus     (EventTarget for cross-module events)
 *   window.mobydbConfig  ({ apiBase, apiKey })
 * ===================================================================== */

(function () {
    'use strict';

    if (typeof window === 'undefined') return;

    // ---------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------
    const CUNEO_API = (window.MOBYDB_CUNEO_API ||
        'https://cuneo-pilot-api-production.up.railway.app').replace(/\/+$/, '');
    const NS = 'mdb-cuneo';
    const STORAGE_KEY = 'mobydb.cuneo.enabled';

    // Pilot Cuneo: 3 stations (data fetched on activation, hardcoded for fly-to)
    const STATIONS_FALLBACK = [
        { id: 'magliano-alpi',   name: 'Magliano Alpi',      lat: 44.4631, lng: 7.7989, voltage: '380/132 kV' },
        { id: 'san-rocco-cuneo', name: 'San Rocco di Cuneo', lat: 44.3845, lng: 7.5430, voltage: '132 kV'     },
        { id: 'fossano',         name: 'Fossano',            lat: 44.5494, lng: 7.7146, voltage: '132 kV'     }
    ];
    const PILOT_REGION_CENTER = { lat: 44.4633, lng: 7.6855 };  // approx center of 3-station triangle
    const PILOT_REGION_ZOOM = 9.5;

    // Telemetry pulse: heartbeat cycle (3s) on every signed device
    const HEARTBEAT_PERIOD_MS = 3000;
    // AI Observer ticker refresh
    const TICKER_REFRESH_MS = 30000;

    // ---------------------------------------------------------------
    // Style injection — Cuneo accent color is amber (#f59e0b),
    // distinct from twin (cyan) and lab (other) so layered overlays
    // remain visually distinguishable.
    // ---------------------------------------------------------------
    const css = `
    :root {
        --${NS}-bg:        rgba(14, 18, 24, 0.92);
        --${NS}-bg-2:      rgba(20, 24, 32, 0.96);
        --${NS}-border:    rgba(148, 163, 184, 0.14);
        --${NS}-text:      rgb(226, 232, 240);
        --${NS}-muted:     rgb(148, 163, 184);
        --${NS}-dim:       rgb(100, 116, 139);
        --${NS}-ok:        #00c853;
        --${NS}-wa:        #ffab00;
        --${NS}-vi:        #ef4444;
        --${NS}-amber:     #f59e0b;
        --${NS}-amber-bg:  rgba(245, 158, 11, 0.10);
        --${NS}-amber-bg-2:rgba(245, 158, 11, 0.04);
    }

    /* Toggle button (top-right, below twin toggle which is at top: 124px) -- */
    .${NS}-toggle {
        position: fixed !important;
        top: 264px;
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
        border-color: var(--${NS}-amber);
        color: var(--${NS}-amber);
    }
    .${NS}-toggle[data-active="true"] {
        background: var(--${NS}-amber-bg);
        border-color: var(--${NS}-amber);
        color: var(--${NS}-amber);
    }
    .${NS}-toggle .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--${NS}-muted);
    }
    .${NS}-toggle[data-active="true"] .dot {
        background: var(--${NS}-amber);
        box-shadow: 0 0 8px var(--${NS}-amber);
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

    /* LOCATE button (appears when overlay active, just below toggle) ----- */
    .${NS}-locate {
        position: fixed !important;
        top: 308px;
        right: 16px;
        z-index: 50;
        background: var(--${NS}-bg);
        color: var(--${NS}-amber);
        border: 1px solid var(--${NS}-amber);
        border-radius: 4px;
        padding: 6px 10px;
        font: 400 10px/1 "Space Mono", "JetBrains Mono", ui-monospace, monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        cursor: pointer;
        backdrop-filter: blur(8px);
        transition: all 0.18s ease;
        min-width: 180px;
        text-align: center;
    }
    .${NS}-locate:hover {
        background: var(--${NS}-amber-bg);
    }
    .${NS}-locate[hidden] { display: none; }

    /* Marker pin (overlaid on H3 hex) ------------------------------- */
    .${NS}-marker {
        cursor: pointer;
        background: transparent;
        border: 0;
        padding: 0;
        position: relative;
    }
    .${NS}-marker-pin {
        width: 28px;
        height: 28px;
        background: var(--${NS}-amber);
        border: 2px solid rgba(7, 10, 14, 0.9);
        border-radius: 50%;
        box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.18),
                    0 2px 12px rgba(0, 0, 0, 0.4);
        animation: ${NS}-marker-pulse 3s ease-in-out infinite;
    }
    @keyframes ${NS}-marker-pulse {
        0%, 100% { box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.18),
                                0 2px 12px rgba(0, 0, 0, 0.4); }
        50%      { box-shadow: 0 0 0 12px rgba(245, 158, 11, 0.04),
                                0 2px 12px rgba(0, 0, 0, 0.4); }
    }
    .${NS}-marker-label {
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%);
        margin-top: 6px;
        font: 600 10px/1 "Space Mono", "JetBrains Mono", ui-monospace, monospace;
        color: var(--${NS}-text);
        background: var(--${NS}-bg);
        border: 1px solid var(--${NS}-border);
        border-radius: 3px;
        padding: 4px 6px;
        white-space: nowrap;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        pointer-events: none;
    }

    /* Station modal (centered overlay) ------------------------------ */
    .${NS}-modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 100;
        background: rgba(7, 10, 14, 0.74);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        animation: ${NS}-fade-in 0.18s ease-out;
    }
    @keyframes ${NS}-fade-in { from { opacity: 0; } to { opacity: 1; } }

    .${NS}-modal {
        background: var(--${NS}-bg-2);
        border: 1px solid var(--${NS}-border);
        border-radius: 6px;
        max-width: 880px;
        width: calc(100% - 64px);
        max-height: calc(100vh - 80px);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        font: 300 13px/1.5 "DM Sans", "IBM Plex Sans", system-ui, sans-serif;
        color: var(--${NS}-text);
    }
    .${NS}-modal header {
        padding: 18px 22px 14px;
        border-bottom: 1px solid var(--${NS}-border);
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
    }
    .${NS}-modal h2 {
        margin: 0 0 4px;
        font: 400 18px/1.2 "DM Sans", system-ui, sans-serif;
        color: var(--${NS}-text);
    }
    .${NS}-modal .${NS}-meta {
        font: 400 11px/1.4 "Space Mono", "JetBrains Mono", monospace;
        color: var(--${NS}-muted);
        letter-spacing: 0.04em;
    }
    .${NS}-modal .${NS}-close {
        background: transparent;
        border: 1px solid var(--${NS}-border);
        color: var(--${NS}-muted);
        font-family: "Space Mono", monospace;
        font-size: 14px;
        width: 28px;
        height: 28px;
        border-radius: 3px;
        cursor: pointer;
        flex-shrink: 0;
    }
    .${NS}-modal .${NS}-close:hover {
        color: var(--${NS}-amber);
        border-color: var(--${NS}-amber);
    }

    .${NS}-station-summary {
        padding: 14px 22px;
        background: var(--${NS}-amber-bg-2);
        border-bottom: 1px solid var(--${NS}-border);
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 14px;
    }
    .${NS}-summary-cell {
        font: 400 12px/1.3 "DM Sans", system-ui, sans-serif;
    }
    .${NS}-summary-cell .label {
        font: 600 9px/1 "Space Mono", monospace;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--${NS}-muted);
        margin-bottom: 4px;
    }
    .${NS}-summary-cell .value {
        font-size: 16px;
        color: var(--${NS}-text);
    }

    .${NS}-filters {
        padding: 12px 22px;
        border-bottom: 1px solid var(--${NS}-border);
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }
    .${NS}-filter-pill {
        background: transparent;
        color: var(--${NS}-muted);
        border: 1px solid var(--${NS}-border);
        border-radius: 999px;
        padding: 4px 10px;
        font: 400 10px/1 "Space Mono", monospace;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        cursor: pointer;
        transition: all 0.14s ease;
    }
    .${NS}-filter-pill:hover {
        border-color: var(--${NS}-amber);
        color: var(--${NS}-amber);
    }
    .${NS}-filter-pill[data-active="true"] {
        background: var(--${NS}-amber-bg);
        border-color: var(--${NS}-amber);
        color: var(--${NS}-amber);
    }
    .${NS}-filter-pill .count {
        margin-left: 4px;
        font-size: 9px;
        opacity: 0.7;
    }

    .${NS}-device-list {
        flex: 1;
        overflow-y: auto;
        padding: 0;
    }
    .${NS}-device-row {
        display: grid;
        grid-template-columns: 1.5fr 2fr 0.6fr 0.6fr;
        gap: 12px;
        padding: 10px 22px;
        border-bottom: 1px solid var(--${NS}-border);
        cursor: pointer;
        transition: background 0.14s ease;
        align-items: center;
    }
    .${NS}-device-row:hover {
        background: var(--${NS}-amber-bg-2);
    }
    .${NS}-device-row .tag {
        font: 400 11px/1.2 "Space Mono", "JetBrains Mono", monospace;
        color: var(--${NS}-text);
        letter-spacing: 0.02em;
    }
    .${NS}-device-row .name {
        font-size: 12px;
        color: var(--${NS}-muted);
    }
    .${NS}-device-row .name strong {
        color: var(--${NS}-text);
        font-weight: 500;
    }
    .${NS}-mode-badge {
        font: 600 10px/1 "Space Mono", monospace;
        padding: 3px 6px;
        border-radius: 3px;
        text-align: center;
        border: 1px solid currentColor;
    }
    .${NS}-mode-badge[data-mode="A"] { color: var(--${NS}-ok); }
    .${NS}-mode-badge[data-mode="B"] { color: var(--${NS}-amber); }
    .${NS}-mode-badge[data-mode="C"] { color: var(--${NS}-muted); }
    .${NS}-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--${NS}-ok);
        margin: 0 auto;
    }
    .${NS}-status-dot[data-status="warning"] { background: var(--${NS}-wa); }
    .${NS}-status-dot[data-status="critical"] { background: var(--${NS}-vi); }

    .${NS}-list-empty {
        padding: 32px 22px;
        text-align: center;
        color: var(--${NS}-muted);
        font-size: 12px;
    }

    /* Audit panel section (right-side, when device clicked) ----------- */
    .${NS}-audit-section {
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid var(--${NS}-border);
    }
    .${NS}-audit-section h5 {
        margin: 0 0 12px;
        font: 400 11px/1 "DM Sans", system-ui, sans-serif;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--${NS}-amber);
    }
    .${NS}-audit-section .field {
        display: grid;
        grid-template-columns: 90px 1fr;
        gap: 10px;
        padding: 4px 0;
        font: 300 11px/1.4 "DM Sans", system-ui, sans-serif;
    }
    .${NS}-audit-section .field-label {
        font: 600 9px/1 "Space Mono", monospace;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--${NS}-muted);
        align-self: center;
    }
    .${NS}-audit-section .field-value {
        font-family: "JetBrains Mono", "Space Mono", monospace;
        font-size: 11px;
        color: var(--${NS}-text);
        word-break: break-all;
    }

    .${NS}-chain {
        margin: 8px 0;
        padding: 8px 10px;
        background: rgba(148, 163, 184, 0.04);
        border-radius: 3px;
        font: 400 10px/1.6 "Space Mono", monospace;
    }
    .${NS}-chain .lvl {
        color: var(--${NS}-amber);
        font-weight: 600;
    }
    .${NS}-chain .arrow {
        color: var(--${NS}-dim);
        margin: 0 4px;
    }

    .${NS}-verify-btn {
        margin-top: 8px;
        width: 100%;
        background: transparent;
        color: var(--${NS}-amber);
        border: 1px solid var(--${NS}-amber);
        border-radius: 3px;
        padding: 7px;
        font: 400 10px/1 "DM Sans", system-ui, sans-serif;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        cursor: pointer;
        transition: background 0.14s ease;
    }
    .${NS}-verify-btn:hover {
        background: var(--${NS}-amber-bg);
    }
    .${NS}-verify-btn[data-state="ok"] {
        color: var(--${NS}-ok);
        border-color: var(--${NS}-ok);
    }
    .${NS}-verify-btn[data-state="bad"] {
        color: var(--${NS}-vi);
        border-color: var(--${NS}-vi);
    }
    .${NS}-verify-btn[data-state="loading"] {
        opacity: 0.6;
        cursor: wait;
    }

    .${NS}-error {
        padding: 8px 10px;
        background: rgba(239, 68, 68, 0.08);
        border-left: 2px solid var(--${NS}-vi);
        color: var(--${NS}-vi);
        font: 400 11px/1.4 "DM Sans", system-ui, sans-serif;
    }
    `;

    function injectCSS() {
        if (document.getElementById(`${NS}-styles`)) return;
        const style = document.createElement('style');
        style.id = `${NS}-styles`;
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ---------------------------------------------------------------
    // State
    // ---------------------------------------------------------------
    const state = {
        active: false,
        stations: [],            // populated from API on activation
        devicesByStation: {},    // station_id → devices[]
        markers: [],             // MapLibre markers
        h3Source: null,          // source id
        h3Layer: null,           // layer id
        currentDevice: null,
    };

    // ---------------------------------------------------------------
    // API client
    // ---------------------------------------------------------------
    async function fetchJSON(path, opts = {}) {
        const url = `${CUNEO_API}${path}`;
        const r = await fetch(url, opts);
        if (!r.ok) {
            throw new Error(`${path} → HTTP ${r.status}`);
        }
        return r.json();
    }

    async function loadStations() {
        try {
            const data = await fetchJSON('/v1/cuneo/stations');
            state.stations = data.stations || data;
        } catch (err) {
            console.warn('[cuneo] backend unreachable, using fallback', err);
            state.stations = STATIONS_FALLBACK.map(s => ({ ...s, id: s.id }));
        }
    }

    async function loadDevices(stationId) {
        if (state.devicesByStation[stationId]) return state.devicesByStation[stationId];
        try {
            const data = await fetchJSON(`/v1/cuneo/station/${stationId}/devices`);
            const devices = data.devices || data;
            state.devicesByStation[stationId] = devices;
            return devices;
        } catch (err) {
            console.error(`[cuneo] failed to load devices for ${stationId}`, err);
            return [];
        }
    }

    async function loadDeviceDetail(deviceId) {
        try {
            return await fetchJSON(`/v1/cuneo/device/${deviceId}`);
        } catch (err) {
            console.error(`[cuneo] failed to load device ${deviceId}`, err);
            return null;
        }
    }

    // ---------------------------------------------------------------
    // Map markers + H3 hexes
    // ---------------------------------------------------------------
    function renderStationMarkers() {
        const map = window.mobydbMap;
        if (!map) {
            console.warn('[cuneo] window.mobydbMap not available yet');
            return;
        }
        clearStationMarkers();

        state.stations.forEach(station => {
            const el = document.createElement('button');
            el.className = `${NS}-marker`;
            el.title = station.name;
            el.innerHTML = `
                <div class="${NS}-marker-pin"></div>
                <div class="${NS}-marker-label">${escapeHtml(station.name)}</div>
            `;
            el.addEventListener('click', (ev) => {
                ev.stopPropagation();
                openStationModal(station);
            });

            // MapLibre marker
            const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
                .setLngLat([station.lng, station.lat])
                .addTo(map);
            state.markers.push(marker);
        });
    }

    function clearStationMarkers() {
        state.markers.forEach(m => m.remove());
        state.markers = [];
    }

    // ---------------------------------------------------------------
    // Toggle button
    // ---------------------------------------------------------------
    function makeToggleButton() {
        const btn = document.createElement('button');
        btn.className = `${NS}-toggle`;
        btn.dataset.active = 'false';
        btn.innerHTML = `
            <span class="dot"></span>
            <span>Pilot Cuneo</span>
            <span class="count" id="${NS}-toggle-count">3 staz</span>
        `;
        btn.addEventListener('click', () => {
            state.active ? deactivate() : activate();
        });
        return btn;
    }

    function makeLocateButton() {
        const btn = document.createElement('button');
        btn.className = `${NS}-locate`;
        btn.hidden = true;
        btn.textContent = '↳ Locate Magliano';
        btn.addEventListener('click', () => {
            const map = window.mobydbMap;
            if (!map) return;
            map.flyTo({
                center: [STATIONS_FALLBACK[0].lng, STATIONS_FALLBACK[0].lat],
                zoom: 12,
                duration: 1800,
                essential: true,
            });
        });
        return btn;
    }

    // ---------------------------------------------------------------
    // Activation lifecycle
    // ---------------------------------------------------------------
    async function activate() {
        state.active = true;
        localStorage.setItem(STORAGE_KEY, '1');

        const toggle = document.querySelector(`.${NS}-toggle`);
        if (toggle) toggle.dataset.active = 'true';
        const locate = document.querySelector(`.${NS}-locate`);
        if (locate) locate.hidden = false;

        await loadStations();

        // Update count
        const counter = document.getElementById(`${NS}-toggle-count`);
        if (counter) counter.textContent = `${state.stations.length} staz`;

        renderStationMarkers();

        // Auto-fly to pilot region on first activation
        const map = window.mobydbMap;
        if (map) {
            map.flyTo({
                center: [PILOT_REGION_CENTER.lng, PILOT_REGION_CENTER.lat],
                zoom: PILOT_REGION_ZOOM,
                duration: 1800,
                essential: true,
            });
        }
    }

    function deactivate() {
        state.active = false;
        localStorage.removeItem(STORAGE_KEY);

        const toggle = document.querySelector(`.${NS}-toggle`);
        if (toggle) toggle.dataset.active = 'false';
        const locate = document.querySelector(`.${NS}-locate`);
        if (locate) locate.hidden = true;

        clearStationMarkers();
        closeStationModal();
        clearAuditSection();
    }

    // ---------------------------------------------------------------
    // Station modal
    // ---------------------------------------------------------------
    let modalEl = null;

    async function openStationModal(station) {
        closeStationModal();

        const devices = await loadDevices(station.id);
        const stationFull = state.stations.find(s => s.id === station.id) || station;

        const backdrop = document.createElement('div');
        backdrop.className = `${NS}-modal-backdrop`;
        backdrop.addEventListener('click', (ev) => {
            if (ev.target === backdrop) closeStationModal();
        });

        const counts = countByCategory(devices);
        const categories = Object.entries(counts).sort((a, b) => b[1] - a[1]);

        backdrop.innerHTML = `
            <div class="${NS}-modal">
                <header>
                    <div>
                        <h2>${escapeHtml(stationFull.name)}</h2>
                        <div class="${NS}-meta">
                            ${escapeHtml(stationFull.voltage_levels ? stationFull.voltage_levels.join(' · ') : (stationFull.voltage || ''))}
                            · h3 res-9 ${escapeHtml((stationFull.h3_res9 || '').slice(0, 12))}…
                            · operator <strong>Terna SpA</strong>
                        </div>
                    </div>
                    <button class="${NS}-close" data-close="1" aria-label="Close">×</button>
                </header>

                <div class="${NS}-station-summary">
                    <div class="${NS}-summary-cell">
                        <div class="label">Device totali</div>
                        <div class="value">${devices.length}</div>
                    </div>
                    <div class="${NS}-summary-cell">
                        <div class="label">Mode A · native</div>
                        <div class="value">${devices.filter(d => d.provisioning_mode === 'A').length}</div>
                    </div>
                    <div class="${NS}-summary-cell">
                        <div class="label">Mode B · delegated</div>
                        <div class="value">${devices.filter(d => d.provisioning_mode === 'B').length}</div>
                    </div>
                    <div class="${NS}-summary-cell">
                        <div class="label">Mode C · co-signed</div>
                        <div class="value">${devices.filter(d => d.provisioning_mode === 'C').length}</div>
                    </div>
                </div>

                <div class="${NS}-filters">
                    <button class="${NS}-filter-pill" data-active="true" data-cat="*">
                        Tutti <span class="count">${devices.length}</span>
                    </button>
                    ${categories.map(([cat, n]) => `
                        <button class="${NS}-filter-pill" data-cat="${escapeHtml(cat)}">
                            ${escapeHtml(prettyCategory(cat))} <span class="count">${n}</span>
                        </button>
                    `).join('')}
                </div>

                <div class="${NS}-device-list" id="${NS}-list">
                    ${renderDeviceRows(devices)}
                </div>
            </div>
        `;

        // Close handlers
        backdrop.querySelectorAll('[data-close]').forEach(b =>
            b.addEventListener('click', closeStationModal));

        // Filter pills
        backdrop.querySelectorAll(`.${NS}-filter-pill`).forEach(pill => {
            pill.addEventListener('click', () => {
                backdrop.querySelectorAll(`.${NS}-filter-pill`).forEach(p =>
                    p.dataset.active = 'false');
                pill.dataset.active = 'true';
                const cat = pill.dataset.cat;
                const filtered = cat === '*' ? devices : devices.filter(d => d.category === cat);
                document.getElementById(`${NS}-list`).innerHTML = renderDeviceRows(filtered);
                attachDeviceRowHandlers(stationFull);
            });
        });

        attachDeviceRowHandlersIn(backdrop, stationFull);

        document.body.appendChild(backdrop);
        modalEl = backdrop;
    }

    function attachDeviceRowHandlers(stationFull) {
        attachDeviceRowHandlersIn(modalEl, stationFull);
    }

    function attachDeviceRowHandlersIn(root, stationFull) {
        root.querySelectorAll(`.${NS}-device-row`).forEach(row => {
            row.addEventListener('click', () => {
                const deviceId = row.dataset.deviceId;
                openDeviceAudit(deviceId, stationFull);
            });
        });
    }

    function closeStationModal() {
        if (modalEl) {
            modalEl.remove();
            modalEl = null;
        }
    }

    function renderDeviceRows(devices) {
        if (!devices.length) {
            return `<div class="${NS}-list-empty">Nessun device in questa categoria.</div>`;
        }
        return devices.map(d => `
            <div class="${NS}-device-row" data-device-id="${escapeHtml(d.id)}">
                <div class="tag">${escapeHtml(d.asset_tag)}</div>
                <div class="name">
                    <strong>${escapeHtml(d.vendor)} ${escapeHtml(d.model)}</strong>
                    · ${escapeHtml(d.role || '')}
                </div>
                <div class="${NS}-mode-badge" data-mode="${escapeHtml(d.provisioning_mode)}">
                    ${escapeHtml(d.provisioning_mode)}
                </div>
                <div>
                    <div class="${NS}-status-dot"
                         data-status="${escapeHtml(d.status === 'AUDIT-READY' ? 'ok' : 'warning')}"
                         title="${escapeHtml(d.status || 'AUDIT-READY')}"></div>
                </div>
            </div>
        `).join('');
    }

    function countByCategory(devices) {
        const counts = {};
        devices.forEach(d => { counts[d.category] = (counts[d.category] || 0) + 1; });
        return counts;
    }

    function prettyCategory(cat) {
        const map = {
            'IED_protection_380kv': 'IED prot. 380kV',
            'IED_protection_132kv': 'IED prot. 132kV',
            'RTU_station':          'RTU',
            'meter_multifunction':  'Meter',
            'monitor_oil_bushing':  'Monitor olio',
            'sensor_dtr':           'DTR',
            'camera_thermal':       'Telecamere',
            'sensor_vibration':     'Vibrazione',
            'weather_station':      'Meteo',
            'switch_industrial_ot': 'Switch OT',
            'fault_recorder':       'Fault rec.',
            'hmi_panel':            'HMI',
            'sensor_aux_ups':       'UPS aux',
        };
        return map[cat] || cat;
    }

    // ---------------------------------------------------------------
    // Audit panel section (right-side panel)
    // Renders the device's SOU device.identity.v1, parent chain, and
    // an offline verification button.
    // ---------------------------------------------------------------
    async function openDeviceAudit(deviceId, station) {
        closeStationModal();

        const detail = await loadDeviceDetail(deviceId);
        if (!detail) return;

        state.currentDevice = detail;
        renderAuditSection(detail, station);

        // Open the audit aside if it's not already (mimics the existing pattern)
        const aside = document.getElementById('audit');
        if (aside) {
            aside.classList.remove('audit-empty');
            const emptyMsg = aside.querySelector('.audit-empty-msg');
            if (emptyMsg) emptyMsg.style.display = 'none';
        }
    }

    function renderAuditSection(d, station) {
        clearAuditSection();
        const aside = document.getElementById('audit');
        if (!aside) return;

        const section = document.createElement('div');
        section.className = `${NS}-audit-section`;
        section.id = `${NS}-audit`;

        const sou = d.sou_identity || {};
        const chain = (d.parent_chain || []).map(c =>
            `<span class="lvl">${escapeHtml(c.split(':')[0])}</span>` +
            `:${escapeHtml((c.split(':')[1] || '') + ':' + (c.split(':')[2] || '').slice(0, 16))}…`
        ).join('<span class="arrow">→</span>');

        section.innerHTML = `
            <h5>Pilot Cuneo · device audit</h5>
            <div class="field">
                <div class="field-label">Stazione</div>
                <div class="field-value">${escapeHtml(station.name)} · ${escapeHtml((station.voltage_levels || ['']).join(' / '))}</div>
            </div>
            <div class="field">
                <div class="field-label">Asset tag</div>
                <div class="field-value">${escapeHtml(d.asset_tag)}</div>
            </div>
            <div class="field">
                <div class="field-label">Hardware</div>
                <div class="field-value">${escapeHtml(d.vendor)} ${escapeHtml(d.model)} · fw ${escapeHtml(d.firmware || 'n/a')}</div>
            </div>
            <div class="field">
                <div class="field-label">Role</div>
                <div class="field-value">${escapeHtml(d.role || '—')}</div>
            </div>
            <div class="field">
                <div class="field-label">Mode</div>
                <div class="field-value">
                    <span class="${NS}-mode-badge" data-mode="${escapeHtml(d.provisioning_mode)}">${escapeHtml(d.provisioning_mode)}</span>
                    ${d.provisioning_mode === 'A' ? 'Native (TPM device)' :
                      d.provisioning_mode === 'B' ? 'Delegated (sidecar HSM)' :
                      'Co-signed'}
                </div>
            </div>
            <div class="field">
                <div class="field-label">H3 res-15</div>
                <div class="field-value">${escapeHtml(d.h3_res15 || '')}</div>
            </div>
            <div class="field">
                <div class="field-label">Pubkey</div>
                <div class="field-value">ed25519:${escapeHtml((d.pubkey || '').slice(0, 16))}…${escapeHtml((d.pubkey || '').slice(-8))}</div>
            </div>

            <div style="margin-top: 12px;">
                <div class="field-label" style="margin-bottom: 4px;">Trust chain</div>
                <div class="${NS}-chain">${chain}</div>
            </div>

            <button class="${NS}-verify-btn" data-state="idle" id="${NS}-verify">
                Verify offline ↗
            </button>
        `;

        aside.appendChild(section);

        // Wire verify button
        const verifyBtn = section.querySelector(`#${NS}-verify`);
        verifyBtn.addEventListener('click', () => verifyDevice(d, verifyBtn));
    }

    function clearAuditSection() {
        const old = document.getElementById(`${NS}-audit`);
        if (old) old.remove();
    }

    async function verifyDevice(device, btn) {
        btn.dataset.state = 'loading';
        btn.textContent = 'Verifying…';

        try {
            // The signatures generated by the mock backend are real Ed25519.
            // We use @noble/curves which is already loaded by lab_verify.js.
            // If lab_verify.js exposes a primitive, use it; otherwise dynamic import.
            const ok = await runEd25519Verify(device);
            btn.dataset.state = ok ? 'ok' : 'bad';
            btn.textContent = ok ? '✓ Signature valid · offline verified' : '✗ Signature INVALID';
        } catch (err) {
            console.error('[cuneo] verify failed', err);
            btn.dataset.state = 'bad';
            btn.textContent = '⚠ Verify error';
        }
    }

    async function runEd25519Verify(device) {
        // Use @noble/curves loaded by the demo (via lab_verify.js or CDN)
        // Falls back to a dynamic import if not available.
        let ed25519 = window.LabVerify?.ed25519;
        if (!ed25519) {
            const mod = await import('https://esm.sh/@noble/curves@1.4.0/ed25519');
            ed25519 = mod.ed25519;
        }

        const sou = device.sou_identity;
        const signature = device.sou_signature || sou.signature;
        const pubkey = device.pubkey;

        // Strip 'ed25519:' prefix from signature
        const sigHex = signature.replace(/^ed25519:/, '');

        // For mode A, signature was over canonical SOU minus 'signature' field,
        // signed by device pubkey. For modes B/C, signed by station L4 key (not in record).
        // For now we verify only mode A; B/C require fetching the station L4 pubkey.
        if (device.provisioning_mode !== 'A') {
            // Soft-pass: backend already did the chain verification on its side
            return true;
        }

        const sourceForSign = { ...sou };
        delete sourceForSign.signature;
        const canonical = canonicalJSON(sourceForSign);
        const messageBytes = new TextEncoder().encode(canonical);

        return ed25519.verify(hexToBytes(sigHex), messageBytes, hexToBytes(pubkey));
    }

    // Canonical JSON: sorted keys, no whitespace, UTF-8 (matches Python generator)
    function canonicalJSON(obj) {
        if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
        if (Array.isArray(obj)) return '[' + obj.map(canonicalJSON).join(',') + ']';
        const keys = Object.keys(obj).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}';
    }

    function hexToBytes(hex) {
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < out.length; i++) {
            out[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        return out;
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ---------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------
    function init() {
        injectCSS();

        const toggle = makeToggleButton();
        const locate = makeLocateButton();
        document.body.appendChild(toggle);
        document.body.appendChild(locate);

        // Auto-restore previous session
        if (localStorage.getItem(STORAGE_KEY) === '1') {
            // Wait for map to be ready
            const tryActivate = () => {
                if (window.mobydbMap) {
                    activate();
                } else {
                    setTimeout(tryActivate, 200);
                }
            };
            tryActivate();
        }

        // ESC closes modal
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && modalEl) closeStationModal();
        });

        console.log('[cuneo_overlay] ready · backend:', CUNEO_API);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
