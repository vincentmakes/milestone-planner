/**
 * Presence API endpoints
 * Handles tracking active viewers and conflict detection
 */

import { apiGet, apiPost, apiDelete } from '../client';

export interface PresenceUser {
  user_id: number;
  first_name: string;
  last_name: string;
  activity: 'viewing' | 'editing';
  started_at: string;
  last_seen_at: string;
}

export interface HeartbeatResponse {
  success: boolean;
  viewers: PresenceUser[];
}

export interface ConflictCheckResponse {
  has_conflict: boolean;
  message: string | null;
  last_modified_at: string | null;
  last_modified_by: string | null;
  active_editors: PresenceUser[];
}

/**
 * Send heartbeat to maintain presence on a project
 * Should be called every 30 seconds while viewing a project
 */
export async function sendPresenceHeartbeat(
  projectId: number,
  activity: 'viewing' | 'editing' = 'viewing'
): Promise<HeartbeatResponse> {
  return apiPost<HeartbeatResponse>('/api/presence/heartbeat', {
    project_id: projectId,
    activity,
  });
}

/**
 * Leave a project (remove presence)
 * Should be called when navigating away from a project
 */
export async function leaveProject(projectId: number): Promise<void> {
  await apiDelete(`/api/presence/${projectId}`);
}

/**
 * Get all viewers for a specific project
 */
export async function getProjectPresence(projectId: number): Promise<{
  project_id: number;
  viewers: PresenceUser[];
}> {
  return apiGet(`/api/presence/project/${projectId}`);
}

/**
 * Get presence for all projects in a site
 * Returns a map of project_id -> viewers
 */
export async function getSitePresence(siteId: number): Promise<{
  presence: Record<number, PresenceUser[]>;
}> {
  return apiGet(`/api/presence/site/${siteId}`);
}

/**
 * Check for conflicts before saving
 * @param projectId - The project to check
 * @param expectedUpdatedAt - The updated_at timestamp the client has
 */
export async function checkConflict(
  projectId: number,
  expectedUpdatedAt?: string
): Promise<ConflictCheckResponse> {
  const params = expectedUpdatedAt 
    ? `?expected_updated_at=${encodeURIComponent(expectedUpdatedAt)}`
    : '';
  return apiPost(`/api/presence/check-conflict/${projectId}${params}`);
}
