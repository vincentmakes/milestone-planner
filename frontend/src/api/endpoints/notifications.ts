/**
 * Notification API endpoints.
 *
 * All of these are implicitly scoped to the session user server-side; there is
 * no user id to pass, by design.
 */

import { apiDelete, apiGet, apiPut } from '../client';
import type { AppNotification } from '@/types';

export async function getNotifications(unreadOnly = false, limit = 50): Promise<AppNotification[]> {
  const items = await apiGet<AppNotification[]>(
    `/api/notifications?unread_only=${unreadOnly}&limit=${limit}`
  );
  return items.map((n) => ({ ...n, source: 'server' as const }));
}

export async function getUnreadCount(): Promise<number> {
  const result = await apiGet<{ count: number }>('/api/notifications/unread-count');
  return result.count;
}

export function markNotificationRead(id: number): Promise<{ success: boolean }> {
  return apiPut(`/api/notifications/${id}/read`, {});
}

export function markAllNotificationsRead(): Promise<{ success: boolean }> {
  return apiPut('/api/notifications/read-all', {});
}

/** Delete one of the user's notifications (204; 404 when it is gone or not theirs). */
export async function deleteNotification(id: number): Promise<void> {
  await apiDelete<void>(`/api/notifications/${id}`);
}

/** Delete every notification of the user, beyond the loaded page too. */
export function clearNotifications(): Promise<{ deleted: number }> {
  return apiDelete('/api/notifications');
}
