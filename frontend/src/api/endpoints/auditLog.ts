/**
 * Audit log API (Settings → General → Data management → Open audit log; every route needs
 * `system.audit_log`).
 *
 * `list` is one numbered page of the filtered log, newest first; `actions`
 * the distinct action keys recorded so far (the Action filter's options);
 * `exportCsv` downloads the same filters as `audit-log.csv` (at most 50 000
 * rows), which the server records as `access.audit_log.exported`. Every call
 * is a GET, so none is queued in What-If mode.
 */

import { apiGet, downloadFile } from '../client';
import type { AuditCategory, AuditLogPage, AuditOutcome } from '@/types';

/** The query of `GET /api/audit-log` (the export takes the same, without paging). */
export interface AuditLogQuery {
  category?: AuditCategory;
  /** Exact key; a trailing `.` makes it a prefix (`auth.login.`) */
  action?: string;
  outcome?: AuditOutcome;
  actor_user_id?: number;
  /** Substring of the actor's email or name, the account or the target label */
  q?: string;
  /** Exact address */
  ip?: string;
  /** `YYYY-MM-DD`, inclusive */
  since?: string;
  /** `YYYY-MM-DD`, inclusive (to the end of that day) */
  until?: string;
  project_id?: number;
  page?: number;
  page_size?: number;
}

/** `?a=1&b=2` of the parameters that are set ('' when none is). */
export function auditLogQueryString(query: AuditLogQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const auditLogApi = {
  /** One page of the log for `query`, newest first */
  list: (query: AuditLogQuery) => apiGet<AuditLogPage>(`/api/audit-log${auditLogQueryString(query)}`),

  /** The distinct action keys recorded so far, sorted */
  actions: async (): Promise<string[]> => {
    const response = await apiGet<{ actions: string[] }>('/api/audit-log/actions');
    return response.actions;
  },

  /** Download the filtered log as `audit-log.csv` (paging is ignored) */
  exportCsv: (query: AuditLogQuery) => {
    const filters: AuditLogQuery = { ...query };
    delete filters.page;
    delete filters.page_size;
    return downloadFile(`/api/audit-log/export${auditLogQueryString(filters)}`, 'audit-log.csv');
  },
};
