-- Migration: Add an optional note to equipment bookings (PostgreSQL)
-- Description: Adds equipment_assignments.note (TEXT, nullable): a free-text
-- note written when equipment is booked or edited, shown in the equipment
-- booking dialog, in the project manager's notification and in the site
-- export. The column is added only when it is missing.
--
-- USAGE: Run this on each existing tenant database
-- Example: python migrations/run_migration.py add_equipment_assignment_note
--   or:    psql -h localhost -U postgres -d tenant_db -f migrations/add_equipment_assignment_note.sql
--
-- Idempotent. The tenant auto-migration (tenant_manager._run_auto_migrations)
-- runs the same statement (tenant_provisioner.EQUIPMENT_ASSIGNMENTS_NOTE_SQL)
-- every time a tenant pool is created (2.0.0).

    DO $$
    BEGIN
        IF to_regclass('public.equipment_assignments') IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'equipment_assignments'
              AND column_name = 'note'
        ) THEN
            ALTER TABLE equipment_assignments ADD COLUMN note TEXT;
            
        END IF;
    END $$;
