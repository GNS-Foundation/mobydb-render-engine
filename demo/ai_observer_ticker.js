/* =====================================================================
 * ai_observer_ticker.js — autonomous AI ticker for the demo
 * ---------------------------------------------------------------------
 * Polls /v1/ai-observer/recent on startup, then releases observations
 * one at a time with a typewriter effect.  Each observation is signed
 * Ed25519 — clicking the ticker reveals the full attestation timeline.
 *
 * Drop-in. Add to map.html after twin_overlay.js:
 *   <script type="module" src="./ai_observer_ticker.js"></script>
 * ===================================================================== */

(function () {
    'use strict';

    if (typeof window === 'undefined') return;

    // ---------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------
    const TWIN_API = 'https://geiant-mini-twin-api-production.up.railway.app';
    const NS = 'mdb-obs';
    const RELEASE_INTERVAL_MS = 60_000;       // 60s between observations
    const TYPEWRITER_CHARS_PER_SEC = 45;      // typewriter speed
    const REFRESH_POOL_INTERVAL_MS = 10 * 60_000;  // refetch from server every 10 min

    // Pretty labels for observation types
    const TYPE_LABELS = {
        anomaly_detection: { label: 'ANOMALIA',   color: '#ef4444' },
        aggregate_trend:   { label: 'TREND RETE', color: '#0099cc' },
        comparative:       { label: 'CONFRONTO',  color: '#ffab00' },
        prevision:         { label: 'PREVISIONE', color: '#00c853' },
        unknown:           { label: 'OSSERV.',    color: '#94a3b8' },
    };

    // ---------------------------------------------------------------
    // Style injection
    // ---------------------------------------------------------------
    const css = `
    :root {
        --${NS}-bg:        rgba(14, 18, 24, 0.92);
        --${NS}-border:    rgba(148, 163, 184, 0.14);
        --${NS}-text:      rgb(226, 232, 240);
        --${NS}-muted:     rgb(148, 163, 184);
        --${NS}-cyan:      #0099cc;
    }

    /* Ticker container — top center, below the header */
    .${NS}-ticker {
        position: fixed !important;
        top: 76px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 40;
        width: min(720px, calc(100vw - 320px));
        background: var(--${NS}-bg);
        border: 1px solid var(--${NS}-border);
        border-radius: 4px;
        backdrop-filter: blur(8px);
        padding: 0;
        cursor: pointer;
        font: 300 13px/1.4 "DM Sans", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
        color: var(--${NS}-text);
        overflow: hidden;
        transition: border-color 0.18s ease, box-shadow 0.18s ease;
    }
    .${NS}-ticker:hover {
        border-color: var(--${NS}-cyan);
        box-shadow: 0 0 0 1px rgba(0,153,204,0.20);
    }
    .${NS}-ticker[data-fresh="true"] {
        border-color: var(--${NS}-cyan);
        box-shadow: 0 0 12px rgba(0,153,204,0.32);
    }

    .${NS}-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px 10px 12px;
        min-height: 44px;
    }

    .${NS}-tag {
        flex: none;
        font: 600 9px/1 "Space Mono", "JetBrains Mono", ui-monospace, monospace;
        letter-spacing: 0.08em;
        color: var(--tag-color, var(--${NS}-muted));
        border: 1px solid currentColor;
        padding: 4px 7px;
        border-radius: 2px;
        white-space: nowrap;
    }

    .${NS}-text {
        flex: 1 1 auto;
        font-size: 13px;
        color: var(--${NS}-text);
        line-height: 1.45;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
    }

    /* Right-side meta (timestamp + sig icon) */
    .${NS}-meta {
        flex: none;
        display: flex;
        align-items: center;
        gap: 8px;
        font: 400 10px/1 "Space Mono", monospace;
        color: var(--${NS}-muted);
    }
    .${NS}-meta .sig-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #00c853;
        box-shadow: 0 0 6px rgba(0,200,83,0.6);
    }

    /* Bottom progress bar (countdown to next release) */
    .${NS}-progress {
        height: 2px;
        background: rgba(0, 153, 204, 0.18);
        position: relative;
        overflow: hidden;
    }
    .${NS}-progress-fill {
        position: absolute;
        top: 0;
        left: 0;
        height: 100%;
        background: var(--${NS}-cyan);
        width: 0%;
        transition: width 0.5s linear;
    }

    /* Typewriter cursor */
    .${NS}-cursor {
        display: inline-block;
        width: 6px;
        height: 1em;
        background: var(--${NS}-cyan);
        margin-left: 2px;
        vertical-align: text-bottom;
        animation: ${NS}-blink 0.8s steps(1) infinite;
    }
    @keyframes ${NS}-blink {
        0%, 49%   { opacity: 1; }
        50%, 100% { opacity: 0; }
    }

    /* Modal (timeline of recent observations) ------------------- */
    .${NS}-modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 100;
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 80px 24px 24px 24px;
        overflow-y: auto;
    }
    .${NS}-modal {
        background: var(--${NS}-bg);
        border: 1px solid var(--${NS}-border);
        border-radius: 6px;
        max-width: 720px;
        width: 100%;
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

    .${NS}-timeline {
        display: flex;
        flex-direction: column;
        gap: 14px;
    }
    .${NS}-entry {
        padding: 12px 14px;
        background: rgba(148, 163, 184, 0.04);
        border-left: 2px solid currentColor;
        border-radius: 0 3px 3px 0;
        color: var(--entry-color, var(--${NS}-muted));
    }
    .${NS}-entry-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 6px;
    }
    .${NS}-entry-tag {
        font: 600 9px/1 "Space Mono", monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
    }
    .${NS}-entry-time {
        font: 400 10px/1 "Space Mono", monospace;
        color: var(--${NS}-muted);
    }
    .${NS}-entry-text {
        color: var(--${NS}-text);
        line-height: 1.5;
        margin: 4px 0 8px;
    }
    .${NS}-entry-attest {
        font: 400 10px/1.5 "Space Mono", monospace;
        color: var(--${NS}-muted);
    }
    .${NS}-entry-attest code {
        color: var(--${NS}-cyan);
        word-break: break-all;
    }
    .${NS}-entry-attest .ok {
        color: #00c853;
        font-weight: 600;
    }
    .${NS}-entry-attest .chain-arrow {
        color: var(--${NS}-muted);
        margin: 0 4px;
    }

    .${NS}-disclaimer-row {
        margin-top: 18px;
        padding: 10px 12px;
        background: rgba(148, 163, 184, 0.04);
        border-radius: 3px;
        font: 400 10px/1.5 "Space Mono", monospace;
        color: var(--${NS}-muted);
    }

    /* Hide ticker on narrow viewports — falls back to map only */
    @media (max-width: 900px) {
        .${NS}-ticker { display: none; }
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
    async function fetchRecent(limit = 20) {
        const r = await fetch(`${TWIN_API}/v1/ai-observer/recent?limit=${limit}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
    }

    // ---------------------------------------------------------------
    // State
    // ---------------------------------------------------------------
    const state = {
        pool: [],          // observations from server (newest first)
        cursor: 0,         // index into pool for next release
        currentObs: null,  // observation being displayed
        history: [],       // observations already shown (most recent first)
        ticker: null,      // root DOM node
        textNode: null,    // text container
        progressFill: null,
        typewriterTimer: null,
        releaseTimer: null,
        progressTimer: null,
        refreshTimer: null,
    };

    // ---------------------------------------------------------------
    // Typewriter effect
    // ---------------------------------------------------------------
    function clearTypewriter() {
        if (state.typewriterTimer) {
            clearInterval(state.typewriterTimer);
            state.typewriterTimer = null;
        }
        const cur = state.textNode && state.textNode.querySelector(`.${NS}-cursor`);
        if (cur) cur.remove();
    }

    function typewriteInto(el, fullText) {
        clearTypewriter();
        el.textContent = '';
        const cursor = document.createElement('span');
        cursor.className = `${NS}-cursor`;
        el.appendChild(cursor);

        let i = 0;
        const stepMs = 1000 / TYPEWRITER_CHARS_PER_SEC;
        state.typewriterTimer = setInterval(() => {
            if (i >= fullText.length) {
                clearInterval(state.typewriterTimer);
                state.typewriterTimer = null;
                // Remove cursor 1.5s after finish
                setTimeout(() => {
                    const c = el.querySelector(`.${NS}-cursor`);
                    if (c) c.remove();
                }, 1500);
                return;
            }
            // Insert next char before cursor
            const ch = document.createTextNode(fullText.charAt(i));
            el.insertBefore(ch, cursor);
            i++;
        }, stepMs);
    }

    // ---------------------------------------------------------------
    // Render — single observation in ticker
    // ---------------------------------------------------------------
    function fmtTime(iso) {
        try {
            const d = new Date(iso);
            return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
        } catch { return '—'; }
    }

    function renderObservation(obs) {
        if (!state.ticker) return;
        const tag = TYPE_LABELS[obs.observation_type] || TYPE_LABELS.unknown;
        const tagEl = state.ticker.querySelector(`.${NS}-tag`);
        const timeEl = state.ticker.querySelector(`.${NS}-time`);

        tagEl.textContent = tag.label;
        tagEl.style.setProperty('--tag-color', tag.color);
        timeEl.textContent = fmtTime(obs.timestamp);

        // Pulse the border for 4s
        state.ticker.dataset.fresh = 'true';
        setTimeout(() => {
            if (state.ticker) state.ticker.dataset.fresh = 'false';
        }, 4000);

        // Typewriter into the text node
        typewriteInto(state.textNode, obs.text);

        state.currentObs = obs;
        // Add to history (max 20)
        state.history.unshift(obs);
        if (state.history.length > 20) state.history.length = 20;
    }

    // ---------------------------------------------------------------
    // Release scheduler
    // ---------------------------------------------------------------
    function pickNext() {
        if (!state.pool.length) return null;
        const obs = state.pool[state.cursor % state.pool.length];
        state.cursor++;
        return obs;
    }

    function startProgress() {
        if (state.progressTimer) clearInterval(state.progressTimer);
        if (!state.progressFill) return;
        const start = Date.now();
        state.progressFill.style.transition = 'none';
        state.progressFill.style.width = '0%';
        // Force reflow
        // eslint-disable-next-line no-unused-expressions
        state.progressFill.offsetWidth;
        state.progressFill.style.transition = `width ${RELEASE_INTERVAL_MS}ms linear`;
        state.progressFill.style.width = '100%';
    }

    function scheduleNextRelease() {
        if (state.releaseTimer) clearTimeout(state.releaseTimer);
        startProgress();
        state.releaseTimer = setTimeout(releaseOne, RELEASE_INTERVAL_MS);
    }

    function releaseOne() {
        const obs = pickNext();
        if (obs) renderObservation(obs);
        scheduleNextRelease();
    }

    // ---------------------------------------------------------------
    // Pool refresh
    // ---------------------------------------------------------------
    async function refreshPool() {
        try {
            const data = await fetchRecent(20);
            const fresh = (data && data.observations) || [];
            // Server returns newest first; we want to release oldest first so
            // the natural reading order is "most recent observation appears last"
            // — but for ticker theatrics, releasing newest first feels more
            // "live". We pick newest-first.
            state.pool = fresh;
            console.log(`${NS}: pool refreshed — ${fresh.length} observations`);
            return fresh.length;
        } catch (e) {
            console.warn(`${NS}: refreshPool failed`, e);
            return 0;
        }
    }

    // ---------------------------------------------------------------
    // Modal — timeline of recent observations
    // ---------------------------------------------------------------
    function openTimelineModal() {
        document.querySelectorAll(`.${NS}-modal-backdrop`).forEach(n => n.remove());

        const backdrop = document.createElement('div');
        backdrop.className = `${NS}-modal-backdrop`;

        const entries = state.history.length
            ? state.history.slice(0, 5)
            : state.pool.slice(0, 5);

        const entriesHTML = entries.map(o => {
            const tag = TYPE_LABELS[o.observation_type] || TYPE_LABELS.unknown;
            const hash = (o.record_hash || '').replace(/^blake3:/, '').slice(0, 24);
            const sig = (o.signature || '').replace(/^ed25519:/, '').slice(0, 24);
            const pub = (o.pubkey || '').slice(0, 16);
            const chain = (o.chain || []).join(
                ` <span class="chain-arrow">→</span> `
            );
            return `
                <div class="${NS}-entry" style="--entry-color: ${tag.color}">
                    <div class="${NS}-entry-head">
                        <span class="${NS}-entry-tag" style="color:${tag.color}">${tag.label}</span>
                        <span class="${NS}-entry-time">${fmtTime(o.timestamp)} · ${o.tokens_in}↓ ${o.tokens_out}↑ tokens</span>
                    </div>
                    <div class="${NS}-entry-text">${escapeHTML(o.text)}</div>
                    <div class="${NS}-entry-attest">
                        <div><span class="ok">✓ Firmata Ed25519</span> · model <code>${o.model}</code></div>
                        <div>pubkey     <code>${pub}…</code></div>
                        <div>hash       <code>${hash}…</code></div>
                        <div>signature  <code>${sig}…</code></div>
                        <div>chain      ${chain}</div>
                    </div>
                </div>
            `;
        }).join('');

        backdrop.innerHTML = `
            <div class="${NS}-modal" role="dialog" aria-modal="true">
                <div class="${NS}-modal-head">
                    <div>
                        <h3>AI Observer · timeline</h3>
                        <div class="meta">ultime ${entries.length} osservazioni · ogni record firmato Ed25519 · gpt-4o · azure Sweden</div>
                    </div>
                    <button class="${NS}-close" aria-label="close">×</button>
                </div>
                <div class="${NS}-timeline">${entriesHTML}</div>
                <div class="${NS}-disclaimer-row">
                    Osservazioni auto-generate da gpt-4o · azure Sweden Central · pre-sidecar deployment · pattern derivati da dati pubblici Terna zona Centro
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        const close = () => backdrop.remove();
        backdrop.querySelector(`.${NS}-close`).addEventListener('click', close);
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) close();
        });
        document.addEventListener('keydown', function onKey(e) {
            if (e.key === 'Escape') {
                close();
                document.removeEventListener('keydown', onKey);
            }
        });
    }

    function escapeHTML(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ---------------------------------------------------------------
    // Ticker DOM
    // ---------------------------------------------------------------
    function injectTicker() {
        if (document.querySelector(`.${NS}-ticker`)) return;
        const t = document.createElement('div');
        t.className = `${NS}-ticker`;
        t.dataset.fresh = 'false';
        t.innerHTML = `
            <div class="${NS}-row">
                <span class="${NS}-tag">OSSERV.</span>
                <div class="${NS}-text">In attesa della prima osservazione…</div>
                <div class="${NS}-meta">
                    <span class="${NS}-time">—</span>
                    <span class="sig-dot" title="Ed25519 signed"></span>
                </div>
            </div>
            <div class="${NS}-progress"><div class="${NS}-progress-fill"></div></div>
        `;
        t.addEventListener('click', openTimelineModal);
        document.body.appendChild(t);

        state.ticker = t;
        state.textNode = t.querySelector(`.${NS}-text`);
        state.progressFill = t.querySelector(`.${NS}-progress-fill`);
    }

    // ---------------------------------------------------------------
    // Boot
    // ---------------------------------------------------------------
    async function boot() {
        injectStyles();
        injectTicker();

        const n = await refreshPool();
        if (n === 0) {
            state.textNode.textContent =
                'AI Observer in attesa di osservazioni dal backend…';
            // Retry every 30s if no data yet
            setTimeout(boot, 30_000);
            return;
        }

        // Release first one immediately
        releaseOne();

        // Periodic pool refresh (every 10 min)
        if (state.refreshTimer) clearInterval(state.refreshTimer);
        state.refreshTimer = setInterval(refreshPool, REFRESH_POOL_INTERVAL_MS);

        // Expose minimal API for debugging / manual control
        window.mobydbObserver = {
            api: TWIN_API,
            pool: () => state.pool,
            history: () => state.history,
            release: releaseOne,
            refresh: refreshPool,
        };

        console.log(`${NS}: ready · ${n} observations in pool · interval ${RELEASE_INTERVAL_MS}ms`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
