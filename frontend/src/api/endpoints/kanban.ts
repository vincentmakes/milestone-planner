/**
 * Kanban API endpoints.
 *
 * The board itself needs no endpoint - it derives from the project tree that
 * GET /projects/{id} already returns. These calls cover the things the tree
 * does not carry: comment counts, status moves, assignees and comments.
 */

import { apiGet, apiPut, apiPost, apiDelete } from '../client';
import { cardKey } from '@/utils/kanbanCards';
import type { CardStatus } from '@/types';

export type CardEntityType = 'phase' | 'subphase';

/** Raw shape of GET /kanban/projects/{id}/comment-counts. */
interface CommentCountsResponse {
  phase?: Record<string, number>;
  subphase?: Record<string, number>;
}

export interface MoveCardResponse {
  success: boolean;
  status: CardStatus;
  completion: number | null;
  /** Present only when the write was swallowed by What-If mode. */
  whatIfMode?: boolean;
}

/**
 * Comment counts for one project, flattened to the board's card-key space
 * (`phase-12`, `subphase-45`) so callers never re-derive the key format.
 */
function flattenCommentCounts(raw: CommentCountsResponse): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entityType of ['phase', 'subphase'] as CardEntityType[]) {
    for (const [id, count] of Object.entries(raw[entityType] ?? {})) {
      counts.set(cardKey(entityType, Number(id)), count);
    }
  }
  return counts;
}

export async function getCommentCounts(projectId: number): Promise<Map<string, number>> {
  const raw = await apiGet<CommentCountsResponse>(
    `/api/kanban/projects/${projectId}/comment-counts`
  );
  return flattenCommentCounts(raw);
}

/**
 * Comment counts for every card in a site, in one request.
 * Used by the board's "All projects" mode instead of one call per project.
 */
export async function getSiteCommentCounts(siteId: number): Promise<Map<string, number>> {
  const raw = await apiGet<CommentCountsResponse>(`/api/kanban/sites/${siteId}/comment-counts`);
  return flattenCommentCounts(raw);
}

/** Move a card to a different status column. */
export function moveCard(
  entityType: CardEntityType,
  entityId: number,
  status: CardStatus
): Promise<MoveCardResponse> {
  return apiPut<MoveCardResponse>(`/api/kanban/cards/${entityType}/${entityId}/status`, {
    status,
  });
}

/**
 * Assign a staff member to a card, which also books their time.
 * `allocation` is resolved server-side from the assignee's max_capacity when
 * omitted - never guess it on the client.
 */
export function assignCard(
  entityType: CardEntityType,
  entityId: number,
  staffId: number,
  allocation?: number
): Promise<{ success: boolean; id: number; allocation: number }> {
  return apiPost(`/api/kanban/cards/${entityType}/${entityId}/assignees`, {
    staff_id: staffId,
    allocation: allocation ?? null,
  });
}

/** Remove a staff member from a card, releasing their booking. */
export function unassignCard(
  entityType: CardEntityType,
  entityId: number,
  staffId: number
): Promise<{ success: boolean }> {
  return apiDelete(`/api/kanban/cards/${entityType}/${entityId}/assignees/${staffId}`);
}

export interface CardComment {
  id: number;
  entity_type: CardEntityType;
  entity_id: number;
  project_id: number;
  author_id: number;
  author_name: string | null;
  body: string;
  mentioned_user_ids: number[];
  edited: boolean;
  created_at: string;
  updated_at: string;
}

export function getComments(
  entityType: CardEntityType,
  entityId: number
): Promise<CardComment[]> {
  return apiGet(`/api/kanban/cards/${entityType}/${entityId}/comments`);
}

export function createComment(
  entityType: CardEntityType,
  entityId: number,
  body: string,
  mentionedUserIds: number[] = []
): Promise<CardComment> {
  return apiPost(`/api/kanban/cards/${entityType}/${entityId}/comments`, {
    body,
    mentioned_user_ids: mentionedUserIds,
  });
}

export function updateComment(commentId: number, body: string): Promise<CardComment> {
  return apiPut(`/api/kanban/comments/${commentId}`, { body });
}

export function deleteComment(commentId: number): Promise<{ success: boolean }> {
  return apiDelete(`/api/kanban/comments/${commentId}`);
}
