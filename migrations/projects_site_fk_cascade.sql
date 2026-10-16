-- Migration: projects.site_id FK -> ON DELETE CASCADE (PostgreSQL)
-- Description: Deleting a site deletes its projects. The ORM always did
--              (Site.projects cascade), but the database FK said SET NULL, so
--              any delete outside the ORM -- or a crash mid-flush -- left
--              site-less projects nobody could see. Any projects.site_id FK
--              with another delete rule is dropped (whatever its name) and the
--              CASCADE one added; site ids pointing at a deleted site (only
--              possible without any FK) are cleared first, not deleted.
--
-- USAGE: python migrations/run_migration.py projects_site_fk_cascade
--    or: psql -d <tenant_db> -f migrations/projects_site_fk_cascade.sql
--
-- Idempotent: a no-op when the FK is already ON DELETE CASCADE. The same SQL
-- (tenant_provisioner.PROJECTS_SITE_FK_SQL) also runs automatically on tenant
-- pool creation (app.services.tenant_data_migrations) and in
-- get_tenant_schema_sql() / setup_databases.sql.

DO $$
DECLARE
    fk_name TEXT;
BEGIN
    FOR fk_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = to_regclass('public.projects')
          AND c.contype = 'f'
          AND a.attname = 'site_id'
          AND c.confdeltype <> 'c'
    LOOP
        EXECUTE format('ALTER TABLE projects DROP CONSTRAINT %I', fk_name);
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = to_regclass('public.projects')
          AND c.contype = 'f'
          AND a.attname = 'site_id'
    ) THEN
        UPDATE projects SET site_id = NULL
        WHERE site_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = projects.site_id);
        ALTER TABLE projects ADD CONSTRAINT projects_site_id_fkey
            FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;
    END IF;
END $$;
