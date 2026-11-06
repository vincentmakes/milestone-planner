/**
 * The 202 contract of the self-booking routes: a write that needs approval
 * answers `{success, pending: true, request_id, id}` instead of the row, and
 * the client tells the two apart from the body (a successful call does not
 * expose its HTTP status). And the History's query string.
 */
import { describe, it, expect, vi } from 'vitest';
import * as client from '@/api/client';
import { approvalsApi, HISTORY_PAGE_SIZE, isPendingResponse, SENT_FOR_APPROVAL } from '../approvals';

vi.mock('@/api/client', () => ({ apiGet: vi.fn().mockResolvedValue([]), apiPost: vi.fn() }));

describe('isPendingResponse', () => {
  it('recognises the 202 body', () => {
    expect(isPendingResponse({ success: true, pending: true, request_id: 3, id: 9 })).toBe(true);
  });

  it('is false for a direct write, the What-If fake success and empty bodies', () => {
    expect(isPendingResponse({ id: 9, staff_id: 4, allocation: 50 })).toBe(false);
    expect(isPendingResponse({ success: true, whatIfMode: true, id: 1 })).toBe(false);
    expect(isPendingResponse({ success: true, cancelled: true })).toBe(false);
    expect(isPendingResponse({})).toBe(false);
    expect(isPendingResponse(undefined)).toBe(false);
    expect(isPendingResponse(null)).toBe(false);
    expect(isPendingResponse('pending')).toBe(false);
  });

  it('needs a request id', () => {
    expect(isPendingResponse({ success: true, pending: true })).toBe(false);
  });

  it('names the flash message once', () => {
    expect(SENT_FOR_APPROVAL).toBe('Sent for approval');
  });
});

describe('listHistory', () => {
  const url = () => vi.mocked(client.apiGet).mock.lastCall?.[0];

  it('sends every parameter it is given', async () => {
    await approvalsApi.listHistory({
      scope: 'all',
      closed: true,
      status: 'rejected',
      project_id: 2,
      requester_id: 7,
      decided_by: 9,
      before_id: 151,
      limit: HISTORY_PAGE_SIZE,
    });
    expect(url()).toBe(
      '/api/approval-requests?scope=all&closed=true&status=rejected&project_id=2&requester_id=7&decided_by=9&before_id=151&limit=50'
    );
  });

  it('leaves out what is not set', async () => {
    await approvalsApi.listHistory({ scope: 'decided', closed: false, limit: 50 });
    expect(url()).toBe('/api/approval-requests?scope=decided&limit=50');
  });
});
