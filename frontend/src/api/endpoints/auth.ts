/**
 * Authentication API endpoints
 */

import { apiGet, apiPost } from '../client';
import type { User, AuthResponse } from '@/types';

/**
 * Check current authentication status
 * Returns the current user if authenticated
 */
export async function checkAuth(): Promise<{ user: User | null }> {
  try {
    const response = await apiGet<{ user: User }>('/api/auth/me');
    return response;
  } catch {
    return { user: null };
  }
}

/**
 * Login with email and password
 */
export async function login(email: string, password: string): Promise<AuthResponse> {
  return apiPost<AuthResponse>('/api/auth/login', { email, password });
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
