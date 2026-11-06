import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import { auditLogApi, auditLogQueryString } from '../auditLog';

vi.mock('@/api/client', () => ({ apiGet: vi.fn(), downloadFile: vi.fn() }));

describe('auditLogQueryString', () => {
  it('serialises the set parameters only', () => {
    expect(auditLogQueryString({})).toBe('');
    expect(
      auditLogQueryString({ category: 'auth', q: 'ada@x', actor_user_id: 7, page: 2, page_size: 25, ip: '' })
    ).toBe('?category=auth&q=ada%40x&actor_user_id=7&page=2&page_size=25');
  });
});

describe('auditLogApi', () => {
  beforeEach(() => {
    vi.mocked(client.apiGet).mockReset();
    vi.mocked(client.downloadFile).mockReset().mockResolvedValue(undefined);
  });

  it('lists a page with the query', async () => {
    const page = { items: [], total: 0, page: 1, page_size: 50 };
    vi.mocked(client.apiGet).mockResolvedValue(page);
    await expect(auditLogApi.list({ outcome: 'failure', page: 1, page_size: 50 })).resolves.toBe(page);
    expect(client.apiGet).toHaveBeenCalledWith('/api/audit-log?outcome=failure&page=1&page_size=50');
  });

  it('unwraps the actions', async () => {
    vi.mocked(client.apiGet).mockResolvedValue({ actions: ['auth.logout', 'project.created'] });
    await expect(auditLogApi.actions()).resolves.toEqual(['auth.logout', 'project.created']);
    expect(client.apiGet).toHaveBeenCalledWith('/api/audit-log/actions');
  });

  it('downloads the export with the filters and without the paging', async () => {
    await auditLogApi.exportCsv({ category: 'admin', since: '2026-11-01', page: 3, page_size: 100 });
    expect(client.downloadFile).toHaveBeenCalledWith(
      '/api/audit-log/export?category=admin&since=2026-11-01',
      'audit-log.csv'
    );
    await auditLogApi.exportCsv({});
    expect(client.downloadFile).toHaveBeenLastCalledWith('/api/audit-log/export', 'audit-log.csv');
  });
});
