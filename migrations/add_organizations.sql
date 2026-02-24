-- =============================================================================
-- Master Database Migration: Add Organizations for Organization-Level SSO
-- =============================================================================
-- This migration adds support for organization-level SSO configuration.
-- 
-- Key Features:
-- - Organizations can have multiple tenants
-- - SSO can be configured at organization level (shared across tenants)
-- - Tenants can require specific Entra group membership for access
-- - Group membership can be validated in 'any' (OR) or 'all' (AND) mode
--
-- IMPORTANT: Run this migration on the MASTER database only!
-- Use: python migrations/run_migration_master.py add_organizations
-- =============================================================================

-- Create organizations table
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(63) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index on organization slug for fast lookups
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

-- Create organization SSO configuration table
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

-- Add organization reference to tenants table (nullable for backward compatibility)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'tenants' AND column_name = 'organization_id'
    ) THEN
        ALTER TABLE tenants ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Add group access control columns to tenants
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'tenants' AND column_name = 'required_group_ids'
    ) THEN
        -- JSONB array of Entra group IDs (UUIDs) required for access
        ALTER TABLE tenants ADD COLUMN required_group_ids JSONB DEFAULT '[]';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'tenants' AND column_name = 'group_membership_mode'
    ) THEN
        -- 'any' = user must be member of at least one group (OR)
        -- 'all' = user must be member of all groups (AND)
        ALTER TABLE tenants ADD COLUMN group_membership_mode VARCHAR(10) DEFAULT 'any';
    END IF;
END $$;

-- Create index for faster tenant lookups by organization
CREATE INDEX IF NOT EXISTS idx_tenants_organization_id ON tenants(organization_id);

-- Add comment describing the schema
COMMENT ON TABLE organizations IS 'Organizations that can have multiple tenants with shared SSO configuration';
COMMENT ON TABLE organization_sso_config IS 'SSO configuration for organizations (Microsoft Entra ID)';
COMMENT ON COLUMN tenants.organization_id IS 'Optional reference to parent organization for shared SSO';
COMMENT ON COLUMN tenants.required_group_ids IS 'JSONB array of Entra group IDs required for tenant access';
COMMENT ON COLUMN tenants.group_membership_mode IS 'any = member of at least one group, all = member of all groups';
