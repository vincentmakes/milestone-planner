/**
 * Authentication API endpoints
 */

import { apiGet, apiPost } from '../client';
import type { User, AuthResponse } from '@/types';

/**
 * Transform user from API camelCase to frontend snake_case.
 *
 * The permission fields are the role's resolved matrix (see
 * utils/permissions). A server that sends none grants nothing: the client
 * never infers permissions from the role key.
 */
function transformUser(apiUser: Record<string, unknown>): User {
  const role = apiUser.role as User['role'];
  return {
    id: apiUser.id as number,
    email: apiUser.email as string,
    first_name: apiUser.firstName as string,
    last_name: apiUser.lastName as string,
    name: apiUser.name as string,
    job_title: apiUser.jobTitle as string | undefined,
    role,
    role_name: (apiUser.roleName ?? role) as string,
    max_capacity: (apiUser.maxCapacity ?? apiUser.max_capacity ?? 100) as number,
    active: true,
    // Older servers send no flag: everyone stays bookable, as before.
    is_resource: apiUser.isResource !== false,
    site_ids: (apiUser.siteIds || []) as number[],
    skills: (apiUser.skills || []) as User['skills'],
    permissions: (apiUser.permissions ?? []) as string[],
    approval_required: (apiUser.approvalRequired ?? []) as string[],
    can_see_all_sites: Boolean(apiUser.canSeeAllSites),
  };
}

/**
 * Check current authentication status
 * Returns the current user if authenticated
 */
export async function checkAuth(): Promise<{ user: User | null }> {
  try {
    const response = await apiGet<{ user: Record<string, unknown> | null }>('/api/auth/me');
    if (response.user) {
      return { user: transformUser(response.user) };
    }
    return { user: null };
  } catch {
    return { user: null };
  }
}

/**
 * The signed-in user, `null` when the session is gone. Unlike checkAuth this
 * THROWS on network/server errors, so callers can tell "logged out" from
 * "could not ask" (a dropped connection must not log anyone out).
 */
export async function fetchCurrentUser(): Promise<User | null> {
  const response = await apiGet<{ user: Record<string, unknown> | null }>('/api/auth/me');
  return response.user ? transformUser(response.user) : null;
}

/**
 * Login with email and password
 */
export async function login(email: string, password: string): Promise<AuthResponse> {
  const response = await apiPost<{ success: boolean; user: Record<string, unknown> }>('/api/auth/login', { email, password });
  return {
    user: transformUser(response.user),
  };
}

/**
 * Logout current user
 */
export async function logout(): Promise<void> {
  await apiPost('/api/auth/logout');
}

/**
 * Check if SSO is enabled for this tenant
 */
export async function checkSSOEnabled(): Promise<{ enabled: boolean; provider?: string }> {
  try {
    const response = await apiGet<{ enabled: boolean; provider?: string }>('/api/auth/sso/status');
    return response;
  } catch {
    return { enabled: false };
  }
}

/**
 * Get SSO login URL
 */
export async function getSSOLoginUrl(): Promise<{ url: string }> {
  return apiGet<{ url: string }>('/api/auth/sso/login');
}
