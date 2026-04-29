/* =====================================================================
 * compliance_button.js — Compliance Audit Bundle generator UI
 * ---------------------------------------------------------------------
 * Adds a button (top-right, under TWIN TELEMETRY) that opens a modal
 * dashboard preview with live bundle stats. From the modal, the user
 * can download the signed PDF bundle.
 *
 * Backend:
 *   GET /v1/compliance/bundle.json  -> populates the dashboard
 *   GET /v1/compliance/bundle.pdf   -> downloads the signed PDF
 *
 * Drop-in. Add to map.html after ai_observer_ticker.js:
 *   <script type="module" src="./compliance_button.js"></script>
 * ===================================================================== */

(function () {
    'use strict';

    if (typeof window === 'undefined') return;

    const TWIN_API = 'https://geiant-mini-twin-api-production.up.railway.app';
    const NS = 'mdb-comp';

    // EU AI Act articles to surface in the dashboard preview.
    // Mirrors the PDF mapping but trimmed for screen.
    const AIACT_MAP = [
        { article: 'Art. 12',  topic: 'Record-keeping',          evidence: '40,320 signed records' },
        { article: 'Art. 13',  topic: 'Trasparenza utenti',      evidence: 'Disclaimer in ogni record' },
        { article: 'Art. 14',  topic: 'Sorveglianza umana',      evidence: 'AI Inspector q&a flow' },
        { article: 'Art. 25',  topic: 'Obblighi fornitore',      evidence: 'ULISSY s.r.l. chain doc' },
        { article: 'Art. 26§6', topic: 'Conservazione log',      evidence: 'Postgres con timestamp UTC' },
        { article: 'Art. 50',  topic: 'Trasparenza output AI',   evidence: 'Per-inference signature' },
        { article: 'Art. 72',  topic: 'Post-market monitoring',  evidence: 'Observer/recent endpoint' },
    ];

    // ---------------------------------------------------------------
    // CSS
    // ---------------------------------------------------------------
    const css = `
    :root {
        --${NS}-bg:        rgba(14, 18, 24, 0.95);
        --${NS}-border:    rgba(148, 163, 184, 0.14);
        --${NS}-text:      rgb(226, 232, 240);
        --${NS}-muted:     rgb(148, 163, 184);
        --${NS}-cyan:      #0099cc;
        --${NS}-cyan-bg:   rgba(0, 153, 204, 0.12);
        --${NS}-ok:        #00c853;
    }

    /* Toggle button — same row as twin telemetry, below it */
    .${NS}-toggle {
        position: fixed !important;
        top: 220px;
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
    .${NS}-toggle .icon {
        font-family: ui-monospace, monospace;
        font-weight: 700;
        font-size: 10px;
        color: var(--${NS}-muted);
    }
    .${NS}-toggle:hover .icon { color: var(--${NS}-cyan); }

    /* Modal */
    .${NS}-backdrop {
        position: fixed;
        inset: 0;
        z-index: 200;
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(6px);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 60px 24px 24px;
        overflow-y: auto;
    }
    .${NS}-modal {
        background: var(--${NS}-bg);
        border: 1px solid var(--${NS}-border);
        border-radius: 6px;
        max-width: 720px;
        width: 100%;
        padding: 24px 28px;
        font: 300 13px/1.5 "DM Sans", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
        color: var(--${NS}-text);
    }
    .${NS}-modal-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
    }
    .${NS}-modal-head h2 {
        margin: 0;
        font: 400 18px/1.3 "DM Sans", system-ui, sans-serif;
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
        font-size: 22px;
        cursor: pointer;
        padding: 0;
        width: 28px;
        height: 28px;
    }
    .${NS}-close:hover { color: var(--${NS}-text); }

    /* Loading state */
    .${NS}-loading {
        padding: 40px 0;
        text-align: center;
        color: var(--${NS}-cyan);
        font: 400 12px/1 "Space Mono", monospace;
    }
    .${NS}-loading::after {
        content: '';
        display: inline-block;
        width: 8px;
        height: 8px;
        margin-left: 8px;
        border-radius: 50%;
        background: var(--${NS}-cyan);
        animation: ${NS}-pulse 1s ease-in-out infinite;
    }
    @keyframes ${NS}-pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.3; }
    }

    /* Stats grid (4 cards) */
    .${NS}-stats {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 10px;
        margin: 12px 0 18px;
    }
    .${NS}-stat {
        background: rgba(0, 153, 204, 0.06);
        border-left: 2px solid var(--${NS}-cyan);
        padding: 10px 12px;
        border-radius: 0 3px 3px 0;
    }
    .${NS}-stat-value {
        font: 400 22px/1.1 "DM Sans", system-ui, sans-serif;
        color: var(--${NS}-text);
        margin-bottom: 2px;
    }
    .${NS}-stat-label {
        font: 600 9px/1.2 "Space Mono", monospace;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--${NS}-muted);
    }

    /* Section headings */
    .${NS}-section-title {
        font: 600 10px/1 "Space Mono", monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--${NS}-muted);
        margin: 18px 0 8px;
        padding-bottom: 6px;
        border-bottom: 1px solid var(--${NS}-border);
    }

    /* Trust chain rows */
    .${NS}-chain-row {
        display: grid;
        grid-template-columns: 18px 110px 1fr 110px;
        gap: 10px;
        align-items: center;
        padding: 6px 0;
        font-size: 12px;
        border-bottom: 1px solid var(--${NS}-border);
    }
    .${NS}-chain-row:last-child { border-bottom: none; }
    .${NS}-chain-check {
        color: var(--${NS}-ok);
        font-weight: 600;
    }
    .${NS}-chain-label {
        color: var(--${NS}-muted);
        font: 600 10px/1 "Space Mono", monospace;
        letter-spacing: 0.04em;
    }
    .${NS}-chain-pubkey {
        font: 400 11px "Space Mono", monospace;
        color: var(--${NS}-cyan);
        word-break: break-all;
    }
    .${NS}-chain-name {
        font-size: 11px;
        color: var(--${NS}-muted);
        text-align: right;
    }

    /* Compliance map rows */
    .${NS}-aiact-row {
        display: grid;
        grid-template-columns: 18px 70px 160px 1fr;
        gap: 10px;
        align-items: center;
        padding: 5px 0;
        font-size: 11px;
        border-bottom: 1px solid var(--${NS}-border);
    }
    .${NS}-aiact-row:last-child { border-bottom: none; }
    .${NS}-aiact-check { color: var(--${NS}-ok); font-weight: 600; }
    .${NS}-aiact-art {
        color: var(--${NS}-cyan);
        font: 600 11px "Space Mono", monospace;
    }
    .${NS}-aiact-topic { color: var(--${NS}-text); }
    .${NS}-aiact-ev { color: var(--${NS}-muted); font-size: 10px; }

    /* Signature box */
    .${NS}-sig {
        background: rgba(148, 163, 184, 0.04);
        border-left: 2px solid var(--${NS}-cyan);
        padding: 10px 12px;
        border-radius: 0 3px 3px 0;
        margin: 12px 0;
        font: 400 10px/1.6 "Space Mono", monospace;
    }
    .${NS}-sig-row {
        display: grid;
        grid-template-columns: 100px 1fr;
        gap: 8px;
    }
    .${NS}-sig-label {
        color: var(--${NS}-muted);
    }
    .${NS}-sig-value {
        color: var(--${NS}-cyan);
        word-break: break-all;
    }

    /* Download button */
    .${NS}-download {
        display: block;
        width: 100%;
        margin-top: 18px;
        background: var(--${NS}-cyan);
        color: black;
        border: none;
        border-radius: 4px;
        padding: 12px;
        font: 600 12px/1 "DM Sans", system-ui, sans-serif;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        cursor: pointer;
        transition: opacity 0.15s ease;
    }
    .${NS}-download:hover { opacity: 0.85; }
    .${NS}-download:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
    .${NS}-download .arrow { margin-left: 6px; }

    .${NS}-disclaimer {
        margin-top: 12px;
        padding: 8px 10px;
        background: rgba(148, 163, 184, 0.04);
        border-radius: 3px;
        font: 400 10px/1.5 "Space Mono", monospace;
        color: var(--${NS}-muted);
    }

    /* Toast for download confirmation */
    .${NS}-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 300;
        background: var(--${NS}-bg);
        border: 1px solid var(--${NS}-cyan);
        border-radius: 4px;
        padding: 12px 16px;
        font: 400 12px/1.4 "DM Sans", system-ui, sans-serif;
        color: var(--${NS}-text);
        max-width: 380px;
        backdrop-filter: blur(8px);
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
    }
    .${NS}-toast .ok {
        color: var(--${NS}-ok);
        font-weight: 600;
    }
    .${NS}-toast code {
        color: var(--${NS}-cyan);
        font-family: "Space Mono", monospace;
        font-size: 10px;
    }

    /* Hide on narrow viewports */
    @media (max-width: 900px) {
        .${NS}-toggle { display: none; }
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
    // API
    // ---------------------------------------------------------------
    async function fetchBundleJson() {
        const r = await fetch(`${TWIN_API}/v1/compliance/bundle.json`);
        if (!r.ok) throw new Error(`bundle.json HTTP ${r.status}`);
        return r.json();
    }

    async function fetchBundlePdf() {
        const r = await fetch(`${TWIN_API}/v1/compliance/bundle.pdf`);
        if (!r.ok) throw new Error(`bundle.pdf HTTP ${r.status}`);
        const blob = await r.blob();
        const headers = {
            id: r.headers.get('x-bundle-id'),
            hash: r.headers.get('x-bundle-hash'),
            signature: r.headers.get('x-bundle-signature'),
        };
        return { blob, headers };
    }

    // ---------------------------------------------------------------
    // Modal rendering
    // ---------------------------------------------------------------
    function fmtIsoShort(iso) {
        try {
            const d = new Date(iso);
            return d.toLocaleString('it-IT', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
            }) + ' UTC';
        } catch { return iso; }
    }

    function trunc(s, n) {
        if (!s) return '';
        return s.length > n ? s.slice(0, n) + '…' : s;
    }

    function escapeHTML(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function buildDashboardHTML(bundle) {
        const s = bundle.summary || {};
        const c = bundle.chain || {};

        const stats = [
            { value: s.n_cells || 0,        label: 'cells covered' },
            { value: s.n_observations || 0, label: 'AI observations' },
            { value: (s.n_signed_records || 0).toLocaleString('it-IT'), label: 'signed records' },
            { value: (s.total_load_mw || 0).toFixed(0), label: 'MW total load' },
        ];

        const statsHTML = stats.map(st => `
            <div class="${NS}-stat">
                <div class="${NS}-stat-value">${escapeHTML(st.value)}</div>
                <div class="${NS}-stat-label">${escapeHTML(st.label)}</div>
            </div>
        `).join('');

        const chain = [
            { label: 'root',         name: 'GNS Foundation',   pk: c.root_pubkey },
            { label: 'lab-env',      name: 'GEIANT Lab',       pk: c.lab_pubkey },
            { label: 'ai-runtime',   name: 'AI Runtime v1',    pk: c.ai_pubkey },
            { label: 'twin-runtime', name: 'Twin Runtime v1',  pk: c.twin_pubkey },
        ];
        const chainHTML = chain.map(r => `
            <div class="${NS}-chain-row">
                <span class="${NS}-chain-check">${r.pk ? '✓' : '·'}</span>
                <span class="${NS}-chain-label">${escapeHTML(r.label)}</span>
                <span class="${NS}-chain-pubkey">${escapeHTML(trunc(r.pk || 'n/a', 28))}</span>
                <span class="${NS}-chain-name">${escapeHTML(r.name)}</span>
            </div>
        `).join('');

        const aiactHTML = AIACT_MAP.map(a => `
            <div class="${NS}-aiact-row">
                <span class="${NS}-aiact-check">✓</span>
                <span class="${NS}-aiact-art">${escapeHTML(a.article)}</span>
                <span class="${NS}-aiact-topic">${escapeHTML(a.topic)}</span>
                <span class="${NS}-aiact-ev">${escapeHTML(a.evidence)}</span>
            </div>
        `).join('');

        const bundleHash = bundle.bundle_hash || '';
        const bundleSig = bundle.bundle_signature || '';

        return `
            <div class="${NS}-modal-head">
                <div>
                    <h2>Compliance Audit Bundle</h2>
                    <div class="meta">
                        Bundle ID <span style="color: var(--${NS}-cyan)">${escapeHTML(bundle.bundle_id || '—')}</span><br>
                        Generato ${escapeHTML(fmtIsoShort(bundle.generated_at))}
                    </div>
                </div>
                <button class="${NS}-close" aria-label="close">×</button>
            </div>

            <div class="${NS}-stats">${statsHTML}</div>

            <div class="${NS}-section-title">Trust chain</div>
            ${chainHTML}

            <div class="${NS}-section-title">EU AI Act compliance</div>
            ${aiactHTML}

            <div class="${NS}-section-title">Bundle signature</div>
            <div class="${NS}-sig">
                <div class="${NS}-sig-row">
                    <span class="${NS}-sig-label">hash</span>
                    <span class="${NS}-sig-value">${escapeHTML(trunc(bundleHash, 60))}</span>
                </div>
                <div class="${NS}-sig-row">
                    <span class="${NS}-sig-label">signature</span>
                    <span class="${NS}-sig-value">${escapeHTML(trunc(bundleSig, 60))}</span>
                </div>
                <div class="${NS}-sig-row">
                    <span class="${NS}-sig-label">signed_by</span>
                    <span class="${NS}-sig-value">${escapeHTML(trunc(c.ai_pubkey || '', 60))}</span>
                </div>
                <div class="${NS}-sig-row">
                    <span class="${NS}-sig-label">chain</span>
                    <span class="${NS}-sig-value" style="color: var(--${NS}-text)">root → lab-env → ai-runtime-v1</span>
                </div>
            </div>

            <button class="${NS}-download" type="button">
                Scarica PDF firmato Ed25519 <span class="arrow">↓</span>
            </button>

            <div class="${NS}-disclaimer">
                Bundle pre-sidecar deployment · telemetria simulata · pattern derivati da dati pubblici Terna zona Centro.
                Pronto per validazione su sostituzione con SCADA sidecar binary.
            </div>
        `;
    }

    function showToast(bundleId, sig) {
        document.querySelectorAll(`.${NS}-toast`).forEach(n => n.remove());
        const t = document.createElement('div');
        t.className = `${NS}-toast`;
        t.innerHTML = `
            <div><span class="ok">✓ Bundle scaricato</span></div>
            <div style="margin-top: 4px;">
                ID <code>${escapeHTML(trunc(bundleId, 16))}</code><br>
                Signed <code>${escapeHTML(trunc((sig || '').replace(/^ed25519:/, ''), 24))}</code>
            </div>
        `;
        document.body.appendChild(t);
        setTimeout(() => {
            t.style.transition = 'opacity 0.5s';
            t.style.opacity = '0';
            setTimeout(() => t.remove(), 500);
        }, 5000);
    }

    async function openModal() {
        document.querySelectorAll(`.${NS}-backdrop`).forEach(n => n.remove());

        const backdrop = document.createElement('div');
        backdrop.className = `${NS}-backdrop`;
        backdrop.innerHTML = `
            <div class="${NS}-modal" role="dialog" aria-modal="true">
                <div class="${NS}-modal-head">
                    <div>
                        <h2>Compliance Audit Bundle</h2>
                        <div class="meta">Caricamento dei dati…</div>
                    </div>
                </div>
                <div class="${NS}-loading">Generazione bundle in corso</div>
            </div>
        `;
        document.body.appendChild(backdrop);

        // Click-outside to close
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) backdrop.remove();
        });
        const onKey = (e) => {
            if (e.key === 'Escape') {
                backdrop.remove();
                document.removeEventListener('keydown', onKey);
            }
        };
        document.addEventListener('keydown', onKey);

        // Fetch bundle
        let bundle;
        try {
            bundle = await fetchBundleJson();
        } catch (err) {
            const modal = backdrop.querySelector(`.${NS}-modal`);
            modal.innerHTML = `
                <div class="${NS}-modal-head">
                    <div>
                        <h2>Errore</h2>
                        <div class="meta" style="color: #ef4444">${escapeHTML(err.message || String(err))}</div>
                    </div>
                    <button class="${NS}-close" aria-label="close">×</button>
                </div>
            `;
            modal.querySelector(`.${NS}-close`).addEventListener('click', () => backdrop.remove());
            return;
        }

        // Render dashboard
        const modal = backdrop.querySelector(`.${NS}-modal`);
        modal.innerHTML = buildDashboardHTML(bundle);

        modal.querySelector(`.${NS}-close`).addEventListener('click', () => {
            backdrop.remove();
            document.removeEventListener('keydown', onKey);
        });

        // Wire download button
        const dl = modal.querySelector(`.${NS}-download`);
        dl.addEventListener('click', async () => {
            dl.disabled = true;
            const original = dl.innerHTML;
            dl.innerHTML = 'Generazione PDF firmato…';
            try {
                const { blob, headers } = await fetchBundlePdf();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
                a.download = `geiant-compliance-bundle-${ts}.pdf`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                showToast(headers.id, headers.signature);

                dl.innerHTML = '✓ PDF scaricato';
                setTimeout(() => {
                    dl.innerHTML = original;
                    dl.disabled = false;
                }, 2000);
            } catch (err) {
                dl.innerHTML = `Errore: ${err.message || err}`;
                setTimeout(() => {
                    dl.innerHTML = original;
                    dl.disabled = false;
                }, 3000);
            }
        });
    }

    // ---------------------------------------------------------------
    // Toggle button
    // ---------------------------------------------------------------
    function injectButton() {
        if (document.querySelector(`.${NS}-toggle`)) return;
        const btn = document.createElement('button');
        btn.className = `${NS}-toggle`;
        btn.type = 'button';
        btn.innerHTML = `
            <span class="icon">[BUNDLE]</span>
            <span class="label">Compliance Audit</span>
        `;
        btn.addEventListener('click', openModal);
        document.body.appendChild(btn);
    }

    // ---------------------------------------------------------------
    // Boot
    // ---------------------------------------------------------------
    function boot() {
        injectStyles();
        injectButton();

        window.mobydbCompliance = {
            api: TWIN_API,
            open: openModal,
        };

        console.log(`${NS}: ready · backend ${TWIN_API}`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
