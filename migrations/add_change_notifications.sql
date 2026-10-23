-- Migration: Add the change notification types (PostgreSQL)
-- Description: Widens notifications_type_check with assignment_changed (your
-- booking was added, changed or removed by someone else) and project_changed
-- (a change on a project you manage). The constraint is replaced only when it
-- does not allow project_changed yet.
--
-- USAGE: Run this on each existing tenant database
-- Example: python migrations/run_migration.py add_change_notifications
--   or:    psql -h localhost -U postgres -d tenant_db -f migrations/add_change_notifications.sql
--
-- Idempotent. The tenant auto-migration (tenant_manager._run_auto_migrations)
-- runs the same statement (tenant_provisioner.NOTIFICATIONS_TYPE_CHECK_SQL)
-- every time a tenant pool is created (1.15.0).

DO $$
BEGIN
    IF to_regclass('public.notifications') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.notifications')
          AND conname = 'notifications_type_check'
          AND strpos(pg_get_constraintdef(oid), 'project_changed') > 0
    ) THEN
        ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
        ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
            CHECK (type IN ('assigned', 'comment', 'mention', 'status_change', 'approval_requested', 'approval_decided', 'assignment_changed', 'project_changed'));
    END IF;
END $$;
