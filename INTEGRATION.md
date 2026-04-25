# lab-client crate — integration into mobydb-render-engine workspace

This bundle adds the `lab-client` crate to the workspace. The crate provides
a clean Rust trait (`LabClient`) with a Postgres implementation
(`PostgresLabClient`) for reading SignedPredictionRecord rows from the
GEIANT Lab's Supabase.

**Today's milestone:** crate compiles, unit tests pass for timestamp
formatting, and the integration test successfully fetches a known Lazio
record from the lab Supabase.

**Tomorrow / next session:** wire `LabClient` into `mcp-server` (Cargo.toml,
Config, AppState, http.rs route plumbing, tools.rs MCP registration). That
work is separate and depends on this crate compiling cleanly first.

---

## Files in this bundle

```
crates/lab-client/Cargo.toml              NEW
crates/lab-client/src/lib.rs              NEW
crates/lab-client/src/client.rs           NEW (LabClient trait)
crates/lab-client/src/error.rs            NEW (LabClientError)
crates/lab-client/src/types.rs            NEW (SignedPredictionRecord etc.)
crates/lab-client/src/postgres.rs         NEW (PostgresLabClient impl)
crates/lab-client/tests/integration.rs    NEW (live test against Supabase)
```

---

## Step 1 — drop files into repo

From the bundle's root:

```bash
cd ~/GNS-Foundation/mobydb-render-engine

# The tar will overwrite nothing because lab-client is all-new.
tar xzf ~/Downloads/lab_client_crate.tar.gz

# Verify
ls crates/lab-client/
# Expected: Cargo.toml, src/, tests/
```

## Step 2 — add lab-client to workspace members

Edit the root `Cargo.toml`. In the `[workspace] members = [...]` array,
add `"crates/lab-client"`:

```toml
[workspace]
resolver = "2"
members = [
    "crates/render-core",
    "crates/mobydb-client",
    "crates/mcp-server",
    "crates/seed-data",
    "crates/lab-client",          # <-- add this line
]
```

## Step 3 — verify compilation

```bash
cargo build -p lab-client
```

Expected: no errors. First build downloads sqlx + chrono dependencies; ~1-2
minutes the first time. If anything fails, paste the output.

## Step 4 — run the unit tests (no DB required)

```bash
cargo test -p lab-client --lib
```

This runs the embedded `ts_tests` module in `postgres.rs` — three tests
that verify the timestamp formatter produces Python-`isoformat()`-byte-
compatible output. These tests do NOT require a database. **They MUST
pass for the rest of today's work to be meaningful.**

Expected output:

```
running 3 tests
test postgres::ts_tests::format_matches_python_microseconds ... ok
test postgres::ts_tests::format_matches_python_padded_microseconds ... ok
test postgres::ts_tests::format_matches_python_zero_microseconds ... ok
```

## Step 5 — set up read-only Supabase role

In the Supabase SQL Editor for the lab project (`srjaqvbimkxvcdakiqer`):

```sql
-- Create a read-only role for the render engine.
CREATE ROLE render_engine_reader LOGIN PASSWORD '<STRONG_RANDOM_PASSWORD>';
GRANT USAGE ON SCHEMA public TO render_engine_reader;
GRANT SELECT ON public.predictions TO render_engine_reader;

-- Smoke test (run as render_engine_reader)
SET ROLE render_engine_reader;
SELECT COUNT(*) FROM predictions;  -- should return 10500
RESET ROLE;
```

Generate the password with: `openssl rand -base64 32`

Build the connection string. From the Supabase dashboard,
the host is the **pooler** endpoint:

```
LAB_DATABASE_URL=postgresql://render_engine_reader:<PASSWORD>@aws-1-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require
```

Note the username includes the project ref in some Supabase configs:
`postgres.srjaqvbimkxvcdakiqer.render_engine_reader`. Check the Supabase
"Connection Pooling" section of project settings to be sure.

## Step 6 — local integration test against the live lab DB

Add `LAB_DATABASE_URL` to a `.env` file at the repo root (do NOT commit
this file — `.gitignore` should already exclude it):

```bash
echo "LAB_DATABASE_URL=postgresql://render_engine_reader:..." >> .env
```

Run the integration test:

```bash
cargo test -p lab-client --test integration -- --nocapture
```

Expected: 4 tests pass, with the second one printing a real fetched record:

```
=== record fetched cleanly ===
  h3_cell           : 881e800001fffff
  epoch             : 774
  model_version     : sen1floods11@918b9f140bb1
  signer_public_key : voOKfWHUsYGPlMBMJHoK1rEJxuS_VfjgJAfPjCaQoFY
  delegation_chain  : baf40edcacf5759f03fd8b64f50a57f6bcfcfbd7f991d81f494a74aa2877499f
  acq_timestamp     : 2026-02-13T10:09:09.832000+00:00
  signed_at         : 2026-04-25T09:06:35.573651+00:00
  cloud_cover       : 1.9998
  trust_root        : h9TRb07XyhDu06h40PSEwcIOn-Z_Md_3GfShCm67vUs
```

If the integration test passes, **today's milestone is done**. The
crate is solid; mcp-server integration follows in the next session.

## Step 7 — commit + push

```bash
git add crates/lab-client/ Cargo.toml
git status
# Expected: 7 new files + modified root Cargo.toml

git commit -m "Add lab-client crate (trait + Postgres impl)

Read-only Rust client to the GEIANT Lab Supabase 'predictions' table.
Three trait methods (medium scope):

  fetch_signed_predictions  — full SignedPredictionRecord with optional
                              chain JSONs
  list_cells_for_model      — light (h3_cell, epoch) pairs for a model
  health                    — startup-time DB sanity check

Trust root pinned: GEIANT_LAB_ROOT_PUBKEY constant, distinct from the
render engine's primary trust root.

Cryptographic note: timestamp formatting matches Python's
datetime.isoformat() byte-for-byte ('+00:00' suffix, 6-digit microseconds)
so signatures verify offline downstream.

Workspace addition only. mcp-server integration follows in next commit."

git push origin main
```

## What this bundle deliberately does NOT do

- **No mcp-server changes.** The new tool, the AppState field, the
  http.rs route plumbing — all next session.
- **No frontend work.** verify.js and app.js untouched.
- **No deployment changes.** Railway is still serving exactly what it
  was serving before; this commit doesn't trigger a behavioral change.
- **No production traffic to the lab DB.** Only the integration test
  hits it, locally, when LAB_DATABASE_URL is set.

This is intentional. We're shipping the riskiest architectural piece
(the lab-client crate, which has cryptographic correctness constraints
in its timestamp formatting) standalone, with tests that prove it works.
The mcp-server integration in the next session is mechanical glue.

---

## Troubleshooting

### `cargo build -p lab-client` fails

Most likely cause: sqlx's tls feature mismatch. Check workspace
`Cargo.toml` — sqlx should have `runtime-tokio-rustls` as a feature.
The workspace dep already specifies this; if your local Cargo.lock got
stale, try:

```bash
cargo update -p sqlx
cargo build -p lab-client
```

### `cargo test -p lab-client --lib` ts_tests fail

The Python-compatible timestamp format is a hard correctness contract.
If the unit tests fail, the format string in `format_canonical_ts` was
edited or chrono's behavior changed. Don't ship until these pass.

### Integration test reports "LAB_DATABASE_URL not set"

That's a skip, not a failure. If you want it to actually run, ensure
the `.env` at the repo root is loaded. The test calls `dotenvy::dotenv()`
which looks for `.env` in the current dir or parents. Either run from
the repo root or `cd ~/GNS-Foundation/mobydb-render-engine && cargo
test -p lab-client --test integration -- --nocapture`.

### Integration test reports `Database` error

Most likely cause: read-only role wasn't granted SELECT on
`public.predictions`, or the connection string is wrong (look for
`could not find role`, `password authentication failed`, `permission
denied for table predictions`). Re-run the SQL in Step 5 against the
correct lab project.

### Integration test reports `Decoding` error

The lab schema has drifted (a new column added or removed, or a column
type changed). Compare against
`~/geiant-lab/src/geiant_lab/schema.py`'s DDL — every column referenced
in `row_to_record` must exist with the expected type.

### Integration test passes BUT `acquisition_timestamp` doesn't match

If the timestamp string is `2026-02-13T10:09:09.832000Z` (trailing `Z`)
instead of `+00:00`, chrono's behavior was overridden. Verify
`format_canonical_ts` is being called and the format string is exactly
`"%Y-%m-%dT%H:%M:%S%.6f+00:00"`.
