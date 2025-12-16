/**
 * Admin API Endpoints
 * Multi-tenant administration
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';

// Types
export interface AdminUser {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'superadmin';
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
