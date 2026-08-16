/**
 * Due-soon and overdue reminders, derived in the browser.
 *
 * These are NOT stored server-side: the application has no scheduler, and
 * every card's end date and status is already in appStore.projects on every
 * client. Deriving them costs nothing and avoids adding an always-on
 * background job for one badge.
 *
 * The trade-off, stated plainly: nothing fires while the app is closed, and
 * there is no email or push. Dismissals live in localStorage, keyed by card
 * and due date so a card that becomes overdue again after a reschedule
 * notifies afresh.
 */

import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { collectCardsForProjects, dueStateOf } from '@/utils/kanbanCards';
import { getLocalStorage, setLocalStorage, STORAGE_KEYS } from '@/utils/storage';
import type { AppNotification } from '@/types';

type DismissedMap = Record<string, string>;

/** Dismissal key: card + the due date it was flagged for. */
function dismissalKey(cardKey: string, endDate: string): string {
  return `${cardKey}@${endDate}`;
}

export function dismissDerivedNotification(cardKey: string, endDate: string): void {
  const map = getLocalStorage<DismissedMap>(STORAGE_KEYS.KANBAN_DUE_DISMISSED, {});
  map[dismissalKey(cardKey, endDate)] = new Date().toISOString();
  setLocalStorage(STORAGE_KEYS.KANBAN_DUE_DISMISSED, map);
}

/**
 * Derived reminders for the current user's cards.
 * Ids are negative so they can never collide with real notification ids.
 */
export function useDerivedDueNotifications(): AppNotification[] {
  const projects = useAppStore((s) => s.projects);
  const currentUser = useAppStore((s) => s.currentUser);

  return useMemo(() => {
    if (!currentUser) return [];
    const dismissed = getLocalStorage<DismissedMap>(STORAGE_KEYS.KANBAN_DUE_DISMISSED, {});

    return collectCardsForProjects(projects)
      .filter((card) => card.assigneeIds.includes(currentUser.id))
      .map((card) => ({ card, due: dueStateOf(card) }))
      .filter(({ card, due }) => due !== null && !dismissed[dismissalKey(card.key, card.endDate)])
      .map(({ card, due }, index): AppNotification => ({
        id: -(index + 1),
        type: due === 'overdue' ? 'overdue' : 'due_soon',
        actor_id: null,
        actor_name: null,
        entity_type: card.entityType,
        entity_id: card.entityId,
        project_id: card.projectId,
        title:
          due === 'overdue'
            ? `${card.name} is overdue`
            : `${card.name} is due soon`,
        body: `${card.projectName} - due ${card.endDate}`,
        read_at: null,
        created_at: new Date().toISOString(),
        source: 'derived',
      }));
  }, [projects, currentUser]);
}
