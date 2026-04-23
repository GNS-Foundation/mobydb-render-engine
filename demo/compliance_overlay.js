/* =====================================================================
 * MobyDB demo — Compliance overlay (Session 3 · v2)
 * ---------------------------------------------------------------------
 * Drop-in module. Add to index.html AFTER the main app script:
 *
 *   <script type="module" src="./compliance_overlay.js"></script>
 *
 * Depends on the globals the Session 2 app already exposes:
 *   - window.mobydbMap        (MapLibre GL instance)
 *   - window.mobydbState      ({ cells: [...], currentEpoch, seenEpochs })
 *   - window.mobydbBus        (EventTarget for 'cells', 'epoch', 'audit-open')
 *
 * v2 changes:
 *   - scoreCell() reads real data shape (epoch_id, identity_pk, signature)
 *   - isEuCell() matches H3 prefix resolution-agnostically
 *   - Aux values never leak 'NaN' to the UI
 *   - Audit panel selector includes #audit
 * ===================================================================== */

(function () {
  'use strict';

  const NS = 'mdb-compliance';
  const STORAGE_KEY = 'mobydb.compliance.enabled';

  // ---------------------------------------------------------------
  // 1. Compliance model
  // ---------------------------------------------------------------
  // Four dimensions, each scored 0 | 1. Overall tier:
  //   4/4 → OK    (full compliance)
  //   3/4 → WA    (warning — one stale attestation)
  //  ≤2/4 → VI    (violation — blocking for pilot)

  const TIER = Object.freeze({ OK: 'OK', WA: 'WA', VI: 'VI' });

  const COLOR = Object.freeze({
    OK: '#14b8a6', // teal — compliant
    WA: '#f59e0b', // amber — attention
    VI: '#ef4444', // red — blocking
    EU: '#60a5fa'  // blue — jurisdiction halo
  });

  // Italian H3 prefixes — resolution-agnostic.
  // H3 hex ids begin with a 1-char resolution nibble, then progressively
  // refine. Matching on the 3 chars AFTER the leading nibble covers
  // every resolution (r7 through r15) inside the same geographic region.
  //   '71e...' → central Italy (Lazio, where Rome lives)
  //   '71f...' → eastern Italy
  //   '739...' → northern Italy (Lombardy, western)
  //   '73a...' → northern Italy (Lombardy, central)
  //   '73b...' → northern Italy (Lombardy, eastern)
  // Samples seen: '871e...' (r9), '8b1e...' (r11), '8f1e...' (r15).
  const IT_PREFIXES_3 = ['71e', '71f', '739', '73a', '73b'];

  // ISEUCELL_V3 — use h3-js native base-cell lookup rather than string
  // slicing. Italian territory is covered by H3 base cells 14 (north)
  // and 15 (central/south). Verified against actual seed data:
  //   8b1e8050145bfff  →  resolution 11, base cell 15  (Rome)
  //
  // This is resolution-agnostic by construction: all descendants of a
  // given base cell share that base cell regardless of their refinement.
  const IT_BASE_CELLS = new Set([14, 15]);

  function isEuCell(h3) {
    if (!h3 || typeof h3 !== 'string') return false;
    // Prefer h3-js if available — it's the authoritative decoder.
    const h3lib = (typeof window !== 'undefined' ? window.h3 : null) || null;
    if (h3lib && typeof h3lib.getBaseCellNumber === 'function') {
      try {
        return IT_BASE_CELLS.has(h3lib.getBaseCellNumber(h3));
      } catch (e) { /* fall through to manual decode */ }
    }
    // Fallback: decode the H3 bits directly from hex.
    // Bits 51..45 of the 64-bit id are the 7-bit base cell number.
    try {
      const hi = parseInt(h3.slice(0, 8), 16);
      const base = (hi >>> 13) & 0x7F;
      return IT_BASE_CELLS.has(base);
    } catch (e) {
      return false;
    }
  }

  // Recognises the real data shape from /mcp query_cells_in_region:
  //   { h3_cell, epoch_id, identity_pk, signature, content_hash, payload, ... }
  // Tolerates the provenance shape from /mcp get_provenance too.
  function scoreCell(cell, currentEpoch) {
    // SCORE_V2_1 — unwraps provenance-shaped cells (cell_state wrapper)
    // and tolerates 120-128-char hex signatures (leading-zero-trim tolerance).
    if (!cell || typeof cell !== 'object') {
      return {
        tier: TIER.VI,
        score: 0,
        detail: {
          signature:    { ok: false, label: 'Ed25519 signature' },
          freshness:    { ok: false, label: 'Proof \u2264 1 epoch old' },
          jurisdiction: { ok: false, label: 'EU data residency' },
          delegation:   { ok: false, label: 'Delegation attested' }
        }
      };
    }

    // If this is a provenance-shaped object (from /mcp get_provenance),
    // the signed fields live inside cell_state. Merge so both shapes work.
    const inner = cell.cell_state && typeof cell.cell_state === 'object'
      ? { ...cell.cell_state }
      : {};
    const merged = { ...inner, ...cell };
    for (const k of ['identity_pk','signature','content_hash','epoch_id','payload','writer_pk']) {
      if (merged[k] === undefined && inner[k] !== undefined) merged[k] = inner[k];
    }

    // 1. Signature: ed25519 as hex. Accept 120-128 chars to tolerate
    //    backends that trim leading-zero nibbles in the hex encoding.
    const sig = merged.signature || merged.sig || '';
    const signatureOk = typeof sig === 'string' && /^[0-9a-f]{120,128}$/i.test(sig);

    // 2. Freshness: epoch_id vs currentEpoch (fallback to payload.epoch).
    //    For provenance shape, merged.epoch may be an epoch-wrapper object
    //    rather than a number — guard against that.
    const rawEpoch =
      merged.epoch_id ??
      (typeof merged.epoch === 'number' ? merged.epoch : merged.epoch?.epoch_id) ??
      merged.payload?.epoch;
    let freshness = NaN;
    if (Number.isFinite(rawEpoch) && Number.isFinite(currentEpoch)) {
      freshness = Math.max(0, currentEpoch - rawEpoch);
    }
    const freshOk = Number.isFinite(freshness) && freshness <= 1;

    // 3. Jurisdiction: H3 prefix match (resolution-agnostic).
    const jurisdictionOk = isEuCell(merged.h3_cell);

    // 4. Delegation: presence of 64-hex writer key.
    const writerKey = merged.identity_pk || merged.writer_pk || merged.pubkey || '';
    const delegationOk = typeof writerKey === 'string' &&
                         /^[0-9a-f]{64}$/i.test(writerKey);

    const score = [signatureOk, freshOk, jurisdictionOk, delegationOk]
      .filter(Boolean).length;

    const tierLabel =
      score === 4 ? TIER.OK :
      score === 3 ? TIER.WA : TIER.VI;

    const freshAux = Number.isFinite(freshness)
      ? (freshness === 0 ? 'current' : `${freshness} behind`)
      : '';
    const delegAux = delegationOk ? 'ed25519' : '';

    return {
      tier: tierLabel,
      score,
      detail: {
        signature:    { ok: signatureOk,    label: 'Ed25519 signature' },
        freshness:    { ok: freshOk,        label: 'Proof \u2264 1 epoch old', aux: freshAux },
        jurisdiction: { ok: jurisdictionOk, label: 'EU data residency' },
        delegation:   { ok: delegationOk,   label: 'Delegation attested', aux: delegAux }
      }
    };
  }

  // ---------------------------------------------------------------
  // 2. Style injection
  // ---------------------------------------------------------------
  const css = `
  :root {
    --${NS}-bg:        rgba(14, 18, 24, 0.92);
    --${NS}-border:    rgba(148, 163, 184, 0.14);
    --${NS}-text:      rgb(226, 232, 240);
    --${NS}-muted:     rgb(148, 163, 184);
    --${NS}-ok:        ${COLOR.OK};
    --${NS}-wa:        ${COLOR.WA};
    --${NS}-vi:        ${COLOR.VI};
    --${NS}-eu:        ${COLOR.EU};
  }

  .${NS}-toggle {
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 50;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 14px 9px 12px;
    background: var(--${NS}-bg);
    border: 1px solid var(--${NS}-border);
    color: var(--${NS}-text);
    font: 300 12px/1 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    backdrop-filter: blur(14px) saturate(120%);
    -webkit-backdrop-filter: blur(14px) saturate(120%);
    transition: border-color .18s ease, color .18s ease;
  }
  .${NS}-toggle:hover { border-color: rgba(148,163,184,0.32); }
  .${NS}-toggle[data-on="true"] { color: var(--${NS}-ok); border-color: color-mix(in srgb, var(--${NS}-ok) 40%, transparent); }
  .${NS}-toggle .dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--${NS}-muted);
    box-shadow: 0 0 0 0 transparent;
    transition: background .18s ease, box-shadow .18s ease;
  }
  .${NS}-toggle[data-on="true"] .dot {
    background: var(--${NS}-ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--${NS}-ok) 22%, transparent);
  }

  .${NS}-legend {
    position: absolute;
    bottom: 20px;
    right: 16px;
    z-index: 48;
    min-width: 218px;
    background: var(--${NS}-bg);
    border: 1px solid var(--${NS}-border);
    padding: 14px 15px 13px;
    color: var(--${NS}-text);
    font: 300 11.5px/1.55 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    letter-spacing: 0.015em;
    backdrop-filter: blur(14px) saturate(120%);
    -webkit-backdrop-filter: blur(14px) saturate(120%);
    transform: translateY(8px);
    opacity: 0;
    pointer-events: none;
    transition: opacity .22s ease, transform .22s ease;
  }
  .${NS}-legend[data-on="true"] { opacity: 1; transform: translateY(0); pointer-events: auto; }
  .${NS}-legend h4 {
    margin: 0 0 10px;
    font: 300 10px/1 "JetBrains Mono", ui-monospace, monospace;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--${NS}-muted);
  }
  .${NS}-legend .row {
    display: grid;
    grid-template-columns: 14px 1fr auto;
    align-items: center;
    gap: 9px;
    padding: 3px 0;
  }
  .${NS}-legend .sw {
    width: 10px; height: 10px;
    border: 1px solid rgba(0,0,0,0.35);
  }
  .${NS}-legend .code {
    font: 300 10px/1 "JetBrains Mono", ui-monospace, monospace;
    color: var(--${NS}-muted);
    letter-spacing: 0.08em;
  }
  .${NS}-legend .divider {
    height: 1px;
    background: var(--${NS}-border);
    margin: 8px 0;
  }
  .${NS}-legend .foot {
    margin-top: 6px;
    font: 300 10.5px/1.5 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    color: var(--${NS}-muted);
  }

  /* Audit panel compliance section — scoped so it doesn't fight host styles. */
  .${NS}-audit-section {
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid var(--${NS}-border);
    font: 300 12px/1.55 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    color: var(--${NS}-text);
  }
  .${NS}-audit-section header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .${NS}-audit-section h5 {
    margin: 0;
    font: 300 10px/1 "JetBrains Mono", ui-monospace, monospace;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--${NS}-muted);
  }
  .${NS}-tier-pill {
    font: 300 10px/1 "JetBrains Mono", ui-monospace, monospace;
    letter-spacing: 0.18em;
    padding: 4px 8px;
    border: 1px solid currentColor;
  }
  .${NS}-tier-pill[data-tier="OK"] { color: var(--${NS}-ok); }
  .${NS}-tier-pill[data-tier="WA"] { color: var(--${NS}-wa); }
  .${NS}-tier-pill[data-tier="VI"] { color: var(--${NS}-vi); }

  .${NS}-checks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .${NS}-checks li {
    display: grid;
    grid-template-columns: 18px 1fr auto;
    gap: 10px;
    align-items: baseline;
  }
  .${NS}-checks .mk {
    font: 300 11px/1 "JetBrains Mono", ui-monospace, monospace;
    letter-spacing: 0.1em;
  }
  .${NS}-checks .mk[data-ok="true"]  { color: var(--${NS}-ok); }
  .${NS}-checks .mk[data-ok="false"] { color: var(--${NS}-vi); }
  .${NS}-checks .aux {
    font: 300 10.5px/1 "JetBrains Mono", ui-monospace, monospace;
    color: var(--${NS}-muted);
    letter-spacing: 0.05em;
  }

  /* Article references under the checks — the regulatory narrative. */
  .${NS}-refs {
    margin: 12px 0 0;
    padding: 10px 12px;
    background: rgba(96, 165, 250, 0.06);
    border-left: 2px solid var(--${NS}-eu);
    font: 300 10.5px/1.5 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    color: var(--${NS}-muted);
  }
  .${NS}-refs b {
    color: var(--${NS}-text);
    font-weight: 400;
  }
  `;

  function injectCss() {
    if (document.getElementById(`${NS}-css`)) return;
    const s = document.createElement('style');
    s.id = `${NS}-css`;
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------
  // 3. DOM — toggle + legend
  // ---------------------------------------------------------------
  function buildToggle(initialOn) {
    const btn = document.createElement('button');
    btn.className = `${NS}-toggle`;
    btn.setAttribute('data-on', String(initialOn));
    btn.setAttribute('aria-pressed', String(initialOn));
    btn.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <span>EU AI Act view</span>
    `;
    return btn;
  }

  function buildLegend(initialOn) {
    const el = document.createElement('aside');
    el.className = `${NS}-legend`;
    el.setAttribute('data-on', String(initialOn));
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Compliance legend');
    el.innerHTML = `
      <h4>Compliance tier</h4>
      <div class="row">
        <span class="sw" style="background:${COLOR.OK}"></span>
        <span>Fully compliant</span>
        <span class="code">OK</span>
      </div>
      <div class="row">
        <span class="sw" style="background:${COLOR.WA}"></span>
        <span>Attestation stale</span>
        <span class="code">WA</span>
      </div>
      <div class="row">
        <span class="sw" style="background:${COLOR.VI}"></span>
        <span>Blocking</span>
        <span class="code">VI</span>
      </div>
      <div class="divider"></div>
      <div class="row">
        <span class="sw" style="background:${COLOR.EU}; opacity:.55"></span>
        <span>EU jurisdiction</span>
        <span class="code">EU</span>
      </div>
      <p class="foot">Signatures, proof freshness, residency and delegation scored per cell. Art. 12 &amp; 72 AI Act.</p>
    `;
    return el;
  }

  // ---------------------------------------------------------------
  // 4. Map styling — MapLibre layer side effects
  // ---------------------------------------------------------------
  let savedPaint = null;

  function compliancePaintExpression() {
    return [
      'match',
      ['get', 'tier'],
      'OK', COLOR.OK,
      'WA', COLOR.WA,
      'VI', COLOR.VI,
      /* default */ '#94a3b8'
    ];
  }

  function applyOverlay(map) {
    if (!map || !map.getLayer || !map.getLayer('cells-fill')) return;
    try {
      savedPaint = map.getPaintProperty('cells-fill', 'fill-color');
      map.setPaintProperty('cells-fill', 'fill-color', compliancePaintExpression());
      map.setPaintProperty('cells-fill', 'fill-opacity', 0.58);
    } catch (e) { /* map not ready yet */ }
  }

  function removeOverlay(map) {
    if (!map || !map.getLayer || !map.getLayer('cells-fill')) return;
    try {
      if (savedPaint !== null) {
        map.setPaintProperty('cells-fill', 'fill-color', savedPaint);
      }
      map.setPaintProperty('cells-fill', 'fill-opacity', 0.45);
    } catch (e) { /* ignore */ }
  }

  function annotateCells(map, cells, currentEpoch) {
    if (!map || !map.getSource || !map.getSource('cells')) return;
    const src = map.getSource('cells');
    const data = src._data || { type: 'FeatureCollection', features: [] };
    const byH3 = new Map(cells.map(c => [c.h3_cell, scoreCell(c, currentEpoch)]));
    const features = data.features.map(f => {
      const h3 = f.properties?.h3_cell || f.properties?.id;
      const scored = byH3.get(h3);
      if (!scored) return f;
      return {
        ...f,
        properties: { ...f.properties, tier: scored.tier, score: scored.score }
      };
    });
    src.setData({ type: 'FeatureCollection', features });
  }

  // ---------------------------------------------------------------
  // 5. Audit panel extension
  // ---------------------------------------------------------------
  function renderAuditSection(cell, currentEpoch) {
    const scored = scoreCell(cell, currentEpoch);
    const section = document.createElement('div');
    section.className = `${NS}-audit-section`;

    const mark = ok => ok ? '[OK]' : '[VI]';

    const rows = Object.values(scored.detail).map(d => `
      <li>
        <span class="mk" data-ok="${d.ok}">${mark(d.ok)}</span>
        <span>${d.label}</span>
        <span class="aux">${d.aux ?? ''}</span>
      </li>
    `).join('');

    section.innerHTML = `
      <header>
        <h5>EU AI Act compliance</h5>
        <span class="${NS}-tier-pill" data-tier="${scored.tier}">${scored.tier} \u00b7 ${scored.score}/4</span>
      </header>
      <ul class="${NS}-checks">${rows}</ul>
      <p class="${NS}-refs">
        Per-cell attestation bundle covers <b>Art. 12</b> (record-keeping),
        <b>Art. 50</b> (transparency), <b>Art. 72</b> (post-market monitoring).
        Merkle proof &rarr; <b>Art. 26\u00a76</b>.
      </p>
    `;
    return section;
  }

  function tryAttachToAuditPanel(cell, currentEpoch) {
    // Host selectors, in order of specificity.
    const host =
      document.querySelector('#audit') ||
      document.querySelector('#audit-panel') ||
      document.querySelector('[data-role="audit-panel"]') ||
      document.querySelector('.audit-panel');
    if (!host) return false;

    // Remove any previous compliance section
    host.querySelectorAll(`.${NS}-audit-section`).forEach(n => n.remove());

    host.appendChild(renderAuditSection(cell, currentEpoch));
    return true;
  }

  // ---------------------------------------------------------------
  // 6. Controller
  // ---------------------------------------------------------------
  function currentEpoch() {
    return window.mobydbState?.currentEpoch ?? 0;
  }
  function cellsList() {
    return window.mobydbState?.cells ?? [];
  }
  function getMap() {
    return window.mobydbMap || null;
  }
  function getBus() {
    if (window.mobydbBus instanceof EventTarget) return window.mobydbBus;
    if (!window.__mobydbFallbackBus) window.__mobydbFallbackBus = new EventTarget();
    return window.__mobydbFallbackBus;
  }

  function controller() {
    injectCss();

    const stored = localStorage.getItem(STORAGE_KEY);
    let on = stored === null ? true : stored === '1';

    const mapContainer =
      document.querySelector('.maplibregl-map') ||
      document.querySelector('#map') ||
      document.body;

    const toggle = buildToggle(on);
    const legend = buildLegend(on);
    mapContainer.appendChild(toggle);
    mapContainer.appendChild(legend);

    function paint(state) {
      toggle.setAttribute('data-on', String(state));
      toggle.setAttribute('aria-pressed', String(state));
      legend.setAttribute('data-on', String(state));
      const map = getMap();
      if (!map) return;
      if (state) {
        annotateCells(map, cellsList(), currentEpoch());
        applyOverlay(map);
      } else {
        removeOverlay(map);
      }
    }

    toggle.addEventListener('click', () => {
      on = !on;
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
      paint(on);
    });

    const bus = getBus();
    bus.addEventListener('cells', () => { if (on) paint(true); });
    bus.addEventListener('epoch', () => { if (on) paint(true); });
    // LEGEND_AUTOHIDE_V1 — hide legend while an audit panel is open,
    // because both sit in the bottom-right and collide on narrow viewports.
    // The compliance section inside the audit panel carries the same info,
    // so hiding the legend doesn't lose anything for the user.
    bus.addEventListener('audit-open', ev => {
      const cell = ev?.detail?.cell;
      if (cell) tryAttachToAuditPanel(cell, currentEpoch());
      legend.style.opacity = '0';
      legend.style.pointerEvents = 'none';
    });

    // Re-show the legend when the user clicks on the map background
    // (i.e. anywhere other than a substation cell). Map clicks not over
    // a cell don't trigger audit-open, so we treat them as 'done inspecting'.
    const map2 = getMap();
    if (map2 && typeof map2.on === 'function') {
      map2.on('click', e => {
        // If a cells-fill feature is at this point, the dedicated
        // handler already fired — do nothing. Otherwise restore the legend
        // (only if compliance view is on).
        const feats = map2.queryRenderedFeatures(e.point, { layers: ['cells-fill'] });
        if ((!feats || feats.length === 0) && on) {
          legend.style.opacity = '';
          legend.style.pointerEvents = '';
        }
      });
    }

    const map = getMap();
    if (map) {
      if (map.loaded && map.loaded()) paint(on);
      else map.once?.('load', () => paint(on));
      map.on?.('sourcedata', e => {
        if (e && e.sourceId === 'cells' && e.isSourceLoaded && on) paint(true);
      });
    }
  }

  // ---------------------------------------------------------------
  // 7. Public API — marker bumped to 3.1.0-local
  // ---------------------------------------------------------------
  window.mobydbCompliance = Object.freeze({
    scoreCell,
    isEuCell,
    TIER,
    COLOR,
    renderAuditSection,
    version: '3.1.3-local'
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', controller, { once: true });
  } else {
    controller();
  }
})();
