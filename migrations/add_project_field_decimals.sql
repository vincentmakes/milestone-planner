-- Migration: Add per-field decimals to number project fields (PostgreSQL)
-- Description: Adds project_fields.decimals (SMALLINT, nullable, CHECK 0-3):
-- how many decimals a number field keeps. New values are rounded half-up to
-- it when they are written; NULL keeps values as typed; stored values are
-- never rewritten when it changes. The column is added only when it is
-- missing.
--
-- USAGE: Run this on each existing tenant database
-- Example: python migrations/run_migration.py add_project_field_decimals
--   or:    psql -h localhost -U postgres -d tenant_db -f migrations/add_project_field_decimals.sql
--
-- Idempotent. The tenant auto-migration (tenant_manager._run_auto_migrations)
-- runs the same statement (tenant_provisioner.PROJECT_FIELD_DECIMALS_SQL)
-- every time a tenant pool is created (2.1.0).

    DO $$
    BEGIN
        IF to_regclass('public.project_fields') IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'project_fields'
              AND column_name = 'decimals'
        ) THEN
            ALTER TABLE project_fields ADD COLUMN decimals SMALLINT CONSTRAINT project_fields_decimals_check CHECK (decimals BETWEEN 0 AND 3);
            
        END IF;
    END $$;
