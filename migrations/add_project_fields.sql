-- Migration: Add project fields, convert tag groups (PostgreSQL)
-- Description: Creates project_fields (custom fields on projects: text,
-- number, toggle, select, multiselect), project_field_options (the items of
-- the dropdown fields) with their site and team links
-- (project_field_option_sites, project_field_option_teams),
-- project_field_values (a project's text / number / toggle values) and
-- project_field_selections (the items a project holds). Every foreign key
-- cascades. Then converts the tag groups into dropdown fields: a single-select
-- group becomes a 'select' field, any other group a 'multiselect' field; each
-- tag of a group becomes an item with its colour, order, sites and teams, and
-- every project carrying it keeps it as a selection. The grouped tags are
-- deleted, the remaining (ungrouped) tags renumbered, and tags.group_id and
-- tag_groups dropped (2.0.0). Requires the teams tables (add_teams).
--
-- USAGE: Run this on each existing tenant database
-- Example: python migrations/run_migration.py add_project_fields
--   or:    psql -h localhost -U postgres -d tenant_db -f migrations/add_project_fields.sql
--
-- Idempotent: the conversion runs only while tag_groups exists. The tenant
-- auto-migration (tenant_manager._run_auto_migrations) applies the same
-- statements (tenant_provisioner.PROJECT_FIELDS_SCHEMA_STATEMENTS and
-- PROJECT_FIELDS_MIGRATION_SQL) when a tenant pool is created (2.0.0).
--
-- NOTE: Run as database superuser (postgres) to ensure proper grants

-- Project fields
CREATE TABLE IF NOT EXISTS project_fields (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    field_type VARCHAR(20) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT project_fields_type_check
        CHECK (field_type IN ('text', 'number', 'toggle', 'select', 'multiselect'))
);

-- Items of the dropdown fields
CREATE TABLE IF NOT EXISTS project_field_options (
    id SERIAL PRIMARY KEY,
    field_id INTEGER NOT NULL REFERENCES project_fields(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
    all_sites BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT project_field_options_field_name_unique UNIQUE (field_id, name)
);

-- Item <-> site links (consulted only when all_sites is false)
CREATE TABLE IF NOT EXISTS project_field_option_sites (
    option_id INTEGER NOT NULL REFERENCES project_field_options(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (option_id, site_id)
);

-- Item <-> team links
CREATE TABLE IF NOT EXISTS project_field_option_teams (
    option_id INTEGER NOT NULL REFERENCES project_field_options(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    PRIMARY KEY (option_id, team_id)
);

-- Text / number / toggle values of a project (absent = empty)
CREATE TABLE IF NOT EXISTS project_field_values (
    id SERIAL PRIMARY KEY,
    field_id INTEGER NOT NULL REFERENCES project_fields(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    value_text TEXT,
    value_number DOUBLE PRECISION,
    value_bool BOOLEAN,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT project_field_values_field_project_unique UNIQUE (field_id, project_id)
);

-- Items chosen for a project's dropdown fields
CREATE TABLE IF NOT EXISTS project_field_selections (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    option_id INTEGER NOT NULL REFERENCES project_field_options(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, option_id)
);

-- Indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_project_field_option_sites_site ON project_field_option_sites(site_id);
CREATE INDEX IF NOT EXISTS idx_project_field_option_teams_team ON project_field_option_teams(team_id);
CREATE INDEX IF NOT EXISTS idx_project_field_values_project ON project_field_values(project_id);
CREATE INDEX IF NOT EXISTS idx_project_field_selections_option ON project_field_selections(option_id);

-- Convert the tag groups into dropdown fields (no-op once tag_groups is gone)
DO $$
DECLARE
    grp RECORD;
    grouped_tag RECORD;
    new_field_id INTEGER;
    new_option_id INTEGER;
    candidate TEXT;
    suffix TEXT;
    attempt INTEGER;
BEGIN
    IF to_regclass('public.tag_groups') IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'tags'
              AND column_name = 'group_id'
        ) THEN
            FOR grp IN
                SELECT id, name, single_select, sort_order FROM tag_groups
                ORDER BY sort_order, id
            LOOP
                candidate := grp.name;
                attempt := 1;
                WHILE EXISTS (
                    SELECT 1 FROM project_fields WHERE lower(name) = lower(candidate)
                ) LOOP
                    suffix := CASE WHEN attempt = 1 THEN ' (tags)'
                                   ELSE ' (tags ' || attempt || ')' END;
                    candidate := left(grp.name, 100 - length(suffix)) || suffix;
                    attempt := attempt + 1;
                END LOOP;

                INSERT INTO project_fields (name, field_type, sort_order)
                VALUES (
                    candidate,
                    CASE WHEN grp.single_select THEN 'select' ELSE 'multiselect' END,
                    grp.sort_order
                )
                RETURNING id INTO new_field_id;

                FOR grouped_tag IN
                    SELECT id, name, color, all_sites, sort_order FROM tags
                    WHERE group_id = grp.id
                    ORDER BY sort_order, name
                LOOP
                    INSERT INTO project_field_options
                        (field_id, name, color, all_sites, sort_order)
                    VALUES (
                        new_field_id, grouped_tag.name, grouped_tag.color,
                        grouped_tag.all_sites, grouped_tag.sort_order
                    )
                    RETURNING id INTO new_option_id;

                    INSERT INTO project_field_option_sites (option_id, site_id)
                    SELECT new_option_id, site_id FROM tag_sites
                    WHERE tag_id = grouped_tag.id;

                    INSERT INTO project_field_option_teams (option_id, team_id)
                    SELECT new_option_id, team_id FROM tag_teams
                    WHERE tag_id = grouped_tag.id;

                    INSERT INTO project_field_selections (project_id, option_id, assigned_at)
                    SELECT project_id, new_option_id, COALESCE(assigned_at, CURRENT_TIMESTAMP)
                    FROM project_tags
                    WHERE tag_id = grouped_tag.id;
                END LOOP;
            END LOOP;

            DELETE FROM tags WHERE group_id IS NOT NULL;

            UPDATE tags SET sort_order = ranked.position
            FROM (
                SELECT id, row_number() OVER (ORDER BY sort_order, name) - 1 AS position
                FROM tags
            ) AS ranked
            WHERE tags.id = ranked.id AND tags.sort_order <> ranked.position;

            DROP INDEX IF EXISTS idx_tags_group;
            ALTER TABLE tags DROP COLUMN IF EXISTS group_id;
        END IF;

        DROP TABLE tag_groups;
    END IF;
END $$;

-- Grant permissions to the database owner/app user
DO $$
DECLARE
    db_owner TEXT;
BEGIN
    SELECT pg_catalog.pg_get_userbyid(d.datdba) INTO db_owner
    FROM pg_catalog.pg_database d
    WHERE d.datname = current_database();

    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE project_fields TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE project_field_options TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE project_field_option_sites TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE project_field_option_teams TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE project_field_values TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE project_field_selections TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE project_fields_id_seq TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE project_field_options_id_seq TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE project_field_values_id_seq TO %I', db_owner);

    RAISE NOTICE 'Granted permissions to database owner: %', db_owner;
END $$;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Project fields migration completed successfully';
    RAISE NOTICE 'Tables created: project_fields, project_field_options, project_field_option_sites, project_field_option_teams, project_field_values, project_field_selections';
END $$;
