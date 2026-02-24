/**
 * Admin API Endpoints
 * Multi-tenant administration
 */

import { apiGet, apiPost, apiPut, apiDelete, apiPatch } from '../client';

// Types
export interface AdminUser {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'superadmin';
}

// Organization Types
export interface Organization {
  id: string;
  name: string;
  slug: string;
  description?: string;
  created_at: string;
  updated_at?: string;
  tenant_count: number;
  sso_enabled: boolean;
}

export interface OrganizationSSOConfig {
  enabled: boolean;
  configured: boolean;
  provider: string;
  entraTenantId?: string;
  clientId?: string;
  redirectUri?: string;
  autoCreateUsers: boolean;
  defaultUserRole: string;
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  required_group_ids: string[];
  group_membership_mode: 'any' | 'all';
}

export interface OrganizationDetail extends Omit<Organization, 'tenant_count' | 'sso_enabled'> {
  sso_config?: OrganizationSSOConfig;
  tenants: TenantSummary[];
}

export interface OrganizationCreateRequest {
  name: string;
  slug: string;
  description?: string;
}

export interface OrganizationSSOConfigUpdate {
  enabled?: boolean;
  entraTenantId?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  autoCreateUsers?: boolean;
  defaultUserRole?: string;
}

export interface TenantGroupAccessUpdate {
  organizationId?: string | null;
  requiredGroupIds?: string[];
  groupMembershipMode?: 'any' | 'all';
}

export interface AdminLoginResponse {
  success: boolean;
  user: AdminUser;
}

export interface AdminMeResponse {
  user: AdminUser | null;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  company_name?: string;
  admin_email: string;
  status: 'pending' | 'active' | 'suspended' | 'archived';
  plan: string;
  max_users: number;
  max_projects: number;
  database_name: string;
  database_user: string;
  database_status?: {
    exists: boolean;
    accessible: boolean;
  };
  // Organization fields
  organization_id?: string;
  organization_name?: string;
  required_group_ids?: string[];
  group_membership_mode?: 'any' | 'all';
  created_at: string;
  updated_at: string;
}

export interface TenantCreateRequest {
  name: string;
  slug: string;
  company_name?: string;
  admin_email: string;
  plan?: string;
  max_users?: number;
  max_projects?: number;
}

export interface TenantProvisionResponse {
  success: boolean;
  adminEmail: string;
  adminPassword: string;
}

export interface SystemStats {
  tenants: {
    total: number;
    active: number;
    suspended: number;
    pending: number;
    archived: number;
  };
  connections: {
    active_pools: number;
    total_connections: number;
  };
  system: {
    uptime: number;
    memory_mb: number;
    python_version: string;
  };
}

export interface AdminUserListItem {
  id: number;
  email: string;
  name: string;
  role: string;
  active: boolean;
  created_at: string;
  last_login: string | null;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  details: Record<string, unknown>;
  actor: string | null;
  created_at: string;
}

// Admin Authentication
export async function adminLogin(email: string, password: string): Promise<AdminLoginResponse> {
  return apiPost<AdminLoginResponse>('/api/admin/auth/login', { email, password });
}

export async function adminLogout(): Promise<void> {
  await apiPost('/api/admin/auth/logout', {});
}

export async function getAdminMe(): Promise<AdminMeResponse> {
  return apiGet<AdminMeResponse>('/api/admin/auth/me');
}

// Tenant Management
export async function getTenants(): Promise<Tenant[]> {
  return apiGet<Tenant[]>('/api/admin/tenants');
}

export async function getTenant(id: string): Promise<Tenant> {
  return apiGet<Tenant>(`/api/admin/tenants/${id}`);
}

export async function createTenant(data: TenantCreateRequest): Promise<Tenant> {
  return apiPost<Tenant>('/api/admin/tenants', data);
}

export async function updateTenant(id: string, data: Partial<TenantCreateRequest>): Promise<Tenant> {
  return apiPut<Tenant>(`/api/admin/tenants/${id}`, data);
}

export async function updateTenantStatus(id: string, status: Tenant['status']): Promise<Tenant> {
  return apiPut<Tenant>(`/api/admin/tenants/${id}/status`, { status });
}

export async function deleteTenant(id: string, deleteDatabase: boolean = false): Promise<void> {
  await apiDelete(`/api/admin/tenants/${id}?delete_database=${deleteDatabase}`);
}

export async function provisionTenant(id: string): Promise<TenantProvisionResponse> {
  return apiPost<TenantProvisionResponse>(`/api/admin/tenants/${id}/provision`, {});
}

export async function deprovisionTenant(id: string): Promise<void> {
  await apiPost(`/api/admin/tenants/${id}/deprovision`, {});
}

export async function resetTenantAdminPassword(id: string): Promise<{ email: string; password: string }> {
  return apiPost(`/api/admin/tenants/${id}/reset-admin-password`, {});
}

export async function getTenantAuditLog(id: string, limit = 50): Promise<AuditLogEntry[]> {
  return apiGet<AuditLogEntry[]>(`/api/admin/tenants/${id}/audit?limit=${limit}`);
}

// System Stats
export async function getSystemStats(): Promise<SystemStats> {
  return apiGet<SystemStats>('/api/admin/stats');
}

// Admin User Management (Superadmin only)
export async function getAdminUsers(): Promise<AdminUserListItem[]> {
  return apiGet<AdminUserListItem[]>('/api/admin/users');
}

export async function createAdminUser(data: {
  email: string;
  password: string;
  name: string;
  role: string;
}): Promise<AdminUserListItem> {
  return apiPost<AdminUserListItem>('/api/admin/users', data);
}

export async function updateAdminUser(
  id: number,
  data: { name?: string; role?: string; active?: boolean; password?: string }
): Promise<AdminUserListItem> {
  return apiPut<AdminUserListItem>(`/api/admin/users/${id}`, data);
}

export async function deleteAdminUser(id: number): Promise<void> {
  await apiDelete(`/api/admin/users/${id}`);
}

// Organization Management
export async function getOrganizations(): Promise<Organization[]> {
  return apiGet<Organization[]>('/api/admin/organizations');
}

export async function getOrganization(id: string): Promise<OrganizationDetail> {
  return apiGet<OrganizationDetail>(`/api/admin/organizations/${id}`);
}

export async function createOrganization(data: OrganizationCreateRequest): Promise<Organization> {
  return apiPost<Organization>('/api/admin/organizations', data);
}

export async function updateOrganization(id: string, data: Partial<OrganizationCreateRequest>): Promise<Organization> {
  return apiPut<Organization>(`/api/admin/organizations/${id}`, data);
}

export async function deleteOrganization(id: string): Promise<void> {
  await apiDelete(`/api/admin/organizations/${id}`);
}

// Organization SSO Configuration
export async function getOrganizationSSOConfig(orgId: string): Promise<OrganizationSSOConfig> {
  return apiGet<OrganizationSSOConfig>(`/api/admin/organizations/${orgId}/sso`);
}

export async function updateOrganizationSSOConfig(orgId: string, data: OrganizationSSOConfigUpdate): Promise<OrganizationSSOConfig> {
  return apiPut<OrganizationSSOConfig>(`/api/admin/organizations/${orgId}/sso`, data);
}

export async function deleteOrganizationSSOConfig(orgId: string): Promise<void> {
  await apiDelete(`/api/admin/organizations/${orgId}/sso`);
}

// Tenant Organization Assignment
export async function addTenantToOrganization(orgId: string, tenantId: string, data?: TenantGroupAccessUpdate): Promise<void> {
  await apiPut(`/api/admin/organizations/${orgId}/tenants/${tenantId}`, data || {});
}

export async function removeTenantFromOrganization(orgId: string, tenantId: string): Promise<void> {
  await apiDelete(`/api/admin/organizations/${orgId}/tenants/${tenantId}`);
}

export async function updateTenantGroupAccess(tenantId: string, data: TenantGroupAccessUpdate): Promise<void> {
  await apiPatch(`/api/admin/organizations/tenants/${tenantId}/groups`, data);
}
