/* =====================================================================
 * lab_overlay.js — GEIANT Lab attestation block in the audit panel
 * ---------------------------------------------------------------------
 * Listens to `audit-open` on window.mobydbBus, calls the
 * query_predictions MCP tool, verifies each record with LabVerify, and
 * appends a stacked attestation block under the existing render-engine
 * attestation + EU AI Act compliance sections.
 *
 * Drop-in. No app.js or compliance_overlay.js changes required.
 *
 * Load order in index.html:
 *   <script src="./lab_verify.js"></script>            (UMD, sets window.LabVerify)
 *   <script type="module" src="./app.js"></script>
 *   <script type="module" src="./compliance_overlay.js"></script>
 *   <script type="module" src="./lab_overlay.js"></script>     ← here
 *
 * Depends on globals exposed by app.js:
 *   window.mobydbBus     (EventTarget)
 *   window.mobydbState   ({ currentEpoch, ... })
 *   window.mobydbConfig  ({ apiBase, apiKey })
 *   window.LabVerify     (from lab_verify.js)
 * ===================================================================== */

(function () {
    'use strict';

    if (typeof window === 'undefined') return;
    if (!window.LabVerify) {
        console.warn('lab_overlay: window.LabVerify not found — load lab_verify.js first');
        return;
    }

    const NS = 'mdb-lab';
    const SECTION_CLASS = `${NS}-audit-section`;

    // ---------------------------------------------------------------
    // Style injection — scoped, matches compliance_overlay's tokens
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
    }
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
    .${NS}-tier-pill {
        font: 600 10px/1 "Space Mono", "JetBrains Mono", ui-monospace, monospace;
        letter-spacing: 0.04em;
        padding: 4px 8px;
        border-radius: 3px;
        border: 1px solid currentColor;
    }
    .${NS}-tier-pill[data-tier="OK"]      { color: var(--${NS}-ok); }
    .${NS}-tier-pill[data-tier="WA"]      { color: var(--${NS}-wa); }
    .${NS}-tier-pill[data-tier="VI"]      { color: var(--${NS}-vi); }
    .${NS}-tier-pill[data-tier="EMPTY"]   { color: var(--${NS}-muted); }
    .${NS}-tier-pill[data-tier="LOAD"]    { color: var(--${NS}-cyan); }

    .${NS}-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 3px 0;
        font-size: 11px;
    }
    .${NS}-row .${NS}-k {
        color: var(--${NS}-muted);
        flex: 0 0 auto;
        letter-spacing: 0.03em;
    }
    .${NS}-row .${NS}-v {
        color: var(--${NS}-text);
        text-align: right;
        font-family: "Space Mono", ui-monospace, monospace;
        font-size: 10.5px;
        word-break: break-all;
    }
    .${NS}-row .${NS}-v.normal {
        font-family: "DM Sans", system-ui, sans-serif;
        font-size: 11px;
    }
    .${NS}-row .${NS}-v[data-ok="true"]  { color: var(--${NS}-ok); }
    .${NS}-row .${NS}-v[data-ok="false"] { color: var(--${NS}-vi); }

    .${NS}-chain {
        margin-top: 10px;
    }
    .${NS}-chain summary {
        cursor: pointer;
        color: var(--${NS}-muted);
        font-size: 10.5px;
        letter-spacing: 0.04em;
        padding: 4px 0;
        outline: none;
    }
    .${NS}-chain summary:hover { color: var(--${NS}-text); }
    .${NS}-cert {
        margin-top: 6px;
        padding: 6px 8px;
        background: rgba(148, 163, 184, 0.04);
        border-left: 2px solid var(--${NS}-border);
        font: 10.5px/1.4 "Space Mono", ui-monospace, monospace;
    }
    .${NS}-cert[data-ok="true"]  { border-left-color: var(--${NS}-ok); }
    .${NS}-cert[data-ok="false"] { border-left-color: var(--${NS}-vi); }
    .${NS}-cert .${NS}-role {
        color: var(--${NS}-cyan);
        font-weight: 600;
        font-family: "DM Sans", system-ui, sans-serif;
        font-size: 11px;
    }
    .${NS}-cert .${NS}-key {
        display: block;
        color: var(--${NS}-muted);
        margin-top: 2px;
    }
    .${NS}-cert .${NS}-validity {
        display: block;
        color: var(--${NS}-muted);
        margin-top: 2px;
        font-size: 10px;
    }

    .${NS}-foot {
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px dashed var(--${NS}-border);
        color: var(--${NS}-muted);
        font-size: 10px;
        letter-spacing: 0.02em;
        line-height: 1.4;
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
    // MCP client (self-contained — does not depend on app.js's mcpCall)
    // ---------------------------------------------------------------
    async function queryPredictions(h3Cell, epoch, signal) {
        const cfg = window.mobydbConfig || {};
        if (!cfg.apiBase || !cfg.apiKey) {
            throw new Error('mobydb config missing (apiBase or apiKey)');
        }
        const args = { h3_cell: h3Cell, include_chain: true, limit: 10 };
        if (typeof epoch === 'number') args.epoch = epoch;
        if (typeof MODEL_VERSION_FILTER === 'string' && MODEL_VERSION_FILTER) {
            args.model_version = MODEL_VERSION_FILTER;
        }
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: 'query_predictions',
                arguments: args
            }
        });
        const resp = await fetch(`${cfg.apiBase}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-mobydb-api-key': cfg.apiKey
            },
            body,
            signal
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const rpc = await resp.json();
        if (rpc.error) throw new Error(`MCP ${rpc.error.code}: ${rpc.error.message}`);
        if (rpc.result.isError) throw new Error(rpc.result.content?.[0]?.text || 'tool error');
        const inner = JSON.parse(rpc.result.content[0].text);
        return inner; // { records: [...], trust_root: {...} }
    }

    // ---------------------------------------------------------------
    // Cache — predictions are immutable per (h3_cell, epoch)
    // ---------------------------------------------------------------
    const cache = new Map();
    function cacheKey(h3Cell, epoch) { return `${h3Cell}:${epoch}`; }

    // ---------------------------------------------------------------
    // Renderers
    // ---------------------------------------------------------------
    function renderShell(tier, tierLabel) {
        const section = document.createElement('div');
        section.className = SECTION_CLASS;
        section.innerHTML = `
            <header>
                <h5>GEIANT Lab attestation</h5>
                <span class="${NS}-tier-pill" data-tier="${tier}">${tierLabel}</span>
            </header>
            <div class="${NS}-body"></div>
        `;
        return section;
    }

    function row(k, v, opts = {}) {
        const valClass = opts.normal ? `${NS}-v normal` : `${NS}-v`;
        const okAttr = opts.ok === undefined ? '' : ` data-ok="${opts.ok}"`;
        return `
            <div class="${NS}-row">
                <span class="${NS}-k">${k}</span>
                <span class="${valClass}"${okAttr}>${v}</span>
            </div>
        `;
    }

    function shortB64u(s, n = 12) {
        if (typeof s !== 'string') return '—';
        return s.length <= n ? s : s.slice(0, n) + '…';
    }

    function renderEmpty(labCell, clickedCell) {
        const section = renderShell('EMPTY', 'no record');
        const parentNote = (clickedCell && clickedCell !== labCell)
            ? `<div class="${NS}-row"><span class="${NS}-k">res-8 parent</span><span class="${NS}-v">${shortB64u(labCell, 16)}</span></div>`
            : '';
        section.querySelector(`.${NS}-body`).innerHTML = `
            ${parentNote}
            <div class="${NS}-foot">
                No GEIANT Lab prediction at this cell. The lab stores
                Sentinel-2 flood-classification records at H3 resolution 8;
                only cells covered by recent satellite acquisitions carry
                lab records.
            </div>
        `;
        return section;
    }

    function renderError(msg) {
        const section = renderShell('VI', 'fetch failed');
        section.querySelector(`.${NS}-body`).innerHTML = `
            <div class="${NS}-foot" style="color: var(--${NS}-vi);">
                ${escapeHtml(msg)}
            </div>
        `;
        return section;
    }

    function renderLoading() {
        const section = renderShell('LOAD', 'verifying…');
        return section;
    }

    function renderVerdict(record, response, verdict, ctx = {}) {
        const tier = verdict.ok ? 'OK' : 'VI';
        const tierLabel = verdict.ok
            ? `OK · ${verdict.chain_depth}-level chain`
            : 'tampered';
        const section = renderShell(tier, tierLabel);

        const acquired = (record.input?.acquisition_timestamp || '').slice(0, 10);
        const cloud = record.input?.cloud_cover_percent;
        const cloudStr = (typeof cloud === 'number') ? `${cloud.toFixed(2)}% cloud` : '';
        const inputLine = [acquired, cloudStr].filter(Boolean).join(' · ');

        const cellRow = (ctx.clickedCell && ctx.labCell && ctx.clickedCell !== ctx.labCell)
            ? row('lab cell', `${shortB64u(ctx.labCell, 16)} · res-8 parent of clicked cell`, { normal: true })
            : '';

        const summary = [
            cellRow,
            row('trust root',  `${response.trust_root.label} · ${shortB64u(response.trust_root.root_pubkey, 16)}`, { normal: true }),
            row('signer',      `${shortB64u(record.signer_public_key, 16)}`),
            row('signer role', verdict.chain[2]?.role || '—', { normal: true }),
            row('chain depth', String(verdict.chain_depth), { normal: true }),
            row('outer sig',   verdict.outer_signature_ok ? 'OK · Ed25519 / RFC 8785' : 'FAIL', { normal: true, ok: verdict.outer_signature_ok }),
            row('model',       record.model_version, { normal: true }),
            row('input',       inputLine || '—', { normal: true }),
            row('lab epoch',   String(record.epoch), { normal: true }),
        ].join('');

        const certs = verdict.chain.map((c, i) => `
            <div class="${NS}-cert" data-ok="${c.ok}">
                <span class="${NS}-role">L${i} · ${escapeHtml(c.role || '?')}</span>
                ${c.ok ? 'OK' : 'FAIL'}
                <span class="${NS}-key">subject: ${shortB64u(c.subject || '—', 20)}</span>
                <span class="${NS}-key">issuer:  ${shortB64u(c.issuer || '—', 20)}</span>
                <span class="${NS}-validity">valid ${(c.validity?.not_before || '').slice(0, 10)} → ${(c.validity?.not_after || '').slice(0, 10)} · ${c.validity?.current ? 'current' : 'EXPIRED'}</span>
            </div>
        `).join('');

        const errs = verdict.errors && verdict.errors.length
            ? `<div class="${NS}-foot" style="color: var(--${NS}-vi);">${verdict.errors.map(escapeHtml).join('<br>')}</div>`
            : '';

        section.querySelector(`.${NS}-body`).innerHTML = `
            ${summary}
            <details class="${NS}-chain">
                <summary>delegation chain (${verdict.chain_depth} levels)</summary>
                ${certs}
            </details>
            <div class="${NS}-foot">
                Trust root distinct from render-engine root. Both verify independently;
                neither implies the other.
            </div>
            ${errs}
        `;
        return section;
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ---------------------------------------------------------------
    // Audit panel discovery — same selectors as compliance_overlay
    // ---------------------------------------------------------------
    function findAuditHost() {
        return document.querySelector('#audit')
            || document.querySelector('#audit-panel')
            || document.querySelector('[data-role="audit-panel"]')
            || document.querySelector('.audit-panel');
    }

    function clearPrevious(host) {
        host.querySelectorAll(`.${SECTION_CLASS}`).forEach(n => n.remove());
    }

    function attach(host, section) {
        clearPrevious(host);
        host.appendChild(section);
        toggleCostCounter(false); // audit panel populated → hide cost-counter
    }

    // ---------------------------------------------------------------
    // Cost-counter autohide — matches the LEGEND_AUTOHIDE_V1 pattern
    // already established by compliance_overlay. The #cost-counter
    // floating panel overlaps the lower portion of the audit column;
    // hide it whenever a lab attestation block is rendered, restore
    // it when the panel empties.
    // ---------------------------------------------------------------
    let costCounterRestoreDisplay = null;
    function toggleCostCounter(show) {
        const cc = document.getElementById('cost-counter');
        if (!cc) return;
        if (show) {
            if (costCounterRestoreDisplay !== null) {
                cc.style.display = costCounterRestoreDisplay;
                costCounterRestoreDisplay = null;
            }
        } else {
            if (costCounterRestoreDisplay === null) {
                costCounterRestoreDisplay = cc.style.display || '';
            }
            cc.style.display = 'none';
        }
    }

    // ---------------------------------------------------------------
    // Controller
    // ---------------------------------------------------------------
    let inflight = null; // AbortController for the current fetch

    // Lab stores predictions at H3 resolution 8 (~5 km cells). Render-engine
    // clicks come in at res 11 (~70 m). Walk up via cellToParent before querying.
    const LAB_RESOLUTION = 8;

    // Restrict to the production Prithvi flood-classification model. Without
    // this filter, synthetic benchmark records (model "synthetic-bench@10k_v1"
    // and similar) will be returned and may render as "tampered" if they were
    // not generated through the real signing path. Set to null/undefined to
    // surface all model versions.
    const MODEL_VERSION_FILTER = 'sen1floods11@918b9f140bb1';

    async function onAuditOpen(ev) {
        const host = findAuditHost();
        if (!host) return;

        const cell = ev?.detail?.cell;
        if (!cell || !cell.h3_cell) return;

        // Resolution-walk: clicked cell -> res-8 ancestor.
        let labCell = cell.h3_cell;
        try {
            if (window.h3 && typeof window.h3.cellToParent === 'function') {
                const candidate = window.h3.cellToParent(cell.h3_cell, LAB_RESOLUTION);
                if (typeof candidate === 'string' && candidate.length) labCell = candidate;
            }
        } catch (e) {
            // Fall through with the original cell — query will likely return empty,
            // but we don't want to block the panel render on h3-js misbehavior.
        }

        // Cancel any in-flight request from a previous click
        if (inflight) inflight.abort();
        inflight = new AbortController();

        const key = cacheKey(labCell, 'any');

        // Show a loading shell only if not cached — avoids flicker on cache hit
        if (!cache.has(key)) {
            attach(host, renderLoading());
        }

        let response;
        try {
            if (cache.has(key)) {
                response = cache.get(key);
            } else {
                // No epoch filter — render-engine epoch is unrelated to lab epoch
                // (lab epoch = days since 2024-01-01 mapped from Sentinel-2
                // acquisition timestamps). Surface whichever lab records exist.
                response = await queryPredictions(labCell, undefined, inflight.signal);
                cache.set(key, response);
            }
        } catch (e) {
            if (e.name === 'AbortError') return; // user clicked another cell
            attach(host, renderError(`query_predictions failed: ${e.message}`));
            return;
        }

        if (!response.records || response.records.length === 0) {
            attach(host, renderEmpty(labCell, cell.h3_cell));
            return;
        }

        // Pick the most recent record by signed_at (lexical ISO8601 sort works)
        const records = response.records.slice().sort(
            (a, b) => (b.signed_at || '').localeCompare(a.signed_at || '')
        );
        const record = records[0];

        let verdict;
        try {
            verdict = await window.LabVerify.verifyLabRecord(record, response.trust_root);
        } catch (e) {
            attach(host, renderError(`verifier crashed: ${e.message}`));
            return;
        }

        attach(host, renderVerdict(record, response, verdict, {
            clickedCell: cell.h3_cell,
            labCell,
            recordCount: response.records.length
        }));

        // Notify the tile-preview module (and any other future consumers).
        // The section is already in the DOM at this point, so the listener
        // can find it via querySelector and attach a trigger button. The
        // record is included for convenience.
        try {
            const section = host.querySelector('.' + SECTION_CLASS);
            if (section) {
                section.dataset.labRecord = JSON.stringify(record);
                window.mobydbBus.dispatchEvent(new CustomEvent('lab-attestation-rendered', {
                    detail: { section, record, response, verdict }
                }));
            }
        } catch (e) {
            console.warn('lab-attestation-rendered dispatch failed:', e);
        }
    }

    // ---------------------------------------------------------------
    // Boot
    // ---------------------------------------------------------------
    function boot() {
        injectStyles();
        const bus = window.mobydbBus;
        if (!bus) {
            // app.js may not have set up the bus yet — retry briefly
            setTimeout(boot, 100);
            return;
        }
        bus.addEventListener('audit-open', onAuditOpen);
        // Also re-run when the user moves the epoch slider while a cell is open
        bus.addEventListener('epoch', () => {
            // No automatic refetch — the audit panel already re-opens on
            // explicit cell-click. Listening here is forward-compatible
            // for when app.js starts emitting cell-aware epoch events.
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
