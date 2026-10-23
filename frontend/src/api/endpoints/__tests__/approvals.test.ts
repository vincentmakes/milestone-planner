/**
 * The 202 contract of the self-booking routes: a write that needs approval
 * answers `{success, pending: true, request_id, id}` instead of the row, and
 * the client tells the two apart from the body (a successful call does not
 * expose its HTTP status).
 */
import { describe, it, expect } from 'vitest';
import { isPendingResponse, SENT_FOR_APPROVAL } from '../approvals';

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
