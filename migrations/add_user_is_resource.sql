-- Migration: Add the "Bookable as a resource" flag to users (PostgreSQL)
-- Description: Adds users.is_resource (BOOLEAN NOT NULL DEFAULT TRUE): the
-- person may be booked on projects and appears in the Staff panel. Existing
-- administrators are back-filled FALSE and everyone else keeps TRUE, so the
-- upgrade changes nobody's bookability. The column is added (and back-filled)
-- only when it is missing.
--
-- USAGE: Run this on each existing tenant database
-- Example: python migrations/run_migration.py add_user_is_resource
--   or:    psql -h localhost -U postgres -d tenant_db -f migrations/add_user_is_resource.sql
--
-- Idempotent. The tenant auto-migration (tenant_manager._run_auto_migrations)
-- runs the same statement (tenant_provisioner.USERS_IS_RESOURCE_SQL) every
-- time a tenant pool is created (1.16.0).

    DO $$
    BEGIN
        IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'users'
              AND column_name = 'is_resource'
        ) THEN
            ALTER TABLE users ADD COLUMN is_resource BOOLEAN NOT NULL DEFAULT TRUE;
            UPDATE users SET is_resource = FALSE WHERE role = 'admin';
        END IF;
    END $$;
