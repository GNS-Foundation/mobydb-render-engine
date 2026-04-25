// =============================================================================
// test_lab_verify.mjs — runs lab_verify.js against the real curl-3 record
// Run with:  node test_lab_verify.mjs
// Requires Node 19+ for SubtleCrypto Ed25519 support (verified on Node 20+).
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(import.meta.url);

const LabVerify = require(resolve(__dirname, "..", "demo", "lab_verify.js"));
const fixture   = JSON.parse(readFileSync(resolve(__dirname, "test_record.json"), 'utf8'));

const PASS = '\x1b[32m[PASS]\x1b[0m';
const FAIL = '\x1b[31m[FAIL]\x1b[0m';
const DIM  = '\x1b[2m';
const RST  = '\x1b[0m';

let failures = 0;
function expect(cond, label) {
    if (cond) console.log(`${PASS} ${label}`);
    else { console.log(`${FAIL} ${label}`); failures++; }
}

(async () => {
    // ---- 0. Sanity: SubtleCrypto Ed25519 available? ----
    try {
        await crypto.subtle.importKey(
            'raw',
            new Uint8Array(32),
            { name: 'Ed25519' },
            true,
            ['verify']
        );
        console.log(`${DIM}node version: ${process.version} — Ed25519 supported${RST}`);
    } catch (e) {
        console.log(`${FAIL} SubtleCrypto Ed25519 NOT supported by this Node`);
        console.log(`        ${e.message}`);
        console.log(`        Upgrade to Node 19+ (preferably 20+).`);
        process.exit(2);
    }

    // ---- 1. JCS sanity check ----
    const { jcs } = LabVerify._internal;
    expect(jcs({ b: 1, a: 2 }) === '{"a":2,"b":1}', 'JCS sorts keys');
    expect(jcs([3, 1, 2]) === '[3,1,2]',           'JCS preserves array order');
    expect(jcs({ x: null }) === '{"x":null}',       'JCS keeps explicit nulls');
    expect(jcs({ x: undefined }) === '{}',          'JCS drops undefined');
    expect(jcs(1.5) === '1.5',                      'JCS number');
    expect(jcs("hi") === '"hi"',                    'JCS string');

    // ---- 2. base64url round-trip ----
    const { b64uToBytes, bytesToB64u } = LabVerify._internal;
    const sample = 'voOKfWHUsYGPlMBMJHoK1rEJxuS_VfjgJAfPjCaQoFY';
    const bytes = b64uToBytes(sample);
    expect(bytes.length === 32, `b64u decode produces 32 bytes (got ${bytes.length})`);
    expect(bytesToB64u(bytes) === sample, 'b64u round-trips');

    // ---- 3. The headline test: verify the real record ----
    const record    = fixture.records[0];
    const trustRoot = fixture.trust_root;

    console.log(`\n${DIM}--- verifying real record from production ---${RST}`);
    console.log(`${DIM}h3_cell:       ${record.h3_cell}${RST}`);
    console.log(`${DIM}epoch:         ${record.epoch}${RST}`);
    console.log(`${DIM}signer:        ${record.signer_public_key.slice(0, 16)}…${RST}`);
    console.log(`${DIM}trust_root:    ${trustRoot.label} (${trustRoot.root_pubkey.slice(0, 16)}…)${RST}`);

    const verdict = await LabVerify.verifyLabRecord(record, trustRoot);

    console.log(`\n${DIM}--- verdict ---${RST}`);
    console.log(JSON.stringify(verdict, null, 2));

    expect(verdict.outer_signature_ok === true,        'outer Ed25519 signature verifies');
    expect(verdict.chain.length === 3,                 'chain depth = 3');
    expect(verdict.chain[0].role === 'gns-foundation-root', 'level 0 = gns-foundation-root');
    expect(verdict.chain[1].role === 'geiant-lab-env',      'level 1 = geiant-lab-env');
    expect(verdict.chain[2].role === 'prithvi-runtime',     'level 2 = prithvi-runtime');
    expect(verdict.chain.every(c => c.ok),             'all 3 cert links verify');
    expect(verdict.ok === true,                        'overall verdict: ok');

    // ---- 4. Tamper detection: flip one bit in raw_output_sha256 ----
    const tampered = JSON.parse(JSON.stringify(record));
    tampered.output.raw_output_sha256 =
        '0' + tampered.output.raw_output_sha256.slice(1);
    const tampVerdict = await LabVerify.verifyLabRecord(tampered, trustRoot);
    expect(tampVerdict.outer_signature_ok === false, 'tampered output → outer sig fails');
    expect(tampVerdict.ok === false,                 'tampered record overall: not ok');

    // ---- 5. Wrong trust root → must fail at anchor ----
    const wrongRoot = { label: 'Imposter', root_pubkey: 'A'.repeat(43) };
    const wrongVerdict = await LabVerify.verifyLabRecord(record, wrongRoot);
    expect(wrongVerdict.ok === false, 'wrong trust_root: not ok');
    expect(
        wrongVerdict.errors.some(e => e.toLowerCase().includes('trust anchor')),
        'wrong trust_root: errors mention trust anchor'
    );

    // ---- summary ----
    console.log(`\n${DIM}---${RST}`);
    if (failures === 0) {
        console.log(`${PASS} all checks passed`);
        process.exit(0);
    } else {
        console.log(`${FAIL} ${failures} check(s) failed`);
        process.exit(1);
    }
})().catch(e => {
    console.error('test harness crashed:', e);
    process.exit(2);
});
