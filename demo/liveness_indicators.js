/* =====================================================================
 * MobyDB demo — Liveness indicators (Session 3 · v2)
 * ---------------------------------------------------------------------
 * Strategy:
 *   - Poll GET /health every 3s for backend heartbeat (we know it exists).
 *   - Derive all metrics (cells loaded, cells/min, last fetch, epoch)
 *     from window.mobydbState and bus events — no dependency on /stats.
 *   - Flash newly-loaded cells in the viewport for ~700ms.
 *   - Toast on epoch change (slider-driven).
 * ===================================================================== */

(function () {
  'use strict';

  const NS = 'mdb-live';
  const INTERVAL_MS = 3000;
  const WINDOW_MS   = 60000;
  const TOAST_MS    = 5200;

  // ---------------------------------------------------------------
  // Style
  // ---------------------------------------------------------------
  const css = `
  :root {
    --${NS}-bg:       rgba(14, 18, 24, 0.92);
    --${NS}-border:   rgba(148, 163, 184, 0.14);
    --${NS}-text:     rgb(226, 232, 240);
    --${NS}-muted:    rgb(148, 163, 184);
    --${NS}-ok:       #14b8a6;
    --${NS}-warn:     #f59e0b;
    --${NS}-stale:    #64748b;
  }
  .${NS}-strip {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 49;
    display: grid;
    grid-auto-flow: column;
    align-items: center;
    gap: 0;
    background: var(--${NS}-bg);
    border: 1px solid var(--${NS}-border);
    color: var(--${NS}-text);
    font: 300 11.5px/1 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    letter-spacing: 0.02em;
    backdrop-filter: blur(14px) saturate(120%);
    -webkit-backdrop-filter: blur(14px) saturate(120%);
    overflow: hidden;
  }
  .${NS}-strip > .cell {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 11px 16px;
    border-right: 1px solid var(--${NS}-border);
  }
  .${NS}-strip > .cell:last-child { border-right: 0; }
  .${NS}-strip .k {
    font: 300 9.5px/1 "JetBrains Mono", ui-monospace, monospace;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--${NS}-muted);
  }
  .${NS}-strip .v {
    font: 300 12.5px/1 "JetBrains Mono", ui-monospace, monospace;
    letter-spacing: 0.04em;
    color: var(--${NS}-text);
    font-variant-numeric: tabular-nums;
  }
  .${NS}-strip .v.muted { color: var(--${NS}-stale); }
  .${NS}-beat {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--${NS}-ok);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--${NS}-ok) 55%, transparent);
    animation: ${NS}-pulse 1800ms ease-out infinite;
    margin-right: 2px;
    transform: translateY(1px);
  }
  .${NS}-strip[data-state="stale"] .${NS}-beat {
    background: var(--${NS}-stale);
    animation-duration: 3800ms;
  }
  .${NS}-strip[data-state="warn"] .${NS}-beat { background: var(--${NS}-warn); }
  @keyframes ${NS}-pulse {
    0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--${NS}-ok) 55%, transparent); }
    70%  { box-shadow: 0 0 0 9px transparent; }
    100% { box-shadow: 0 0 0 0 transparent; }
  }
  .${NS}-strip::after {
    content: '';
    position: absolute;
    inset: 0 -10%;
    background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--${NS}-ok) 35%, transparent) 50%, transparent 100%);
    transform: translateX(-120%);
    pointer-events: none;
    opacity: 0;
  }
  .${NS}-strip[data-flash="true"]::after {
    animation: ${NS}-scan 900ms ease-out;
  }
  @keyframes ${NS}-scan {
    0%   { transform: translateX(-120%); opacity: 0; }
    20%  { opacity: 1; }
    100% { transform: translateX(120%); opacity: 0; }
  }
  .${NS}-toast {
    position: absolute;
    top: 64px;
    left: 50%;
    transform: translate(-50%, -6px);
    z-index: 51;
    padding: 10px 14px;
    background: var(--${NS}-bg);
    border: 1px solid color-mix(in srgb, var(--${NS}-ok) 30%, var(--${NS}-border));
    color: var(--${NS}-text);
    font: 300 11.5px/1.2 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    backdrop-filter: blur(14px) saturate(120%);
    -webkit-backdrop-filter: blur(14px) saturate(120%);
    opacity: 0;
    pointer-events: none;
    transition: opacity .28s ease, transform .28s ease;
    display: grid;
    grid-auto-flow: column;
    align-items: center;
    gap: 10px;
  }
  .${NS}-toast[data-on="true"] { opacity: 1; transform: translate(-50%, 0); }
  .${NS}-toast .tag {
    font: 300 9.5px/1 "JetBrains Mono", ui-monospace, monospace;
    letter-spacing: 0.24em;
    text-transform: uppercase;
    color: var(--${NS}-ok);
  }
  .${NS}-toast .hash {
    font: 300 11px/1 "JetBrains Mono", ui-monospace, monospace;
    color: var(--${NS}-muted);
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
  // DOM
  // ---------------------------------------------------------------
  function buildStrip() {
    const el = document.createElement('div');
    el.className = `${NS}-strip`;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('data-state', 'init');
    el.innerHTML = `
      <div class="cell">
        <span class="${NS}-beat" aria-hidden="true"></span>
        <span class="k">Status</span>
        <span class="v" data-f="state">—</span>
      </div>
      <div class="cell">
        <span class="k">Last fetch</span>
        <span class="v" data-f="last">—</span>
      </div>
      <div class="cell">
        <span class="k">Epoch</span>
        <span class="v" data-f="epoch">—</span>
      </div>
      <div class="cell">
        <span class="k">Cells / min</span>
        <span class="v" data-f="cpm">—</span>
      </div>
      <div class="cell">
        <span class="k">Cells loaded</span>
        <span class="v" data-f="total">—</span>
      </div>
    `;
    return el;
  }
  function buildToast() {
    const el = document.createElement('div');
    el.className = `${NS}-toast`;
    el.setAttribute('data-on', 'false');
    el.innerHTML = `
      <span class="tag">Epoch changed</span>
      <span data-f="epoch">—</span>
      <span class="hash" data-f="root">—</span>
    `;
    return el;
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------
  function fmtAgo(ts) {
    if (!ts) return '—';
    const d = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (d < 2)    return 'just now';
    if (d < 60)   return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d/60)}m ${d%60}s ago`;
    return `${Math.floor(d/3600)}h ${Math.floor((d%3600)/60)}m ago`;
  }
  function fmtInt(n) {
    if (n == null) return '—';
    return new Intl.NumberFormat('en-US').format(Math.round(n));
  }
  function getMap() { return window.mobydbMap || null; }
  function getBus() {
    if (window.mobydbBus instanceof EventTarget) return window.mobydbBus;
    if (!window.__mobydbFallbackBus) window.__mobydbFallbackBus = new EventTarget();
    return window.__mobydbFallbackBus;
  }
  function apiBase() {
    return (window.mobydbConfig && window.mobydbConfig.apiBase) || '';
  }

  // ---------------------------------------------------------------
  // Backend heartbeat — /health only
  // ---------------------------------------------------------------
  async function pingHealth() {
    const base = apiBase();
    if (!base) return { ok: false };
    try {
      const r = await fetch(base.replace(/\/+$/, '') + '/health', { cache: 'no-store' });
      return { ok: r.ok, status: r.status };
    } catch {
      return { ok: false };
    }
  }

  // ---------------------------------------------------------------
  // Local rate-tracking from bus events
  // ---------------------------------------------------------------
  const cellLog = []; // [{ts, delta}]
  let lastFetchTs = null;
  let prevCellCount = 0;
  let prevEpoch = null;

  function onCellsEvent(count) {
    const now = Date.now();
    const delta = Math.max(0, count - prevCellCount);
    prevCellCount = count;
    if (delta > 0) {
      cellLog.push({ ts: now, delta });
      lastFetchTs = now;
    }
    // Even a re-fetch with same count is user activity — bump timestamp.
    if (count > 0 && delta === 0) lastFetchTs = now;
    const cutoff = now - WINDOW_MS;
    while (cellLog.length && cellLog[0].ts < cutoff) cellLog.shift();
  }

  function cellsPerMin() {
    if (!cellLog.length) return 0;
    const now = Date.now();
    const span = Math.min(WINDOW_MS, now - cellLog[0].ts);
    if (span < 1000) return 0;
    const sum = cellLog.reduce((a, b) => a + b.delta, 0);
    return (sum / span) * 60000;
  }

  function stateLabel(backendOk, lastTs) {
    if (!backendOk) return { text: 'offline', attr: 'stale' };
    if (!lastTs)    return { text: 'ready',   attr: 'ok' };
    const age = Date.now() - lastTs;
    if (age < 30_000)  return { text: 'live',  attr: 'ok' };
    if (age < 120_000) return { text: 'idle',  attr: 'warn' };
    return { text: 'stale', attr: 'stale' };
  }

  // ---------------------------------------------------------------
  // Map flash layer
  // ---------------------------------------------------------------
  function ensureFlashLayer(map) {
    if (!map || !map.getStyle) return;
    if (!map.getSource('cells-flash')) {
      map.addSource('cells-flash', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getLayer('cells-flash-fill')) {
      const before = map.getLayer('cells-stroke') ? 'cells-stroke' : undefined;
      map.addLayer({
        id: 'cells-flash-fill',
        type: 'fill',
        source: 'cells-flash',
        paint: {
          'fill-color': '#14b8a6',
          'fill-opacity': ['interpolate', ['linear'], ['get', 'age_ms'], 0, 0.55, 700, 0]
        }
      }, before);
    }
  }
  function flashCells(map, h3s) {
    ensureFlashLayer(map);
    const src = map.getSource('cells-flash');
    if (!src) return;
    const h3lib = window.h3 || window.h3js || null;
    if (!h3lib || !h3lib.cellToBoundary) return;
    const features = h3s.map(h => {
      let boundary;
      try { boundary = h3lib.cellToBoundary(h, true); } catch { return null; }
      if (!boundary || !boundary.length) return null;
      const ring = boundary.concat([boundary[0]]);
      return {
        type: 'Feature',
        properties: { age_ms: 0 },
        geometry: { type: 'Polygon', coordinates: [ring] }
      };
    }).filter(Boolean);
    src.setData({ type: 'FeatureCollection', features });
    const start = Date.now();
    const step = () => {
      const age = Date.now() - start;
      const data = src._data;
      if (!data || !data.features) return;
      src.setData({
        ...data,
        features: data.features.map(f => ({ ...f, properties: { ...f.properties, age_ms: age } }))
      });
      if (age < 700) requestAnimationFrame(step);
      else src.setData({ type: 'FeatureCollection', features: [] });
    };
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------
  // Controller
  // ---------------------------------------------------------------
  function controller() {
    injectCss();
    const host =
      document.querySelector('.maplibregl-map') ||
      document.querySelector('#map') ||
      document.body;

    const strip = buildStrip();
    const toast = buildToast();
    host.appendChild(strip);
    host.appendChild(toast);

    const $ = sel => strip.querySelector(`[data-f="${sel}"]`);

    function render(backendOk) {
      const cells = window.mobydbState?.cells?.length ?? 0;
      const epoch = window.mobydbState?.currentEpoch ?? 0;
      const s = stateLabel(backendOk, lastFetchTs);
      strip.setAttribute('data-state', s.attr);
      $('state').textContent = s.text;
      $('state').classList.toggle('muted', s.attr === 'stale');
      $('last').textContent  = fmtAgo(lastFetchTs);
      $('epoch').textContent = `E${fmtInt(epoch)}`;
      $('cpm').textContent   = fmtInt(cellsPerMin());
      $('total').textContent = fmtInt(cells);
    }

    function flashStrip() {
      strip.setAttribute('data-flash', 'true');
      clearTimeout(flashStrip._t);
      flashStrip._t = setTimeout(() => strip.setAttribute('data-flash', 'false'), 900);
    }

    function showEpochToast(newEpoch) {
      toast.querySelector('[data-f="epoch"]').textContent = `E${newEpoch}`;
      toast.querySelector('[data-f="root"]').textContent  = '—';
      toast.setAttribute('data-on', 'true');
      clearTimeout(showEpochToast._t);
      showEpochToast._t = setTimeout(() => toast.setAttribute('data-on', 'false'), TOAST_MS);
    }

    // Cells event from app.js bus
    getBus().addEventListener('cells', ev => {
      const cells = ev?.detail?.cells || [];
      const count = Array.isArray(cells) ? cells.length : 0;
      onCellsEvent(count);
      const map = getMap();
      if (map && count > 0) {
        const h3s = cells.map(c => c.h3_cell).filter(Boolean).slice(0, 8);
        if (h3s.length) {
          flashCells(map, h3s);
          flashStrip();
        }
      }
    });

    // Epoch event from app.js bus (slider change)
    getBus().addEventListener('epoch', ev => {
      const e = ev?.detail?.epoch;
      if (e != null && e !== prevEpoch) {
        if (prevEpoch !== null) showEpochToast(e);
        prevEpoch = e;
      }
    });

    // Seed prevEpoch from initial state so we don't toast on load
    prevEpoch = window.mobydbState?.currentEpoch ?? null;

    // Backend heartbeat every 3s; re-render every 1s for "last fetch" ticking.
    let lastBackendOk = false;
    async function tick() {
      const h = await pingHealth();
      lastBackendOk = h.ok;
      render(h.ok);
    }
    tick();
    setInterval(tick, INTERVAL_MS);
    setInterval(() => render(lastBackendOk), 1000);
  }

  // Public surface (marker used by the verify grep)
  window.mobydbLiveness = Object.freeze({
    version: '3.1.0-local',
    pingHealth
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', controller, { once: true });
  } else {
    controller();
  }
})();
