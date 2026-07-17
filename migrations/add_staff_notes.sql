-- Migration: Create staff_notes and retire the legacy notes table
--
-- The Note SQLAlchemy model has always targeted staff_notes, but historic
-- install paths (tenant provisioner, manual schema template) created a
-- table named notes instead, so the notes feature had no working table.
-- This migration creates staff_notes to match the model, copies any rows
-- from a legacy notes table, and drops the legacy table.
--
-- Idempotent - safe to run multiple times.

CREATE TABLE IF NOT EXISTS staff_notes (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    date DATE NOT NULL,
    text TEXT NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'general',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_staff_notes_site_date ON staff_notes(site_id, date);

-- Copy rows from a legacy notes table (if present), then drop it. The app
-- never wrote to notes (the ORM always used staff_notes), so rows can only
-- come from manual inserts. Rows without a site_id are skipped because
-- staff_notes.site_id is NOT NULL. Legacy notes tables may or may not have
-- a type column, so both shapes are handled.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'notes'
    ) THEN
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'notes' AND column_name = 'type'
        ) THEN
            INSERT INTO staff_notes (site_id, staff_id, date, text, type, created_at)
            SELECT site_id, staff_id, date, text,
                   COALESCE(type, 'general'),
                   COALESCE(created_at, CURRENT_TIMESTAMP)
            FROM notes
            WHERE site_id IS NOT NULL;
        ELSE
            INSERT INTO staff_notes (site_id, staff_id, date, text, created_at)
            SELECT site_id, staff_id, date, text,
                   COALESCE(created_at, CURRENT_TIMESTAMP)
            FROM notes
            WHERE site_id IS NOT NULL;
        END IF;

        DROP TABLE notes;
        RAISE NOTICE 'Migrated legacy notes table into staff_notes and dropped it';
    END IF;
END $$;
