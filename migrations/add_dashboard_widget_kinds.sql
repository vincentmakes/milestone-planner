-- Migration: Add the gauge, heatmap, treemap and sankey widget kinds (PostgreSQL)
-- Description: Widens dashboard_widgets_kind_check from kpi / bar / line /
-- pie / table to kpi / bar / line / pie / table / gauge / heatmap / treemap /
-- sankey. No row changes: every existing kind stays valid. Requires
-- add_dashboards (2.3.0).
--
-- It exists only for databases created from the pre-release 2.3.0 branch,
-- whose dashboard_widgets table carries the five-kind CHECK: the fresh-schema
-- sources (setup_databases.sql, the provisioner, the template) and
-- add_dashboards.sql create the nine kinds directly.
--
-- USAGE: Run this on each existing tenant database
-- Example: python migrations/run_migration.py add_dashboard_widget_kinds
--   or:    psql -h localhost -U postgres -d tenant_db -f migrations/add_dashboard_widget_kinds.sql
--
-- Idempotent (the block changes the CHECK only while it does not allow
-- 'sankey', the newest kind, and only when dashboard_widgets exists). The
-- application applies the same block itself (tenant_manager._run_auto_migrations,
-- tenant_provisioner.DASHBOARD_WIDGET_KIND_CHECK_SQL) on every tenant pool
-- creation, so running this file by hand is only needed when that step fails
-- (it logs an error naming this file).
--
-- NOTE: Run as database superuser (postgres) or the owner of dashboard_widgets

-- Widget kinds: gauge, heatmap, treemap and sankey (databases created from a pre-release build)
DO $$
BEGIN
    IF to_regclass('public.dashboard_widgets') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.dashboard_widgets')
          AND conname = 'dashboard_widgets_kind_check'
          AND strpos(pg_get_constraintdef(oid), 'sankey') > 0
    ) THEN
        ALTER TABLE dashboard_widgets DROP CONSTRAINT IF EXISTS dashboard_widgets_kind_check;
        ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_kind_check
            CHECK (kind IN ('kpi', 'bar', 'line', 'pie', 'table', 'gauge', 'heatmap', 'treemap', 'sankey'));
    END IF;
END $$;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Dashboard widget kinds migration completed successfully';
    RAISE NOTICE 'Widget kinds: kpi, bar, line, pie, table, gauge, heatmap, treemap, sankey';
END $$;
