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
    name VARCHAR(100) NOT NULL,
    location VARCHAR(255),
    country_code VARCHAR(10),
    region VARCHAR(100),
    timezone VARCHAR(50) DEFAULT 'Europe/Zurich',
    color VARCHAR(20),
    is_default INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Users
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password TEXT,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    job_title VARCHAR(100),
    role VARCHAR(20) DEFAULT 'user',
    max_capacity INTEGER DEFAULT 100,
    active INTEGER DEFAULT 1,
    is_system INTEGER DEFAULT 0,
    sso_provider VARCHAR(50),
    sso_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User-Site associations
CREATE TABLE user_sites (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    UNIQUE(user_id, site_id)
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
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    customer VARCHAR(255),
    pm_name VARCHAR(100),
    sales_pm VARCHAR(100),
    volume FLOAT,
    confirmed INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0,
    start_date DATE,
    end_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Project phases
CREATE TABLE project_phases (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    color VARCHAR(20),
    is_milestone INTEGER DEFAULT 0,
    completion INTEGER,
    dependencies TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Project subphases (nested, recursive)
CREATE TABLE project_subphases (
    id SERIAL PRIMARY KEY,
    phase_id INTEGER NOT NULL REFERENCES project_phases(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES project_subphases(id) ON DELETE CASCADE,
    parent_type VARCHAR(20) DEFAULT 'phase',
    name VARCHAR(100) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    color VARCHAR(20),
    is_milestone INTEGER DEFAULT 0,
    completion INTEGER,
    dependencies TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- ASSIGNMENT TABLES
-- ============================================================================

-- Project-level staff assignments
CREATE TABLE project_assignments (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    allocation_percent INTEGER DEFAULT 100,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Phase-level staff assignments
CREATE TABLE phase_staff_assignments (
    id SERIAL PRIMARY KEY,
    phase_id INTEGER NOT NULL REFERENCES project_phases(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    allocation_percent INTEGER DEFAULT 100,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Subphase-level staff assignments
CREATE TABLE subphase_staff_assignments (
    id SERIAL PRIMARY KEY,
    subphase_id INTEGER NOT NULL REFERENCES project_subphases(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    allocation_percent INTEGER DEFAULT 100,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- EQUIPMENT TABLES
-- ============================================================================

-- Equipment inventory
CREATE TABLE equipment (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50),
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Equipment assignments
CREATE TABLE equipment_assignments (
    id SERIAL PRIMARY KEY,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    phase_id INTEGER REFERENCES project_phases(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    allocation_percent INTEGER DEFAULT 100,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- CALENDAR TABLES
-- ============================================================================

-- Vacations
CREATE TABLE vacations (
    id SERIAL PRIMARY KEY,
    staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    description TEXT,
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

-- Company events (audits, meetings, etc.)
CREATE TABLE company_events (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    end_date DATE,
    name VARCHAR(200) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Notes (date-specific annotations)
CREATE TABLE notes (
    id SERIAL PRIMARY KEY,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    staff_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    name VARCHAR(100) NOT NULL,
    color VARCHAR(20),
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    is_system INTEGER DEFAULT 0,
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
    column_type VARCHAR(20) NOT NULL DEFAULT 'text',
    list_options TEXT,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    display_order INTEGER DEFAULT 0,
    width INTEGER DEFAULT 100,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Custom column values
CREATE TABLE custom_column_values (
    id SERIAL PRIMARY KEY,
    custom_column_id INTEGER NOT NULL REFERENCES custom_columns(id) ON DELETE CASCADE,
    entity_type VARCHAR(20) NOT NULL,
    entity_id INTEGER NOT NULL,
    value TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(custom_column_id, entity_type, entity_id)
);

-- ============================================================================
-- SKILLS (for staff capability tracking)
-- ============================================================================

-- Skills definitions (global, shared across all sites)
CREATE TABLE skills (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    color VARCHAR(7) DEFAULT '#6366f1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User skills (many-to-many with proficiency)
CREATE TABLE user_skills (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    proficiency INTEGER DEFAULT 3 CHECK (proficiency >= 1 AND proficiency <= 5),
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, skill_id)
);

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
CREATE INDEX idx_phases_project ON project_phases(project_id);
CREATE INDEX idx_subphases_phase ON project_subphases(phase_id);
CREATE INDEX idx_subphases_parent ON project_subphases(parent_id);
CREATE INDEX idx_project_assignments_project ON project_assignments(project_id);
CREATE INDEX idx_project_assignments_user ON project_assignments(user_id);
CREATE INDEX idx_phase_staff_phase ON phase_staff_assignments(phase_id);
CREATE INDEX idx_phase_staff_user ON phase_staff_assignments(user_id);
CREATE INDEX idx_subphase_staff_subphase ON subphase_staff_assignments(subphase_id);
CREATE INDEX idx_subphase_staff_user ON subphase_staff_assignments(user_id);
CREATE INDEX idx_equipment_site ON equipment(site_id);
CREATE INDEX idx_equipment_assignments_equipment ON equipment_assignments(equipment_id);
CREATE INDEX idx_equipment_assignments_project ON equipment_assignments(project_id);
CREATE INDEX idx_vacations_staff ON vacations(staff_id);
CREATE INDEX idx_vacations_dates ON vacations(start_date, end_date);
CREATE INDEX idx_bank_holidays_site ON bank_holidays(site_id);
CREATE INDEX idx_bank_holidays_date ON bank_holidays(date);
CREATE INDEX idx_company_events_site_date ON company_events(site_id, date);
CREATE INDEX idx_notes_staff ON notes(staff_id);
CREATE INDEX idx_notes_date ON notes(date);
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
    ('instanceTitle', 'Milestone'),
    ('fiscalYearStart', '1'),
    ('defaultView', 'month'),
    ('workingDays', '1,2,3,4,5');

-- Default predefined phases
INSERT INTO predefined_phases (name, color, sort_order, is_active, is_system) VALUES
    ('Preparation', '#9b59b6', 1, 1, 1),
    ('Analytics', '#3498db', 2, 1, 1),
    ('Trial', '#e67e22', 3, 1, 1),
    ('Cleaning', '#1abc9c', 4, 1, 1),
    ('Report', '#27ae60', 5, 1, 1);

-- Initialize SSO config row
INSERT INTO sso_config (id, enabled) VALUES (1, 0);

-- Default skills
INSERT INTO skills (name, description, color) VALUES
    ('Project Management', 'Experience in managing projects and teams', '#3b82f6'),
    ('Data Analysis', 'Statistical analysis and data interpretation', '#8b5cf6'),
    ('Laboratory Work', 'Hands-on laboratory experience', '#10b981'),
    ('Technical Writing', 'Documentation and report writing', '#f59e0b'),
    ('Quality Control', 'QC procedures and compliance', '#ef4444'),
    ('R&D', 'Research and development experience', '#06b6d4');

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
