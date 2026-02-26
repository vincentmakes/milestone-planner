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
    sso_provider VARCHAR(50),
    sso_id VARCHAR(255),
    active INTEGER DEFAULT 1 NOT NULL,
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
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
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
    dependencies TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
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
    dependencies TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT project_subphases_parent_type_check CHECK (parent_type IN ('phase', 'subphase'))
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

-- Equipment
CREATE TABLE IF NOT EXISTS equipment (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    type VARCHAR(100),
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    description TEXT,
    active INTEGER DEFAULT 1 NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
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

-- Vacations (staff time-off)
CREATE TABLE IF NOT EXISTS vacations (
    id SERIAL PRIMARY KEY,
    staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    description VARCHAR(200) DEFAULT 'Vacation' NOT NULL,
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

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_projects_site_id ON projects(site_id);
CREATE INDEX IF NOT EXISTS idx_projects_pm_id ON projects(pm_id);
CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived);
CREATE INDEX IF NOT EXISTS idx_project_phases_project_id ON project_phases(project_id);
CREATE INDEX IF NOT EXISTS idx_project_subphases_project_id ON project_subphases(project_id);
CREATE INDEX IF NOT EXISTS idx_project_subphases_parent ON project_subphases(parent_type, parent_id);
CREATE INDEX IF NOT EXISTS idx_project_assignments_project_id ON project_assignments(project_id);
CREATE INDEX IF NOT EXISTS idx_project_assignments_staff_id ON project_assignments(staff_id);
CREATE INDEX IF NOT EXISTS idx_phase_staff_assignments_phase_id ON phase_staff_assignments(phase_id);
CREATE INDEX IF NOT EXISTS idx_phase_staff_assignments_staff_id ON phase_staff_assignments(staff_id);
CREATE INDEX IF NOT EXISTS idx_subphase_staff_assignments_subphase_id ON subphase_staff_assignments(subphase_id);
CREATE INDEX IF NOT EXISTS idx_equipment_site_id ON equipment(site_id);
CREATE INDEX IF NOT EXISTS idx_equipment_assignments_project_id ON equipment_assignments(project_id);
CREATE INDEX IF NOT EXISTS idx_equipment_assignments_equipment_id ON equipment_assignments(equipment_id);
CREATE INDEX IF NOT EXISTS idx_vacations_staff_id ON vacations(staff_id);
CREATE INDEX IF NOT EXISTS idx_bank_holidays_site_id ON bank_holidays(site_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);

-- Insert default predefined phases
INSERT INTO predefined_phases (name, sort_order, is_active) VALUES
    ('Preparation', 1, 1),
    ('Analytics', 2, 1),
    ('Trial', 3, 1),
    ('Cleaning', 4, 1),
    ('Report', 5, 1)
ON CONFLICT (name) DO NOTHING;

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
--   Or manually via: python -m app.scripts.create_admin
--
-- For single-tenant setup:
--   Create a user in the tenant database's users table
--   Password should be bcrypt hashed
--
-- Environment variables needed:
--   DATABASE_URL=postgresql://user:pass@host:5432/milestone_tenant
--   MASTER_DATABASE_URL=postgresql://user:pass@host:5432/milestone_master
--   MULTI_TENANT=true  (or false for single-tenant)
--   SECRET_KEY=your-secret-key
--   ENCRYPTION_KEY=your-32-byte-encryption-key
--
-- ============================================================================
