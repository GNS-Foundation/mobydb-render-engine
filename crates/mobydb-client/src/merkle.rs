//! Merkle proof construction.
//!
//! The epoch's `merkle_root` is the blake3 root over the ordered list of
//! `content_hash` values for every cell written at that epoch, ordered by
//! `h3_cell ASC`. This matches the ordering convention used by the GNS
//! breadcrumb chain (deterministic sort, no dependence on insertion time).
//!
//! Tree construction:
//!   * Leaves = the content hashes as-is (already 32 bytes).
//!   * Inner node = blake3(left || right).
//!   * If the layer has an odd number of nodes, the last node is duplicated
//!     (standard Bitcoin-style). This keeps proofs fixed-size for any input.
//!
//! Proof format: the list of sibling hashes from leaf to root. The verifier
//! reconstructs the root by iteratively hashing `(current, sibling)` where
//! `current` starts as the leaf's content hash. The sibling's position (left
//! or right) is determined by the leaf's index parity at each level — which
//! the verifier can compute from the leaf's index in the sorted list. For
//! v0.1 we bundle the index implicitly via h3_cell ordering: the verifier
//! recomputes position by looking up h3_cell's rank in the (known) epoch
//! cell list. A future optimization is to emit `(sibling_hash, is_right)`
//! tuples; out of scope here.

use render_core::{CoreError, CoreResult, HexBytes32};

/// Given an ordered list of `(h3_cell_i64, content_hash_bytes)`, construct the
/// merkle proof path for `target_h3`. Returns the sibling hashes leaf-to-root.
///
/// If `target_h3` is not in the list, returns `CellNotFound` semantics as a
/// `CoreError::Other` — the caller should have already validated the cell
/// exists at this epoch.
pub fn proof_for(ordered_leaves: &[(i64, Vec<u8>)], target_h3: i64) -> CoreResult<Vec<HexBytes32>> {
    if ordered_leaves.is_empty() {
        return Err(CoreError::Other("empty epoch: no leaves".into()));
    }

    let target_idx = ordered_leaves
        .iter()
        .position(|(h, _)| *h == target_h3)
        .ok_or_else(|| {
            CoreError::Other(format!(
                "target h3 {:x} not in epoch leaf set",
                target_h3 as u64
            ))
        })?;

    // Start with the leaf layer (clone hashes into [u8; 32] per leaf).
    let mut layer: Vec<[u8; 32]> = ordered_leaves
        .iter()
        .map(|(_, h)| {
            let mut a = [0u8; 32];
            if h.len() != 32 {
                return Err(CoreError::Other(format!(
                    "leaf hash wrong length: {}",
                    h.len()
                )));
            }
            a.copy_from_slice(h);
            Ok(a)
        })
        .collect::<CoreResult<_>>()?;

    let mut idx = target_idx;
    let mut proof: Vec<HexBytes32> = Vec::new();

    while layer.len() > 1 {
        // Pad odd layer by duplicating the last element.
        if layer.len() % 2 == 1 {
            let last = *layer.last().unwrap();
            layer.push(last);
        }

        // Record the sibling at this level.
        let sibling_idx = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
        proof.push(HexBytes32(layer[sibling_idx]));

        // Hash pairs into next layer.
        let mut next = Vec::with_capacity(layer.len() / 2);
        for chunk in layer.chunks(2) {
            let mut hasher = blake3::Hasher::new();
            hasher.update(&chunk[0]);
            hasher.update(&chunk[1]);
            next.push(*hasher.finalize().as_bytes());
        }
        layer = next;
        idx /= 2;
    }

    Ok(proof)
}

/// Verify that following `proof` from the leaf `content_hash` (at position
/// `leaf_idx` in an epoch of `leaf_count` cells) yields `expected_root`.
/// Kept here for use by tests and by the `verify_attestation` fast-path in a
/// future version (currently that tool delegates cell existence to the DB).
pub fn verify_proof(
    content_hash: &[u8; 32],
    leaf_idx: usize,
    leaf_count: usize,
    proof: &[HexBytes32],
    expected_root: &[u8; 32],
) -> bool {
    let mut current = *content_hash;
    let mut idx = leaf_idx;
    let mut layer_count = leaf_count;

    for sibling in proof {
        if layer_count % 2 == 1 {
            layer_count += 1;
        }
        let sibling_bytes = sibling.as_bytes();
        let mut hasher = blake3::Hasher::new();
        if idx % 2 == 0 {
            hasher.update(&current);
            hasher.update(sibling_bytes);
        } else {
            hasher.update(sibling_bytes);
            hasher.update(&current);
        }
        current = *hasher.finalize().as_bytes();
        idx /= 2;
        layer_count /= 2;
    }

    current == *expected_root
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(bytes: &[u8]) -> [u8; 32] {
        *blake3::hash(bytes).as_bytes()
    }

    #[test]
    fn roundtrip_single_leaf() {
        let leaves = vec![(42i64, hash(b"only").to_vec())];
        let proof = proof_for(&leaves, 42).unwrap();
        assert_eq!(proof.len(), 0); // single leaf = empty proof, root = leaf itself
    }

    #[test]
    fn roundtrip_four_leaves() {
        let leaves: Vec<(i64, Vec<u8>)> =
            (0..4).map(|i| (i, hash(&[i as u8; 32]).to_vec())).collect();

        // Build root independently to compare.
        let level0: Vec<[u8; 32]> = leaves
            .iter()
            .map(|(_, h)| {
                let mut a = [0u8; 32];
                a.copy_from_slice(h);
                a
            })
            .collect();
        let mut l1 = vec![];
        for c in level0.chunks(2) {
            let mut h = blake3::Hasher::new();
            h.update(&c[0]);
            h.update(&c[1]);
            l1.push(*h.finalize().as_bytes());
        }
        let mut h = blake3::Hasher::new();
        h.update(&l1[0]);
        h.update(&l1[1]);
        let expected_root = *h.finalize().as_bytes();

        // Prove + verify each leaf
        for i in 0..4 {
            let proof = proof_for(&leaves, i).unwrap();
            let leaf_hash = {
                let mut a = [0u8; 32];
                a.copy_from_slice(&leaves[i as usize].1);
                a
            };
            assert!(
                verify_proof(&leaf_hash, i as usize, 4, &proof, &expected_root),
                "proof for leaf {i} failed"
            );
        }
    }

    #[test]
    fn odd_leaf_count_padded() {
        let leaves: Vec<(i64, Vec<u8>)> =
            (0..3).map(|i| (i, hash(&[i as u8; 32]).to_vec())).collect();
        let proof0 = proof_for(&leaves, 0).unwrap();
        // With 3 leaves, last is duplicated → tree has 4 leaves effectively.
        // Each leaf's proof should be 2 long.
        assert_eq!(proof0.len(), 2);
    }
}
