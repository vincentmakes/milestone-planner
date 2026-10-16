-- Migration: Add tag groups and site-scoped tags (PostgreSQL)
-- Description: Creates tag_groups (single-select groups, at most one colouring
-- projects) and tag_sites (tags restricted to some sites), and adds
-- tags.group_id / tags.all_sites / tags.sort_order. Existing tags stay
-- ungrouped and available at every site.
--
-- USAGE: Run this on each existing tenant database
-- Example: psql -h localhost -U postgres -d tenant_db -f migrations/add_tag_groups_and_sites.sql
--   or:    python migrations/run_migration.py add_tag_groups_and_sites
--
-- Idempotent. The tenant auto-migration (tenant_manager._run_auto_migrations)
-- applies the same changes when a tenant pool is created.
--
-- Self-contained: also creates tags / project_tags (same DDL as
-- add_tags_tables.sql) on a tenant that predates them.
--
-- NOTE: Run as database superuser (postgres) to ensure proper grants

-- Tags + project tags (no-ops when add_tags_tables already ran)
CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_tags (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_project_tags_project ON project_tags(project_id);
CREATE INDEX IF NOT EXISTS idx_project_tags_tag ON project_tags(tag_id);

-- Tag groups
CREATE TABLE IF NOT EXISTS tag_groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    single_select BOOLEAN NOT NULL DEFAULT FALSE,
    colors_projects BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- At most one group colours projects
CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_groups_colors_projects
    ON tag_groups ((true)) WHERE colors_projects;

-- New tag columns
DO $$
BEGIN
    IF to_regclass('public.tags') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tags'
          AND column_name = 'group_id'
    ) THEN
        ALTER TABLE tags ADD COLUMN group_id INTEGER
            REFERENCES tag_groups(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.tags') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tags'
          AND column_name = 'all_sites'
    ) THEN
        ALTER TABLE tags ADD COLUMN all_sites BOOLEAN NOT NULL DEFAULT TRUE;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.tags') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tags'
          AND column_name = 'sort_order'
    ) THEN
        ALTER TABLE tags ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
    END IF;
END $$;

-- Tag <-> site links (consulted only when tags.all_sites is false)
CREATE TABLE IF NOT EXISTS tag_sites (
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (tag_id, site_id)
);

-- Indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_tags_group ON tags(group_id);
CREATE INDEX IF NOT EXISTS idx_tag_sites_site ON tag_sites(site_id);

-- Grant permissions to the database owner/app user
DO $$
DECLARE
    db_owner TEXT;
BEGIN
    SELECT pg_catalog.pg_get_userbyid(d.datdba) INTO db_owner
    FROM pg_catalog.pg_database d
    WHERE d.datname = current_database();

    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE tags TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE project_tags TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE tags_id_seq TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE tag_groups TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE tag_sites TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE tag_groups_id_seq TO %I', db_owner);

    RAISE NOTICE 'Granted permissions to database owner: %', db_owner;
END $$;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Tag groups migration completed successfully';
    RAISE NOTICE 'Tables created: tag_groups, tag_sites; columns added: tags.group_id, tags.all_sites, tags.sort_order';
END $$;
