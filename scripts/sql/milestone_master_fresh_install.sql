-- ============================================================================
-- Milestone - Multi-Tenant Master Database Fresh Install
-- 
-- This script creates the master database for tenant management.
-- Tenant databases are created automatically via the Admin Panel.
--
-- Run as PostgreSQL superuser (postgres):
--
--   Windows (PowerShell):
--     psql -U postgres -f milestone_master_fresh_install.sql
--
--   Linux/WSL:
--     sudo -u postgres psql -f milestone_master_fresh_install.sql
--
-- After running this script:
--   1. Configure your .env file (see bottom of script)
--   2. Start the application: uvicorn app.main:app --host 127.0.0.1 --port 8485
--   3. Access admin panel: http://localhost:8485/admin/
--   4. Login with the credentials shown at the end
--   5. Create your first tenant from the admin panel
--
-- ============================================================================

-- Drop and recreate databases (comment out if you want to preserve existing)
DROP DATABASE IF EXISTS milestone_master;
DROP DATABASE IF EXISTS milestone_dev;

CREATE DATABASE milestone_master;
CREATE DATABASE milestone_dev;

-- Connect to the master database
\c milestone_master

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- TENANT MANAGEMENT TABLES
-- ============================================================================

-- Tenants registry
CREATE TABLE tenants (
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tenant credentials (encrypted database passwords)
CREATE TABLE tenant_credentials (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    encrypted_password TEXT NOT NULL,
    password_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tenant audit log
CREATE TABLE tenant_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    actor VARCHAR(255),
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- ADMIN USER TABLES
-- ============================================================================

-- Admin users (for multi-tenant admin panel)
CREATE TABLE admin_users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name VARCHAR(255),
    role VARCHAR(20) DEFAULT 'admin',
    active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- Admin sessions
CREATE TABLE admin_sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired BIGINT NOT NULL
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX idx_admin_sessions_expired ON admin_sessions(expired);
CREATE INDEX idx_tenants_slug ON tenants(slug);
CREATE INDEX idx_tenants_status ON tenants(status);
CREATE INDEX idx_tenant_audit_log_tenant ON tenant_audit_log(tenant_id);
CREATE INDEX idx_tenant_audit_log_created ON tenant_audit_log(created_at DESC);

-- ============================================================================
-- DEFAULT SUPERADMIN USER
-- ============================================================================

-- Password format: salt:hash (PBKDF2-SHA512, 10000 iterations)
-- Default password: admin123
-- 
-- To generate a new hash, run in Python:
--   from app.services.encryption import hash_password
--   print(hash_password('your_password'))

INSERT INTO admin_users (email, password_hash, name, role, active)
VALUES (
    'admin@milestone.app',
    -- This is the hash for 'admin123' - CHANGE THIS AFTER FIRST LOGIN!
    '1ed85eaa9461451cc9b15c4d4068105d:f43a1d98325337e265bc657712546e15b4e8b9b746e2971527cce08f955788a63ba45a68dde30ae875c1d8f3c692cea344baeef43649005efa6397805d6d26a0',
    'System Admin',
    'superadmin',
    1
);

-- ============================================================================
-- VERIFICATION
-- ============================================================================

-- Display summary
DO $$
DECLARE
    table_count INTEGER;
    admin_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO table_count 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
    
    SELECT COUNT(*) INTO admin_count FROM admin_users;
    
    RAISE NOTICE '';
    RAISE NOTICE '============================================';
    RAISE NOTICE 'MILESTONE MASTER DATABASE SETUP COMPLETE';
    RAISE NOTICE '============================================';
    RAISE NOTICE 'Tables created: %', table_count;
    RAISE NOTICE 'Admin users: %', admin_count;
    RAISE NOTICE '';
    RAISE NOTICE 'Default admin credentials:';
    RAISE NOTICE '  Email: admin@milestone.app';
    RAISE NOTICE '  Password: admin123';
    RAISE NOTICE '';
    RAISE NOTICE 'IMPORTANT: Change password after first login!';
    RAISE NOTICE '';
    RAISE NOTICE 'Or run: python scripts/setup_admin_password.py';
    RAISE NOTICE '============================================';
END $$;

-- Show created tables
SELECT table_name, 
       (SELECT COUNT(*) FROM information_schema.columns c WHERE c.table_name = t.table_name) as columns
FROM information_schema.tables t
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- ============================================================================
-- POST-INSTALL INSTRUCTIONS
-- ============================================================================

/*

STEP 1: Configure .env file
===========================

Create/update your .env file with:

  # Application
  DEBUG=false
  PORT=8485

  # Multi-tenant mode ENABLED
  MULTI_TENANT=true

  # Master database (stores tenant registry)
  MASTER_DB_HOST=localhost
  MASTER_DB_PORT=5432
  MASTER_DB_NAME=milestone_master
  MASTER_DB_USER=postgres
  MASTER_DB_PASSWORD=YOUR_POSTGRES_PASSWORD

  # Default database settings (used as template for tenants)
  DB_HOST=localhost
  DB_PORT=5432
  DB_USER=postgres
  DB_PASSWORD=YOUR_POSTGRES_PASSWORD

  # PostgreSQL admin credentials (for auto-provisioning tenant databases)
  PG_ADMIN_USER=postgres
  PG_ADMIN_PASSWORD=YOUR_POSTGRES_PASSWORD

  # Session secret (generate with: python -c "import secrets; print(secrets.token_hex(32))")
  SESSION_SECRET=YOUR_64_CHAR_RANDOM_STRING

  # Timezone
  TZ=Europe/Zurich


STEP 2: Start the application
=============================

  cd C:\Users\Public\milestone
  uvicorn app.main:app --host 127.0.0.1 --port 8485


STEP 3: Access admin panel
==========================

  URL: http://localhost:8485/admin/
  Email: admin@milestone.app
  Password: admin123

  *** CHANGE THE PASSWORD AFTER FIRST LOGIN! ***

  To change password:
    python scripts/setup_admin_password.py


STEP 4: Create your first tenant
================================

  1. Click "Create Tenant" in the admin panel
  2. Fill in tenant details (name, slug, admin email)
  3. Click "Create" - this creates the tenant record
  4. Click "Provision" on the tenant row - this creates the database
  5. Note the generated admin credentials
  6. Access tenant at: http://localhost:8485/t/{slug}/


AUTOMATED ALTERNATIVE
=====================

Instead of running this SQL script manually, you can use:

  python scripts/fresh_install.py

This will:
  - Create both databases
  - Set up all tables
  - Prompt for a secure admin password
  - Generate .env file automatically

*/
