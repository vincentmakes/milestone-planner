-- Migration: Add dashboard sharing by site, team and person (PostgreSQL)
-- Description: Creates dashboard_sites, dashboard_teams and dashboard_users
-- (the sites -- their members --, teams -- their members -- and people a
-- dashboard is shared with, beside dashboard_roles). The visibility value
-- 'roles' becomes 'shared' (private / shared / everyone): a 'shared'
-- dashboard opens for anyone matching one of its roles, sites, teams or
-- people. A link goes with its dashboard and with its site, team or person.
-- Requires add_dashboards, sites, teams (add_teams) and users (2.1.0).
--
-- USAGE: Run this on each existing tenant database
-- Example: python migrations/run_migration.py add_dashboard_sharing
--   or:    psql -h localhost -U postgres -d tenant_db -f migrations/add_dashboard_sharing.sql
--
-- Idempotent (IF NOT EXISTS everywhere; the visibility block changes the
-- CHECK only while it does not allow 'shared'). The tenant auto-migration
-- (tenant_manager._run_auto_migrations) applies the same statements
-- (tenant_provisioner.DASHBOARD_SHARING_SCHEMA_STATEMENTS and
-- DASHBOARD_VISIBILITY_CHECK_SQL) when a tenant pool is created; nothing is
-- seeded.
--
-- NOTE: Run as database superuser (postgres) to ensure proper grants

-- Sites a dashboard is shared with (their members may open it)
CREATE TABLE IF NOT EXISTS dashboard_sites (
    dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (dashboard_id, site_id)
);

-- Teams a dashboard is shared with (their members may open it)
CREATE TABLE IF NOT EXISTS dashboard_teams (
    dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    PRIMARY KEY (dashboard_id, team_id)
);

-- People a dashboard is shared with
CREATE TABLE IF NOT EXISTS dashboard_users (
    dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (dashboard_id, user_id)
);

-- Indexes (dashboards shared with a site, team or person)
CREATE INDEX IF NOT EXISTS idx_dashboard_sites_site ON dashboard_sites(site_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_teams_team ON dashboard_teams(team_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_users_user ON dashboard_users(user_id);

-- Visibility 'roles' -> 'shared' (databases created from a pre-release build)
DO $$
BEGIN
    IF to_regclass('public.dashboards') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.dashboards')
          AND conname = 'dashboards_visibility_check'
          AND strpos(pg_get_constraintdef(oid), 'shared') > 0
    ) THEN
        ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS dashboards_visibility_check;
        UPDATE dashboards SET visibility = 'shared' WHERE visibility = 'roles';
        ALTER TABLE dashboards ADD CONSTRAINT dashboards_visibility_check
            CHECK (visibility IN ('private', 'shared', 'everyone'));
    END IF;
END $$;

-- Grant permissions to the database owner/app user
DO $$
DECLARE
    db_owner TEXT;
BEGIN
    SELECT pg_catalog.pg_get_userbyid(d.datdba) INTO db_owner
    FROM pg_catalog.pg_database d
    WHERE d.datname = current_database();

    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE dashboard_sites TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE dashboard_teams TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE dashboard_users TO %I', db_owner);

    RAISE NOTICE 'Granted permissions to database owner: %', db_owner;
END $$;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Dashboard sharing migration completed successfully';
    RAISE NOTICE 'Tables created: dashboard_sites, dashboard_teams, dashboard_users';
END $$;
