-- Migration: Add tags tables (PostgreSQL)
-- Description: Creates tags and project_tags tables for project tagging
--
-- USAGE: Run this on each existing tenant database that needs the tags feature
-- Example: psql -h localhost -U postgres -d tenant_db -f migrations/add_tags_tables.sql
--
-- NOTE: Run as database superuser (postgres) to ensure proper grants

-- Tags table (global, shared across all sites)
CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Project tags association table (many-to-many)
CREATE TABLE IF NOT EXISTS project_tags (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, tag_id)
);

-- Indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_project_tags_project ON project_tags(project_id);
CREATE INDEX IF NOT EXISTS idx_project_tags_tag ON project_tags(tag_id);

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

    RAISE NOTICE 'Granted permissions to database owner: %', db_owner;
END $$;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Tags migration completed successfully';
    RAISE NOTICE 'Tables created: tags, project_tags';
END $$;
