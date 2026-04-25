//! Domain types for the lab-client.
//!
//! These types mirror the GEIANT Lab's Python `SignedPredictionRecord` and
//! its sub-types. The serialization (via `serde`) is what the
//! canonical-JSON-over-Ed25519 verification is computed against — the field
//! names and shapes here MUST match the Python signer byte-for-byte for
//! signatures to verify offline downstream.
//!
//! Specifically:
//!   - field names use `snake_case` exactly as in Python
//!   - `acquisition_timestamp` and `signed_at` are ISO 8601 strings with
//!     6-digit microsecond precision and a literal `+00:00` UTC offset,
//!     matching Python's `datetime.isoformat()` output
//!   - `cloud_cover_percent` is a `f64` (Postgres column is DOUBLE PRECISION)
//!   - `output_shape` is a list of `i32` (matches Python's int list output)
//!
//! See `crates/lab-client/src/postgres.rs::format_canonical_ts` for the
//! timestamp-formatting contract.

use serde::{Deserialize, Serialize};

/// A signed prediction record as stored in the lab's `predictions` table.
///
/// All fields except the chain JSONs are part of the canonically-signed
/// content. The signature in `signature_bytes` is over the Ed25519
/// signature of `canonical_json({h3_cell, epoch, model_version, input,
/// model, output, runtime, record_version})` — note `signed_at` and the
/// envelope fields are NOT part of the signed content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedPredictionRecord {
    // ---- canonically-signed content ----
    pub h3_cell: String,
    pub epoch: i64,
    pub model_version: String,
    pub input: InputAttestation,
    pub model: ModelAttestation,
    pub output: OutputAttestation,
    pub runtime: RuntimeFingerprint,
    pub record_version: i16,

    // ---- signature envelope (not part of signed content) ----
    /// Base64url (no padding) Ed25519 public key of the signer.
    pub signer_public_key: String,
    /// Base64url (no padding) Ed25519 signature over canonical JSON.
    pub signature_bytes: String,
    /// SHA-256 hex of the chain that authorizes `signer_public_key`.
    pub delegation_chain_hash: String,
    /// ISO 8601 UTC timestamp the signer recorded at sign time.
    pub signed_at: String,

    // ---- delegation chain (optional; omit on lighter responses) ----
    /// Canonical JSON of the GEIANT Lab root certificate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_cert_json: Option<String>,
    /// Canonical JSON of the lab certificate (root → lab delegation).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lab_cert_json: Option<String>,
    /// Canonical JSON of the runtime certificate (lab → runtime delegation).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_cert_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputAttestation {
    /// SHA-256 hex of the raw Sentinel-2 tile bytes the model was fed.
    pub input_tile_hash: String,
    /// STAC item ID the tile came from (e.g. "S2C_33TUG_20260213_0_L2A").
    pub stac_item_id: String,
    /// ISO 8601 UTC, 6-digit microseconds, "+00:00" suffix (Python
    /// `datetime.isoformat()` byte-for-byte).
    pub acquisition_timestamp: String,
    /// Cloud cover at acquisition, percent in [0.0, 100.0].
    pub cloud_cover_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelAttestation {
    /// HuggingFace repo ID
    /// (e.g. "ibm-nasa-geospatial/Prithvi-EO-2.0-300M-TL-Sen1Floods11").
    pub repo_id: String,
    /// Git commit hash of the model weights.
    pub commit_hash: String,
    /// SHA-256 of the weight file bytes.
    pub weight_sha256: String,
    /// Total parameter count of the model.
    pub parameter_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputAttestation {
    /// SHA-256 of the raw model output tensor bytes (encoder activations
    /// or similar, model-dependent).
    pub raw_output_sha256: String,
    /// SHA-256 of argmax-reduced output (per-pixel class indices).
    pub argmax_output_sha256: String,
    /// SHA-256 of binary-thresholded output (e.g. flood mask).
    pub binary_output_sha256: String,
    /// Tensor shape of the raw output, e.g. [1, 196, 1536].
    pub output_shape: Vec<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeFingerprint {
    /// `nvidia-smi` GPU name string (e.g. "NVIDIA A40").
    pub gpu_name: String,
    /// `nvidia-smi` driver version (e.g. "570.195.03").
    pub cuda_driver_version: String,
    /// CUDA toolkit version reported by the runtime (e.g. "12.8").
    pub cuda_version: String,
    /// torch.__version__ + CUDA suffix (e.g. "2.1.0+cu118").
    pub torch_version: String,
}

/// Lighter pair returned by [`LabClient::list_cells_for_model`]: just
/// enough for a frontend to know which (h3_cell, epoch) pairs exist for
/// a given model. Use [`LabClient::fetch_signed_predictions`] to fetch
/// the full signed record.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CellEpochPair {
    pub h3_cell: H3CellHex,
    pub epoch: i64,
}

/// A 15-character lowercase hexadecimal H3 cell index, copied as a fixed
/// array so it implements `Copy`. (The lab's H3 cells are always rendered
/// as exactly 15 hex chars; cells from coarser resolutions would be 14
/// chars or fewer, but the lab pipeline emits resolution 8 only.)
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct H3CellHex(pub [u8; 15]);

impl H3CellHex {
    /// Construct from a string slice. Returns None if the slice is not
    /// exactly 15 ASCII hex characters.
    pub fn from_str(s: &str) -> Option<Self> {
        if s.len() != 15 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let mut buf = [0u8; 15];
        buf.copy_from_slice(s.as_bytes());
        Some(Self(buf))
    }

    /// View as a UTF-8 string slice (always valid since the bytes are
    /// guaranteed ASCII at construction time).
    pub fn as_str(&self) -> &str {
        // Safe: only constructed from valid ASCII hex.
        std::str::from_utf8(&self.0).expect("H3CellHex bytes are valid ASCII")
    }
}

impl std::fmt::Display for H3CellHex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}
