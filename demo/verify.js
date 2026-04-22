import { ed25519 } from "https://esm.sh/@noble/curves@1.7.0/ed25519";
import { blake3 } from "https://esm.sh/@noble/hashes@1.6.0/blake3";

export function hexToBytes(hex) {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0) throw new Error("odd-length hex");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

export function bytesToHex(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
}

function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

function reconstructRoot(leaf, siblings, leafIdx) {
    let node = leaf;
    let idx = leafIdx;
    for (const sib of siblings) {
        const combined = (idx % 2 === 1) ? concat(sib, node) : concat(node, sib);
        node = blake3(combined);
        idx = Math.floor(idx / 2);
    }
    return node;
}

export function verifyProvenance(p) {
    try {
        const sig = hexToBytes(p.cell_state.signature);
        const pk  = hexToBytes(p.cell_state.identity_pk);
        const ch  = hexToBytes(p.cell_state.content_hash);
        const sigOk = ed25519.verify(sig, ch, pk);

        const reconstructed = reconstructRoot(
            ch,
            p.merkle_proof.map(hexToBytes),
            p.leaf_index,
        );
        const reconstructedHex = bytesToHex(reconstructed);
        const rootOk = bytesEqual(reconstructed, hexToBytes(p.epoch.merkle_root));

        return {
            ok: sigOk && rootOk,
            sigOk,
            rootOk,
            reconstructedHex,
            storedHex: p.epoch.merkle_root,
        };
    } catch (e) {
        return { ok: false, sigOk: false, rootOk: false, error: String(e.message || e) };
    }
}
