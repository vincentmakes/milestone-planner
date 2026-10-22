-- Migration: Add unlinked booking segments to phase / subphase staff bookings (PostgreSQL)
-- Description: Adds start_date / end_date (DATE, NULL) to phase_staff_assignments
-- and subphase_staff_assignments, with a CHECK that both are NULL or both set
-- (<table>_segment_dates_check). Both NULL = a linked booking that follows its
-- phase / subphase, as before; both set = an unlinked segment with its own
-- dates inside the card. Existing rows stay linked. Columns and CHECK are added
-- only when missing.
--
-- USAGE: Run this on each existing tenant database
-- Example: python migrations/run_migration.py add_booking_segments
--   or:    psql -h localhost -U postgres -d tenant_db -f migrations/add_booking_segments.sql
--
-- Idempotent. The tenant auto-migration (tenant_manager._run_auto_migrations)
-- runs the same statements (tenant_provisioner.BOOKING_SEGMENT_COLUMN_STATEMENTS)
-- every time a tenant pool is created (1.17.0).

DO $$
BEGIN
    IF to_regclass('public.phase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'phase_staff_assignments'
          AND column_name = 'start_date'
    ) THEN
        ALTER TABLE phase_staff_assignments ADD COLUMN start_date DATE;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.phase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'phase_staff_assignments'
          AND column_name = 'end_date'
    ) THEN
        ALTER TABLE phase_staff_assignments ADD COLUMN end_date DATE;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.phase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.phase_staff_assignments')
          AND conname = 'phase_staff_assignments_segment_dates_check'
    ) THEN
        ALTER TABLE phase_staff_assignments ADD CONSTRAINT phase_staff_assignments_segment_dates_check
            CHECK ((start_date IS NULL) = (end_date IS NULL));
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.subphase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'subphase_staff_assignments'
          AND column_name = 'start_date'
    ) THEN
        ALTER TABLE subphase_staff_assignments ADD COLUMN start_date DATE;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.subphase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'subphase_staff_assignments'
          AND column_name = 'end_date'
    ) THEN
        ALTER TABLE subphase_staff_assignments ADD COLUMN end_date DATE;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.subphase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.subphase_staff_assignments')
          AND conname = 'subphase_staff_assignments_segment_dates_check'
    ) THEN
        ALTER TABLE subphase_staff_assignments ADD CONSTRAINT subphase_staff_assignments_segment_dates_check
            CHECK ((start_date IS NULL) = (end_date IS NULL));
    END IF;
END $$;
