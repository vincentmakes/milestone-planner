/**
 * The mention picker's per-site cache: one load per site, shared while in
 * flight, a failure not kept, and a clear forgets everything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clearMentionableUsersCache, mentionableUsersFor } from '../mentionableCache';

const alice = { id: 7, name: 'Alice', job_title: null };

beforeEach(() => clearMentionableUsersCache());

describe('mentionableUsersFor', () => {
  it('loads once per site', async () => {
    const load = vi.fn().mockResolvedValue([alice]);
    await expect(mentionableUsersFor(1, load)).resolves.toEqual([alice]);
    await expect(mentionableUsersFor(1, load)).resolves.toEqual([alice]);
    await mentionableUsersFor(2, load);
    expect(load.mock.calls).toEqual([[1], [2]]);
  });

  it('does not keep a failed load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('500')).mockResolvedValue([alice]);
    await expect(mentionableUsersFor(1, load)).rejects.toThrow('500');
    await expect(mentionableUsersFor(1, load)).resolves.toEqual([alice]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('loads again after a clear', async () => {
    const load = vi.fn().mockResolvedValue([alice]);
    await mentionableUsersFor(1, load);
    clearMentionableUsersCache();
    await mentionableUsersFor(1, load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
