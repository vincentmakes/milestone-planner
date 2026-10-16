/**
 * API client: What-If interception (which writes are queued, which are
 * exempt), session-expiry detection on 401, and Content-Disposition decoding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiRequest, configureApiClient, clientConfig, decodeFilename } from '../client';
import type { WriteMethod } from '../client';

type QueuedOp = { method: WriteMethod; url: string; body?: unknown };

let whatIf = false;
let queued: QueuedOp[] = [];
const onUnauthorized = vi.fn();
const fetchMock = vi.fn();

function respond(status: number, body: unknown = {}) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('apiRequest', () => {
  beforeEach(() => {
    whatIf = false;
    queued = [];
    onUnauthorized.mockReset();
    fetchMock.mockReset();
    respond(200, { ok: true });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    configureApiClient({
      isWhatIfMode: () => whatIf,
      queueWhatIfOperation: (op) => queued.push(op),
      onUnauthorized,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    configureApiClient({ isWhatIfMode: () => false, queueWhatIfOperation: undefined, onUnauthorized: undefined });
  });

  describe('What-If interception', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('queues %s instead of sending it', async (method) => {
      whatIf = true;
      const result = await apiRequest<{ success: boolean; whatIfMode: boolean }>('/api/custom-columns/3', {
        method,
        body: { name: 'x' },
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(queued).toEqual([{ method, url: '/api/custom-columns/3', body: { name: 'x' } }]);
      expect(result).toMatchObject({ success: true, whatIfMode: true });
    });

    it('sends GETs for real', async () => {
      whatIf = true;
      await apiRequest('/api/projects');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(queued).toEqual([]);
    });

    it.each([
      ['PUT', '/api/auth/change-password'],
      ['PUT', '/api/settings/instance_title'],
      ['PATCH', '/api/admin/organizations/tenants/abc/groups'],
      ['PUT', '/api/notifications/read-all'],
      ['PUT', '/api/kanban/comments/5'],
      ['POST', '/api/kanban/cards/phase/12/comments'],
      ['POST', '/api/kanban/cards/subphase/7/comments'],
    ] as const)('lets exempt write %s %s through', async (method, url) => {
      whatIf = true;
      await apiRequest(url, { method, body: {} });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(queued).toEqual([]);
    });

    it('still queues Kanban card moves and assignments (plan operations)', async () => {
      whatIf = true;
      await apiRequest('/api/kanban/cards/phase/12/status', { method: 'PUT', body: { status: 'done' } });
      await apiRequest('/api/kanban/cards/phase/12/assignees', { method: 'POST', body: { staff_id: 1 } });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(queued.map((op) => op.url)).toEqual([
        '/api/kanban/cards/phase/12/status',
        '/api/kanban/cards/phase/12/assignees',
      ]);
    });

    it('lets tag and tag-group writes through while a project write is still queued', async () => {
      whatIf = true;
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await apiRequest('/api/tags', { method: 'POST', body: { name: 'Pilot' } });
      await apiRequest('/api/tags/3', { method: 'PUT', body: { color: '#ff0000' } });
      await apiRequest('/api/tags/reorder', { method: 'PUT', body: { tag_order: [3, 1] } });
      await apiRequest('/api/tag-groups', { method: 'POST', body: { name: 'Type' } });
      await apiRequest('/api/tag-groups/2', { method: 'DELETE' });
      await apiRequest('/api/tag-groups/reorder', { method: 'PUT', body: { group_order: [2] } });
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(queued).toEqual([]);

      await apiRequest('/api/projects/7', { method: 'PUT', body: { tag_ids: [3] } });
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(queued).toEqual([{ method: 'PUT', url: '/api/projects/7', body: { tag_ids: [3] } }]);
    });

    it('sends every write for real outside What-If (PATCH included)', async () => {
      await apiRequest('/api/custom-columns/reorder', { method: 'PATCH', body: { order: [1] } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PATCH' });
      expect(queued).toEqual([]);
    });
  });

  describe('401 handling', () => {
    it('reports an expired session and still rejects the call', async () => {
      respond(401, { detail: 'Not authenticated' });
      await expect(apiRequest('/api/projects')).rejects.toThrow('Not authenticated');
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('does not treat a failed login (bad password) as an expired session', async () => {
      respond(401, { detail: 'Invalid email or password' });
      await expect(
        apiRequest('/api/auth/login', { method: 'POST', body: { email: 'a', password: 'b' } })
      ).rejects.toThrow('Invalid email or password');
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it('does not log the user out when change-password answers 401', async () => {
      respond(401, { detail: 'Current password is incorrect' });
      await expect(
        apiRequest('/t/acme/api/auth/change-password', {
          method: 'POST',
          body: { currentPassword: 'typo', newPassword: 'new-pass-123' },
        })
      ).rejects.toThrow('Current password is incorrect');
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it('leaves the admin portal session alone', async () => {
      respond(401, { detail: 'Not authenticated' });
      await expect(apiRequest('/api/admin/tenants')).rejects.toThrow();
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it('ignores other error statuses', async () => {
      respond(403, { detail: 'Forbidden' });
      await expect(apiRequest('/api/users')).rejects.toThrow('Forbidden');
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it('works without a handler configured', async () => {
      clientConfig.onUnauthorized = undefined;
      respond(401, { detail: 'Not authenticated' });
      await expect(apiRequest('/api/projects')).rejects.toThrow('Not authenticated');
    });
  });
});

describe('decodeFilename', () => {
  it('percent-decodes a Content-Disposition filename', () => {
    expect(decodeFilename('Site%20Export%20%C3%A9.xlsx', 'fallback.xlsx')).toBe('Site Export é.xlsx');
  });

  it('falls back instead of throwing on a malformed escape', () => {
    expect(() => decodeURIComponent('100%_done.xlsx')).toThrow(URIError);
    expect(decodeFilename('100%_done.xlsx', 'fallback.xlsx')).toBe('fallback.xlsx');
  });
});
