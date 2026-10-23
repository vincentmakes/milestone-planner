-- ============================================================================
-- Milestone - Tenant Database Schema Template
-- 
-- This is the base schema for each tenant database.
-- This file is used by the provisioning system and for reference.
-- 
-- DO NOT RUN THIS MANUALLY - tenant databases are created automatically
-- when you click "Provision" in the admin panel.
--
-- For manual tenant database setup (development only):
--   1. Create the database: CREATE DATABASE milestone_tenant_name;
--   2. Connect: \c milestone_tenant_name
--   3. Run this script
--
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Sites (locations)
CREATE TABLE sites (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    location VARCHAR(255),
    city VARCHAR(255),
    country_code VARCHAR(10),
    region_code VARCHAR(100),
    timezone VARCHAR(50) DEFAULT 'Europe/Zurich',
    last_holiday_fetch TIMESTAMP,
    active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Roles (users.role references roles.key, so before users) and their
-- permission rows (allow / approval; no row = deny; the admin role has none,
-- it holds every permission in code). The system roles are seeded here with
-- their default permissions.
CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    key VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT roles_key_format CHECK (key ~ '^[a-z][a-z0-9_]{1,19}$')
);

CREATE TABLE role_permissions (
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission VARCHAR(60) NOT NULL,
    mode VARCHAR(10) NOT NULL DEFAULT 'allow',
    PRIMARY KEY (role_id, permission),
    CONSTRAINT role_permissions_mode_check CHECK (mode IN ('allow', 'approval'))
);

WITH new_roles AS (
  INSERT INTO roles (key, name, description, is_system, sort_order)
  VALUES
    ('admin', 'Administrator', 'Holds every permission. Cannot be edited or deleted.', TRUE, 0),
    ('superuser', 'Superuser', 'Plans projects, staff and equipment at their sites.', TRUE, 1),
    ('user', 'User', 'Sees the plan, books themself and manages their own absences.', TRUE, 2)
  ON CONFLICT (key) DO NOTHING
  RETURNING id, key
)
INSERT INTO role_permissions (role_id, permission, mode)
SELECT r.id, d.permission, d.mode
FROM new_roles r JOIN (VALUES
  ('superuser', 'projects.view', 'allow'),
  ('superuser', 'projects.create', 'allow'),
  ('superuser', 'projects.edit_any', 'allow'),
  ('superuser', 'projects.manage_as_pm', 'allow'),
  ('superuser', 'projects.archive', 'allow'),
  ('superuser', 'projects.delete', 'allow'),
  ('superuser', 'projects.import', 'allow'),
  ('superuser', 'projects.export', 'allow'),
  ('superuser', 'assignments.manage_others', 'allow'),
  ('superuser', 'assignments.self_create', 'allow'),
  ('superuser', 'assignments.self_update', 'allow'),
  ('superuser', 'assignments.self_remove', 'allow'),
  ('superuser', 'equipment_bookings.manage', 'allow'),
  ('superuser', 'kanban.move_any', 'allow'),
  ('superuser', 'kanban.move_assigned', 'allow'),
  ('superuser', 'kanban.comment', 'allow'),
  ('superuser', 'kanban.moderate_comments', 'allow'),
  ('superuser', 'custom_columns.set_values', 'allow'),
  ('superuser', 'absences.view_others', 'allow'),
  ('superuser', 'absences.manage_own', 'allow'),
  ('superuser', 'absences.manage_others', 'allow'),
  ('superuser', 'staff_notes.manage', 'allow'),
  ('superuser', 'equipment.manage', 'allow'),
  ('superuser', 'equipment_types.manage', 'allow'),
  ('superuser', 'equipment_blocks.manage', 'allow'),
  ('superuser', 'bank_holidays.manage', 'allow'),
  ('superuser', 'company_events.manage', 'allow'),
  ('superuser', 'sites.export', 'allow'),
  ('superuser', 'teams.manage', 'allow'),
  ('superuser', 'users.view', 'allow'),
  ('superuser', 'users.edit', 'allow'),
  ('superuser', 'skills.manage', 'allow'),
  ('superuser', 'skills.assign', 'allow'),
  ('superuser', 'predefined_phases.manage', 'allow'),
  ('superuser', 'todos.manage_own', 'allow'),
  ('superuser', 'todos.assign_others', 'allow'),
  ('superuser', 'views.kanban', 'allow'),
  ('superuser', 'views.staff', 'allow'),
  ('superuser', 'views.equipment', 'allow'),
  ('superuser', 'views.crosssite', 'allow'),
  ('superuser', 'views.archived', 'allow'),
  ('superuser', 'whatif.use', 'allow'),
  ('user', 'projects.view', 'allow'),
  ('user', 'projects.manage_as_pm', 'allow'),
  ('user', 'assignments.self_create', 'allow'),
  ('user', 'assignments.self_update', 'allow'),
  ('user', 'assignments.self_remove', 'allow'),
  ('user', 'kanban.move_assigned', 'allow'),
  ('user', 'kanban.comment', 'allow'),
  ('user', 'custom_columns.set_values', 'allow'),
  ('user', 'absences.view_others', 'allow'),
  ('user', 'absences.manage_own', 'allow'),
  ('user', 'todos.manage_own', 'allow'),
  ('user', 'views.kanban', 'allow'),
  ('user', 'views.staff', 'allow'),
  ('user', 'views.equipment', 'allow'),
  ('user', 'views.crosssite', 'allow'),
  ('user', 'views.archived', 'allow')
) AS d(role_key, permission, mode) ON d.role_key = r.key
ON CONFLICT (role_id, permission) DO NOTHING;

-- Users
CREATE TABLE users (
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
    is_resource BOOLEAN NOT NULL DEFAULT TRUE,
    is_system INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT users_role_fkey FOREIGN KEY (role) REFERENCES roles(key) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- User-Site associations
CREATE TABLE user_sites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, site_id)
);

-- Sessions (express-session compatible)
CREATE TABLE sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired BIGINT NOT NULL
);

-- ============================================================================
-- PROJECT MANAGEMENT TABLES
-- ============================================================================

-- Projects
CREATE TABLE projects (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    customer VARCHAR(255),
    pm_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sales_pm VARCHAR(200),
    confirmed INTEGER DEFAULT 0,
    volume REAL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    notes TEXT,
    archived INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Project phases (type carries the phase name)
CREATE TABLE project_phases (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type VARCHAR(100) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_milestone INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    completion INTEGER,
    status VARCHAR(20) NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
    dependencies TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Project subphases (nested, recursive via parent_id + parent_type)
CREATE TABLE project_subphases (
    id SERIAL PRIMARY KEY,
    parent_id INTEGER NOT NULL,
    parent_type VARCHAR(20) NOT NULL DEFAULT 'phase' CHECK (parent_type IN ('phase', 'subphase')),
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_milestone INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    depth INTEGER DEFAULT 1,
    completion INTEGER,
    status VARCHAR(20) NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
    dependencies TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- ASSIGNMENT TABLES
-- ============================================================================

-- Project-level staff assignments (have their own dates)
CREATE TABLE project_assignments (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    allocation INTEGER DEFAULT 100,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Phase-level staff assignments (own start_date / end_date = an unlinked
-- segment inside the phase; both NULL = linked, dates come from the phase)
CREATE TABLE phase_staff_assignments (
    id SERIAL PRIMARY KEY,
    phase_id INTEGER NOT NULL REFERENCES project_phases(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    allocation INTEGER DEFAULT 100,
    start_date DATE,
    end_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT phase_staff_assignments_segment_dates_check
        CHECK ((start_date IS NULL) = (end_date IS NULL))
);

-- Subphase-level staff assignments (own start_date / end_date = an unlinked
-- segment inside the subphase; both NULL = linked, dates come from the subphase)
CREATE TABLE subphase_staff_assignments (
    id SERIAL PRIMARY KEY,
    subphase_id INTEGER NOT NULL REFERENCES project_subphases(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    allocation INTEGER DEFAULT 100,
    start_date DATE,
    end_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT subphase_staff_assignments_segment_dates_check
        CHECK ((start_date IS NULL) = (end_date IS NULL))
);

-- ============================================================================
-- EQUIPMENT TABLES
-- ============================================================================

-- Equipment inventory. Equipment can be shared by several sites
-- (equipment_sites); site_id is a legacy column (first linked site).
CREATE TABLE equipment (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(100),
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    description TEXT,
    active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Equipment <-> site links (many-to-many)
CREATE TABLE equipment_sites (
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (equipment_id, site_id)
);

-- Equipment assignments (project-level bookings)
CREATE TABLE equipment_assignments (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- CALENDAR TABLES
-- ============================================================================

-- Absence types (Holidays, Home Office, ...; global, admin-managed).
-- counts_as_unavailable = false keeps the person available for planning.
CREATE TABLE absence_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    color VARCHAR(7) NOT NULL DEFAULT '#8b5cf6',
    counts_as_unavailable BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Vacations (a NULL absence_type_id counts as unavailable)
CREATE TABLE vacations (
    id SERIAL PRIMARY KEY,
    staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    description VARCHAR(200) DEFAULT 'Vacation' NOT NULL,
    absence_type_id INTEGER REFERENCES absence_types(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Equipment blocks (maintenance / defect / calibration unavailability)
CREATE TABLE equipment_blocks (
    id SERIAL PRIMARY KEY,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason VARCHAR(50) DEFAULT 'maintenance' NOT NULL,
    description VARCHAR(200) DEFAULT 'Maintenance' NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Bank holidays
CREATE TABLE bank_holidays (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    end_date DATE,
    name VARCHAR(255) NOT NULL,
    is_custom INTEGER DEFAULT 0,
    year INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(site_id, date, name)
);

-- Company events (audits, meetings, etc.). An event can apply to several
-- sites (company_event_sites); site_id is a legacy column (first linked site).
-- counts_as_unavailable marks a site closure: staff of the linked sites are
-- unavailable on the event's dates.
CREATE TABLE company_events (
    id SERIAL PRIMARY KEY,
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    date DATE NOT NULL,
    end_date DATE,
    name VARCHAR(200) NOT NULL,
    color VARCHAR(20),
    counts_as_unavailable BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Company event <-> site links (many-to-many)
CREATE TABLE company_event_sites (
    event_id INTEGER NOT NULL REFERENCES company_events(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, site_id)
);

-- Staff notes (date-specific annotations pinned to a site)
CREATE TABLE staff_notes (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    date DATE NOT NULL,
    text TEXT NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'general',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- SETTINGS TABLES
-- ============================================================================

-- Key-value settings
CREATE TABLE settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Predefined phase templates
CREATE TABLE predefined_phases (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- SSO configuration
CREATE TABLE sso_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    enabled INTEGER DEFAULT 0,
    tenant_id VARCHAR(255),
    client_id VARCHAR(255),
    client_secret TEXT,
    redirect_uri TEXT,
    auto_create_users INTEGER DEFAULT 0,
    default_role VARCHAR(20) DEFAULT 'user',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT single_row CHECK (id = 1)
);

-- ============================================================================
-- CUSTOM COLUMNS (EAV Pattern)
-- ============================================================================

-- Custom column definitions
CREATE TABLE custom_columns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    column_type VARCHAR(20) NOT NULL DEFAULT 'text' CHECK (column_type IN ('text', 'boolean', 'list')),
    list_options TEXT,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    display_order INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 120,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Custom column values
CREATE TABLE custom_column_values (
    id SERIAL PRIMARY KEY,
    custom_column_id INTEGER NOT NULL REFERENCES custom_columns(id) ON DELETE CASCADE,
    entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('project', 'phase', 'subphase')),
    entity_id INTEGER NOT NULL,
    value TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(custom_column_id, entity_type, entity_id)
);

-- Kanban card comments (a card is a leaf phase/subphase)
CREATE TABLE card_comments (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('phase', 'subphase')),
    entity_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    mentioned_user_ids TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- In-app notifications (one row per recipient)
CREATE TABLE notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL CHECK (type IN ('assigned', 'comment', 'mention', 'status_change', 'approval_requested', 'approval_decided', 'todo_assigned', 'assignment_changed', 'project_changed')),
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    entity_type VARCHAR(20),
    entity_id INTEGER,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    body TEXT,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- ============================================================================
-- SKILLS (for staff capability tracking)
-- ============================================================================

-- Skills definitions (global, shared across all sites)
CREATE TABLE skills (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User skills (many-to-many with proficiency)
CREATE TABLE user_skills (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    proficiency INTEGER NOT NULL DEFAULT 3 CHECK (proficiency >= 1 AND proficiency <= 5),
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, skill_id)
);

-- ============================================================================
-- TAGS (tenant-wide project tags, optionally site-scoped)
-- ============================================================================

-- Tags definitions (all_sites = false: only at the sites in tag_sites)
CREATE TABLE tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
    all_sites BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tag <-> site links (many-to-many)
CREATE TABLE tag_sites (
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (tag_id, site_id)
);

-- Project tags (many-to-many)
CREATE TABLE project_tags (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, tag_id)
);

-- ============================================================================
-- TEAMS (per site; users, projects, tags, company events and equipment can be
-- linked to teams -- every FK cascades, so a site's teams go with the site)
-- ============================================================================

-- Teams definitions (name unique per site)
CREATE TABLE teams (
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
CREATE TABLE team_members (
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, user_id)
);

-- Project <-> team links (many-to-many)
CREATE TABLE project_teams (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, team_id)
);

-- Tag <-> team links (many-to-many)
CREATE TABLE tag_teams (
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    PRIMARY KEY (tag_id, team_id)
);

-- Company event <-> team links (many-to-many)
CREATE TABLE company_event_teams (
    event_id INTEGER NOT NULL REFERENCES company_events(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, team_id)
);

-- Equipment <-> team links (many-to-many)
CREATE TABLE equipment_teams (
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    PRIMARY KEY (equipment_id, team_id)
);

-- ============================================================================
-- PROJECT FIELDS (custom fields on projects; dropdown items scoped like tags)
-- ============================================================================

-- Project fields (custom fields on projects: text, number, toggle, select,
-- multiselect). Same DDL as tenant_provisioner.PROJECT_FIELDS_SCHEMA_STATEMENTS
-- and migrations/add_project_fields.sql.
CREATE TABLE project_fields (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    field_type VARCHAR(20) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT project_fields_type_check
        CHECK (field_type IN ('text', 'number', 'toggle', 'select', 'multiselect'))
);

-- Items of the dropdown fields (all_sites = false: only at the sites in
-- project_field_option_sites; per site, team rows limit the item to those teams)
CREATE TABLE project_field_options (
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
CREATE TABLE project_field_option_sites (
    option_id INTEGER NOT NULL REFERENCES project_field_options(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (option_id, site_id)
);

-- Item <-> team links (many-to-many)
CREATE TABLE project_field_option_teams (
    option_id INTEGER NOT NULL REFERENCES project_field_options(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    PRIMARY KEY (option_id, team_id)
);

-- Text / number / toggle values of a project (absent = empty)
CREATE TABLE project_field_values (
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

-- Items chosen for a project's dropdown fields (many-to-many)
CREATE TABLE project_field_selections (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    option_id INTEGER NOT NULL REFERENCES project_field_options(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, option_id)
);

-- ============================================================================
-- APPROVALS AND TODOS (approval policies per approvable action, approval
-- requests for own bookings, My Todos) and the RBAC upgrades of the tables
-- above (no-ops on a fresh database; same SQL as the provisioner constants)
-- ============================================================================

CREATE TABLE approval_policies (
    action VARCHAR(60) PRIMARY KEY,
    pm_approves BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE approval_policy_roles (
    action VARCHAR(60) NOT NULL REFERENCES approval_policies(action) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (action, role_id)
);

CREATE TABLE approval_requests (
    id SERIAL PRIMARY KEY,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action VARCHAR(60) NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    level VARCHAR(10) NOT NULL,
    target_id INTEGER NOT NULL,
    assignment_id INTEGER,
    requested TEXT,
    previous TEXT,
    note TEXT,
    status VARCHAR(12) NOT NULL DEFAULT 'pending',
    close_reason VARCHAR(20),
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at TIMESTAMP,
    decision_note TEXT,
    superseded_by_id INTEGER REFERENCES approval_requests(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT approval_requests_level_check CHECK (level IN ('project', 'phase', 'subphase')),
    CONSTRAINT approval_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'superseded', 'expired')),
    CONSTRAINT approval_requests_close_reason_check CHECK (close_reason IN ('target_deleted', 'requester_inactive', 'permission_lost', 'overtaken', 'duplicate'))
);

CREATE TABLE todos (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    notes TEXT,
    due_date DATE,
    assignee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'open',
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    entity_type VARCHAR(20),
    entity_id INTEGER,
    completed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT todos_status_check CHECK (status IN ('open', 'done', 'cancelled')),
    CONSTRAINT todos_entity_type_check CHECK (entity_type IN ('phase', 'subphase'))
);

DO $$
BEGIN
    IF to_regclass('public.project_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'project_assignments'
          AND column_name = 'approval_status'
    ) THEN
        ALTER TABLE project_assignments ADD COLUMN approval_status VARCHAR(10) NOT NULL DEFAULT 'approved' CONSTRAINT project_assignments_approval_status_check CHECK (approval_status IN ('approved', 'pending'));
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.project_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'project_assignments'
          AND column_name = 'approval_request_id'
    ) THEN
        ALTER TABLE project_assignments ADD COLUMN approval_request_id INTEGER CONSTRAINT project_assignments_approval_request_id_fkey REFERENCES approval_requests(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.phase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'phase_staff_assignments'
          AND column_name = 'approval_status'
    ) THEN
        ALTER TABLE phase_staff_assignments ADD COLUMN approval_status VARCHAR(10) NOT NULL DEFAULT 'approved' CONSTRAINT phase_staff_assignments_approval_status_check CHECK (approval_status IN ('approved', 'pending'));
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.phase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'phase_staff_assignments'
          AND column_name = 'approval_request_id'
    ) THEN
        ALTER TABLE phase_staff_assignments ADD COLUMN approval_request_id INTEGER CONSTRAINT phase_staff_assignments_approval_request_id_fkey REFERENCES approval_requests(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.subphase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'subphase_staff_assignments'
          AND column_name = 'approval_status'
    ) THEN
        ALTER TABLE subphase_staff_assignments ADD COLUMN approval_status VARCHAR(10) NOT NULL DEFAULT 'approved' CONSTRAINT subphase_staff_assignments_approval_status_check CHECK (approval_status IN ('approved', 'pending'));
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.subphase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'subphase_staff_assignments'
          AND column_name = 'approval_request_id'
    ) THEN
        ALTER TABLE subphase_staff_assignments ADD COLUMN approval_request_id INTEGER CONSTRAINT subphase_staff_assignments_approval_request_id_fkey REFERENCES approval_requests(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Unlinked booking segments (1.17.0): own dates on phase / subphase staff
-- bookings (both NULL = linked, follows the card). No-ops on a fresh database
-- (CREATE TABLE has them); the same statements as migrations/add_booking_segments.sql.
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

DO $$
BEGIN
    IF to_regclass('public.notifications') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.notifications')
          AND conname = 'notifications_type_check'
          AND strpos(pg_get_constraintdef(oid), 'project_changed') > 0
    ) THEN
        ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
        ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
            CHECK (type IN ('assigned', 'comment', 'mention', 'status_change', 'approval_requested', 'approval_decided', 'todo_assigned', 'assignment_changed', 'project_changed'));
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.sso_config')
          AND conname = 'sso_config_default_role_check'
    ) THEN
        ALTER TABLE sso_config DROP CONSTRAINT sso_config_default_role_check;
    END IF;
END $$;

UPDATE users SET role = 'user' WHERE role NOT IN (SELECT key FROM roles);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.users') AND conname = 'users_role_check'
    ) THEN
        ALTER TABLE users DROP CONSTRAINT users_role_check;
    END IF;
    IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.users') AND conname = 'users_role_fkey'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_role_fkey FOREIGN KEY (role) REFERENCES roles(key) ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;
END $$;

-- ============================================================================
-- REALTIME COLLABORATION
-- ============================================================================

-- Project presence (tracking active viewers)
CREATE TABLE project_presence (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity VARCHAR(20) DEFAULT 'viewing' NOT NULL,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Unique constraint - one presence record per user per project
CREATE UNIQUE INDEX idx_project_presence_unique ON project_presence(project_id, user_id);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX idx_sessions_expired ON sessions(expired);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_active ON users(active);
CREATE INDEX idx_projects_site ON projects(site_id);
CREATE INDEX idx_projects_archived ON projects(archived);
CREATE INDEX idx_projects_pm ON projects(pm_id);
CREATE INDEX idx_phases_project ON project_phases(project_id);
CREATE INDEX idx_subphases_project ON project_subphases(project_id);
CREATE INDEX idx_subphases_parent ON project_subphases(parent_type, parent_id);
CREATE INDEX idx_card_comments_entity ON card_comments(entity_type, entity_id);
CREATE INDEX idx_card_comments_project ON card_comments(project_id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX idx_project_assignments_project ON project_assignments(project_id);
CREATE INDEX idx_project_assignments_staff ON project_assignments(staff_id);
CREATE INDEX idx_phase_staff_phase ON phase_staff_assignments(phase_id);
CREATE INDEX idx_phase_staff_project ON phase_staff_assignments(project_id);
CREATE INDEX idx_phase_staff_staff ON phase_staff_assignments(staff_id);
CREATE INDEX idx_subphase_staff_subphase ON subphase_staff_assignments(subphase_id);
CREATE INDEX idx_subphase_staff_project ON subphase_staff_assignments(project_id);
CREATE INDEX idx_subphase_staff_staff ON subphase_staff_assignments(staff_id);
CREATE INDEX idx_equipment_site ON equipment(site_id);
CREATE INDEX idx_equipment_sites_site ON equipment_sites(site_id);
CREATE INDEX idx_equipment_assignments_equipment ON equipment_assignments(equipment_id);
CREATE INDEX idx_equipment_assignments_project ON equipment_assignments(project_id);
CREATE INDEX idx_vacations_staff ON vacations(staff_id);
CREATE INDEX idx_vacations_dates ON vacations(start_date, end_date);
CREATE INDEX idx_vacations_absence_type ON vacations(absence_type_id);
CREATE INDEX idx_bank_holidays_site ON bank_holidays(site_id);
CREATE INDEX idx_bank_holidays_date ON bank_holidays(date);
CREATE INDEX idx_company_events_site_date ON company_events(site_id, date);
CREATE INDEX idx_company_event_sites_site ON company_event_sites(site_id);
CREATE INDEX idx_staff_notes_site_date ON staff_notes(site_id, date);
CREATE INDEX idx_equipment_blocks_equipment_id ON equipment_blocks(equipment_id);
CREATE INDEX idx_equipment_blocks_dates ON equipment_blocks(start_date, end_date);
CREATE INDEX idx_project_tags_project ON project_tags(project_id);
CREATE INDEX idx_project_tags_tag ON project_tags(tag_id);
CREATE INDEX idx_tag_sites_site ON tag_sites(site_id);
CREATE INDEX idx_teams_site ON teams(site_id);
CREATE INDEX idx_team_members_user ON team_members(user_id);
CREATE INDEX idx_project_teams_team ON project_teams(team_id);
CREATE INDEX idx_tag_teams_team ON tag_teams(team_id);
CREATE INDEX idx_company_event_teams_team ON company_event_teams(team_id);
CREATE INDEX idx_equipment_teams_team ON equipment_teams(team_id);
CREATE INDEX idx_project_field_option_sites_site ON project_field_option_sites(site_id);
CREATE INDEX idx_project_field_option_teams_team ON project_field_option_teams(team_id);
CREATE INDEX idx_project_field_values_project ON project_field_values(project_id);
CREATE INDEX idx_project_field_selections_option ON project_field_selections(option_id);
CREATE INDEX idx_approval_policy_roles_role ON approval_policy_roles(role_id);
CREATE INDEX idx_approval_requests_project_status ON approval_requests(project_id, status);
CREATE INDEX idx_approval_requests_requester_status ON approval_requests(requester_id, status);
CREATE INDEX idx_approval_requests_pending ON approval_requests(status) WHERE status = 'pending';
CREATE INDEX idx_todos_assignee_status ON todos(assignee_id, status);
CREATE INDEX idx_custom_columns_site ON custom_columns(site_id);
CREATE INDEX idx_custom_column_values_column ON custom_column_values(custom_column_id);
CREATE INDEX idx_custom_column_values_entity ON custom_column_values(entity_type, entity_id);
CREATE INDEX idx_user_skills_user ON user_skills(user_id);
CREATE INDEX idx_user_skills_skill ON user_skills(skill_id);
CREATE INDEX idx_bank_holidays_year ON bank_holidays(site_id, year);
CREATE INDEX idx_project_presence_project ON project_presence(project_id);
CREATE INDEX idx_project_presence_user ON project_presence(user_id);
CREATE INDEX idx_project_presence_last_seen ON project_presence(last_seen_at);

-- ============================================================================
-- DEFAULT DATA
-- ============================================================================

-- Default settings
INSERT INTO settings (key, value) VALUES
    ('instance_title', 'Milestone'),
    ('fiscal_year_start', '1');

-- Default predefined phases
INSERT INTO predefined_phases (name, sort_order, is_active) VALUES
    ('Preparation', 1, 1),
    ('Analytics', 2, 1),
    ('Trial', 3, 1),
    ('Cleaning', 4, 1),
    ('Report', 5, 1);

-- Initialize SSO config row
INSERT INTO sso_config (id, enabled) VALUES (1, 0);

-- One approval policy per approvable action: the project manager approves
INSERT INTO approval_policies (action, pm_approves) VALUES
  ('assignments.self_create', TRUE),
  ('assignments.self_update', TRUE),
  ('assignments.self_remove', TRUE)
ON CONFLICT (action) DO NOTHING;

-- Default skills
INSERT INTO skills (name, description, color) VALUES
    ('Project Management', 'Experience in managing projects and teams', '#3b82f6'),
    ('Data Analysis', 'Statistical analysis and data interpretation', '#8b5cf6'),
    ('Laboratory Work', 'Hands-on laboratory experience', '#10b981'),
    ('Technical Writing', 'Documentation and report writing', '#f59e0b'),
    ('Quality Control', 'QC procedures and compliance', '#ef4444'),
    ('R&D', 'Research and development experience', '#06b6d4');

-- Default absence types
INSERT INTO absence_types (name, color, counts_as_unavailable, sort_order) VALUES
    ('Holidays', '#8b5cf6', TRUE, 0),
    ('Home Office', '#0ea5e9', FALSE, 1),
    ('Illness', '#ef4444', TRUE, 2),
    ('Business Trip', '#f59e0b', TRUE, 3),
    ('Training', '#10b981', TRUE, 4);

-- ============================================================================
-- VERIFICATION
-- ============================================================================

DO $$
DECLARE
    table_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO table_count 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
    
    RAISE NOTICE 'Tenant database schema created successfully!';
    RAISE NOTICE 'Tables created: %', table_count;
END $$;
