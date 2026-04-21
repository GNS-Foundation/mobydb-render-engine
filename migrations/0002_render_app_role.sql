-- =============================================================================
-- 0002_render_app_role.sql
-- Non-superuser role for the render engine — required for RLS enforcement.
-- =============================================================================
-- The default `postgres` role on Railway has rolsuper=t and rolbypassrls=t,
-- which means RLS policies installed in 0001 are bypassed when connecting as
-- that role. This migration creates `render_app`, a role that:
--   * Has LOGIN
--   * Is NOT a superuser (NOSUPERUSER)
--   * Does NOT bypass RLS (NOBYPASSRLS)
--   * Has SELECT/INSERT/UPDATE/DELETE on public schema tables
--   * Cannot create DBs/roles/replicate (principle of least privilege)
--
-- The render service's DATABASE_URL uses THIS role, not postgres.
-- The postgres role stays for admin tasks (migrations, debugging).
--
-- Apply with:
--   psql "$RAILWAY_DB_URL" \
--       -v render_app_password="$RENDER_APP_PASSWORD" \
--       -v ON_ERROR_STOP=1 \
--       -f migrations/0002_render_app_role.sql
-- =============================================================================

-- ---- Idempotent role creation / password update ----
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'render_app') AS role_exists \gset

\if :role_exists
    \echo 'render_app role exists — updating password only'
    ALTER ROLE render_app WITH PASSWORD :'render_app_password';
\else
    \echo 'Creating render_app role'
    CREATE ROLE render_app LOGIN PASSWORD :'render_app_password';
\endif

-- ---- Enforce least-privilege attributes (idempotent) ----
-- NOBYPASSRLS is the critical one — without it, RLS policies are ignored.
ALTER ROLE render_app WITH
    NOSUPERUSER
    NOBYPASSRLS
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    LOGIN;

-- ---- Grants (idempotent — re-granting is a no-op) ----
-- Use current_database() so this works regardless of DB name.
DO $$
DECLARE
    db_name text := current_database();
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO render_app', db_name);
END $$;

GRANT USAGE ON SCHEMA public TO render_app;

-- Table-level DML
GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA public TO render_app;

-- Sequences (for any SERIAL/IDENTITY columns we add later)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO render_app;

-- Default privileges for future tables/sequences created by migrations
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO render_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO render_app;
