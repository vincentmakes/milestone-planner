-- Migration: Add teams (PostgreSQL)
-- Description: Creates teams (a team belongs to one site, name unique per
-- site), team_members (users in a team) and the links from projects, tags,
-- company events and equipment to teams (project_teams, tag_teams,
-- company_event_teams, equipment_teams). Every foreign key cascades, so
-- deleting a site removes its teams and all their links.
--
-- USAGE: Run this on each existing tenant database
-- Example: python migrations/run_migration.py add_teams
--   or:    psql -h localhost -U postgres -d tenant_db -f migrations/add_teams.sql
--
-- Idempotent. The tenant auto-migration (tenant_manager._run_auto_migrations)
-- applies the same statements (tenant_provisioner.TEAMS_SCHEMA_STATEMENTS)
-- when a tenant pool is created (1.12.0).
--
-- NOTE: Run as database superuser (postgres) to ensure proper grants

-- Teams (per site)
CREATE TABLE IF NOT EXISTS teams (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    color VARCHAR(7),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT teams_site_name_unique UNIQUE (site_id, name)
);

-- Team members (many-to-many)
CREATE TABLE IF NOT EXISTS team_members (
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, user_id)
);

-- Project <-> team links (many-to-many)
CREATE TABLE IF NOT EXISTS project_teams (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, team_id)
);

-- Tag <-> team links (many-to-many)
CREATE TABLE IF NOT EXISTS tag_teams (
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    PRIMARY KEY (tag_id, team_id)
);

-- Company event <-> team links (many-to-many)
CREATE TABLE IF NOT EXISTS company_event_teams (
    event_id INTEGER NOT NULL REFERENCES company_events(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, team_id)
);

-- Equipment <-> team links (many-to-many)
CREATE TABLE IF NOT EXISTS equipment_teams (
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    PRIMARY KEY (equipment_id, team_id)
);

-- Indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_teams_site ON teams(site_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_project_teams_team ON project_teams(team_id);
CREATE INDEX IF NOT EXISTS idx_tag_teams_team ON tag_teams(team_id);
CREATE INDEX IF NOT EXISTS idx_company_event_teams_team ON company_event_teams(team_id);
CREATE INDEX IF NOT EXISTS idx_equipment_teams_team ON equipment_teams(team_id);

-- Grant permissions to the database owner/app user
DO $$
DECLARE
    db_owner TEXT;
BEGIN
    SELECT pg_catalog.pg_get_userbyid(d.datdba) INTO db_owner
    FROM pg_catalog.pg_database d
    WHERE d.datname = current_database();

    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE teams TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE team_members TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE project_teams TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE tag_teams TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE company_event_teams TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE equipment_teams TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE teams_id_seq TO %I', db_owner);

    RAISE NOTICE 'Granted permissions to database owner: %', db_owner;
END $$;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Teams migration completed successfully';
    RAISE NOTICE 'Tables created: teams, team_members, project_teams, tag_teams, company_event_teams, equipment_teams';
END $$;
