/**
 * Users API endpoints
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { User, CreateUserRequest, UpdateUserRequest } from '@/types';

/**
 * Get all users
 * @param includeDisabled - If true, include disabled users
 */
export async function getUsers(includeDisabled = false): Promise<User[]> {
  const url = includeDisabled
    ? '/api/users?includeDisabled=true'
    : '/api/users';
  const response = await apiGet<{ items: User[]; total: number; offset: number; limit: number }>(url);
  return response.items;
}

/**
 * Get a single user
 */
export async function getUser(id: number): Promise<User> {
  return apiGet<User>(`/api/users/${id}`);
}

/**
 * Create a new user
 */
export async function createUser(data: CreateUserRequest): Promise<User> {
  return apiPost<User>('/api/users', data);
}

/**
 * Update a user
 */
export async function updateUser(id: number, data: UpdateUserRequest): Promise<User> {
  return apiPut<User>(`/api/users/${id}`, data);
}

/**
 * Delete a user
 */
export async function deleteUser(id: number): Promise<void> {
  await apiDelete(`/api/users/${id}`);
}
