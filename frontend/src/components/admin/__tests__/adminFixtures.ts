/**
 * Admin-portal test data (master-DB shapes from @/api/endpoints/admin).
 * Test-only helper for the admin component tests in this folder.
 */
import type {
  AdminUserListItem,
  AuditLogEntry,
  Organization,
  SystemStats,
  Tenant,
} from '@/api/endpoints/admin';

export function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 't-demo',
    name: 'Demo Company',
    slug: 'demo',
    company_name: 'Demo Company AG',
    admin_email: 'admin@demo.local',
    status: 'active',
    plan: 'standard',
    max_users: 10,
    max_projects: 50,
    database_name: 'milestone_demo',
    database_user: 'milestone_demo',
    database_status: { exists: true, accessible: true },
    created_at: '2026-01-15T09:30:00.000Z',
    updated_at: '2026-01-15T09:30:00.000Z',
    ...overrides,
  };
}

export function makeOrganization(overrides: Partial<Organization> = {}): Organization {
  return {
    id: 'o-acme',
    name: 'Acme Group',
    slug: 'acme',
    description: 'Shared Entra tenant',
    created_at: '2026-02-01T00:00:00.000Z',
    tenant_count: 0,
    sso_enabled: false,
    ...overrides,
  };
}

export function makeAdminListUser(overrides: Partial<AdminUserListItem> = {}): AdminUserListItem {
  return {
    id: 2,
    email: 'ops@milestone.local',
    name: 'Ops Admin',
    role: 'admin',
    active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    last_login: null,
    ...overrides,
  };
}

export function makeStats(overrides: Partial<SystemStats> = {}): SystemStats {
  return {
    tenants: { total: 7, active: 4, suspended: 1, pending: 2, archived: 0 },
    connections: { active_pools: 3, total_connections: 12 },
    system: { uptime: 93780, memory_mb: 256.4, python_version: '3.11.9 (main, Apr 2026)' },
    ...overrides,
  };
}

export function makeAuditEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: 'a1',
    action: 'tenant.provisioned',
    details: {},
    actor: 'admin@milestone.local',
    created_at: '2026-01-16T10:00:00.000Z',
    ...overrides,
  };
}
