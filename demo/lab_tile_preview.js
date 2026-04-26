/* =====================================================================
 * lab_tile_preview.js — Sentinel-2 tile preview with H3 cell overlay
 * ---------------------------------------------------------------------
 * Adds a "view satellite tile" link to the GEIANT Lab attestation block.
 * On click, opens a modal that:
 *   1. Fetches the STAC item from Element84 Earth Search (public, anon)
 *   2. Loads the public Sentinel-2 RGB thumbnail JPEG from sentinel-cogs
 *   3. Projects the H3 cell boundary onto the thumbnail using the tile's
 *      geometry polygon corners as ground-control points (bilinear)
 *   4. Draws the cell as a cyan outline on top of the satellite image
 *
 * The story this tells: "Here is the satellite frame the AI ran on, and
 * here is the exact H3 cell within it that the lab record attests to.
 * The cryptographic chain binds these together."
 *
 * Drop-in. Listens to a custom 'lab-attestation-rendered' event that
 * lab_overlay.js emits. No app.js / lab_overlay.js modifications needed
 * beyond the small event emit (added in the same commit).
 *
 * Load order in map.html:
 *   <script src="./lab_verify.js"></script>
 *   <script type="module" src="./app.js"></script>
 *   <script type="module" src="./compliance_overlay.js"></script>
 *   <script type="module" src="./liveness_indicators.js"></script>
 *   <script type="module" src="./lab_overlay.js"></script>
 *   <script type="module" src="./lab_demo_button.js"></script>
 *   <script type="module" src="./lab_tile_preview.js"></script>   ← new
 * ===================================================================== */

(function () {
    'use strict';

    if (typeof window === 'undefined') return;

    const NS = 'mdb-lab-tile';
    const STAC_BASE = 'https://earth-search.aws.element84.com/v1';
    const COLLECTION = 'sentinel-2-l2a';

    // ---------------------------------------------------------------
    // CSS — modal + button styles, namespaced
    // ---------------------------------------------------------------
    const css = `
    :root {
        --${NS}-bg:        rgba(14, 18, 24, 0.96);
        --${NS}-overlay:   rgba(0, 0, 0, 0.72);
        --${NS}-border:    rgba(148, 163, 184, 0.22);
        --${NS}-text:      rgb(226, 232, 240);
        --${NS}-muted:     rgb(148, 163, 184);
        --${NS}-cyan:      #0099cc;
        --${NS}-amber:     #ffab00;
    }

    /* Inline link inside the lab block */
    .${NS}-trigger {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-top: 10px;
        padding: 6px 10px;
        background: transparent;
        border: 1px solid var(--${NS}-border);
        color: var(--${NS}-text);
        font: 300 11px/1 "DM Sans", system-ui, sans-serif;
        letter-spacing: 0.05em;
        cursor: pointer;
        transition: border-color .18s ease, color .18s ease;
        user-select: none;
    }
    .${NS}-trigger:hover {
        border-color: var(--${NS}-cyan);
        color: var(--${NS}-cyan);
    }
    .${NS}-trigger .${NS}-tag {
        font: 600 9px/1 "Space Mono", "JetBrains Mono", ui-monospace, monospace;
        letter-spacing: 0.08em;
        padding: 3px 5px;
        border: 1px solid var(--${NS}-border);
        color: var(--${NS}-cyan);
        border-radius: 2px;
    }

    /* Modal scaffold */
    .${NS}-modal {
        position: fixed;
        inset: 0;
        z-index: 10000;
        background: var(--${NS}-overlay);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: "DM Sans", system-ui, sans-serif;
        animation: ${NS}-fade .18s ease-out;
    }
    @keyframes ${NS}-fade {
        from { opacity: 0; }
        to   { opacity: 1; }
    }
    .${NS}-card {
        width: min(90vw, 720px);
        max-height: 90vh;
        background: var(--${NS}-bg);
        border: 1px solid var(--${NS}-border);
        color: var(--${NS}-text);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .${NS}-card header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px;
        border-bottom: 1px solid var(--${NS}-border);
    }
    .${NS}-card header h4 {
        margin: 0;
        font: 400 12px/1 "DM Sans", system-ui, sans-serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--${NS}-muted);
    }
    .${NS}-close {
        background: transparent;
        border: 1px solid var(--${NS}-border);
        color: var(--${NS}-muted);
        font: 11px/1 "Space Mono", ui-monospace, monospace;
        padding: 4px 9px;
        cursor: pointer;
        letter-spacing: 0.06em;
        transition: border-color .15s ease, color .15s ease;
    }
    .${NS}-close:hover {
        color: var(--${NS}-text);
        border-color: var(--${NS}-text);
    }

    .${NS}-canvas-wrap {
        position: relative;
        background: #000;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 280px;
    }
    .${NS}-canvas-wrap canvas {
        display: block;
        max-width: 100%;
        height: auto;
    }
    .${NS}-status {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 8px;
        color: var(--${NS}-muted);
        font: 300 12px/1.4 "DM Sans", system-ui, sans-serif;
        letter-spacing: 0.04em;
        pointer-events: none;
    }
    .${NS}-status .${NS}-spin {
        width: 22px; height: 22px;
        border: 2px solid var(--${NS}-border);
        border-top-color: var(--${NS}-cyan);
        border-radius: 50%;
        animation: ${NS}-spin 0.9s linear infinite;
    }
    @keyframes ${NS}-spin { to { transform: rotate(360deg); } }
    .${NS}-status[data-state="error"] {
        color: #ef4444;
    }

    .${NS}-meta {
        padding: 14px 18px;
        font: 11px/1.5 "DM Sans", system-ui, sans-serif;
        color: var(--${NS}-text);
    }
    .${NS}-meta .${NS}-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 3px 0;
    }
    .${NS}-meta .${NS}-k { color: var(--${NS}-muted); letter-spacing: 0.03em; }
    .${NS}-meta .${NS}-v { font-family: "Space Mono", ui-monospace, monospace; font-size: 10.5px; word-break: break-all; }
    .${NS}-meta .${NS}-v.normal { font-family: "DM Sans", system-ui, sans-serif; font-size: 11px; }

    .${NS}-foot {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px dashed var(--${NS}-border);
        color: var(--${NS}-muted);
        font-size: 10px;
        letter-spacing: 0.02em;
        line-height: 1.5;
    }
    .${NS}-foot a {
        color: var(--${NS}-cyan);
        text-decoration: none;
    }
    .${NS}-foot a:hover { text-decoration: underline; }

    .${NS}-legend {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-right: 14px;
    }
    .${NS}-legend::before {
        content: '';
        display: inline-block;
        width: 16px; height: 2px;
        background: var(--${NS}-cyan);
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
    // STAC item cache — STAC items are immutable; cache by id
    // ---------------------------------------------------------------
    const itemCache = new Map();
    async function fetchStacItem(stacId, signal) {
        if (itemCache.has(stacId)) return itemCache.get(stacId);
        const url = `${STAC_BASE}/collections/${COLLECTION}/items/${encodeURIComponent(stacId)}`;
        const r = await fetch(url, { signal });
        if (!r.ok) throw new Error(`STAC fetch HTTP ${r.status}`);
        const item = await r.json();
        itemCache.set(stacId, item);
        return item;
    }

    // ---------------------------------------------------------------
    // Project (lat, lng) onto image coordinates using the tile
    // polygon corners.
    //
    // Sentinel-2 tile polygons in STAC have 5 vertices (closed ring).
    // The 4 unique corners correspond, after MGRS gridding, to the 4
    // image corners. The polygon is given in scene-CCW order starting
    // from the NW corner. Image coordinates are TL-origin pixel space.
    //
    // We use bilinear interpolation: invert-mapping (lng, lat) into
    // (u, v) ∈ [0, 1]² of the polygon, then scale to image (W, H).
    //
    // Bilinear inversion is a 2×2 nonlinear system; we solve via
    // Newton-Raphson with the linear midpoint as the initial guess.
    // 6–10 iterations converges to sub-pixel for our purposes.
    // ---------------------------------------------------------------
    function bilinearForward(u, v, c) {
        // c[0]=NW, c[1]=SW, c[2]=SE, c[3]=NE  — each [lng, lat]
        // u: 0=west edge, 1=east edge
        // v: 0=north edge, 1=south edge
        const w = [(1 - u) * (1 - v), (1 - u) * v, u * v, u * (1 - v)];
        const lng = w[0] * c[0][0] + w[1] * c[1][0] + w[2] * c[2][0] + w[3] * c[3][0];
        const lat = w[0] * c[0][1] + w[1] * c[1][1] + w[2] * c[2][1] + w[3] * c[3][1];
        return [lng, lat];
    }

    function projectToUV(lng, lat, corners) {
        // Newton-Raphson invert of bilinearForward
        let u = 0.5, v = 0.5;
        const eps = 1e-9;
        for (let iter = 0; iter < 30; iter++) {
            const [fLng, fLat] = bilinearForward(u, v, corners);
            const errLng = fLng - lng;
            const errLat = fLat - lat;
            if (Math.abs(errLng) < eps && Math.abs(errLat) < eps) break;

            // Numerical Jacobian
            const h = 1e-5;
            const [fLngU, fLatU] = bilinearForward(u + h, v, corners);
            const [fLngV, fLatV] = bilinearForward(u, v + h, corners);
            const dLngdU = (fLngU - fLng) / h;
            const dLatdU = (fLatU - fLat) / h;
            const dLngdV = (fLngV - fLng) / h;
            const dLatdV = (fLatV - fLat) / h;

            const det = dLngdU * dLatdV - dLngdV * dLatdU;
            if (Math.abs(det) < 1e-15) break;

            const du = (dLatdV * errLng - dLngdV * errLat) / det;
            const dv = (-dLatdU * errLng + dLngdU * errLat) / det;
            u -= du;
            v -= dv;
        }
        return [u, v];
    }

    // Extract the 4 unique scene corners from the STAC polygon.
    // STAC polygon convention: first ring, closed (last == first), 5 vertices.
    // Order is geographic (NW, SW, SE, NE) per S2 tile metadata.
    function sceneCornersFromPolygon(stacItem) {
        const ring = stacItem.geometry.coordinates[0];
        // Drop the closing repeat
        return ring.slice(0, 4);
    }

    // ---------------------------------------------------------------
    // Modal — built once per click
    // ---------------------------------------------------------------
    let openModal = null;

    function closeModal() {
        if (!openModal) return;
        openModal.abort.abort();
        openModal.el.remove();
        document.removeEventListener('keydown', onKey);
        openModal = null;
    }

    function onKey(e) {
        if (e.key === 'Escape') closeModal();
    }

    function buildModal(record) {
        if (openModal) closeModal();

        const stacId = record?.input?.stac_item_id;
        const cell = record?.h3_cell;
        const cloud = record?.input?.cloud_cover_percent;
        const acquired = record?.input?.acquisition_timestamp;

        const root = document.createElement('div');
        root.className = `${NS}-modal`;
        root.innerHTML = `
            <div class="${NS}-card" role="dialog" aria-modal="true" aria-label="Sentinel-2 tile preview">
                <header>
                    <h4>Sentinel-2 tile · ${escapeHtml(stacId || '—')}</h4>
                    <button type="button" class="${NS}-close" aria-label="Close">CLOSE</button>
                </header>
                <div class="${NS}-canvas-wrap">
                    <canvas></canvas>
                    <div class="${NS}-status" data-state="loading">
                        <div class="${NS}-spin"></div>
                        <span>fetching STAC metadata…</span>
                    </div>
                </div>
                <div class="${NS}-meta">
                    <div class="${NS}-row"><span class="${NS}-k">cell</span><span class="${NS}-v">${escapeHtml(cell || '—')}</span></div>
                    <div class="${NS}-row"><span class="${NS}-k">acquisition</span><span class="${NS}-v normal">${escapeHtml(acquired || '—')}</span></div>
                    <div class="${NS}-row"><span class="${NS}-k">cloud cover</span><span class="${NS}-v normal">${typeof cloud === 'number' ? cloud.toFixed(2) + '%' : '—'}</span></div>
                    <div class="${NS}-foot">
                        <span class="${NS}-legend">cell footprint</span>
                        Imagery via Element84 Earth Search (Sentinel-2 L2A, public).
                        <a href="${STAC_BASE}/collections/${COLLECTION}/items/${encodeURIComponent(stacId || '')}" target="_blank" rel="noopener">view STAC item ↗</a>
                    </div>
                </div>
            </div>
        `;

        // Close interactions
        root.querySelector(`.${NS}-close`).addEventListener('click', closeModal);
        root.addEventListener('click', (ev) => { if (ev.target === root) closeModal(); });
        document.addEventListener('keydown', onKey);

        document.body.appendChild(root);

        const canvas = root.querySelector('canvas');
        const status = root.querySelector(`.${NS}-status`);
        const abort = new AbortController();

        openModal = { el: root, abort };

        // Async load pipeline
        (async () => {
            try {
                if (!stacId) throw new Error('no stac_item_id on record');
                if (!cell) throw new Error('no h3_cell on record');

                // Step 1 — fetch STAC item
                status.querySelector('span').textContent = 'fetching STAC metadata…';
                const item = await fetchStacItem(stacId, abort.signal);
                const thumbHref = item.assets?.thumbnail?.href;
                if (!thumbHref) throw new Error('no thumbnail asset on item');
                const corners = sceneCornersFromPolygon(item);

                // Step 2 — load thumbnail (CORS-enabled S3 bucket)
                status.querySelector('span').textContent = 'loading thumbnail…';
                const img = await loadImage(thumbHref, abort.signal);

                // Step 3 — draw + overlay cell
                status.querySelector('span').textContent = 'drawing cell footprint…';
                drawTileWithCell(canvas, img, corners, cell);

                // Done
                status.style.display = 'none';
            } catch (e) {
                if (e.name === 'AbortError') return;
                status.dataset.state = 'error';
                status.innerHTML = `<span style="color:#ef4444;">failed: ${escapeHtml(e.message)}</span>`;
            }
        })();
    }

    function loadImage(url, signal) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('thumbnail load failed (CORS?)'));
            // Honour aborts
            const onAbort = () => { img.src = ''; reject(new Error('aborted')); };
            if (signal) {
                if (signal.aborted) return onAbort();
                signal.addEventListener('abort', onAbort, { once: true });
            }
            img.src = url;
        });
    }

    function drawTileWithCell(canvas, img, corners, cell) {
        // Cap canvas size at 600px wide to avoid blurring small thumbnails
        const maxW = 600;
        const scale = Math.min(1, maxW / img.naturalWidth);
        const W = Math.round(img.naturalWidth * scale);
        const H = Math.round(img.naturalHeight * scale);

        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, W, H);

        if (!window.h3 || typeof window.h3.cellToBoundary !== 'function') {
            // No h3 available — bail with just the image
            console.warn(`${NS}: window.h3 unavailable; cell overlay skipped`);
            return;
        }

        const boundary = window.h3.cellToBoundary(cell); // [[lat, lng], ...]
        const points = boundary.map(([lat, lng]) => {
            const [u, v] = projectToUV(lng, lat, corners);
            return [u * W, v * H];
        });

        // Outline
        ctx.beginPath();
        points.forEach(([x, y], i) => {
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();

        // Glow halo for visibility against any background
        ctx.shadowColor = 'rgba(0, 153, 204, 0.9)';
        ctx.shadowBlur = 6;
        ctx.strokeStyle = '#0099cc';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Reset shadow before fill
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(0, 153, 204, 0.18)';
        ctx.fill();

        // Vertex dots
        ctx.fillStyle = '#0099cc';
        points.forEach(([x, y]) => {
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ---------------------------------------------------------------
    // Trigger button injection
    //
    // Listens to the custom 'lab-attestation-rendered' event that
    // lab_overlay.js dispatches AFTER it inserts a verdict block. The
    // event's detail carries the record object so we have everything
    // we need without re-querying.
    // ---------------------------------------------------------------
    function injectTrigger(section, record) {
        if (!record || !record.input || !record.input.stac_item_id) return;
        if (section.querySelector(`.${NS}-trigger`)) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `${NS}-trigger`;
        btn.innerHTML = `
            <span class="${NS}-tag">S2</span>
            <span>view satellite tile</span>
        `;
        btn.addEventListener('click', () => buildModal(record));

        // Place above the "delegation chain" details if present, else at end
        const chainDetails = section.querySelector('details');
        if (chainDetails && chainDetails.parentNode) {
            chainDetails.parentNode.insertBefore(btn, chainDetails);
        } else {
            const body = section.querySelector('.mdb-lab-body') || section;
            body.appendChild(btn);
        }
    }

    function boot() {
        injectStyles();

        const bus = window.mobydbBus;
        if (!bus) {
            // app.js not ready yet
            setTimeout(boot, 100);
            return;
        }

        // Primary path: lab_overlay emits after rendering verdict
        bus.addEventListener('lab-attestation-rendered', (ev) => {
            const section = ev?.detail?.section;
            const record = ev?.detail?.record;
            if (section && record) injectTrigger(section, record);
        });

        // Fallback path: in case lab_overlay was bundled before this module's
        // event hook existed, observe DOM for newly-attached lab sections.
        // Looks for sections lacking our trigger and tries to recover the
        // record from a data attribute lab_overlay sets.
        const observer = new MutationObserver(() => {
            document.querySelectorAll('.mdb-lab-audit-section').forEach((section) => {
                if (section.querySelector(`.${NS}-trigger`)) return;
                const recordJson = section.dataset.labRecord;
                if (!recordJson) return;
                try {
                    const record = JSON.parse(recordJson);
                    injectTrigger(section, record);
                } catch (e) {
                    // ignore
                }
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
