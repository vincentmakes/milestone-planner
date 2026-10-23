-- Migration: Add dashboards (PostgreSQL)
-- Description: Creates dashboards (KPI and chart dashboards over the planning
-- data: name, description, owner (NULL = admin-owned), visibility private /
-- roles / everyone, at most one default -- partial unique index
-- dashboards_one_default), dashboard_roles (the roles a dashboard is shared
-- with) and dashboard_widgets (kind kpi / bar / line / pie / table, title, the
-- metric query, display options and grid layout as JSON texts, sort order).
-- Widgets and role links go with their dashboard; a role link also goes with
-- its role; a dashboard whose owner is deleted keeps existing (owner_id SET
-- NULL). Requires users and roles (add_rbac) (2.1.0).
--
-- USAGE: Run this on each existing tenant database
-- Example: python migrations/run_migration.py add_dashboards
--   or:    psql -h localhost -U postgres -d tenant_db -f migrations/add_dashboards.sql
--
-- Idempotent (IF NOT EXISTS everywhere). The tenant auto-migration
-- (tenant_manager._run_auto_migrations) applies the same statements
-- (tenant_provisioner.DASHBOARDS_SCHEMA_STATEMENTS) when a tenant pool is
-- created, and in that same step -- only when it finds a dashboards table
-- missing -- seeds the base "Overview" dashboard and grants views.dashboards
-- (superuser, user) and dashboards.manage (superuser). This file creates the
-- tables only: run by hand BEFORE the 2.1.0 application first starts on a
-- tenant, it leaves that tenant without the Overview and without those
-- grants (an admin can add both in the application).
--
-- NOTE: Run as database superuser (postgres) to ensure proper grants

-- Dashboards
CREATE TABLE IF NOT EXISTS dashboards (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    visibility VARCHAR(10) NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT dashboards_visibility_check
        CHECK (visibility IN ('private', 'roles', 'everyone'))
);

-- Roles a dashboard with visibility 'roles' is shared with
CREATE TABLE IF NOT EXISTS dashboard_roles (
    dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (dashboard_id, role_id)
);

-- Widgets of a dashboard (query / options / layout: JSON texts)
CREATE TABLE IF NOT EXISTS dashboard_widgets (
    id SERIAL PRIMARY KEY,
    dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    kind VARCHAR(12) NOT NULL,
    title VARCHAR(120) NOT NULL,
    query TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '{}',
    layout TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT dashboard_widgets_kind_check
        CHECK (kind IN ('kpi', 'bar', 'line', 'pie', 'table'))
);

-- Indexes (at most one default dashboard; faster lookups)
CREATE UNIQUE INDEX IF NOT EXISTS dashboards_one_default ON dashboards(is_default) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_dashboard_roles_role ON dashboard_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_dashboard ON dashboard_widgets(dashboard_id);

-- Grant permissions to the database owner/app user
DO $$
DECLARE
    db_owner TEXT;
BEGIN
    SELECT pg_catalog.pg_get_userbyid(d.datdba) INTO db_owner
    FROM pg_catalog.pg_database d
    WHERE d.datname = current_database();

    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE dashboards TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE dashboard_roles TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE dashboard_widgets TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE dashboards_id_seq TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE dashboard_widgets_id_seq TO %I', db_owner);

    RAISE NOTICE 'Granted permissions to database owner: %', db_owner;
END $$;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Dashboards migration completed successfully';
    RAISE NOTICE 'Tables created: dashboards, dashboard_roles, dashboard_widgets';
END $$;
