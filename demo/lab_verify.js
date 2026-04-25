// =============================================================================
// lab_verify.js — GEIANT Lab record verifier
// -----------------------------------------------------------------------------
// Verifies AI prediction records returned by `query_predictions` against the
// GEIANT Lab trust root. Pure crypto, no DOM. Uses SubtleCrypto Ed25519
// (Chrome 113+, Firefox 130+, Safari 17+) and an inline RFC 8785 JCS impl.
//
// Trust model (3-level delegation):
//   root_cert      gns-foundation-root  self-signed
//   lab_cert       geiant-lab-env       signed by root
//   runtime_cert   prithvi-runtime      signed by lab
//   record         signed by runtime cert's subject_public_key
//
// Public API:
//   verifyLabRecord(record, trustRoot) -> Promise<{ ok, error?, ... }>
//   verifyChain(record, trustRootPubkeyB64u) -> Promise<chainDetail>
//
// Both `record` and `trustRoot` are exactly as returned by the MCP tool:
//   record    = response.records[i]
//   trustRoot = response.trust_root          (note: distinct from render-engine root)
//
// Encoding conventions:
//   - Public keys & signatures are base64url (RFC 4648 §5, no padding)
//   - delegation_chain_hash is hex (informational only; not security-critical)
//   - Cert _json fields are JSON strings, already canonical
// =============================================================================

(function (root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        root.LabVerify = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ---------------------------------------------------------------
    // 1. base64url <-> Uint8Array
    // ---------------------------------------------------------------
    function b64uToBytes(s) {
        if (typeof s !== 'string') throw new Error('b64u: not a string');
        // base64url -> base64
        let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
        const pad = (4 - (b64.length % 4)) % 4;
        b64 += '='.repeat(pad);
        const bin = (typeof atob === 'function')
            ? atob(b64)
            : Buffer.from(b64, 'base64').toString('binary');
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function bytesToB64u(bytes) {
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const b64 = (typeof btoa === 'function')
            ? btoa(bin)
            : Buffer.from(bin, 'binary').toString('base64');
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    // ---------------------------------------------------------------
    // 2. RFC 8785 JCS canonicalizer (subset sufficient for our records)
    //    - Object keys sorted by UTF-16 code units
    //    - Numbers via ECMA-262 ToString (Number)
    //    - Strings re-encoded with JSON.stringify (browser/Node already
    //      produce RFC 8259-compliant JSON strings for non-pathological
    //      inputs; lab records do not contain control chars or surrogate
    //      pairs that require special handling)
    //    - undefined keys are dropped (not emitted as null)
    //    - Arrays preserved in order
    // ---------------------------------------------------------------
    function jcs(value) {
        if (value === null) return 'null';
        if (value === undefined) {
            throw new Error('jcs: undefined is not serializable; remove the field');
        }
        const t = typeof value;
        if (t === 'boolean') return value ? 'true' : 'false';
        if (t === 'number') {
            if (!Number.isFinite(value)) throw new Error('jcs: non-finite number');
            // ECMA-262 ToString — JS's default Number.prototype.toString already
            // matches the JCS-required form for the integers and decimal floats
            // present in our records (cloud_cover_percent, parameter_count, etc.)
            return Number(value).toString();
        }
        if (t === 'string') return JSON.stringify(value);
        if (Array.isArray(value)) {
            const parts = value.map(jcs);
            return '[' + parts.join(',') + ']';
        }
        if (t === 'object') {
            const keys = Object.keys(value)
                .filter(k => value[k] !== undefined)
                .sort(); // default String compare = UTF-16 code-unit order
            const parts = keys.map(k => JSON.stringify(k) + ':' + jcs(value[k]));
            return '{' + parts.join(',') + '}';
        }
        throw new Error('jcs: unsupported type ' + t);
    }

    // ---------------------------------------------------------------
    // 3. Ed25519 verify (SubtleCrypto)
    // ---------------------------------------------------------------
    async function ed25519Verify(pubkeyBytes, msgBytes, sigBytes) {
        const subtle = (typeof crypto !== 'undefined' && crypto.subtle) ||
                       (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle);
        if (!subtle) throw new Error('SubtleCrypto unavailable');
        const key = await subtle.importKey(
            'raw',
            pubkeyBytes,
            { name: 'Ed25519' },
            true,
            ['verify']
        );
        return await subtle.verify({ name: 'Ed25519' }, key, sigBytes, msgBytes);
    }

    // ---------------------------------------------------------------
    // 4. Cert verification
    //    A cert is an object with: subject_public_key, issued_by_public_key,
    //    subject_role, not_before, not_after, version, constraints,
    //    issued_at, parent_signature.
    //    The parent's signature is over JCS(cert minus parent_signature).
    // ---------------------------------------------------------------
    async function verifyCert(cert, parentPubkeyB64u, label) {
        const errs = [];
        const required = ['subject_public_key', 'issued_by_public_key', 'subject_role',
                          'not_before', 'not_after', 'version', 'parent_signature'];
        for (const k of required) {
            if (cert[k] === undefined) errs.push(`${label}: missing field "${k}"`);
        }
        if (errs.length) return { ok: false, errors: errs, role: cert.subject_role };

        // Temporal validity
        const nb = Date.parse(cert.not_before);
        const na = Date.parse(cert.not_after);
        const now = Date.now();
        const tempOk = Number.isFinite(nb) && Number.isFinite(na) && nb <= now && now <= na;
        if (!tempOk) errs.push(`${label}: outside validity window (${cert.not_before} → ${cert.not_after})`);

        // Issuer must match parent
        if (cert.issued_by_public_key !== parentPubkeyB64u) {
            errs.push(`${label}: issuer mismatch (cert says ${cert.issued_by_public_key}, expected ${parentPubkeyB64u})`);
        }

        // Verify signature
        let sigOk = false;
        try {
            const certBody = { ...cert };
            delete certBody.parent_signature;
            const canonical = jcs(certBody);
            const msgBytes = new TextEncoder().encode(canonical);
            const sigBytes = b64uToBytes(cert.parent_signature);
            const parentPkBytes = b64uToBytes(parentPubkeyB64u);
            sigOk = await ed25519Verify(parentPkBytes, msgBytes, sigBytes);
        } catch (e) {
            errs.push(`${label}: signature verify threw — ${e.message}`);
        }
        if (!sigOk && errs.length === 0) errs.push(`${label}: invalid signature`);

        return {
            ok: sigOk && tempOk && errs.length === 0,
            errors: errs,
            role: cert.subject_role,
            subject: cert.subject_public_key,
            issuer: cert.issued_by_public_key,
            validity: { not_before: cert.not_before, not_after: cert.not_after, current: tempOk },
            constraints: cert.constraints || {}
        };
    }

    // ---------------------------------------------------------------
    // 5. Outer record signature
    //
    //    The signed pre-image is JCS(signable_content(record)) — an
    //    explicit 8-field subset, NOT "everything minus signature_bytes".
    //    Source of truth: geiant_lab/schema.py :: signable_content()
    //
    //      { h3_cell, epoch, model_version,
    //        input, model, output, runtime,
    //        record_version }
    //
    //    Excluded by design (per the lab's docstring):
    //      - signer_public_key, signature_bytes, delegation_chain_hash
    //        (envelope; verified separately)
    //      - signed_at (so two signers attesting the same fact at the
    //        same cell/epoch/model produce identical canonical bytes)
    //      - root_cert_json, lab_cert_json, runtime_cert_json
    //        (chain artifacts, verified by the chain walk)
    // ---------------------------------------------------------------
    function signableContent(record) {
        return {
            h3_cell:        record.h3_cell,
            epoch:          record.epoch,
            model_version:  record.model_version,
            input:          record.input,
            model:          record.model,
            output:         record.output,
            runtime:        record.runtime,
            record_version: record.record_version,
        };
    }

    async function verifyOuterSignature(record) {
        try {
            const canonical = jcs(signableContent(record));
            const msgBytes  = new TextEncoder().encode(canonical);
            const sigBytes  = b64uToBytes(record.signature_bytes);
            const pkBytes   = b64uToBytes(record.signer_public_key);
            return await ed25519Verify(pkBytes, msgBytes, sigBytes);
        } catch (e) {
            return false;
        }
    }

    // ---------------------------------------------------------------
    // 6. Top-level: verifyLabRecord
    //    record    — one element of response.records
    //    trustRoot — response.trust_root  ({label, root_pubkey})
    // ---------------------------------------------------------------
    async function verifyLabRecord(record, trustRoot) {
        const errors = [];
        const result = {
            ok: false,
            trust_root: trustRoot && trustRoot.root_pubkey,
            trust_root_label: trustRoot && trustRoot.label,
            chain_depth: 0,
            signer: record && record.signer_public_key,
            outer_signature_ok: false,
            chain: [],   // [{role, ok, errors}, ...] root → leaf
            errors
        };

        if (!record) { errors.push('no record'); return result; }
        if (!trustRoot || !trustRoot.root_pubkey) { errors.push('no trust_root'); return result; }
        if (record.record_version !== 1) {
            errors.push(`unsupported record_version ${record.record_version}`);
            return result;
        }

        // Parse the three cert JSON strings
        let rootCert, labCert, runtimeCert;
        try {
            rootCert    = JSON.parse(record.root_cert_json);
            labCert     = JSON.parse(record.lab_cert_json);
            runtimeCert = JSON.parse(record.runtime_cert_json);
        } catch (e) {
            errors.push('cert JSON parse failed: ' + e.message);
            return result;
        }

        // Trust anchor: root cert's issuer must equal expected trust root
        if (rootCert.issued_by_public_key !== trustRoot.root_pubkey) {
            errors.push(`trust anchor mismatch: root cert issued by ${rootCert.issued_by_public_key}, expected ${trustRoot.root_pubkey}`);
        }
        // Root cert is self-signed
        if (rootCert.subject_public_key !== rootCert.issued_by_public_key) {
            errors.push(`root cert is not self-signed (subject ${rootCert.subject_public_key} !== issuer ${rootCert.issued_by_public_key})`);
        }

        // Verify chain links — each cert is signed by the parent's subject_public_key
        const rootCheck    = await verifyCert(rootCert,    rootCert.issued_by_public_key, 'root_cert');
        const labCheck     = await verifyCert(labCert,     rootCert.subject_public_key,    'lab_cert');
        const runtimeCheck = await verifyCert(runtimeCert, labCert.subject_public_key,     'runtime_cert');

        result.chain = [rootCheck, labCheck, runtimeCheck];
        result.chain_depth = result.chain.length;

        for (const c of result.chain) if (!c.ok) errors.push(...c.errors);

        // Runtime cert's subject must match record signer
        if (runtimeCert.subject_public_key !== record.signer_public_key) {
            errors.push(`signer mismatch: runtime cert subject ${runtimeCert.subject_public_key} !== record signer ${record.signer_public_key}`);
        }

        // Outer signature
        result.outer_signature_ok = await verifyOuterSignature(record);
        if (!result.outer_signature_ok) errors.push('outer record signature invalid');

        result.ok = errors.length === 0
                    && result.outer_signature_ok
                    && result.chain.every(c => c.ok);
        return result;
    }

    // ---------------------------------------------------------------
    // 7. Convenience: verify all records in a query_predictions response
    // ---------------------------------------------------------------
    async function verifyResponse(response) {
        if (!response || !Array.isArray(response.records) || !response.trust_root) {
            return { ok: false, error: 'malformed response' };
        }
        const verdicts = await Promise.all(
            response.records.map(r => verifyLabRecord(r, response.trust_root))
        );
        return {
            ok: verdicts.every(v => v.ok),
            trust_root: response.trust_root,
            count: verdicts.length,
            verdicts
        };
    }

    return {
        verifyLabRecord,
        verifyResponse,
        // exposed for testing
        _internal: { jcs, b64uToBytes, bytesToB64u, ed25519Verify, verifyCert, signableContent }
    };
}));
