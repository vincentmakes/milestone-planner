/**
 * useMentionCandidates: the people on the target first, then the site's
 * mentionable people (loaded once per site), never the signed-in user; no
 * site, no load.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useMentionCandidates } from '../useMentionCandidates';
import { getMentionableUsers } from '@/api/endpoints/kanban';
import { clearMentionableUsersCache } from '@/api/endpoints/mentionableCache';
import type { StaffAssignment } from '@/types';

vi.mock('@/api/endpoints/kanban', () => ({
  getMentionableUsers: vi.fn(),
}));

const participants: StaffAssignment[] = [
  { id: 1, staff_id: 9, staff_name: 'Carol Chen', allocation: 50, start_date: '', end_date: '' },
];
const ME = 4;

beforeEach(() => {
  vi.clearAllMocks();
  clearMentionableUsersCache();
  vi.mocked(getMentionableUsers).mockResolvedValue([
    { id: 7, name: 'Alice Anderson', job_title: 'Engineer' },
    { id: ME, name: 'Bob Brown', job_title: null },
  ]);
});

describe('useMentionCandidates', () => {
  it('lists the participants first, then the site people, never me', async () => {
    const { result } = renderHook(() => useMentionCandidates(1, participants, ME));

    await waitFor(() => expect(result.current.map((c) => c.name)).toEqual(['Carol Chen', 'Alice Anderson']));
    expect(getMentionableUsers).toHaveBeenCalledWith(1);
    expect(result.current[0]).toMatchObject({ id: 9, onCard: true });
    expect(result.current[1]).toMatchObject({ id: 7, hint: 'Engineer', onCard: false });
  });

  it.each([null, undefined])('loads nothing without a site (%s)', (siteId) => {
    const { result } = renderHook(() => useMentionCandidates(siteId, participants, ME));

    expect(getMentionableUsers).not.toHaveBeenCalled();
    expect(result.current.map((c) => c.name)).toEqual(['Carol Chen']);
  });

  it('logs a failed load and keeps the participants', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getMentionableUsers).mockRejectedValueOnce(new Error('403'));

    const { result } = renderHook(() => useMentionCandidates(2, participants, ME));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('[Comments] Failed to load mentionable users:', expect.any(Error))
    );
    expect(result.current.map((c) => c.name)).toEqual(['Carol Chen']);
    error.mockRestore();
  });
});
