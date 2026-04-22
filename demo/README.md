# MobyDB Render Engine — live demo app

Single-page, zero-build JavaScript app that hits the live MobyDB Render
Engine MCP endpoint and renders signed H3 grid telemetry with offline
provenance verification.

Four files, all vanilla:

- `index.html` — layout, controls, panels
- `styles.css` — dark theme, teal→red load ramp
- `app.js` — MapLibre + MCP client + epoch slider + cost counter
- `verify.js` — Ed25519 signature + Merkle proof reconstruction

CDN-loaded: MapLibre GL 4.7.1, h3-js 4.1.0, @noble/curves, @noble/hashes.

## Local testing

Inject the demo API key into `index.html`, then serve:

```bash
# Edit demo/index.html — add this line BEFORE the app.js <script type="module">:
# <script>
#   window.MOBYDB_DEMO_KEY = "<64-hex from AUTH_DEMO_API_KEY env>";
# </script>

cd demo
python3 -m http.server 8000
# open http://localhost:8000
```

The app defaults `MOBYDB_RENDER_URL` to the production Railway URL. Override
by setting `window.MOBYDB_RENDER_URL` before app.js loads (e.g. to point at
a local `cargo run --bin mcp-server` on port 8080).

## Deployment — Cloudflare Pages

1. Connect Cloudflare Pages to this repo (GitHub integration)
2. Project settings:
   - Production branch: `main`
   - Build command: *(leave empty — no build step)*
   - Build output directory: `demo`
3. Environment variables — Cloudflare Pages injects these into a built-time
   step you would need to add. Simpler: before deploy, run a short
   `prebuild.sh` that appends the key into a `config.js` file. For now we
   just commit `config.js` with the public demo key and gitignore it if we
   want to rotate — same security posture as a rate-limited public key.

### DNS — point demo.mobydb.com at Pages

In Cloudflare DNS for `mobydb.com`:

```
CNAME  demo  <your-pages-project>.pages.dev  proxied
```

TLS auto-issued. First resolution ~2 min.

## The key is in `window.MOBYDB_DEMO_KEY`

The demo key is rate-limited (100 req/min by default) and scoped to the
seed tenant. It is explicitly designed to be visible in client code —
rotation just requires updating `AUTH_DEMO_API_KEY` in Railway and the
value in `config.js` here.

Do not use `AUTH_API_KEY` (the main key) here. That one is unlimited and
would expose the full surface to anonymous traffic.

## Architecture notes

- Zoom-level thresholds:
  - `< 7` → H3 res 6 (overview hexagons, ~36 km²)
  - `>= 7` → H3 res 9 (detail, ~0.1 km²)
- Fetch on map `moveend`, debounced 400ms
- In-flight fetches abort on new moveend (`AbortController`)
- Click a cell → `get_provenance` → audit panel
- "Verify offline" reconstructs the Merkle root from the returned proof
  and checks the Ed25519 signature against the content hash — runs 100%
  client-side, no server trust
- Cost counter shows bytes-over-wire from real fetches vs an estimated
  tile-pyramid equivalent (tiles × 14kB) for rhetorical contrast
