/**
 * Notification bell + panel.
 *
 * This is a popover, not a modal: click-outside-to-close is the correct
 * behaviour here (the no-backdrop-close rule covers dialogs only). Dismissal
 * (outside click, Tab out, Escape) is the shared `useDismissableOverlay`.
 *
 * Server notifications and browser-derived due reminders are merged for
 * display; only the former are marked read against the API. A click opens
 * the card on the Kanban board, or — for approval requests, decisions and
 * assigned tasks — My Todos on the matching tab; both are blocked during
 * What-If (they leave the Gantt).
 */

import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { useNotificationStore } from '@/stores/notificationStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import { useTodoStore } from '@/stores/todoStore';
import type { TodoStatusFilter, TodoTab } from '@/stores/todoStore';
import {
  getNotifications,
  getUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/api/endpoints/notifications';
import {
  dismissDerivedNotification,
  useDerivedDueNotifications,
} from '@/hooks/useDerivedDueNotifications';
import { cardKey } from '@/utils/kanbanCards';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { relativeTime } from '@/utils/relativeTime';
import type { AppNotification, NotificationType } from '@/types';
import styles from './NotificationBell.module.css';
import { useHasPermission } from '@/hooks/useCan';

const TYPE_ICONS: Record<string, string> = {
  assigned: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8.5 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  comment: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  mention: 'M12 2a10 10 0 1 0 4 19.2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm0 0v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-4 7.5',
  status_change: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  due_soon: 'M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  overdue: 'M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  approval_requested: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  approval_decided: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3',
  todo_assigned: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
};

/** Does clicking this notification jump to its card on the Kanban board? */
function opensCard(n: AppNotification): boolean {
  return Boolean(n.project_id && (n.entity_type === 'phase' || n.entity_type === 'subphase') && n.entity_id);
}

interface TodosTarget {
  tab: TodoTab;
  /** The Open/Done filter that shows the item (none on To decide, which has no filter) */
  filter?: TodoStatusFilter;
}

/**
 * Where in My Todos a notification about a request or a task lands. A
 * decision is about a request that is no longer pending, so My requests
 * opens on Done; a new task is open.
 */
const TODO_TARGETS: Partial<Record<NotificationType, TodosTarget>> = {
  approval_requested: { tab: 'decide' },
  approval_decided: { tab: 'requests', filter: 'done' },
  todo_assigned: { tab: 'tasks', filter: 'open' },
};

/** My Todos' target for this notification, unless it opens a card instead. */
function todosTargetFor(n: AppNotification): TodosTarget | null {
  if (opensCard(n)) return null;
  return TODO_TARGETS[n.type] ?? null;
}

const OPEN_CARD_ACTION = 'Opening a card from a notification';
const OPEN_TODOS_ACTION = 'Opening My Todos from a notification';

export function NotificationBell() {
  const panelRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const items = useNotificationStore((s) => s.items);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const panelOpen = useNotificationStore((s) => s.panelOpen);
  const setItems = useNotificationStore((s) => s.setItems);
  const setUnreadCount = useNotificationStore((s) => s.setUnreadCount);
  const setPanelOpen = useNotificationStore((s) => s.setPanelOpen);
  const togglePanel = useNotificationStore((s) => s.togglePanel);
  const markReadLocal = useNotificationStore((s) => s.markReadLocal);
  const markAllReadLocal = useNotificationStore((s) => s.markAllReadLocal);

  const currentUser = useAppStore((s) => s.currentUser);
  const setCurrentView = useViewStore((s) => s.setCurrentView);
  const setKanbanProjectId = useViewStore((s) => s.setKanbanProjectId);
  const openKanbanCard = useUIStore((s) => s.openKanbanCardModal);
  const setTodoTab = useTodoStore((s) => s.setActiveTab);
  const setTodoFilter = useTodoStore((s) => s.setStatusFilter);

  const derived = useDerivedDueNotifications();
  // What-If is Gantt-only and the card opens on the Kanban board, so card
  // links are blocked while the sandbox is active (other rows stay usable).
  const whatIf = useWhatIfBlocked();
  // Card links open the Kanban board, which needs views.kanban (its reads
  // answer 403 without it): the notification is still marked read.
  const canOpenCards = useHasPermission('views.kanban');

  const refresh = useCallback(async () => {
    if (!currentUser) return;
    try {
      const [list, count] = await Promise.all([getNotifications(), getUnreadCount()]);
      setItems(list);
      setUnreadCount(count);
    } catch (err) {
      console.error('[Notifications] Failed to refresh:', err);
    }
  }, [currentUser, setItems, setUnreadCount]);

  // Load on mount and on focus. The WebSocket push is only a hint: the
  // connection manager is per-process, so a user on another worker misses it.
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const { onBlur } = useDismissableOverlay({
    open: panelOpen,
    onClose: () => setPanelOpen(false),
    wrapperRef: panelRef,
    triggerRef: bellRef,
  });

  const merged = useMemo(() => {
    // Derived reminders first: they are actionable now.
    return [...derived, ...items].slice(0, 60);
  }, [derived, items]);

  const totalBadge = unreadCount + derived.length;

  const handleOpen = async (n: AppNotification) => {
    const todosTarget = todosTargetFor(n);
    // Both targets leave the Gantt, which What-If cannot do.
    if ((opensCard(n) || todosTarget) && whatIf.blocked) return;
    if (
      canOpenCards &&
      n.project_id &&
      (n.entity_type === 'phase' || n.entity_type === 'subphase') &&
      n.entity_id
    ) {
      setKanbanProjectId(n.project_id);
      setCurrentView('kanban');
      openKanbanCard(n.entity_type, n.entity_id, n.project_id);
    } else if (todosTarget) {
      // My Todos needs no key: every user has one.
      setTodoTab(todosTarget.tab);
      if (todosTarget.filter) setTodoFilter(todosTarget.filter);
      setCurrentView('todos');
    }
    setPanelOpen(false);

    if (n.source === 'derived') {
      // Derived reminders are dismissed locally; there is no server row.
      if ((n.entity_type === 'phase' || n.entity_type === 'subphase') && n.entity_id && n.body) {
        const due = n.body.split('due ').pop() ?? '';
        dismissDerivedNotification(cardKey(n.entity_type, n.entity_id), due);
      }
      return;
    }

    if (!n.read_at) {
      markReadLocal(n.id);
      try {
        await markNotificationRead(n.id);
      } catch (err) {
        console.error('[Notifications] Failed to mark read:', err);
        void refresh();
      }
    }
  };

  const handleMarkAll = async () => {
    markAllReadLocal();
    try {
      await markAllNotificationsRead();
    } catch (err) {
      console.error('[Notifications] Failed to mark all read:', err);
      void refresh();
    }
  };

  if (!currentUser) return null;

  return (
    <div ref={panelRef} className={styles.wrapper} onBlur={onBlur}>
      <button
        ref={bellRef}
        type="button"
        className={`${styles.bell} ${totalBadge > 0 ? styles.hasUnread : ''}`}
        onClick={togglePanel}
        aria-label={`Notifications${totalBadge > 0 ? ` (${totalBadge} unread)` : ''}`}
        aria-expanded={panelOpen}
        aria-haspopup="dialog"
        aria-controls={panelOpen ? panelId : undefined}
        title="Notifications"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {totalBadge > 0 && (
          <span className={styles.badge}>{totalBadge > 99 ? '99+' : totalBadge}</span>
        )}
      </button>

      {panelOpen && (
        <div id={panelId} className={styles.panel} role="dialog" aria-label="Notifications">
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>Notifications</span>
            {unreadCount > 0 && (
              <button type="button" className={styles.markAll} onClick={handleMarkAll}>
                Mark all read
              </button>
            )}
          </div>

          {whatIf.blocked && (
            <p className={styles.whatIfNote} role="note">
              {whatIf.reason(OPEN_CARD_ACTION)}
            </p>
          )}

          <ul className={styles.list}>
            {merged.map((n) => {
              const cardBlocked = whatIf.blocked && opensCard(n);
              const todosBlocked = whatIf.blocked && todosTargetFor(n) !== null;
              const blockedReason = cardBlocked
                ? whatIf.reason(OPEN_CARD_ACTION)
                : todosBlocked
                  ? whatIf.reason(OPEN_TODOS_ACTION)
                  : undefined;
              return (
                <li key={`${n.source ?? 'server'}-${n.id}`}>
                  <button
                    type="button"
                    className={`${styles.item} ${!n.read_at ? styles.unread : ''}`}
                    onClick={() => handleOpen(n)}
                    disabled={Boolean(blockedReason)}
                    title={blockedReason}
                  >
                    <span className={`${styles.icon} ${styles[n.type] ?? ''}`}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d={TYPE_ICONS[n.type] ?? TYPE_ICONS.comment} />
                      </svg>
                    </span>
                    <span className={styles.text}>
                      <span className={styles.title}>{n.title}</span>
                      {n.body && <span className={styles.body}>{n.body}</span>}
                      <span className={styles.time}>{relativeTime(n.created_at)}</span>
                    </span>
                    {!n.read_at && <span className={styles.dot} aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
            {merged.length === 0 && <li className={styles.empty}>Nothing new</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
