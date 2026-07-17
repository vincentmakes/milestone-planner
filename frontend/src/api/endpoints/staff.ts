/**
 * Staff API endpoints.
 *
 * Staff are read-only views of users — there are no staff write endpoints.
 * Staff members are created and managed via the /users endpoints.
 */

import { apiGet } from '../client';
import type { Staff } from '@/types';

/**
 * Get all staff members
 * @param includeAllSites - If true, return staff from all sites
 */
export async function getStaff(includeAllSites = false): Promise<Staff[]> {
  const url = includeAllSites
    ? '/api/staff?includeAllSites=true'
    : '/api/staff';
  return apiGet<Staff[]>(url);
}

/**
 * Get a single staff member
 */
export async function getStaffMember(id: number): Promise<Staff> {
  return apiGet<Staff>(`/api/staff/${id}`);
}
