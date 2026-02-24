/**
 * Authentication API endpoints
 */

import { apiGet, apiPost } from '../client';
import type { User, AuthResponse } from '@/types';

/**
 * Transform user from API camelCase to frontend snake_case
 */
function transformUser(apiUser: any): User {
  return {
    id: apiUser.id,
    email: apiUser.email,
    first_name: apiUser.firstName,
    last_name: apiUser.lastName,
    name: apiUser.name,
    job_title: apiUser.jobTitle,
    role: apiUser.role,
    max_capacity: apiUser.maxCapacity ?? apiUser.max_capacity ?? 100,
    active: true,
    site_ids: apiUser.siteIds || [],
    skills: apiUser.skills || [],
  };
}

/**
 * Check current authentication status
 * Returns the current user if authenticated
 */
export async function checkAuth(): Promise<{ user: User | null }> {
  try {
    const response = await apiGet<{ user: any }>('/api/auth/me');
    if (response.user) {
      return { user: transformUser(response.user) };
    }
    return { user: null };
  } catch {
    return { user: null };
  }
}

/**
 * Login with email and password
 */
export async function login(email: string, password: string): Promise<AuthResponse> {
  const response = await apiPost<{ success: boolean; user: any }>('/api/auth/login', { email, password });
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
