-- Migration: Absence types and multi-site company events (PostgreSQL)
-- Description: Adds the absence_types table (seeded with the default types),
--              vacations.absence_type_id (existing rows become "Holidays"),
--              and the company_event_sites junction so one company event can
--              apply to several sites.
--
-- USAGE: Run this on each existing tenant database.
-- Example: psql -h localhost -U postgres -d tenant_db -f migrations/add_absence_types_and_event_sites.sql
--      or: python migrations/run_migration.py add_absence_types_and_event_sites
--
-- NOTE: Run as database superuser (postgres) to ensure proper grants
--
-- Idempotent: safe to re-run. The same steps also run automatically on
-- tenant pool creation (tenant_manager._run_auto_migrations).

-- ---------------------------------------------------------------
-- 1. Absence types
-- ---------------------------------------------------------------
-- counts_as_unavailable = false means the person is away from the office but
-- still available for planning (e.g. Home Office), so capacity is not reduced.

CREATE TABLE IF NOT EXISTS absence_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    color VARCHAR(7) NOT NULL DEFAULT '#8b5cf6',
    counts_as_unavailable BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed only an empty table, so types an admin deleted are not re-created.
INSERT INTO absence_types (name, color, counts_as_unavailable, sort_order)
SELECT v.name, v.color, v.counts_as_unavailable, v.sort_order
FROM (VALUES
    ('Holidays', '#8b5cf6', TRUE, 0),
    ('Home Office', '#0ea5e9', FALSE, 1),
    ('Illness', '#ef4444', TRUE, 2),
    ('Business Trip', '#f59e0b', TRUE, 3),
    ('Training', '#10b981', TRUE, 4)
) AS v(name, color, counts_as_unavailable, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM absence_types);

-- ---------------------------------------------------------------
-- 2. vacations.absence_type_id
-- ---------------------------------------------------------------
-- NULL is treated as "unavailable" by the app, preserving today's behaviour.

-- The backfill runs only together with the column creation, so a re-run never
-- re-files absences whose type was later deleted (ON DELETE SET NULL).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'vacations'
          AND column_name = 'absence_type_id'
    ) THEN
        ALTER TABLE vacations ADD COLUMN absence_type_id INTEGER
            REFERENCES absence_types(id) ON DELETE SET NULL;

        -- Existing time off was all "vacation": file it under Holidays.
        UPDATE vacations
        SET absence_type_id = (SELECT id FROM absence_types WHERE name = 'Holidays');
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vacations_absence_type ON vacations(absence_type_id);

-- ---------------------------------------------------------------
-- 3. Multi-site company events
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS company_event_sites (
    event_id INTEGER NOT NULL REFERENCES company_events(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_company_event_sites_site ON company_event_sites(site_id);

-- Every existing event keeps its site. Runs even when the table already
-- existed (e.g. created empty by a newer schema run), and only touches events
-- without any link: the app keeps site_id equal to one of an event's linked
-- sites and deletes events left without any, so a re-run is a no-op.
INSERT INTO company_event_sites (event_id, site_id)
SELECT e.id, e.site_id
FROM company_events e
WHERE e.site_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM company_event_sites s WHERE s.event_id = e.id)
ON CONFLICT DO NOTHING;

-- company_events.site_id becomes a legacy column (first linked site).
ALTER TABLE company_events ALTER COLUMN site_id DROP NOT NULL;

-- Its FK used to cascade: deleting a site would delete events still shared
-- with other sites. Re-point it to SET NULL; the app removes events left
-- without any site.
DO $$
DECLARE
    fk_name TEXT;
BEGIN
    FOR fk_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'company_events'::regclass
          AND c.contype = 'f'
          AND a.attname = 'site_id'
          AND c.confdeltype <> 'n'
    LOOP
        EXECUTE format('ALTER TABLE company_events DROP CONSTRAINT %I', fk_name);
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'company_events'::regclass
          AND c.contype = 'f'
          AND a.attname = 'site_id'
    ) THEN
        ALTER TABLE company_events ADD CONSTRAINT company_events_site_id_fkey
            FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
    END IF;
END $$;

-- ---------------------------------------------------------------
-- Grant permissions to the database owner/app user
-- ---------------------------------------------------------------

DO $$
DECLARE
    db_owner TEXT;
BEGIN
    SELECT pg_catalog.pg_get_userbyid(d.datdba) INTO db_owner
    FROM pg_catalog.pg_database d
    WHERE d.datname = current_database();

    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE absence_types TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE company_event_sites TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE absence_types_id_seq TO %I', db_owner);

    RAISE NOTICE 'Granted permissions to database owner: %', db_owner;
END $$;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Absence types / multi-site events migration completed successfully';
    RAISE NOTICE 'Tables created: absence_types, company_event_sites';
    RAISE NOTICE 'Columns added: vacations.absence_type_id';
END $$;
