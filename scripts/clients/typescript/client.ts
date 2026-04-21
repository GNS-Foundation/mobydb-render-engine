/**
 * MobyDB Render Engine — TypeScript client.
 *
 * Minimal, dependency-free (except @noble/curves for Ed25519 verification
 * and @noble/hashes for blake3, both pure JS).  Copy this file into your
 * project and you're calling the service.
 *
 *     npm install @noble/curves @noble/hashes
 *
 * Usage:
 *
 *     import { MobyDbClient } from "./client.ts";
 *
 *     const c = new MobyDbClient({
 *         endpoint: "https://mobydb-render-engine-production.up.railway.app",
 *         apiKey:   process.env.MOBYDB_API_KEY!,
 *     });
 *
 *     const state = await c.getCellState({ h3_cell: "891e8052a0bffff" });
 *     const prov  = await c.getProvenance({ h3_cell: "891e8052a0bffff", epoch_id: 2 });
 *     const ok    = await c.verifyProofLocally(prov);
 *
 * All methods return typed results.  Errors surface as thrown `MobyDbError`.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";

// -----------------------------------------------------------------------------
// Types — mirror the JSON Schema returned by `tools/list`
// -----------------------------------------------------------------------------

export type UUID   = string;
export type H3Hex  = string;  // 15-16 hex chars
export type Hex32  = string;  // 64 hex chars — blake3 hash, Ed25519 pubkey
export type Hex64  = string;  // 128 hex chars — Ed25519 signature
export type EpochId = number;

export interface CellState {
    tenant_id:    UUID;
    h3_cell:      H3Hex;
    epoch_id:     EpochId;
    identity_pk:  Hex32;
    payload:      unknown;
    content_hash: Hex32;
    signature:    Hex64;
    written_at:   string;  // ISO 8601
}

export interface Epoch {
    tenant_id:   UUID;
    epoch_id:    EpochId;
    sealed_at:   string;
    merkle_root: Hex32;
    parent_root: Hex32 | null;
    cell_count:  number;
}

export interface Attestation {
    attestation_id: UUID;
    tenant_id:      UUID;
    h3_cell:        H3Hex;
    epoch_id:       EpochId;
    attester_pk:    Hex32;
    claim:          unknown;
    claim_hash:     Hex32;
    signature:      Hex64;
    issued_at:      string;
    expires_at:     string | null;
}

export interface Provenance {
    tenant_id:    UUID;
    h3_cell:      H3Hex;
    epoch_id:     EpochId;
    cell_state:   CellState;
    attestations: Attestation[];
    merkle_proof: Hex32[];
    /** This cell's position in the sorted leaf list at this epoch.
     *  Needed by offline verifiers to interpret the proof path. */
    leaf_index:   number;
    epoch:        Epoch;
}

export type Viewport =
    | { mode: "parent_cell";  parent: H3Hex; target_resolution: number }
    | { mode: "bounding_box"; south_west: LatLng; north_east: LatLng; resolution: number };

export interface LatLng { lat: number; lng: number }

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class MobyDbError extends Error {
    constructor(public code: number, message: string, public data?: unknown) {
        super(message);
        this.name = "MobyDbError";
    }
}

// -----------------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------------

export interface ClientConfig {
    endpoint: string;    // e.g. "https://mobydb-render-engine-production.up.railway.app"
    apiKey:   string;    // x-mobydb-api-key header value
    fetch?:   typeof fetch;   // for testing / non-browser envs
}

export class MobyDbClient {
    private url: string;
    private apiKey: string;
    private fetch: typeof fetch;
    private rpcId = 0;

    constructor(cfg: ClientConfig) {
        this.url    = cfg.endpoint.replace(/\/+$/, "") + "/mcp";
        this.apiKey = cfg.apiKey;
        this.fetch  = cfg.fetch ?? globalThis.fetch;
    }

    // --- Tool wrappers ---

    async renderViewport(args: {
        viewport: Viewport;
        epoch_id?: EpochId;
        max_cells?: number;
    }): Promise<{ cells: CellState[]; count: number; epoch?: EpochId }> {
        return this.call("render_viewport", args);
    }

    async getCellState(args: {
        h3_cell: H3Hex;
        epoch_id?: EpochId;
    }): Promise<{ cell_state: CellState | null }> {
        return this.call("get_cell_state", args);
    }

    async queryCellsInRegion(args: {
        viewport: Viewport;
        epoch_id?: EpochId;
        limit?: number;
    }): Promise<{ cells: CellState[]; count: number }> {
        return this.call("query_cells_in_region", args);
    }

    async getProvenance(args: {
        h3_cell: H3Hex;
        epoch_id: EpochId;
    }): Promise<Provenance> {
        return this.call("get_provenance", args);
    }

    async verifyAttestation(args: {
        attestation: Attestation;
    }): Promise<{
        claim_hash_ok: boolean;
        signature_ok:  boolean;
        cell_exists:   boolean;
        expired:       boolean;
        verdict:       "valid" | "invalid";
    }> {
        return this.call("verify_attestation", args);
    }

    // --- Offline verification ---

    /**
     * Verify a provenance bundle entirely offline.
     * Checks (a) the Ed25519 signature on cell_state and
     *        (b) that merkle_proof reconstructs the stored root.
     *
     * Returns true iff both pass.
     */
    async verifyProofLocally(p: Provenance): Promise<boolean> {
        // 1. Ed25519 signature on content_hash
        const sig   = hexToBytes(p.cell_state.signature);
        const pk    = hexToBytes(p.cell_state.identity_pk);
        const hash  = hexToBytes(p.cell_state.content_hash);
        if (!ed25519.verify(sig, hash, pk)) return false;

        // 2. Merkle proof reconstructs the stored root
        const reconstructed = reconstructRoot(
            hash,
            p.merkle_proof.map(hexToBytes),
            p.leaf_index,
            p.epoch.cell_count,
        );
        return bytesEqual(reconstructed, hexToBytes(p.epoch.merkle_root));
    }

    // --- Raw RPC ---

    private async call<T>(name: string, args: unknown): Promise<T> {
        const id = ++this.rpcId;
        const body = JSON.stringify({
            jsonrpc: "2.0", id, method: "tools/call",
            params: { name, arguments: args },
        });

        const resp = await this.fetch(this.url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-mobydb-api-key": this.apiKey,
            },
            body,
        });

        if (!resp.ok) {
            throw new MobyDbError(resp.status, `HTTP ${resp.status}: ${await resp.text()}`);
        }
        const rpc: {
            result?: { content: { type: "text"; text: string }[]; isError?: boolean; _meta?: unknown };
            error?:  { code: number; message: string; data?: unknown };
        } = await resp.json();

        if (rpc.error) {
            throw new MobyDbError(rpc.error.code, rpc.error.message, rpc.error.data);
        }
        if (!rpc.result) {
            throw new MobyDbError(-32603, "malformed response: missing result");
        }
        if (rpc.result.isError) {
            const msg = rpc.result.content?.[0]?.text ?? "tool error";
            throw new MobyDbError(-32000, msg);
        }
        const text = rpc.result.content?.[0]?.text ?? "{}";
        return JSON.parse(text) as T;
    }
}

// -----------------------------------------------------------------------------
// Merkle helpers (blake3 pair-hash, odd-layer duplicates last — same
// convention as the server).
// -----------------------------------------------------------------------------

/**
 * Reconstruct the root by folding the leaf up through the sibling hashes.
 * Must match the server's proof construction in
 * crates/mobydb-client/src/merkle.rs.
 */
function reconstructRoot(
    leaf:       Uint8Array,
    siblings:   Uint8Array[],
    leafIndex:  number,
    leafCount:  number,
): Uint8Array {
    let node = leaf;
    let idx  = leafIndex;
    let lenAtLayer = leafCount;

    for (const sib of siblings) {
        // Odd layer? Server duplicates the last node; if we're that last node,
        // our sibling IS ourselves.  Otherwise pair normally.
        const isRight = (idx % 2 === 1);
        const combined = isRight
            ? concat(sib, node)
            : concat(node, sib);
        node = blake3(combined);
        idx  = Math.floor(idx / 2);
        lenAtLayer = Math.ceil(lenAtLayer / 2);
    }
    return node;
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${clean.length}`);
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;  // constant-time
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
