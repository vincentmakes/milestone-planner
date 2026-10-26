/**
 * The @-mention picker's candidates for a thread on a project's site: the
 * people on the target first (`participants`, e.g. the card's bookings), then
 * everyone mentionable at the site (loaded once per site for the session,
 * `mentionableCache.ts`), never the signed-in user (a self-mention would
 * render a pill that notifies nobody).
 *
 * Shared by `CardComments` (a thread's composer) and `AssignmentModal` (the
 * optional comment written with a new booking). No site (`null` /
 * `undefined`) loads nothing — pass `null` while the field is hidden.
 */

import { useEffect, useMemo, useState } from 'react';
import { getMentionableUsers } from '@/api/endpoints/kanban';
import { mentionableUsersFor, type CachedMentionableUser } from '@/api/endpoints/mentionableCache';
import { buildMentionCandidates, type MentionCandidate } from '@/utils/mentions';
import type { StaffAssignment } from '@/types';

export function useMentionCandidates(
  siteId: number | null | undefined,
  participants: readonly StaffAssignment[],
  meUserId: number | null | undefined
): MentionCandidate[] {
  const [mentionable, setMentionable] = useState<{ siteId: number; users: CachedMentionableUser[] } | null>(
    null
  );

  useEffect(() => {
    if (siteId === undefined || siteId === null) return;
    let cancelled = false;
    mentionableUsersFor(siteId, getMentionableUsers)
      .then((users) => {
        if (!cancelled) setMentionable({ siteId, users });
      })
      .catch((err) => console.error('[Comments] Failed to load mentionable users:', err));
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  return useMemo(
    () =>
      buildMentionCandidates(
        [...participants],
        (mentionable && mentionable.siteId === siteId ? mentionable.users : []).map((u) => ({
          id: u.id,
          name: u.name,
          role: u.job_title ?? undefined,
        })),
        meUserId ?? undefined
      ),
    [participants, mentionable, siteId, meUserId]
  );
}
