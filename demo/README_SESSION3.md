# MobyDB demo · Session 3 deliverables

Three drop-ins on top of the v1 that is already live on `demo.mobydb.com`.

## Files

| File | Where it goes |
|------|---------------|
| `compliance_overlay.js` | `mobydb-demo/public/` (same folder as existing `index.html`) |
| `liveness_indicators.js` | same |
| `integration.html` | same (sits alongside `index.html`, served at `demo.mobydb.com/integration.html`) |

## Wire-up — `index.html`

Two `<script>` tags. Order matters: load the app first, then the modules.

```html
<!-- existing app bundle -->
<script type="module" src="./app.js"></script>

<!-- Session 3 additions -->
<script type="module" src="./compliance_overlay.js"></script>
<script type="module" src="./liveness_indicators.js"></script>
```

Nothing else changes in `index.html`.

## Required globals from the v1 app

Both modules read a tiny surface off `window`. Verify the app already
exposes this, and add the missing pieces if not:

```js
// in app.js, after you create the map and state
window.mobydbMap   = map;                 // the MapLibre instance
window.mobydbState = state;               // { cells, currentEpoch, seenEpochs }
window.mobydbBus   = new EventTarget();   // see events below

// whenever cells refresh
window.mobydbBus.dispatchEvent(new CustomEvent('cells', { detail: { cells } }));

// whenever the audit panel opens
window.mobydbBus.dispatchEvent(new CustomEvent('audit-open', { detail: { cell } }));

// (optional) whenever epoch changes or stats tick
window.mobydbBus.dispatchEvent(new CustomEvent('epoch', { detail: { epoch } }));
window.mobydbBus.dispatchEvent(new CustomEvent('stats', { detail: stats }));
```

If the bus isn't there, both modules fall back to internal polling and
still work — you just lose a bit of responsiveness on cell-flash sync.

## Config the modules read (optional)

```js
window.mobydbConfig = {
  apiBase: 'https://mobydb-render-engine-production.up.railway.app',
  apiKey:  '<demo public key>',           // x-api-key header for /stats
  statsUrl: undefined,                    // default: apiBase + '/stats'
  livenessIntervalMs: 3000,
  livenessWindowMs:   60000,
  livenessToastMs:    5200,
};
```

## What ships visually

**compliance_overlay.js**
- Toggle button, top-right: `● EU AI ACT VIEW` (on by default — utility audience)
- Recolors `cells-fill` by compliance tier: teal = OK, amber = WA, red = VI
- Bottom-right legend pops in when ON
- Audit panel gains an `EU AI Act compliance` section with four-dimension checklist and Article references (Art. 12, 50, 72, 26§6)

**liveness_indicators.js**
- Top-center glass strip: `● live · last write · epoch · writes/min · records`
- Heartbeat pulse, color-coded by freshness (ok / warn / stale)
- Brief teal flash on visible cells when a write lands inside viewport
- Toast on epoch seal: `EPOCH SEALED  E42  dfee521a…d831`

**integration.html**
- Standalone page, six integration patterns (MCP, HTTP SDK, SCADA sidecar, GNS-AIP, compliance attestation, PostGIS dual-write)
- 5-step EU AI Act pipeline with Article mapping
- Capability matrix vs PostGIS / time-series / blockchain

## Test checklist (before pushing)

```
□ Toggle compliance view OFF/ON — cells recolor without reloading
□ Click 'Acea Astalli' at zoom 15.7 — audit panel shows compliance section with 4/4 OK
□ Wait 30s — liveness strip shows live state, writes/min updates
□ Manually POST a /write to a visible cell — see the teal flash on that cell
□ Wait for epoch seal — toast appears, epoch counter increments
□ Visit /integration.html — renders dark, stack diagram highlights MobyDB layer
□ Mobile viewport — integration page single-column, demo strip still legible
□ No console errors on load
```

## Commit message (suggested)

```
feat(demo): session 3 — compliance overlay, integration page, liveness indicators

- compliance_overlay.js: EU AI Act view (teal/amber/red tiers, legend,
  per-cell audit section, Article mapping)
- liveness_indicators.js: heartbeat strip, cell flash on write,
  epoch-sealed toast, /stats poller (3s)
- integration.html: standalone page with six integration patterns,
  compliance pipeline, capability matrix

Drops in on top of v1 with two script tags in index.html; degrades
gracefully if the host app doesn't expose mobydbBus.

Next: wire window.mobydbBus events in app.js for live flash sync.
```
