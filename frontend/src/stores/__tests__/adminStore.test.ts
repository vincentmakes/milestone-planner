import { describe, it, expect, beforeEach } from 'vitest';
import { useAdminStore } from '../adminStore';
import type { AdminUserListItem, Organization, Tenant } from '@/api/endpoints/admin';

const admin = () => useAdminStore.getState();

const tenant = (id: string, overrides: Partial<Tenant> = {}): Tenant => ({
  id,
  name: `Tenant ${id}`,
  slug: id,
  admin_email: `admin@${id}.local`,
  status: 'active',
  plan: 'standard',
  max_users: 10,
  max_projects: 10,
  database_name: `milestone_${id}`,
  database_user: id,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const org = (id: string): Organization => ({
  id,
  name: `Org ${id}`,
  slug: id,
  created_at: '2026-01-01T00:00:00.000Z',
  tenant_count: 0,
  sso_enabled: false,
});

const adminUser = (id: number): AdminUserListItem => ({
  id,
  email: `a${id}@milestone.local`,
  name: `Admin ${id}`,
  role: 'admin',
  active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  last_login: null,
});

describe('adminStore', () => {
  beforeEach(() => {
    useAdminStore.setState(useAdminStore.getInitialState());
  });

  it('starts loading and unauthenticated', () => {
    expect(admin()).toMatchObject({ isLoading: true, isAuthenticated: false, activeTab: 'tenants' });
  });

  it('sets auth, data and selection state', () => {
    admin().setAdminUser({ id: 1, email: 'a@x', name: 'A', role: 'superadmin' });
    admin().setIsAuthenticated(true);
    admin().setIsLoading(false);
    admin().setMustChangePassword(true);
    admin().setSystemStats(null);
    admin().setActiveTab('stats');
    admin().setSelectedTenantId('t1');
    admin().setSelectedOrganizationId('o1');
    expect(admin()).toMatchObject({
      adminUser: { role: 'superadmin' },
      isAuthenticated: true,
      isLoading: false,
      mustChangePassword: true,
      activeTab: 'stats',
      selectedTenantId: 't1',
      selectedOrganizationId: 'o1',
    });
  });

  it('adds new tenants first, updates and removes them by id', () => {
    admin().setTenants([tenant('a'), tenant('b')]);
    admin().addTenantToList(tenant('c'));
    expect(admin().tenants.map((t) => t.id)).toEqual(['c', 'a', 'b']);
    admin().updateTenantInList('a', { status: 'suspended' });
    expect(admin().tenants.find((t) => t.id === 'a')?.status).toBe('suspended');
    expect(admin().tenants.find((t) => t.id === 'b')?.status).toBe('active');
    admin().removeTenantFromList('b');
    expect(admin().tenants.map((t) => t.id)).toEqual(['c', 'a']);
  });

  it('manages organizations', () => {
    admin().setOrganizations([org('x')]);
    admin().addOrganizationToList(org('y'));
    admin().updateOrganizationInList('x', { tenant_count: 3 });
    expect(admin().organizations.map((o) => [o.id, o.tenant_count])).toEqual([
      ['y', 0],
      ['x', 3],
    ]);
    admin().removeOrganizationFromList('y');
    expect(admin().organizations.map((o) => o.id)).toEqual(['x']);
  });

  it('manages admin users', () => {
    admin().setAdminUsers([adminUser(1)]);
    admin().addAdminUserToList(adminUser(2));
    admin().updateAdminUserInList(1, { active: false });
    expect(admin().adminUsers.map((u) => [u.id, u.active])).toEqual([
      [2, true],
      [1, false],
    ]);
    admin().removeAdminUserFromList(2);
    expect(admin().adminUsers.map((u) => u.id)).toEqual([1]);
  });

  it('reset() empties everything but leaves loading off (logout)', () => {
    admin().setTenants([tenant('a')]);
    admin().setIsAuthenticated(true);
    admin().reset();
    expect(admin()).toMatchObject({ tenants: [], isAuthenticated: false, isLoading: false, adminUser: null });
  });
});
