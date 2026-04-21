#!/usr/bin/env node
/**
 * Example: call the MobyDB Render Engine, fetch a provenance bundle,
 * verify it offline.
 *
 *     cd scripts/clients/typescript
 *     npm install
 *     RENDER_URL=https://mobydb-render-engine-production.up.railway.app \
 *     MOBYDB_API_KEY=<64-hex> \
 *     npx tsx example.ts
 */

import { MobyDbClient } from "./client.ts";

const RENDER_URL = process.env.RENDER_URL;
const API_KEY    = process.env.MOBYDB_API_KEY;

if (!RENDER_URL || !API_KEY) {
    console.error("RENDER_URL and MOBYDB_API_KEY must be set");
    process.exit(1);
}

const client = new MobyDbClient({ endpoint: RENDER_URL, apiKey: API_KEY });

// The Rome-area cell from the seeded dataset
const h3 = "891e8052a0bffff";

// 1. Current state
const now = await client.getCellState({ h3_cell: h3 });
console.log("latest state:", JSON.stringify(now, null, 2));

// 2. Historical state (epoch 0)
const past = await client.getCellState({ h3_cell: h3, epoch_id: 0 });
console.log("epoch 0 state:", JSON.stringify(past, null, 2));

// 3. Full provenance bundle at epoch 2
const prov = await client.getProvenance({ h3_cell: h3, epoch_id: 2 });
console.log("provenance bundle:");
console.log(`  epoch root   : ${prov.epoch.merkle_root}`);
console.log(`  parent root  : ${prov.epoch.parent_root}`);
console.log(`  cell count   : ${prov.epoch.cell_count}`);
console.log(`  leaf index   : ${prov.leaf_index}`);
console.log(`  proof length : ${prov.merkle_proof.length}`);
console.log(`  attestations : ${prov.attestations.length}`);

// 4. Verify the bundle OFFLINE — no service trust required
const ok = await client.verifyProofLocally(prov);
console.log(`\noffline verification: ${ok ? "✓ VALID" : "✗ INVALID"}`);
