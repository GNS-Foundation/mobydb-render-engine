/* =====================================================================
 * lab_demo_button.js — floating "locate lab cell" control
 * ---------------------------------------------------------------------
 * Drop-in. Adds a small floating button bottom-left of the map.
 * On click:
 *   1. Flies map to the GEIANT Lab record's res-8 cell center at zoom 14
 *   2. Pulses a cyan ring at the screen center for ~3s
 *   3. Shows a brief toast hint: "click any visible substation"
 *
 * Then the user manually clicks any substation hexagon. lab_overlay.js
 * walks up to res 8 (cellToParent) and surfaces the lab attestation.
 *
 * No app.js changes required. Depends on:
 *   - window.mobydbMap   (MapLibre GL instance, set by app.js)
 *   - window.h3          (h3-js global, loaded via UMD CDN)
 *
 * Load order (in index.html):
 *   <script src="./lab_verify.js"></script>
 *   <script type="module" src="./app.js"></script>
 *   <script type="module" src="./compliance_overlay.js"></script>
 *   <script type="module" src="./liveness_indicators.js"></script>
 *   <script type="module" src="./lab_overlay.js"></script>
 *   <script type="module" src="./lab_demo_button.js"></script>   ← here
 * ===================================================================== */

(function () {
    'use strict';

    if (typeof window === 'undefined') return;

    // The known-good lab record cell that ALSO contains a render-engine
    // substation. Located in Trastevere (Rome, ~41.8765, 12.4688).
    // This is the only res-8 cell where the GEIANT Lab's 500-cell Lazio
    // pilot intersects with the render-engine's OSM substation set —
    // verified empirically by intersecting the two cell lists.
    // When the lab grows multiple cells, this can become a list and the
    // button cycles through them.
    const LAB_CELL = '881e805015fffff';
    const LAB_LABEL = 'Trastevere · GEIANT Lab × substation';
    const TARGET_ZOOM = 14;

    const NS = 'mdb-lab-demo';

    const css = `
    :root {
        --${NS}-bg:     rgba(14, 18, 24, 0.92);
        --${NS}-border: rgba(0, 153, 204, 0.40);
        --${NS}-text:   rgb(226, 232, 240);
        --${NS}-muted:  rgb(148, 163, 184);
        --${NS}-cyan:   #0099cc;
    }
    .${NS}-btn {
        position: absolute;
        bottom: 124px;
        left: 16px;
        z-index: 50;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 9px 14px 9px 12px;
        background: var(--${NS}-bg);
        border: 1px solid var(--${NS}-border);
        color: var(--${NS}-text);
        font: 300 12px/1 "DM Sans", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        cursor: pointer;
        backdrop-filter: blur(14px) saturate(120%);
        -webkit-backdrop-filter: blur(14px) saturate(120%);
        transition: border-color .18s ease, color .18s ease;
        user-select: none;
    }
    .${NS}-btn:hover {
        border-color: var(--${NS}-cyan);
        color: var(--${NS}-cyan);
    }
    .${NS}-btn .${NS}-tag {
        font: 600 9px/1 "Space Mono", "JetBrains Mono", ui-monospace, monospace;
        letter-spacing: 0.08em;
        padding: 3px 6px;
        border: 1px solid var(--${NS}-border);
        color: var(--${NS}-cyan);
        border-radius: 2px;
    }
    .${NS}-btn .${NS}-label {
        opacity: 0.95;
    }
    .${NS}-btn[data-active="true"] {
        border-color: var(--${NS}-cyan);
        color: var(--${NS}-cyan);
    }

    /* Pulse — anchored to absolute pixel coords on map */
    .${NS}-pulse {
        position: absolute;
        z-index: 40;
        pointer-events: none;
        width: 0;
        height: 0;
        border-radius: 50%;
        border: 2px solid var(--${NS}-cyan);
        transform: translate(-50%, -50%);
        opacity: 0;
        animation: ${NS}-pulse-kf 2.4s ease-out 3;
    }
    @keyframes ${NS}-pulse-kf {
        0%   { width: 30px;  height: 30px;  opacity: 0.85; }
        70%  { width: 240px; height: 240px; opacity: 0.10; }
        100% { width: 280px; height: 280px; opacity: 0;    }
    }

    /* Toast */
    .${NS}-toast {
        position: absolute;
        bottom: 124px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 51;
        padding: 10px 16px;
        background: var(--${NS}-bg);
        border: 1px solid var(--${NS}-border);
        color: var(--${NS}-cyan);
        font: 300 12px/1.4 "DM Sans", system-ui, sans-serif;
        letter-spacing: 0.04em;
        backdrop-filter: blur(14px) saturate(120%);
        opacity: 0;
        animation: ${NS}-toast-kf 4.5s ease-out 1;
        pointer-events: none;
    }
    @keyframes ${NS}-toast-kf {
        0%   { opacity: 0;    transform: translate(-50%, 6px); }
        10%  { opacity: 1;    transform: translate(-50%, 0); }
        85%  { opacity: 1;    transform: translate(-50%, 0); }
        100% { opacity: 0;    transform: translate(-50%, -6px); }
    }
    `;

    function injectStyles() {
        if (document.getElementById(`${NS}-styles`)) return;
        const style = document.createElement('style');
        style.id = `${NS}-styles`;
        style.textContent = css;
        document.head.appendChild(style);
    }

    function findMapContainer() {
        const map = window.mobydbMap;
        if (!map) return null;
        // MapLibre exposes the container DOM node
        return map.getContainer ? map.getContainer() : null;
    }

    function showPulse(container, x, y) {
        const pulse = document.createElement('div');
        pulse.className = `${NS}-pulse`;
        pulse.style.left = `${x}px`;
        pulse.style.top  = `${y}px`;
        container.appendChild(pulse);
        setTimeout(() => pulse.remove(), 8000);
    }

    function showToast(container, msg) {
        const t = document.createElement('div');
        t.className = `${NS}-toast`;
        t.textContent = msg;
        container.appendChild(t);
        setTimeout(() => t.remove(), 5000);
    }

    function flyToLabCell(btn) {
        const map = window.mobydbMap;
        const container = findMapContainer();
        if (!map || !container) {
            console.warn(`${NS}: map not ready`);
            return;
        }
        if (!window.h3 || typeof window.h3.cellToLatLng !== 'function') {
            console.warn(`${NS}: h3-js not loaded`);
            return;
        }
        const [lat, lng] = window.h3.cellToLatLng(LAB_CELL);
        if (typeof lat !== 'number' || typeof lng !== 'number') {
            console.warn(`${NS}: cellToLatLng returned non-numeric`, lat, lng);
            return;
        }

        btn.dataset.active = 'true';
        map.flyTo({
            center: [lng, lat],
            zoom: TARGET_ZOOM,
            duration: 1800,
            essential: true
        });

        // Schedule pulse + toast for after the flyTo settles
        const onceMoveEnd = () => {
            map.off('moveend', onceMoveEnd);
            const point = map.project([lng, lat]);
            showPulse(container, point.x, point.y);
            showToast(container, 'click any substation hexagon to verify · GEIANT Lab cell located');
            setTimeout(() => { btn.dataset.active = 'false'; }, 5000);
        };
        map.on('moveend', onceMoveEnd);
    }

    function buildButton(host) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `${NS}-btn`;
        btn.title = `Pan to ${LAB_LABEL} (${LAB_CELL})`;
        btn.innerHTML = `
            <span class="${NS}-tag">LAB</span>
            <span class="${NS}-label">locate demo cell</span>
        `;
        btn.addEventListener('click', () => flyToLabCell(btn));
        host.appendChild(btn);
    }

    function boot() {
        const container = findMapContainer();
        if (!container) {
            // app.js may not have set up the map yet — retry briefly
            setTimeout(boot, 150);
            return;
        }
        injectStyles();
        buildButton(container);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
