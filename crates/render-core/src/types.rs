//! Domain types for the render engine.
//!
//! All types are `serde`-serializable and `schemars`-schemable so they can be
//! surfaced directly in MCP tool schemas and HTTP JSON responses.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// -----------------------------------------------------------------------------
// Newtype wrappers
// -----------------------------------------------------------------------------

/// Tenant identifier. A UUID that maps to a row in `tenants`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct TenantId(pub Uuid);

impl TenantId {
    pub fn new(u: Uuid) -> Self {
        Self(u)
    }
    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl std::fmt::Display for TenantId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// Monotonic epoch id within a tenant. Starts at 0 (genesis).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(transparent)]
pub struct EpochId(pub i64);

impl EpochId {
    pub const GENESIS: EpochId = EpochId(0);
    pub fn new(n: i64) -> Self {
        Self(n)
    }
    pub fn as_i64(&self) -> i64 {
        self.0
    }
}

/// H3 cell index. Stored as u64 in-memory; serialized as a lowercase hex
/// string (e.g. `"8928308280fffff"`) to match H3 tooling conventions and to
/// preserve the full 64-bit value in JSON (which has no native u64).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct H3Cell(pub u64);

impl H3Cell {
    pub fn new(u: u64) -> Self {
        Self(u)
    }
    pub fn as_u64(&self) -> u64 {
        self.0
    }
    /// Reinterpret as i64 for Postgres BIGINT storage.
    pub fn as_i64(&self) -> i64 {
        self.0 as i64
    }
    pub fn from_i64(i: i64) -> Self {
        Self(i as u64)
    }

    /// Try to parse an H3 cell from a hex string (with or without 0x prefix).
    pub fn from_hex(s: &str) -> Result<Self, crate::CoreError> {
        let s = s.trim_start_matches("0x");
        u64::from_str_radix(s, 16)
            .map(H3Cell)
            .map_err(|e| crate::CoreError::InvalidH3Cell(e.to_string()))
    }

    /// Resolution (0-15) of this cell, via h3o.
    pub fn resolution(&self) -> u8 {
        h3o::CellIndex::try_from(self.0)
            .map(|c| u8::from(c.resolution()))
            .unwrap_or(u8::MAX)
    }
}

impl std::fmt::Display for H3Cell {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:x}", self.0)
    }
}

impl Serialize for H3Cell {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{:x}", self.0))
    }
}

impl<'de> Deserialize<'de> for H3Cell {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        H3Cell::from_hex(&s).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for H3Cell {
    fn schema_name() -> String {
        "H3Cell".to_string()
    }
    fn json_schema(_gen: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
        use schemars::schema::*;
        SchemaObject {
            instance_type: Some(InstanceType::String.into()),
            string: Some(Box::new(StringValidation {
                pattern: Some("^[0-9a-fA-F]{15,16}$".into()),
                ..Default::default()
            })),
            metadata: Some(Box::new(Metadata {
                description: Some("H3 cell index as lowercase hex (no 0x prefix)".into()),
                ..Default::default()
            })),
            ..Default::default()
        }
        .into()
    }
}

// -----------------------------------------------------------------------------
// Cell state
// -----------------------------------------------------------------------------

/// A cell state at a specific (tenant, h3, epoch).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CellState {
    pub tenant_id: TenantId,
    pub h3_cell: H3Cell,
    pub epoch_id: EpochId,
    pub identity_pk: HexBytes32,
    pub payload: serde_json::Value,
    pub content_hash: HexBytes32,
    pub signature: HexBytes64,
    pub written_at: DateTime<Utc>,
}

/// 32-byte hex-encoded blob (Ed25519 pubkey, blake3 hash, merkle root, etc.)
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HexBytes32(pub [u8; 32]);

impl HexBytes32 {
    pub fn from_slice(s: &[u8]) -> Result<Self, crate::CoreError> {
        if s.len() != 32 {
            return Err(crate::CoreError::Other(format!(
                "expected 32 bytes, got {}",
                s.len()
            )));
        }
        let mut a = [0u8; 32];
        a.copy_from_slice(s);
        Ok(Self(a))
    }
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl Serialize for HexBytes32 {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(self.0))
    }
}

impl<'de> Deserialize<'de> for HexBytes32 {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let v = hex::decode(&s).map_err(serde::de::Error::custom)?;
        HexBytes32::from_slice(&v).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for HexBytes32 {
    fn schema_name() -> String {
        "HexBytes32".to_string()
    }
    fn json_schema(_gen: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
        use schemars::schema::*;
        SchemaObject {
            instance_type: Some(InstanceType::String.into()),
            string: Some(Box::new(StringValidation {
                pattern: Some("^[0-9a-fA-F]{64}$".into()),
                ..Default::default()
            })),
            metadata: Some(Box::new(Metadata {
                description: Some("32 bytes as lowercase hex (64 chars)".into()),
                ..Default::default()
            })),
            ..Default::default()
        }
        .into()
    }
}

/// 64-byte hex-encoded Ed25519 signature.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HexBytes64(pub [u8; 64]);

impl HexBytes64 {
    pub fn from_slice(s: &[u8]) -> Result<Self, crate::CoreError> {
        if s.len() != 64 {
            return Err(crate::CoreError::Other(format!(
                "expected 64 bytes, got {}",
                s.len()
            )));
        }
        let mut a = [0u8; 64];
        a.copy_from_slice(s);
        Ok(Self(a))
    }
    pub fn as_bytes(&self) -> &[u8; 64] {
        &self.0
    }
}

impl Serialize for HexBytes64 {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(self.0))
    }
}

impl<'de> Deserialize<'de> for HexBytes64 {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let v = hex::decode(&s).map_err(serde::de::Error::custom)?;
        HexBytes64::from_slice(&v).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for HexBytes64 {
    fn schema_name() -> String {
        "HexBytes64".to_string()
    }
    fn json_schema(_gen: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
        use schemars::schema::*;
        SchemaObject {
            instance_type: Some(InstanceType::String.into()),
            string: Some(Box::new(StringValidation {
                pattern: Some("^[0-9a-fA-F]{128}$".into()),
                ..Default::default()
            })),
            metadata: Some(Box::new(Metadata {
                description: Some(
                    "64 bytes as lowercase hex (128 chars) — Ed25519 signature".into(),
                ),
                ..Default::default()
            })),
            ..Default::default()
        }
        .into()
    }
}

// -----------------------------------------------------------------------------
// Epoch
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Epoch {
    pub tenant_id: TenantId,
    pub epoch_id: EpochId,
    pub sealed_at: DateTime<Utc>,
    pub merkle_root: HexBytes32,
    pub parent_root: Option<HexBytes32>,
    pub cell_count: i64,
}

// -----------------------------------------------------------------------------
// Viewport & region queries
// -----------------------------------------------------------------------------

/// A viewport query. Can be specified in two modes:
/// * `parent_cell` — an H3 cell at a coarser resolution; we return its
///   children at `target_resolution`.
/// * `bbox` — a bounding box (lat/lng); we cover it with H3 cells.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum Viewport {
    ParentCell {
        parent: H3Cell,
        target_resolution: u8,
    },
    BoundingBox {
        south_west: LatLng,
        north_east: LatLng,
        resolution: u8,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
pub struct LatLng {
    pub lat: f64,
    pub lng: f64,
}

// -----------------------------------------------------------------------------
// Provenance
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Provenance {
    pub tenant_id: TenantId,
    pub h3_cell: H3Cell,
    pub epoch_id: EpochId,
    pub cell_state: CellState,
    /// Ordered list of attestations. Empty if none.
    pub attestations: Vec<Attestation>,
    /// Merkle proof: the sibling hashes needed to reconstruct
    /// `epoch.merkle_root` from this cell's `content_hash`.
    pub merkle_proof: Vec<HexBytes32>,
    /// This cell's position in the sorted leaf list at this epoch.
    /// Required by offline verifiers: the proof path is only
    /// interpretable with the leaf's index.
    pub leaf_index: u64,
    pub epoch: Epoch,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Attestation {
    pub attestation_id: Uuid,
    pub tenant_id: TenantId,
    pub h3_cell: H3Cell,
    pub epoch_id: EpochId,
    pub attester_pk: HexBytes32,
    pub claim: serde_json::Value,
    pub claim_hash: HexBytes32,
    pub signature: HexBytes64,
    pub issued_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}

// -----------------------------------------------------------------------------
// Rendered output (viewport render result)
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RenderedViewport {
    pub tenant_id: TenantId,
    pub viewport: Viewport,
    pub epoch_id: EpochId,
    pub cell_count: usize,
    /// Composited payload — rendering rules are application-specific; for v0.1
    /// this is the raw list of cell states. The compositor crate replaces this
    /// with a rasterized/geometric result in a follow-up version.
    pub cells: Vec<CellState>,
    /// Time spent in render pipeline (ms).
    pub render_ms: f64,
}
