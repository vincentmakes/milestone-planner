-- ============================================================================
-- Milestone Database Setup Script
-- 
-- This script creates all required databases and tables for a fresh install.
-- Run as PostgreSQL superuser (e.g., postgres)
--
-- Usage:
--   psql -U postgres -f setup_databases.sql
--
-- Or step by step:
--   psql -U postgres -c "CREATE DATABASE milestone_master;"
--   psql -U postgres -d milestone_master -f setup_databases.sql
-- ============================================================================

-- ============================================================================
-- PART 1: MASTER DATABASE (Multi-tenant management)
-- ============================================================================

-- Create master database if not exists
-- Note: Run this as superuser before the rest of the script
-- CREATE DATABASE milestone_master;

-- Connect to master database
\c milestone_master;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Organizations table (for multi-tenant SSO)
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(63) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Organization SSO configuration (Microsoft Entra ID)
CREATE TABLE IF NOT EXISTS organization_sso_config (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    enabled INTEGER DEFAULT 0,
    provider VARCHAR(50) DEFAULT 'entra',
    entra_tenant_id VARCHAR(255),
    client_id VARCHAR(255),
    client_secret_encrypted TEXT,
    redirect_uri VARCHAR(500),
    auto_create_users INTEGER DEFAULT 0,
    default_user_role VARCHAR(20) DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tenants table
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(63) NOT NULL UNIQUE,
    database_name VARCHAR(63) NOT NULL UNIQUE,
    database_user VARCHAR(63) NOT NULL UNIQUE,
    status VARCHAR(20) DEFAULT 'active' NOT NULL,
    plan VARCHAR(50) DEFAULT 'standard',
    max_users INTEGER DEFAULT 50,
    max_projects INTEGER DEFAULT 100,
    admin_email VARCHAR(255) NOT NULL,
    company_name VARCHAR(255),
    settings JSONB DEFAULT '{}',
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    required_group_ids JSONB DEFAULT '[]',
    group_membership_mode VARCHAR(10) DEFAULT 'any',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tenant credentials (encrypted database passwords)
CREATE TABLE IF NOT EXISTS tenant_credentials (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    encrypted_password TEXT NOT NULL,
    password_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tenant audit log
CREATE TABLE IF NOT EXISTS tenant_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    actor VARCHAR(255),
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Admin users (for multi-tenant admin panel)
CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name VARCHAR(255),
    role VARCHAR(20) DEFAULT 'admin',
    active INTEGER DEFAULT 1,
    must_change_password INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- Admin sessions
CREATE TABLE IF NOT EXISTS admin_sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired BIGINT NOT NULL
);

-- Create index for session expiry cleanup
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expired ON admin_sessions(expired);

-- Create index for tenant lookups
CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_organization_id ON tenants(organization_id);

-- Create index for organization lookups
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

-- NOTE: Default admin user is no longer hardcoded here for security.
-- The application auto-creates an admin on first startup via master_db.verify_admin_exists().
-- To manually create an admin, use:
--   python -m app.scripts.create_admin --email admin@example.com --password <secure_password>

-- ============================================================================
-- PART 2: TENANT DATABASE TEMPLATE
-- 
-- This is the schema for each tenant's database.
-- When provisioning a new tenant, create a new database and run this section.
-- ============================================================================

-- Note: The following would be run on each tenant database
-- For a fresh single-tenant setup, create the database first:
-- CREATE DATABASE milestone_tenant1;

-- To create a tenant database manually:
-- 1. CREATE DATABASE milestone_<tenant_slug>;
-- 2. CREATE USER milestone_<tenant_slug> WITH PASSWORD '<secure_password>';
-- 3. GRANT ALL PRIVILEGES ON DATABASE milestone_<tenant_slug> TO milestone_<tenant_slug>;
-- 4. Connect to the new database and run the tenant schema below

-- ============================================================================
-- TENANT SCHEMA (run on each tenant database)
-- ============================================================================

-- Uncomment and modify for your tenant database:
-- \c milestone_tenant1;

-- Sites
CREATE TABLE IF NOT EXISTS sites (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    location VARCHAR(100),
    city VARCHAR(100),
    country_code VARCHAR(2),
    region_code VARCHAR(10),
    timezone VARCHAR(50) DEFAULT 'Europe/Zurich' NOT NULL,
    last_holiday_fetch TIMESTAMP,
    active INTEGER DEFAULT 1 NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Users (staff members)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    job_title VARCHAR(100),
    role VARCHAR(20) DEFAULT 'user' NOT NULL,
    max_capacity INTEGER DEFAULT 100 NOT NULL,
    sso_provider VARCHAR(50),
    sso_id VARCHAR(255),
    active INTEGER DEFAULT 1 NOT NULL,
    is_system INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT users_role_check CHECK (role IN ('admin', 'superuser', 'user'))
);

-- User-Site association (many-to-many)
CREATE TABLE IF NOT EXISTS user_sites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, site_id)
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    customer VARCHAR(200),
    pm_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sales_pm VARCHAR(200),
    confirmed INTEGER DEFAULT 0 NOT NULL,
    volume FLOAT,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    notes TEXT,
    archived INTEGER DEFAULT 0 NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Project phases
CREATE TABLE IF NOT EXISTS project_phases (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type VARCHAR(100) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_milestone INTEGER DEFAULT 0 NOT NULL,
    sort_order INTEGER DEFAULT 0 NOT NULL,
    completion INTEGER,
    status VARCHAR(20) DEFAULT 'todo' NOT NULL,
    dependencies TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT project_phases_status_check CHECK (status IN ('todo', 'in_progress', 'blocked', 'done'))
);

-- Project subphases (nested phases)
CREATE TABLE IF NOT EXISTS project_subphases (
    id SERIAL PRIMARY KEY,
    parent_id INTEGER NOT NULL,
    parent_type VARCHAR(20) DEFAULT 'phase' NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_milestone INTEGER DEFAULT 0 NOT NULL,
    sort_order INTEGER DEFAULT 0 NOT NULL,
    depth INTEGER DEFAULT 1 NOT NULL,
    completion INTEGER,
    status VARCHAR(20) DEFAULT 'todo' NOT NULL,
    dependencies TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT project_subphases_parent_type_check CHECK (parent_type IN ('phase', 'subphase')),
    CONSTRAINT project_subphases_status_check CHECK (status IN ('todo', 'in_progress', 'blocked', 'done'))
);

-- Project-level staff assignments
CREATE TABLE IF NOT EXISTS project_assignments (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    allocation INTEGER DEFAULT 100 NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Phase-level staff assignments
CREATE TABLE IF NOT EXISTS phase_staff_assignments (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    phase_id INTEGER NOT NULL REFERENCES project_phases(id) ON DELETE CASCADE,
    staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    allocation INTEGER DEFAULT 100 NOT NULL
);

-- Subphase-level staff assignments
CREATE TABLE IF NOT EXISTS subphase_staff_assignments (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    subphase_id INTEGER NOT NULL REFERENCES project_subphases(id) ON DELETE CASCADE,
    staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    allocation INTEGER DEFAULT 100 NOT NULL
);

-- Equipment. Equipment can be shared by several sites (equipment_sites);
-- site_id is a legacy column holding the first linked site.
CREATE TABLE IF NOT EXISTS equipment (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    type VARCHAR(100),
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    description TEXT,
    active INTEGER DEFAULT 1 NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Equipment <-> site links (many-to-many)
CREATE TABLE IF NOT EXISTS equipment_sites (
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (equipment_id, site_id)
);

-- Equipment assignments (bookings)
CREATE TABLE IF NOT EXISTS equipment_assignments (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Absence types (Holidays, Home Office, ...; global, admin-managed).
-- counts_as_unavailable = false keeps the person available for planning.
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

-- Vacations (staff time-off). A NULL absence_type_id counts as unavailable.
CREATE TABLE IF NOT EXISTS vacations (
    id SERIAL PRIMARY KEY,
    staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    description VARCHAR(200) DEFAULT 'Vacation' NOT NULL,
    absence_type_id INTEGER REFERENCES absence_types(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Upgrade of a database that predates absence types (before its index below).
-- Only adds the column: filing existing absences under "Holidays" is done once
-- by migrations/add_absence_types_and_event_sites.sql.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'vacations'
          AND column_name = 'absence_type_id'
    ) THEN
        ALTER TABLE vacations ADD COLUMN absence_type_id INTEGER
            REFERENCES absence_types(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Equipment blocks (maintenance / defect / calibration periods)
CREATE TABLE IF NOT EXISTS equipment_blocks (
    id SERIAL PRIMARY KEY,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason VARCHAR(50) DEFAULT 'maintenance' NOT NULL,
    description VARCHAR(200) DEFAULT 'Maintenance' NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Bank holidays
CREATE TABLE IF NOT EXISTS bank_holidays (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    end_date DATE,
    name VARCHAR(200) NOT NULL,
    is_custom INTEGER DEFAULT 0 NOT NULL,
    year INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT bank_holidays_unique UNIQUE (site_id, date, name)
);

-- Settings (key-value store)
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Predefined phases
CREATE TABLE IF NOT EXISTS predefined_phases (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0 NOT NULL,
    is_active INTEGER DEFAULT 1 NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- SSO configuration (singleton - only one row)
CREATE TABLE IF NOT EXISTS sso_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    enabled INTEGER DEFAULT 0 NOT NULL,
    tenant_id VARCHAR(100),
    client_id VARCHAR(100),
    client_secret VARCHAR(500),
    redirect_uri VARCHAR(500),
    auto_create_users INTEGER DEFAULT 0 NOT NULL,
    default_role VARCHAR(20) DEFAULT 'user' NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT sso_config_singleton CHECK (id = 1),
    CONSTRAINT sso_config_default_role_check CHECK (default_role IN ('superuser', 'user'))
);

-- Sessions (for express-session compatibility)
CREATE TABLE IF NOT EXISTS sessions (
    sid VARCHAR(255) PRIMARY KEY,
    sess TEXT NOT NULL,
    expired BIGINT NOT NULL
);

-- Tag groups (a single-select group allows one of its tags per project)
CREATE TABLE IF NOT EXISTS tag_groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    single_select BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tags (tenant-wide, assignable to projects; all_sites = false restricts a tag
-- to the sites in tag_sites)
CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
    group_id INTEGER REFERENCES tag_groups(id) ON DELETE SET NULL,
    all_sites BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Upgrade of a tags table from before tag groups / site-scoped tags (no-ops on
-- a fresh install). Same SQL as tenant_provisioner.TAGS_UPGRADE_SQL and
-- migrations/add_tag_groups_and_sites.sql.
DO $$
BEGIN
    IF NOT EXISTS (
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
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tags'
          AND column_name = 'all_sites'
    ) THEN
        ALTER TABLE tags ADD COLUMN all_sites BOOLEAN NOT NULL DEFAULT TRUE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
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

-- Project tags association (many-to-many)
CREATE TABLE IF NOT EXISTS project_tags (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, tag_id)
);

-- Company events (audits, meetings, etc. - displayed but don't affect working-day
-- calc, unless counts_as_unavailable marks the event as a site closure).
-- An event can apply to several sites (company_event_sites); site_id is a
-- legacy column holding the first linked site.
CREATE TABLE IF NOT EXISTS company_events (
    id SERIAL PRIMARY KEY,
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    date DATE NOT NULL,
    end_date DATE,
    name TEXT NOT NULL,
    color VARCHAR(20),
    counts_as_unavailable BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Company event <-> site links (many-to-many)
CREATE TABLE IF NOT EXISTS company_event_sites (
    event_id INTEGER NOT NULL REFERENCES company_events(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, site_id)
);

-- Teams (per site): a team groups users (team_members); projects, tags,
-- company events and equipment can be linked to teams. Every FK cascades, so
-- deleting a site removes its teams and all their links. Same DDL as
-- tenant_provisioner.TEAMS_SCHEMA_STATEMENTS and migrations/add_teams.sql.
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

-- Staff notes pinned to a site/date
CREATE TABLE IF NOT EXISTS staff_notes (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    date DATE NOT NULL,
    text TEXT NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'general',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Custom Gantt columns (user-defined)
CREATE TABLE IF NOT EXISTS custom_columns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    column_type VARCHAR(20) NOT NULL DEFAULT 'text' CHECK(column_type IN ('text', 'boolean', 'list')),
    list_options TEXT,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    display_order INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 120,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Custom column values (EAV)
CREATE TABLE IF NOT EXISTS custom_column_values (
    id SERIAL PRIMARY KEY,
    custom_column_id INTEGER NOT NULL REFERENCES custom_columns(id) ON DELETE CASCADE,
    entity_type VARCHAR(20) NOT NULL CHECK(entity_type IN ('project', 'phase', 'subphase')),
    entity_id INTEGER NOT NULL,
    value TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(custom_column_id, entity_type, entity_id)
);

-- Kanban card comments (a card is a leaf phase/subphase)
CREATE TABLE IF NOT EXISTS card_comments (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(20) NOT NULL,
    entity_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    mentioned_user_ids TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT card_comments_entity_type_check CHECK (entity_type IN ('phase', 'subphase'))
);

-- In-app notifications (one row per recipient)
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    entity_type VARCHAR(20),
    entity_id INTEGER,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    body TEXT,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT notifications_type_check CHECK (type IN ('assigned', 'comment', 'mention', 'status_change'))
);

-- Skills (global, shared across all sites)
CREATE TABLE IF NOT EXISTS skills (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User skills association (many-to-many)
CREATE TABLE IF NOT EXISTS user_skills (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    proficiency INTEGER NOT NULL DEFAULT 3 CHECK(proficiency >= 1 AND proficiency <= 5),
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, skill_id)
);

-- Project presence (active viewers for realtime collaboration)
CREATE TABLE IF NOT EXISTS project_presence (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity TEXT DEFAULT 'viewing' NOT NULL,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_presence_unique ON project_presence(project_id, user_id);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_projects_site_id ON projects(site_id);
CREATE INDEX IF NOT EXISTS idx_projects_pm_id ON projects(pm_id);
CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived);
CREATE INDEX IF NOT EXISTS idx_project_phases_project_id ON project_phases(project_id);
CREATE INDEX IF NOT EXISTS idx_project_subphases_project_id ON project_subphases(project_id);
CREATE INDEX IF NOT EXISTS idx_project_subphases_parent ON project_subphases(parent_type, parent_id);
CREATE INDEX IF NOT EXISTS idx_card_comments_entity ON card_comments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_card_comments_project ON card_comments(project_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_assignments_project_id ON project_assignments(project_id);
CREATE INDEX IF NOT EXISTS idx_project_assignments_staff_id ON project_assignments(staff_id);
CREATE INDEX IF NOT EXISTS idx_phase_staff_assignments_phase_id ON phase_staff_assignments(phase_id);
CREATE INDEX IF NOT EXISTS idx_phase_staff_assignments_project_id ON phase_staff_assignments(project_id);
CREATE INDEX IF NOT EXISTS idx_phase_staff_assignments_staff_id ON phase_staff_assignments(staff_id);
CREATE INDEX IF NOT EXISTS idx_subphase_staff_assignments_subphase_id ON subphase_staff_assignments(subphase_id);
CREATE INDEX IF NOT EXISTS idx_subphase_staff_assignments_project_id ON subphase_staff_assignments(project_id);
CREATE INDEX IF NOT EXISTS idx_equipment_site_id ON equipment(site_id);
CREATE INDEX IF NOT EXISTS idx_equipment_sites_site ON equipment_sites(site_id);
CREATE INDEX IF NOT EXISTS idx_equipment_assignments_project_id ON equipment_assignments(project_id);
CREATE INDEX IF NOT EXISTS idx_equipment_assignments_equipment_id ON equipment_assignments(equipment_id);
CREATE INDEX IF NOT EXISTS idx_vacations_staff_id ON vacations(staff_id);
CREATE INDEX IF NOT EXISTS idx_vacations_absence_type ON vacations(absence_type_id);
CREATE INDEX IF NOT EXISTS idx_equipment_blocks_equipment_id ON equipment_blocks(equipment_id);
CREATE INDEX IF NOT EXISTS idx_equipment_blocks_dates ON equipment_blocks(start_date, end_date);

-- Ensure color column exists on pre-existing company_events tables (upgrades)
ALTER TABLE IF EXISTS company_events ADD COLUMN IF NOT EXISTS color VARCHAR(20);

-- Site closures on pre-existing company_events tables (upgrades)
ALTER TABLE IF EXISTS company_events
    ADD COLUMN IF NOT EXISTS counts_as_unavailable BOOLEAN NOT NULL DEFAULT FALSE;

-- Multi-site equipment on pre-existing databases (upgrades; no-ops on a fresh
-- install): the legacy equipment.site_id FK is made ON DELETE SET NULL (site
-- deletion relies on it to keep shared equipment; dangling ids are cleared
-- first), then equipment without any site link is linked to its legacy site.
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
    END IF;
END $$;

INSERT INTO equipment_sites (equipment_id, site_id)
SELECT e.id, e.site_id
FROM equipment e
WHERE e.site_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM equipment_sites s WHERE s.equipment_id = e.id)
ON CONFLICT DO NOTHING;

-- Multi-site company events on pre-existing databases (upgrades; no-ops on a
-- fresh install): the legacy site_id becomes nullable, its FK stops cascading,
-- and events without any site link are linked to their legacy site.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'company_events'
          AND column_name = 'site_id' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE company_events ALTER COLUMN site_id DROP NOT NULL;
    END IF;
END $$;

DO $$
DECLARE
    fk_name TEXT;
BEGIN
    FOR fk_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = to_regclass('public.company_events')
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
        WHERE c.conrelid = to_regclass('public.company_events')
          AND c.contype = 'f'
          AND a.attname = 'site_id'
    ) THEN
        ALTER TABLE company_events ADD CONSTRAINT company_events_site_id_fkey
            FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
    END IF;
END $$;

INSERT INTO company_event_sites (event_id, site_id)
SELECT e.id, e.site_id
FROM company_events e
WHERE e.site_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM company_event_sites s WHERE s.event_id = e.id)
ON CONFLICT DO NOTHING;

-- Deleting a site deletes its projects (pre-existing databases; no-op on a
-- fresh install): the projects.site_id FK is made ON DELETE CASCADE, matching
-- the ORM. Same SQL as tenant_provisioner.PROJECTS_SITE_FK_SQL and
-- migrations/projects_site_fk_cascade.sql.
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

-- Comments outlive their author (pre-existing databases; no-op on a fresh
-- install): card_comments.author_id becomes nullable, ON DELETE SET NULL. Same
-- SQL as tenant_provisioner.CARD_COMMENTS_AUTHOR_FK_SQL and
-- migrations/card_comments_author_set_null.sql.
DO $$
DECLARE
    fk_name TEXT;
BEGIN
    IF to_regclass('public.card_comments') IS NULL THEN
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'card_comments'
          AND column_name = 'author_id' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE card_comments ALTER COLUMN author_id DROP NOT NULL;
    END IF;

    FOR fk_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = to_regclass('public.card_comments')
          AND c.contype = 'f'
          AND a.attname = 'author_id'
          AND c.confdeltype <> 'n'
    LOOP
        EXECUTE format('ALTER TABLE card_comments DROP CONSTRAINT %I', fk_name);
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = to_regclass('public.card_comments')
          AND c.contype = 'f'
          AND a.attname = 'author_id'
    ) THEN
        UPDATE card_comments SET author_id = NULL
        WHERE author_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = card_comments.author_id);
        ALTER TABLE card_comments ADD CONSTRAINT card_comments_author_id_fkey
            FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Custom-column values and card comments left behind by deleted projects,
-- phases and subphases (polymorphic rows, no FK). Same statements as
-- migrations/cleanup_orphaned_values.sql.
DELETE FROM custom_column_values v
WHERE (v.entity_type = 'project'
       AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = v.entity_id))
   OR (v.entity_type = 'phase'
       AND NOT EXISTS (SELECT 1 FROM project_phases ph WHERE ph.id = v.entity_id))
   OR (v.entity_type = 'subphase'
       AND NOT EXISTS (SELECT 1 FROM project_subphases sp WHERE sp.id = v.entity_id));

DELETE FROM card_comments cc
WHERE (cc.entity_type = 'phase'
       AND NOT EXISTS (SELECT 1 FROM project_phases ph WHERE ph.id = cc.entity_id))
   OR (cc.entity_type = 'subphase'
       AND NOT EXISTS (SELECT 1 FROM project_subphases sp WHERE sp.id = cc.entity_id));

CREATE INDEX IF NOT EXISTS idx_bank_holidays_site_id ON bank_holidays(site_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
CREATE INDEX IF NOT EXISTS idx_project_tags_project ON project_tags(project_id);
CREATE INDEX IF NOT EXISTS idx_project_tags_tag ON project_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_tags_group ON tags(group_id);
CREATE INDEX IF NOT EXISTS idx_tag_sites_site ON tag_sites(site_id);
CREATE INDEX IF NOT EXISTS idx_company_events_site_date ON company_events(site_id, date);
CREATE INDEX IF NOT EXISTS idx_company_event_sites_site ON company_event_sites(site_id);
CREATE INDEX IF NOT EXISTS idx_teams_site ON teams(site_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_project_teams_team ON project_teams(team_id);
CREATE INDEX IF NOT EXISTS idx_tag_teams_team ON tag_teams(team_id);
CREATE INDEX IF NOT EXISTS idx_company_event_teams_team ON company_event_teams(team_id);
CREATE INDEX IF NOT EXISTS idx_equipment_teams_team ON equipment_teams(team_id);
CREATE INDEX IF NOT EXISTS idx_staff_notes_site_date ON staff_notes(site_id, date);
CREATE INDEX IF NOT EXISTS idx_custom_columns_site_id ON custom_columns(site_id);
CREATE INDEX IF NOT EXISTS idx_custom_column_values_column_id ON custom_column_values(custom_column_id);
CREATE INDEX IF NOT EXISTS idx_custom_column_values_entity ON custom_column_values(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_user_skills_user ON user_skills(user_id);
CREATE INDEX IF NOT EXISTS idx_user_skills_skill ON user_skills(skill_id);
CREATE INDEX IF NOT EXISTS idx_project_presence_project ON project_presence(project_id);
CREATE INDEX IF NOT EXISTS idx_project_presence_user ON project_presence(user_id);
CREATE INDEX IF NOT EXISTS idx_project_presence_last_seen ON project_presence(last_seen_at);

-- Insert default predefined phases
INSERT INTO predefined_phases (name, sort_order, is_active) VALUES
    ('Preparation', 1, 1),
    ('Analytics', 2, 1),
    ('Trial', 3, 1),
    ('Cleaning', 4, 1),
    ('Report', 5, 1)
ON CONFLICT (name) DO NOTHING;

-- Insert default absence types (only into an empty table)
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

-- Insert default settings
INSERT INTO settings (key, value) VALUES
    ('instance_title', 'Milestone'),
    ('fiscal_year_start', '1')
ON CONFLICT (key) DO NOTHING;

-- Initialize SSO config row
INSERT INTO sso_config (id, enabled) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- PART 3: CREATE A DEFAULT TENANT (Optional - for single-tenant setup)
-- ============================================================================

-- For single-tenant deployment, you can use the tenant schema above
-- directly without the master database setup.

-- For multi-tenant, create your first tenant:
-- 
-- 1. Create tenant database:
--    CREATE DATABASE milestone_acme;
--    CREATE USER milestone_acme WITH PASSWORD 'secure_password_here';
--    GRANT ALL PRIVILEGES ON DATABASE milestone_acme TO milestone_acme;
--
-- 2. Connect and run tenant schema:
--    \c milestone_acme
--    (run PART 2 above)
--
-- 3. Register in master database:
--    \c milestone_master
--    INSERT INTO tenants (name, slug, database_name, database_user, admin_email, status)
--    VALUES ('Acme Corp', 'acme', 'milestone_acme', 'milestone_acme', 'admin@acme.com', 'active');
--
-- 4. Store encrypted password in tenant_credentials
--    (This is handled by the application when provisioning)

-- ============================================================================
-- NOTES
-- ============================================================================
-- 
-- Admin login for multi-tenant admin panel:
--   Created automatically on first startup via master_db.verify_admin_exists()
--   Or reset manually via: python scripts/setup_admin_password.py
--
-- For single-tenant setup:
--   Create a user in the tenant database's users table
--   Password should be bcrypt hashed
--
-- Environment variables needed (see .env.example):
--   DATABASE_URL=postgresql://user:pass@host:5432/milestone_tenant
--   MASTER_DB_HOST / MASTER_DB_PORT / MASTER_DB_NAME / MASTER_DB_USER / MASTER_DB_PASSWORD
--   MULTI_TENANT=true  (or false for single-tenant)
--   SESSION_SECRET=your-session-secret
--   TENANT_ENCRYPTION_KEY=your-64-char-hex-key  (multi-tenant mode)
--
-- ============================================================================
