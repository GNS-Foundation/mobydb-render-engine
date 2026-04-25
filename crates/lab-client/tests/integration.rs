//! Integration test for `lab-client` against the real GEIANT Lab Supabase.
//!
//! Requires `LAB_DATABASE_URL` to be set (in `.env` at the repo root or in
//! the shell). If the variable is absent, the test is skipped with a
//! warning rather than failing — so CI without lab DB credentials still
//! passes for this crate.
//!
//! Run with:
//!   cd crates/lab-client && cargo test -- --nocapture
//!
//! Or from the workspace root:
//!   cargo test -p lab-client -- --nocapture

use lab_client::{Config, LabClient, PostgresLabClient, GEIANT_LAB_ROOT_PUBKEY};
use std::time::Duration;

fn lab_url() -> Option<String> {
    let _ = dotenvy::dotenv(); // ignore if no .env file present
    std::env::var("LAB_DATABASE_URL").ok().filter(|s| !s.is_empty())
}

#[tokio::test]
async fn connects_and_health_passes() {
    let Some(url) = lab_url() else {
        eprintln!("LAB_DATABASE_URL not set; skipping lab-client integration test");
        return;
    };

    let client = PostgresLabClient::connect(Config {
        database_url: url,
        pool_max: 2,
        connect_timeout: Duration::from_secs(10),
    })
    .await
    .expect("connect");

    client.health().await.expect("health");
}

#[tokio::test]
async fn fetches_known_lazio_record_with_chain() {
    let Some(url) = lab_url() else {
        eprintln!("LAB_DATABASE_URL not set; skipping lab-client integration test");
        return;
    };

    let client = PostgresLabClient::connect(Config {
        database_url: url,
        pool_max: 2,
        connect_timeout: Duration::from_secs(10),
    })
    .await
    .expect("connect");

    // This cell is the first cell in the Lazio Q1 2026 pilot
    // (deterministic — every-20th-of-10K, sorted h3_cell ASC).
    let cell = "881e800001fffff";
    let model = "sen1floods11@918b9f140bb1";

    let records = client
        .fetch_signed_predictions(cell, None, Some(model), 10, true)
        .await
        .expect("fetch");

    assert!(
        !records.is_empty(),
        "expected at least one Lazio record for cell {cell} model {model}"
    );

    let r = &records[0];

    // ---- core fields ----
    assert_eq!(r.h3_cell, cell);
    assert_eq!(r.model_version, model);
    assert_eq!(r.record_version, 1);
    assert_eq!(r.input.cloud_cover_percent.is_finite(), true);
    assert_eq!(r.output.output_shape.len(), 3);

    // ---- signature envelope ----
    // base64url, no padding, length 43 for a 32-byte Ed25519 pubkey
    assert_eq!(
        r.signer_public_key.len(),
        43,
        "signer_public_key should be 43 chars base64url, got {}: {}",
        r.signer_public_key.len(),
        r.signer_public_key
    );
    // base64url, no padding, length 86 for a 64-byte Ed25519 signature
    assert_eq!(
        r.signature_bytes.len(),
        86,
        "signature_bytes should be 86 chars base64url"
    );
    // SHA-256 hex = 64 chars
    assert_eq!(r.delegation_chain_hash.len(), 64);

    // ---- timestamp formatting (cryptographic correctness) ----
    // Format: YYYY-MM-DDTHH:MM:SS.uuuuuu+00:00 (32 chars)
    assert_eq!(
        r.input.acquisition_timestamp.len(),
        32,
        "acquisition_timestamp should be 32 chars, got {}: {}",
        r.input.acquisition_timestamp.len(),
        r.input.acquisition_timestamp
    );
    assert!(
        r.input.acquisition_timestamp.ends_with("+00:00"),
        "acquisition_timestamp must end with +00:00 (Python isoformat convention), got: {}",
        r.input.acquisition_timestamp
    );
    assert!(r.signed_at.ends_with("+00:00"));

    // ---- delegation chain present ----
    assert!(r.root_cert_json.is_some(), "root_cert_json missing");
    assert!(r.lab_cert_json.is_some(), "lab_cert_json missing");
    assert!(r.runtime_cert_json.is_some(), "runtime_cert_json missing");

    // ---- chain shapes ----
    let root: serde_json::Value =
        serde_json::from_str(r.root_cert_json.as_ref().unwrap()).expect("root cert json");
    assert_eq!(
        root.get("subject_public_key").and_then(|v| v.as_str()),
        Some(GEIANT_LAB_ROOT_PUBKEY),
        "root cert subject must be the GEIANT Lab root pubkey"
    );

    eprintln!("=== record fetched cleanly ===");
    eprintln!("  h3_cell           : {}", r.h3_cell);
    eprintln!("  epoch             : {}", r.epoch);
    eprintln!("  model_version     : {}", r.model_version);
    eprintln!("  signer_public_key : {}", r.signer_public_key);
    eprintln!("  delegation_chain  : {}", r.delegation_chain_hash);
    eprintln!("  acq_timestamp     : {}", r.input.acquisition_timestamp);
    eprintln!("  signed_at         : {}", r.signed_at);
    eprintln!("  cloud_cover       : {:?}", r.input.cloud_cover_percent);
    eprintln!("  trust_root        : {GEIANT_LAB_ROOT_PUBKEY}");
}

#[tokio::test]
async fn lists_cells_for_lazio_model() {
    let Some(url) = lab_url() else {
        eprintln!("LAB_DATABASE_URL not set; skipping lab-client integration test");
        return;
    };

    let client = PostgresLabClient::connect(Config {
        database_url: url,
        pool_max: 2,
        connect_timeout: Duration::from_secs(10),
    })
    .await
    .expect("connect");

    let pairs = client
        .list_cells_for_model("sen1floods11@918b9f140bb1", 1000)
        .await
        .expect("list");

    // We seeded ~500 Lazio records; the listing should reflect that scale.
    assert!(
        pairs.len() >= 100,
        "expected at least 100 Lazio cells, got {}",
        pairs.len()
    );

    // Each pair should be well-formed.
    for p in &pairs[..5.min(pairs.len())] {
        assert_eq!(p.h3_cell.as_str().len(), 15);
        assert!(p.epoch > 0);
    }

    eprintln!(
        "list_cells_for_model returned {} pairs; first pair: {} epoch={}",
        pairs.len(),
        pairs[0].h3_cell,
        pairs[0].epoch
    );
}

#[tokio::test]
async fn rejects_invalid_h3_cell() {
    let Some(url) = lab_url() else {
        eprintln!("LAB_DATABASE_URL not set; skipping lab-client integration test");
        return;
    };

    let client = PostgresLabClient::connect(Config {
        database_url: url,
        pool_max: 2,
        connect_timeout: Duration::from_secs(10),
    })
    .await
    .expect("connect");

    let result = client
        .fetch_signed_predictions("not-an-h3-cell", None, None, 10, false)
        .await;

    match result {
        Err(lab_client::LabClientError::InvalidH3Cell(_)) => { /* expected */ }
        other => panic!("expected InvalidH3Cell, got {:?}", other),
    }
}
