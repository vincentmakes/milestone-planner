-- Migration: Multi-site equipment and site closures (PostgreSQL)
-- Description: Adds the equipment_sites junction so one piece of equipment can
--              belong to several sites (back-filled from equipment.site_id;
--              the legacy equipment.site_id FK is made ON DELETE SET NULL),
--              and company_events.counts_as_unavailable, which marks an event
--              as a site closure (staff of its sites are unavailable).
--
-- USAGE: Run this on each existing tenant database.
-- Example: psql -h localhost -U postgres -d tenant_db -f migrations/add_equipment_sites_and_site_closures.sql
--      or: python migrations/run_migration.py add_equipment_sites_and_site_closures
--
-- NOTE: Run as database superuser (postgres) to ensure proper grants
--
-- Idempotent: safe to re-run. The same steps also run automatically on
-- tenant pool creation (tenant_manager._run_auto_migrations).

-- ---------------------------------------------------------------
-- 1. Multi-site equipment
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS equipment_sites (
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (equipment_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_equipment_sites_site ON equipment_sites(site_id);

-- equipment.site_id stays as a legacy column (first linked site). Deleting a
-- site relies on its FK being ON DELETE SET NULL so shared equipment survives
-- (the app no longer cascades in the ORM). Every schema declares SET NULL,
-- but an old database might carry another delete rule, or no FK at all: any
-- site_id FK with another rule is dropped (whatever its name) and the SET NULL
-- one is added if missing -- after clearing site_id values that point at a
-- deleted site, as SET NULL would have. A no-op when the FK is already right.
-- Runs before the back-fill below, which those dangling ids would break.
DO $$
DECLARE
    fk_name TEXT;
BEGIN
    FOR fk_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = to_regclass('public.equipment')
          AND c.contype = 'f'
          AND a.attname = 'site_id'
          AND c.confdeltype <> 'n'
    LOOP
        EXECUTE format('ALTER TABLE equipment DROP CONSTRAINT %I', fk_name);
        RAISE NOTICE 'Dropped equipment.site_id FK % (delete rule was not SET NULL)', fk_name;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = to_regclass('public.equipment')
          AND c.contype = 'f'
          AND a.attname = 'site_id'
    ) THEN
        UPDATE equipment SET site_id = NULL
        WHERE site_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = equipment.site_id);
        ALTER TABLE equipment ADD CONSTRAINT equipment_site_id_fkey
            FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
        RAISE NOTICE 'Added equipment.site_id FK ON DELETE SET NULL';
    END IF;
END $$;

-- Every existing piece of equipment keeps its site. Runs even when the table
-- already existed (e.g. created empty by a newer schema run), and only touches
-- equipment without any link: the app keeps site_id equal to one of the
-- linked sites and deletes equipment left without any, so a re-run is a no-op.
INSERT INTO equipment_sites (equipment_id, site_id)
SELECT e.id, e.site_id
FROM equipment e
WHERE e.site_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM equipment_sites s WHERE s.equipment_id = e.id)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------
-- 2. Site closures
-- ---------------------------------------------------------------
-- counts_as_unavailable = true makes the staff of the event's sites
-- unavailable for the event's dates (default false keeps today's behaviour:
-- events are displayed but do not affect availability).

ALTER TABLE company_events
    ADD COLUMN IF NOT EXISTS counts_as_unavailable BOOLEAN NOT NULL DEFAULT FALSE;

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

    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE equipment_sites TO %I', db_owner);

    RAISE NOTICE 'Granted permissions to database owner: %', db_owner;
END $$;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Multi-site equipment / site closures migration completed successfully';
    RAISE NOTICE 'Tables created: equipment_sites';
    RAISE NOTICE 'Columns added: company_events.counts_as_unavailable';
END $$;
