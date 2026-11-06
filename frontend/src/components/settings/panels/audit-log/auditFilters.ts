/**
 * The audit log panel's filters and the query they send.
 *
 * `auditLogQuery` is the one param builder: it drops every empty filter (no
 * `category=` for All, no blank search, no unset date), trims the text
 * fields, and adds the paging only when it is given (the export has none).
 */

import type { AuditLogQuery } from '@/api/endpoints/auditLog';
import type { AuditCategory, AuditOutcome } from '@/types';

export type CategoryFilter = 'all' | AuditCategory;
export type OutcomeFilter = 'all' | AuditOutcome;

export interface AuditFilters {
  /** Email, name or target (debounced by the panel) */
  q: string;
  category: CategoryFilter;
  outcome: OutcomeFilter;
  /** An exact action key, or null for any */
  action: string | null;
  actorUserId: number | null;
  /** An exact IP address (debounced by the panel) */
  ip: string;
  /** `YYYY-MM-DD` or '' */
  since: string;
  /** `YYYY-MM-DD` or '' */
  until: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = {
  q: '',
  category: 'all',
  outcome: 'all',
  action: null,
  actorUserId: null,
  ip: '',
  since: '',
  until: '',
};

export const PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;

/** Whether any filter narrows the log. */
export function hasActiveFilters(filters: AuditFilters): boolean {
  const query = auditLogQuery(filters);
  return Object.keys(query).length > 0;
}

/** The request's query: the set filters only, plus `page` / `page_size` when paging is given. */
export function auditLogQuery(
  filters: AuditFilters,
  paging?: { page: number; pageSize: number }
): AuditLogQuery {
  const query: AuditLogQuery = {};
  const q = filters.q.trim();
  if (q) query.q = q;
  if (filters.category !== 'all') query.category = filters.category;
  if (filters.outcome !== 'all') query.outcome = filters.outcome;
  if (filters.action) query.action = filters.action;
  if (filters.actorUserId !== null) query.actor_user_id = filters.actorUserId;
  const ip = filters.ip.trim();
  if (ip) query.ip = ip;
  if (filters.since) query.since = filters.since;
  if (filters.until) query.until = filters.until;
  if (paging) {
    query.page = paging.page;
    query.page_size = paging.pageSize;
  }
  return query;
}
